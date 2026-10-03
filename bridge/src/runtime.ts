import { OperationTimeout, withDeadline, settleWithin } from "./operation-deadline.ts";
import { readBatchClaim } from "./batch-claim.ts";
import { watchPublicationDirectory } from "./runtime-notifications.ts";
import { DATA_DIR } from "./types.ts";
import { RuntimeDiagnostics, type DiagnosticOperation } from "./runtime-diagnostics.ts";
import { MediaJobLimiter, pendingMediaJobs, saveMediaJob, type MediaJob } from "./media-jobs.ts";
import { queueDotWake } from "./dot-inbox.ts";
import { recoverDurableState } from "./recovery.ts";
import { assertRecoveryTimestamp, isAfterRecoveryCutover, loadRecoveryPolicy, type RecoveryPolicy } from "./recovery-policy.ts";
import { hasSetupConfettiBeenSent, markSetupConfettiSent } from "./setup-confetti.ts";
import { Spectrum, app, attachment, edit, group, poll, voice, type Message, type Space } from "@spectrum-ts/core";
import { effect, imessage } from "@spectrum-ts/imessage";
import type { AttachmentGroupPart, Config, InboundRecord, OutboundItem } from "./types.ts";
import { isDefinitiveSendRejection, sendReplyWithFallback } from "./reply-fallback.ts";
import {
  shapeInboundContent,
  unwrapInboundContent,
  type InboundMessageMetadata,
  toInboundRecord,
  type ContentLike,
} from "./inbound.ts";
import {
  attachmentDisplayText,
  persistInboundAttachment,
  InboundAttachmentError,
  type ReadableAttachmentContent,
} from "./inbound-attachment.ts";
import {
  transcribeInboundVoice,
  voiceDisplayText,
} from "./voice-stt.ts";
import {
  addHandledId,
  addWebhookPending,
  appendInbound,
  enqueueOutbound,
  ensureDataDir,
  listWebhookPending,
  loadHandledIds,
  loadOutboundQueue,
  loadPendingBatch,
  newId,
  removeWebhookPending,
  savePendingBatch,
  updateOutbound,
  writeUnreadBatch,
  savePollMeta,
  loadPollMeta,
  recordReadReceipt,
  saveConversationContext,
  loadConversationContext,
  saveAppCardSession,
  loadAppCardSession,
  type AppCardSession,
} from "./storage.ts";
import { CARDS_READY_DIR, drainCardsReady } from "./cards-ready.ts";
import {
  applyResolvedOptionToInbound,
  persistAttachmentGroupMapping,
  resolveReactionOption,
} from "./reaction-option.ts";
import {
  batchCasualKind,
  isGreetingOnlyBatch,
  pickCannedReply,
} from "./greeting.ts";

function log(message: string): void {
  console.log(`[dot] ${message}`);
}

function outboundKind(
  item: OutboundItem,
): "text" | "reply" | "react" | "poll" | "voice" | "typing" | "attachment_group" | "app" | "app_update" {
  return item.kind ?? "text";
}

/** Resolve short effect name → Spectrum imessage.effect.message constant. */
function resolveMessageEffect(name: string): string {
  const map = imessage.effect.message as Record<string, string>;
  const value = map[name];
  if (!value) {
    throw new Error(`unknown message effect: ${name}`);
  }
  return value;
}


type MaintenanceOperation = "outbound_drain" | "webhook_drain" | "cards_ready";

type MessageWithAppSession = Message & {
  miniAppCardSession?: AppCardSession;
};

function extractAppCardSession(message: unknown): AppCardSession | undefined {
  if (!message || typeof message !== "object") return undefined;
  const raw = (message as MessageWithAppSession).miniAppCardSession;
  if (!raw || typeof raw !== "object") return undefined;
  const { chatGuid, messageGuid, sessionId, targetMessageGuid } = raw as AppCardSession;
  if (
    typeof chatGuid !== "string" ||
    typeof messageGuid !== "string" ||
    typeof sessionId !== "string" ||
    typeof targetMessageGuid !== "string"
  ) {
    return undefined;
  }
  return { chatGuid, messageGuid, sessionId, targetMessageGuid };
}

/** Attach persisted miniAppCardSession onto the Message when getMessage lacks it. */
async function ensureAppCardSession(
  message: Message,
  messageId: string,
): Promise<Message> {
  const existing = extractAppCardSession(message);
  if (existing) return message;
  const stored = await loadAppCardSession(messageId);
  if (!stored) return message;
  (message as MessageWithAppSession).miniAppCardSession = stored;
  return message;
}

export class GpProofRuntime {
  private readonly config: Config;
  private readonly diagnostics = new RuntimeDiagnostics();
  private readonly maintenance = new Map<MaintenanceOperation, Promise<void>>();
  private readonly spaces = new Map<string, Space>();
  private handled = new Set<string>();
  private pending: InboundRecord[] = [];
  private flushScheduled = false;
  private notificationClosers: Array<() => void> = [];
  private outboundAgain = false;
  private maintenanceAgain = new Set<MaintenanceOperation>();
  private webhookTasks = new Set<Promise<void>>();
  private outboundTimer: ReturnType<typeof setInterval> | null = null;
  private webhookTimer: ReturnType<typeof setInterval> | null = null;
  private cardsReadyTimer: ReturnType<typeof setInterval> | null = null;
  private sending = new Set<string>();
  private outboundDrain?: Promise<void>;
  private flushing = false;
  private app: Awaited<ReturnType<typeof Spectrum>> | undefined;
  private stopped = false;
  private consumingStream = false;
  private stopping?: Promise<void>;
  private commits: Promise<void> = Promise.resolve();
  private inboundTasks = new Map<string, Promise<void>>();
  private webhookActive = new Set<string>();
  private readonly shutdownSignal = new AbortController();
  private readonly mediaLimiter: MediaJobLimiter;
  private mediaWork = new Set<Promise<unknown>>();
  private providerTasks = new Set<Promise<unknown>>();
  private recoveryPolicyLoad?: Promise<RecoveryPolicy | undefined>;
  private recoveryPolicy(): Promise<RecoveryPolicy | undefined> {
    return this.recoveryPolicyLoad ??= loadRecoveryPolicy(this.config.requireRecoveryPolicy);
  }
  private commit<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commits.then(fn, fn);
    this.commits = run.then(() => undefined, () => undefined);
    return run;
  }
  private readonly onSigint = () => { void this.stop("SIGINT").catch(() => {}); };
  private readonly onSigterm = () => { void this.stop("SIGTERM").catch(() => {}); };

  /** Every ignored task settles successfully after recording a safe diagnostic. */
  private observeBackground(operation: DiagnosticOperation, work: () => Promise<unknown>): Promise<void> {
    return Promise.resolve().then(work).then(
      () => this.diagnostics.recovered(operation),
      error => this.diagnostics.failure(operation, error),
    );
  }

  /** Repeated timer ticks cannot overlap a maintenance pass or queue retries. */
  private runMaintenance(operation: MaintenanceOperation, work: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const active = this.maintenance.get(operation);
    if (active) return active;
    const task = this.observeBackground(operation, work)
      .finally(() => {
        this.maintenance.delete(operation);
        if (this.maintenanceAgain.delete(operation) && !this.stopped) void this.runMaintenance(operation, work);
      });
    this.maintenance.set(operation, task);
    return task;
  }

  private requestMaintenance(operation: MaintenanceOperation, work: () => Promise<void>): void {
    if (this.stopped) return;
    if (this.maintenance.has(operation)) this.maintenanceAgain.add(operation);
    else void this.runMaintenance(operation, work);
  }

  private notifyWebhook(batchId: string): void {
    // A new turn of the event loop releases the serialized local commit first.
    const task = this.observeBackground("webhook_delivery", async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await this.postWebhook(batchId);
    }).finally(() => this.webhookTasks.delete(task));
    this.webhookTasks.add(task);
  }

  constructor(config: Config, private readonly connect: typeof Spectrum = Spectrum) {
    this.config = config;
    this.mediaLimiter = new MediaJobLimiter(config.mediaConcurrency ?? 2);
    for (const ms of [config.operationTimeoutMs, config.shutdownGraceMs, config.mediaTimeoutMs]) {
      if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0)) throw new Error("invalid_operation_bound");
    }
  }

  async start(): Promise<void> {
    this.diagnostics.lifecycle("runtime_starting");
    try {
      await this.startInner();
      if (!this.stopped) this.diagnostics.lifecycle("provider_stream_eof");
    } catch (error) {
      this.diagnostics.failure(this.consumingStream ? "provider_stream" : "runtime_start", error);
      throw new Error("runtime_start_failed");
    }
  }

  private async startInner(): Promise<void> {
    const policy = await this.recoveryPolicy();
    await ensureDataDir();
    this.pending = await recoverDurableState(policy);
    const mediaJobs = policy ? await pendingMediaJobs() : undefined;
    // No recovered media lookup/download may establish eligibility using the
    // SDK getMessage() timestamp fallback. Require its prior admitted event.
    if (policy) mediaJobs!.forEach(job => assertRecoveryTimestamp(policy, job.recoveryEventTimestamp));
    this.handled = await loadHandledIds();
    if (this.pending.length > 0) this.scheduleFlush();

    const app = await this.connect({
      projectId: this.config.projectId,
      projectSecret: this.config.projectSecret,
      providers: [imessage.config()],
      telemetry: false,
      options: { logLevel: "error" },
    });
    this.app = app;
    this.diagnostics.lifecycle("provider_connected");
    log("hosted iMessage provider connected");
    for (const job of mediaJobs ?? await pendingMediaJobs()) {
      if (this.handled.has(job.messageId)) { await saveMediaJob({ ...job, state: "done" }); continue; }
      if (job.senderId !== this.config.authorizedSenderId) continue;
      const task = this.observeBackground("media_recovery", () => this.resumeMedia(job)).finally(() => this.inboundTasks.delete(job.messageId));
      this.inboundTasks.set(job.messageId, task);
    }

    // Directory watches survive atomic replacement of the queue/marker inode.
    this.notificationClosers.push(await watchPublicationDirectory(DATA_DIR,
      name => name === "outbound-queue.json",
      () => this.requestMaintenance("outbound_drain", () => this.drainOutbound())));
    this.notificationClosers.push(await watchPublicationDirectory(CARDS_READY_DIR,
      name => name.endsWith(".json"),
      () => this.requestMaintenance("cards_ready", () => this.drainCardsReadyWatchdog())));
    this.outboundTimer = setInterval(() => {
      void this.runMaintenance("outbound_drain", () => this.drainOutbound());
    }, 500);
    this.webhookTimer = setInterval(() => {
      void this.runMaintenance("webhook_drain", () => this.drainWebhooks());
    }, 2000);
    this.cardsReadyTimer = setInterval(() => {
      void this.runMaintenance("cards_ready", () => this.drainCardsReadyWatchdog());
    }, 3000);
    void this.runMaintenance("outbound_drain", () => this.drainOutbound());
    void this.runMaintenance("webhook_drain", () => this.drainWebhooks());
    void this.runMaintenance("cards_ready", () => this.drainCardsReadyWatchdog());

    process.on("SIGINT", this.onSigint);
    process.on("SIGTERM", this.onSigterm);

    this.consumingStream = true;
    for await (const [space, message] of app.messages) {
      const streamReceivedAt = new Date().toISOString();
      if (this.stopped) break;
      try {
        if (this.inboundTasks.has(message.id)) continue;
        const task = this.observeBackground("inbound_handler", () => this.onMessage(space, message, { streamReceivedAt })).finally(() => this.inboundTasks.delete(message.id));
        this.inboundTasks.set(message.id, task);
      } catch (error) {
        this.diagnostics.failure("inbound_handler", error);
      }
    }
  }

  async stop(trigger: "SIGINT" | "SIGTERM" | "requested" = "requested"): Promise<void> {
    if (!this.stopping) {
      this.diagnostics.lifecycle("stop_requested", trigger);
      this.stopping = this.stopInner().then(
        () => this.diagnostics.lifecycle("runtime_stopped"),
        error => {
          this.diagnostics.failure("runtime_stop", error);
          throw new Error("runtime_stop_failed");
        },
      );
    }
    return this.stopping;
  }

  private async stopInner(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdownSignal.abort();
    process.off("SIGINT", this.onSigint);
    process.off("SIGTERM", this.onSigterm);
    for (const close of this.notificationClosers.splice(0)) close();
    if (this.outboundTimer) clearInterval(this.outboundTimer);
    if (this.webhookTimer) clearInterval(this.webhookTimer);
    if (this.cardsReadyTimer) clearInterval(this.cardsReadyTimer);
    const grace = this.config.shutdownGraceMs ?? 6_000;
    const deadline = performance.now() + grace;
    const remaining = () => Math.max(0, deadline - performance.now());
    let stopFailed = false;
    let stopError: unknown;
    const inboundSettled = await settleWithin(this.inboundTasks.values(), remaining());
    if (inboundSettled) {
      try { await withDeadline(this.commit(() => this.flushPending()), remaining()); }
      catch (error) { stopFailed = true; stopError = error; }
    }
    const work = () => [this.outboundDrain, ...this.maintenance.values(), ...this.webhookTasks,
      ...this.providerTasks, ...this.mediaWork];
    const settled = inboundSettled && await settleWithin(work(), remaining());
    // Pinned Spectrum stop tears down its provider clients. A deadline alone
    // cannot transfer ownership while an old SDK invocation can still act.
    try { await withDeadline(this.app?.stop() ?? Promise.resolve(), Math.min(5_000, this.config.operationTimeoutMs ?? 5_000)); }
    catch (error) { if (!stopFailed) stopError = error; stopFailed = true; }
    if (!settled && !await settleWithin([...this.inboundTasks.values(), ...work()], Math.min(1_000, grace))) {
      stopFailed = true;
      stopError = new Error("shutdown_requires_owner_exit");
    }
    if (stopFailed) throw stopError;
    log("stopped");

  }

  private async resumeMedia(job: MediaJob): Promise<void> {
    try {
      const policy = await this.recoveryPolicy();
      if (policy) assertRecoveryTimestamp(policy, job.recoveryEventTimestamp);
      const space = await this.resolveSpace(job.spaceId, job.lineId);
      const message = await space.getMessage(job.messageId);
      if (!message) { log(`media recovery source unavailable id=${job.messageId}`); return; }
      await this.onMessage(space, message, { streamReceivedAt: job.streamReceivedAt, recoveryEventTimestamp: policy ? job.recoveryEventTimestamp : undefined });
    } catch { log(`media recovery pending id=${job.messageId}`); }
  }

  private async onMessage(
    space: Space,
    message: Message,
    timing: { streamReceivedAt?: string; recoveryEventTimestamp?: string } = { streamReceivedAt: new Date().toISOString() },
  ): Promise<void> {
    if (message.direction === "outbound") return;
    if (message.platform !== "imessage") return;
    const spaceType = (space as Space & { type?: string }).type;
    if (spaceType && spaceType !== "dm") return;

    const senderId = message.sender?.id;
    if (!senderId || senderId !== this.config.authorizedSenderId) {
      log(`drop unauthorized sender id=${message.id}`);
      return;
    }
    if (this.handled.has(message.id)) {
      log(`drop duplicate id=${message.id}`);
      return;
    }

    const policy = await this.recoveryPolicy();
    let eventTimestamp = message.timestamp;
    if (policy) {
      if (timing.recoveryEventTimestamp !== undefined) {
        assertRecoveryTimestamp(policy, timing.recoveryEventTimestamp);
        eventTimestamp = new Date(timing.recoveryEventTimestamp);
      }
      // Pinned hosted stream: event.occurredAt (read events may use readAt).
      // This is not proof of original Apple creation time. Reject before any
      // bridge receipt, media, context persistence, wake or automatic action.
      if (!isAfterRecoveryCutover(policy, eventTimestamp)) {
        log("drop recovery event: missing, invalid, or not after cutoff");
        return;
      }
    }

    // Recipient read our outbound — do not queue or wake Grok.
    if ((message.content as ContentLike | undefined)?.type === "read") {
      await recordReadReceipt(space.id, (message.content as ContentLike).target?.id, message.id);
      this.handled.add(message.id);
      await addHandledId(message.id);
      log(`recorded inbound read receipt id=${message.id}`);
      return;
    }

    const shaped = shapeInboundContent(message.content as ContentLike, message as unknown as InboundMessageMetadata);
    if (shaped === null) {
      this.handled.add(message.id);
      await addHandledId(message.id);
      log(`ignore unsupported content type id=${message.id}`);
      return;
    }

    const mediaJob: MediaJob | undefined = (shaped.kind === "attachment" || shaped.kind === "voice") ? {
      messageId: message.id, spaceId: space.id, senderId,
      lineId: (space as Space & { phone?: string }).phone,
      kind: shaped.kind as "attachment" | "voice", state: "pending", createdAt: new Date().toISOString(), streamReceivedAt: timing.streamReceivedAt,
      ...(policy ? { recoveryEventTimestamp: eventTimestamp.toISOString() } : {}),
    } : undefined;
    if (mediaJob) await this.commit(() => saveMediaJob(mediaJob));
    await saveConversationContext(space.id, { senderId, lineId: (space as Space & { phone?: string }).phone });
    const contextSavedAt = new Date().toISOString();
    this.spaces.set(space.id, space);

    let attachmentExtras:
      | {
          attachmentPath: string;
          attachmentBytes: number;
          attachmentOriginalPath?: string;
          attachmentOriginalMimeType?: string;
          transcript?: string;
        }
      | undefined;
    if (shaped.kind === "attachment" || shaped.kind === "voice") {
      const work = this.mediaLimiter.run(async () => {
      const content = unwrapInboundContent(message.content as ContentLike) as ReadableAttachmentContent;
      try {
        const saved = await persistInboundAttachment(message.id, content, {
          fallbackRead: async () => {
            if (!this.app || !content.id) {
              throw new Error("no app or attachment id for fallback");
            }
            const im = imessage(this.app);
            const att = await im.getAttachment(content.id);
            if (!att) throw new Error(`getAttachment returned empty for ${content.id}`);
            return att.read();
          },
        });
        attachmentExtras = {
          attachmentPath: saved.path,
          attachmentBytes: saved.bytes,
          ...(saved.originalPath
            ? { attachmentOriginalPath: saved.originalPath }
            : {}),
          ...(saved.originalMimeType
            ? { attachmentOriginalMimeType: saved.originalMimeType }
            : {}),
        };
        shaped.attachmentName = saved.name;
        shaped.attachmentMimeType = saved.mimeType;
        if (saved.attachmentId) shaped.attachmentId = saved.attachmentId;
        log(
          `saved inbound attachment id=${message.id} path=${saved.path} bytes=${saved.bytes}` +
            (saved.convertedFromHeif ? " converted=heif2jpeg" : ""),
        );

        if (shaped.kind === "voice") {
          const stt = await transcribeInboundVoice(saved.path);
          if (stt.text) {
            attachmentExtras.transcript = stt.text;
            log(
              `moonshine stt ok id=${message.id} wav=${stt.wavPath} chars=${stt.text.length}`,
            );
          } else {
            log(
              `moonshine stt empty/fail id=${message.id} wav=${stt.wavPath} err=${stt.error ?? "no text"}`,
            );
          }
          shaped.text = voiceDisplayText(
            saved.name,
            saved.mimeType,
            saved.bytes,
            shaped.attachmentDuration,
            stt.text || undefined,
          );
        } else {
          shaped.text = attachmentDisplayText(
            saved.name,
            saved.mimeType,
            saved.bytes,
          );
        }
      } catch (err) {
        log(`inbound attachment unavailable id=${message.id}`);
        shaped.text = `${shaped.text} [download failed: attachment_unavailable]`;
      }
      }, this.shutdownSignal.signal);
      this.mediaWork.add(work);
      work.then(() => this.mediaWork.delete(work), () => this.mediaWork.delete(work));
      try { await withDeadline(work, this.config.mediaTimeoutMs ?? 180_000); }
      catch (error) {
        if (error instanceof OperationTimeout && mediaJob) await saveMediaJob({ ...mediaJob, lastError: "media_operation_timeout" });
        throw error; // Keep the pending identity for recovery; no fabricated completed input.
      }
    }

    let record = toInboundRecord(
      shaped,
      {
        id: message.id,
        spaceId: space.id,
        senderId,
        timestamp: eventTimestamp.toISOString(),
        receivedAt: new Date().toISOString(),
      },
      attachmentExtras,
    );
    if (record.kind === "poll_vote") {
      const pollMessageId = message.id.split(":")[0] ?? "";
      if (pollMessageId) {
        try {
          const meta = await loadPollMeta(pollMessageId);
          if (meta?.title && (!record.pollTitle || record.pollTitle === "Poll")) {
            record = {
              ...record,
              pollTitle: meta.title,
              text: `${record.pollSelected === false ? "unvoted" : "voted"} ${record.pollOption ?? "?"} on "${meta.title}"`,
            };
          }
        } catch (err) {
          log(`poll meta load failed id=${pollMessageId}`);
        }
      }
    }
    if (record.kind === "reaction") {
      try {
        const resolved = await resolveReactionOption(record.targetMessageId);
        record = applyResolvedOptionToInbound(record, resolved);
        if (resolved.ambiguous) {
          log(
            `reaction option ambiguous id=${message.id} reason=${resolved.reason} names=${resolved.optionNames.length}`,
          );
        } else {
          log(
            `reaction option resolved id=${message.id} part=${resolved.partIndex} title=${resolved.title ?? resolved.optionId ?? "?"}`,
          );
        }
      } catch (err) {
        log(`reaction option resolve failed id=${message.id}`);
      }
    }

    record.lineId = (space as Space & { phone?: string }).phone;
    record.streamReceivedAt = timing.streamReceivedAt;
    record.contextSavedAt = contextSavedAt;
    await this.commit(async () => {
      await appendInbound(record);
      this.pending.push(record);
      await savePendingBatch(this.pending);
      this.handled.add(message.id);
      await addHandledId(message.id);
    });
    log(
      `queued inbound kind=${record.kind ?? "text"} id=${message.id} space=${space.id}`,
    );
    if (mediaJob) await saveMediaJob({ ...mediaJob, state: "done" });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.stopped) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.stopped) void this.observeBackground("batch_flush", () => this.commit(() => this.flushPending()));
    });
  }

  private async flushPending(): Promise<void> {
    if (this.flushing) return;
    if (this.pending.length === 0) return;
    this.flushing = true;
    try {
      const messages = this.pending;
      const batchId = newId("b");
      const greetingOnly = this.config.greetingFastPath === true && isGreetingOnlyBatch(messages);

      const pendingMedia = (await pendingMediaJobs()).filter(job => messages.some(message => message.spaceId === job.spaceId)).map(({ messageId, spaceId, kind, streamReceivedAt, lastError }) => ({ messageId, spaceId, kind, streamReceivedAt, lastError }));
      await writeUnreadBatch({
        batchId,
        flushedAt: new Date().toISOString(),
        messages,
        ...(pendingMedia.length ? { pendingMedia } : {}),
        ...(greetingOnly ? { handledBy: "runtime-greeting" as const } : {}),
      });
      // Publish the durable wake intent before clearing recoverable input.
      if (!greetingOnly) await addWebhookPending(batchId);
      this.pending = [];
      await savePendingBatch([]);
      log(`flushed unread batchId=${batchId} count=${messages.length}`);
      if (!(await this.recoveryPolicy())?.suppressOnboarding && !(await hasSetupConfettiBeenSent())) {
        for (const spaceId of new Set(messages.map(m => m.spaceId))) {
          await enqueueOutbound({ kind: "text", spaceId, text: "it’s dot here", effect: "confetti" }, "setup-confetti");
        }
        await markSetupConfettiSent();
      }

      if (greetingOnly) {
        await this.enqueueGreetingFastPath(batchId, messages);
        return;
      }

      if (this.config.hostMode === "dot-local") await this.postWebhook(batchId);
      else this.notifyWebhook(batchId);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Canned reply without waking Front Door / Chatty.
   * One reply per space, threaded to the latest text inbound when possible.
   */
  private async enqueueGreetingFastPath(
    batchId: string,
    messages: InboundRecord[],
  ): Promise<void> {
    const kind = batchCasualKind(messages);
    const bySpace = new Map<string, InboundRecord[]>();
    for (const m of messages) {
      const list = bySpace.get(m.spaceId) ?? [];
      list.push(m);
      bySpace.set(m.spaceId, list);
    }

    for (const [spaceId, spaceMessages] of bySpace) {
      const texts = spaceMessages.filter((m) => (m.kind ?? "text") === "text");
      const target = texts[texts.length - 1];
      const reply = pickCannedReply(kind, Date.now() + spaceId.length);
      if (target) {
        await enqueueOutbound({
          kind: "reply",
          spaceId,
          targetMessageId: target.id,
          text: reply,
        });
      } else {
        await enqueueOutbound({ kind: "text", spaceId, text: reply });
      }
      log(
        `greeting fast-path batchId=${batchId} space=${spaceId} reply=${JSON.stringify(reply)}`,
      );
    }
  }

  private async postWebhook(batchId: string): Promise<void> {
    if (this.webhookActive.has(batchId)) return;
    this.webhookActive.add(batchId);
    try {
      if ((await readBatchClaim(batchId))?.state === "completed") { await removeWebhookPending(batchId); return; }
      if (this.config.hostMode === "dot-local") {
        await queueDotWake(batchId);
        await removeWebhookPending(batchId);
        console.log(JSON.stringify({ event: "dot_batch_ready", batchId }));
        return;
      }
      if (!this.config.webhookUrl || !this.config.webhookKey) throw new Error("missing_webhook_configuration");
      const res = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.webhookKey}`,
        },
        body: JSON.stringify({ batchId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log(`webhook failed batchId=${batchId} status=${res.status}`);
        return;
      }
      await removeWebhookPending(batchId);
      log(`webhook ok batchId=${batchId}`);
    } catch (err) {
      log(`webhook error batchId=${batchId}`);
    } finally {
      this.webhookActive.delete(batchId);
    }
  }

  private async drainWebhooks(): Promise<void> {
    const pending = await listWebhookPending();
    for (const batchId of pending) {
      await this.postWebhook(batchId);
    }
  }

  /** Durable Image Cards final-enqueue when PNGs land after FD released the turn. */
  private async drainCardsReadyWatchdog(): Promise<void> {
    const n = await drainCardsReady();
    if (n > 0) log(`cards-ready enqueued stacks=${n}`);
  }

  private drainOutbound(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.outboundAgain = true;
    if (this.outboundDrain) return this.outboundDrain;
    const run = (async () => {
      while (this.outboundAgain && !this.stopped) {
        this.outboundAgain = false;
        await this.drainOutboundInner();
      }
    })();
    this.outboundDrain = run.finally(() => { this.outboundDrain = undefined; });
    return this.outboundDrain;
  }

  private async drainOutboundInner(): Promise<void> {
    const items = await loadOutboundQueue();
    const now = Date.now();
    const blocked = new Map<string, string>();
    for (const item of items) {
      if (this.stopped) break;
      if (item.status === "unknown" || item.status === "sending") { blocked.set(item.spaceId, item.id); continue; }
      if (item.status !== "queued") continue;
      const blocker = blocked.get(item.spaceId);
      if (blocker) {
        if (item.blockedBy !== blocker) await updateOutbound(item.id, { blockedBy: blocker });
        continue;
      }
      if (this.sending.has(item.id)) continue;
      if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now) { blocked.set(item.spaceId, item.id); continue; }
      this.outboundAgain = true; // Reconcile durable state after the pass, even if a watch event was missed.
      this.sending.add(item.id);
      try {
        await this.sendOutbound(item);
        const current = (await loadOutboundQueue()).find(row => row.id === item.id);
        if (current?.status === "unknown" || current?.status === "queued" || current?.status === "sending") blocked.set(item.spaceId, item.id);
      } finally {
        this.sending.delete(item.id);
      }
    }
  }

  private async sendOutbound(item: OutboundItem): Promise<void> {
    const nextAttempts = item.attempts + 1;
    const kind = outboundKind(item);
    let providerCompleted = false;
    let sdkInvoked = false;
    let invocationTimedOut = false;
    const lookup = <T>(work: Promise<T>) => withDeadline(work, this.config.operationTimeoutMs ?? 30_000);
    const invoke = async <T>(call: () => Promise<T>): Promise<T> => {
      if (this.stopped) throw new Error("runtime_stopping");
      sdkInvoked = true;
      const work = Promise.resolve().then(call);
      this.providerTasks.add(work);
      work.then(() => this.providerTasks.delete(work), () => this.providerTasks.delete(work));
      try { return await withDeadline(work, this.config.operationTimeoutMs ?? 30_000); }
      catch (error) { if (error instanceof OperationTimeout) invocationTimedOut = true; throw error; }
    };
    const complete = async (
      providerReturnedAt: string,
      messageId?: string,
      deliveryState: "provider_accepted" | "control_requested" = "provider_accepted",
      hasProviderReturn = true,
    ): Promise<void> => {
      // Set before durable writes: an audit/storage failure after a known send
      // must never route through the unknown-send retry/quarantine path.
      providerCompleted = true;
      await updateOutbound(item.id, {
        status: "sent", deliveryState, attempts: nextAttempts,
        sentAt: providerReturnedAt,
        ...(hasProviderReturn ? { providerReturnedAt } : {}),
        ...(deliveryState === "provider_accepted" ? { providerAcceptedAt: providerReturnedAt } : {}),
        ...(messageId ? { messageId } : {}),
        lastError: undefined, nextAttemptAt: undefined, blockedBy: undefined,
      });
    };
    try {
      const dispatchStartedAt = new Date().toISOString();
      await updateOutbound(item.id, { status: "sending", attempts: nextAttempts, dispatchStartedAt });
      if (kind === "typing") {
        await updateOutbound(item.id, { status: "failed", attempts: nextAttempts, failedAt: new Date().toISOString(), lastError: "outgoing_control_disabled", nextAttemptAt: undefined });
        return;
      }
      const space = await lookup(this.resolveSpace(item.spaceId));
      if (kind === "react") {
        if (item.kind !== "react") throw new Error("react kind mismatch");
        const target = await lookup(space.getMessage(item.targetMessageId));
        if (!target) {
          throw new Error(`target message not found: ${item.targetMessageId}`);
        }
        // undefined = platform skipped reactions → treat as done (no retry loop)
        await invoke(() => target.react(item.emoji));
      } else if (kind === "reply") {
        if (item.kind !== "reply") throw new Error("reply kind mismatch");
        const delivery = await sendReplyWithFallback(
          {
            getMessage: async id => {
              const target = await lookup(space.getMessage(id));
              return target ? { reply: text => invoke(() => target.reply(text)) } : undefined;
            },
            send: text => invoke(() => space.send(text)),
          },
          item.targetMessageId,
          item.text,
        );
        if (delivery.status === "unknown") {
          await this.quarantineSend(item.id, nextAttempts, delivery.reason);
          return;
        }
        if (delivery.status === "failed") {
          await updateOutbound(item.id, {
            status: "failed",
            attempts: nextAttempts,
            failedAt: new Date().toISOString(),
            lastError: delivery.reason,
            nextAttemptAt: undefined,
          });
          log(`outbound dead-letter kind=reply id=${item.id} reason=${delivery.reason}`);
          return;
        }
        if (delivery.mode === "fallback") {
          log(`outbound reply fallback id=${item.id} reason=${delivery.replyError}`);
        }
        await complete(delivery.providerReturnedAt, delivery.messageId);
      } else if (kind === "voice") {
        if (item.kind !== "voice") throw new Error("voice kind mismatch");
        const sent = await invoke(() => space.send(
          voice(item.audioPath, {
            ...(typeof item.durationSeconds === "number"
              ? { duration: item.durationSeconds }
              : {}),
          }),
        ));
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.quarantineSend(item.id, nextAttempts, "undefined-result", providerReturnedAt);
          return;
        }
        await complete(providerReturnedAt, sent.id);
        log(
          `outbound sent kind=voice id=${item.id} space=${item.spaceId} messageId=${sent.id} path=${item.audioPath}`,
        );
        return;
      } else if (kind === "poll") {
        if (item.kind !== "poll") throw new Error("poll kind mismatch");
        const sent = await invoke(() => space.send(poll(item.title, item.options)));
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.quarantineSend(item.id, nextAttempts, "undefined-result", providerReturnedAt);
          return;
        }
        await complete(providerReturnedAt, sent.id);
        try {
          await savePollMeta(sent.id, item.title, item.options);
        } catch (err) {
          log(`poll meta save failed messageId=${sent.id}`);
        }
        log(`outbound sent kind=poll id=${item.id} space=${item.spaceId} messageId=${sent.id}`);
        return;
      } else if (kind === "app") {
        if (item.kind !== "app") throw new Error("app kind mismatch");
        const live = item.live === true;
        const sent = await invoke(() => space.send(
          live ? app(item.url, { live: true }) : app(item.url),
        ));
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.quarantineSend(item.id, nextAttempts, "undefined-result", providerReturnedAt);
          return;
        }
        await complete(providerReturnedAt, sent.id);
        try {
          const session = extractAppCardSession(sent);
          if (session) {
            await saveAppCardSession(sent.id, session, {
              live,
              url: item.url,
            });
          }
        } catch (err) {
          log(`app session save failed messageId=${sent.id}`);
        }
        log(
          `outbound sent kind=app id=${item.id} space=${item.spaceId} messageId=${sent.id} live=${live}`,
        );
        return;
      } else if (kind === "app_update") {
        if (item.kind !== "app_update") throw new Error("app_update kind mismatch");
        const live = item.live === true;
        let target = await lookup(space.getMessage(item.targetMessageId));
        if (!target) {
          throw new Error(`target message not found: ${item.targetMessageId}`);
        }
        target = await ensureAppCardSession(target, item.targetMessageId);
        if (!extractAppCardSession(target)) {
          await updateOutbound(item.id, { status: "failed", attempts: nextAttempts, failedAt: new Date().toISOString(), lastError: "missing_app_card_session" });
          return;
        }
        const sent = await invoke(() => space.send(
          edit(live ? app(item.url, { live: true }) : app(item.url), target),
        ));
        const providerReturnedAt = new Date().toISOString();
        // Undefined edits are completed control requests, not accepted messages.
        await complete(providerReturnedAt, sent?.id, sent === undefined ? "control_requested" : "provider_accepted");
        try {
          const session = extractAppCardSession(target);
          if (session) {
            await saveAppCardSession(item.targetMessageId, session, {
              live,
              url: item.url,
            });
          }
        } catch (err) {
          log(
            `app_update session save failed messageId=${item.targetMessageId}`,
          );
        }
        log(
          `outbound sent kind=app_update id=${item.id} space=${item.spaceId} target=${item.targetMessageId} live=${live} result=${sent === undefined ? "undefined" : "ok"}`,
        );
        return;
      } else if (kind === "attachment_group") {
        if (item.kind !== "attachment_group") {
          throw new Error("attachment_group kind mismatch");
        }
        const paths = item.attachmentPaths;
        if (paths.length < 2) {
          throw new Error("attachment_group requires at least 2 paths");
        }
        // Keep as ONE Spectrum group so iMessage provider uses sendMultipart
        // (upload each → attachmentGuid parts → single sendMultipart). Do not
        // expand into space.send(attachment, attachment, ...) — that is N messages.
        const payload = group(
          attachment(paths[0]!),
          attachment(paths[1]!),
          ...paths.slice(2).map((p) => attachment(p)),
        );
        const sent = await invoke(() => space.send(payload));
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.quarantineSend(item.id, nextAttempts, "undefined-result", providerReturnedAt);
          return;
        }
        await complete(providerReturnedAt, sent.id);
        const parentMessageId = sent.id;
        let parts: AttachmentGroupPart[] | undefined;
        let batchId = item.batchId;
        try {
          const mapped = await persistAttachmentGroupMapping({
            outboundId: item.id,
            spaceId: item.spaceId,
            parentMessageId,
            paths,
            batchId: item.batchId,
            cards: item.cards,
          });
          parts = mapped.parts;
          batchId = mapped.batchId;
          log(
            `attachment_group presentation saved batchId=${mapped.batchId} messageId=${parentMessageId} parts=${mapped.parts.length}`,
          );
        } catch (err) {
          log(
            `attachment_group presentation save failed id=${item.id} messageId=${parentMessageId}`,
          );
        }
        await updateOutbound(item.id, {
          ...(batchId ? { batchId } : {}),
          ...(parts ? { parts } : {}),
        });
        log(
          `outbound sent kind=attachment_group id=${item.id} space=${item.spaceId} count=${paths.length} messageId=${parentMessageId}`,
        );
        return;
      } else {
        // text (missing kind treated as text)
        const textItem = item as Extract<OutboundItem, { kind?: "text" }>;
        let payload: Parameters<Space["send"]>[0] = textItem.attachmentPath
          ? attachment(textItem.attachmentPath)
          : textItem.text;
        if (textItem.effect) {
          const effectId = resolveMessageEffect(textItem.effect);
          payload = effect(payload, effectId as never);
          log(
            `outbound effect=${textItem.effect} id=${item.id} space=${item.spaceId}`,
          );
        }
        const sent = await invoke(() => space.send(payload));
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.quarantineSend(item.id, nextAttempts, "undefined-result", providerReturnedAt);
          return;
        }
        await complete(providerReturnedAt, sent.id);
      }

      // Reactions are awaited SDK control requests, distinct from acceptance.
      if (!providerCompleted) await complete(new Date().toISOString(), undefined, "control_requested");
      log(`outbound sent kind=${kind} id=${item.id} space=${item.spaceId}`);
    } catch (error) {
      if (providerCompleted) {
        log(`outbound completion bookkeeping failed kind=${kind} id=${item.id}`);
        return;
      }
      if (isDefinitiveSendRejection(error)) await updateOutbound(item.id, { status: "failed", attempts: nextAttempts, failedAt: new Date().toISOString(), lastError: "send_rejected_validation_or_auth", nextAttemptAt: undefined });
      else if (sdkInvoked) await this.quarantineSend(item.id, nextAttempts, "send-threw");
      else await this.retryBeforeSend(item.id, nextAttempts, error);
      log(`outbound failure kind=${kind} id=${item.id}`);
    } finally {
      if (invocationTimedOut) void this.stop().catch(() => {});
    }
  }

  private async retryBeforeSend(id: string, attempts: number, error: unknown): Promise<void> {
    const failure = error as { name?: string; status?: number; message?: string };
    const permanent = ["ValidationError", "AuthenticationError", "AuthorizationError", "UnauthorizedError", "ForbiddenError"].includes(failure?.name ?? "") || [401, 403].includes(failure?.status ?? 0) || ["unverified_conversation", "runtime_stopping"].includes(failure?.message ?? "");
    if (permanent || attempts >= 3) {
      await updateOutbound(id, { status: "failed", attempts, failedAt: new Date().toISOString(), lastError: permanent ? "pre_send_validation_or_auth_failed" : "pre_send_retry_exhausted", nextAttemptAt: undefined });
    } else {
      await updateOutbound(id, { status: "queued", attempts, lastError: "pre_send_retry_pending", nextAttemptAt: new Date(Date.now() + 250 * 4 ** (attempts - 1)).toISOString() });
    }
  }

  private async quarantineSend(
    id: string,
    nextAttempts: number,
    lastError: string,
    providerReturnedAt?: string,
  ): Promise<void> {
    await updateOutbound(id, {
      status: "unknown",
      deliveryState: "unknown",
      attempts: nextAttempts,
      ...(providerReturnedAt ? { providerReturnedAt } : {}),
      lastError: lastError === "undefined-result" ? "send_not_confirmed" : "send_outcome_unknown",
      nextAttemptAt: undefined,
    });
    log(`outbound quarantined id=${id} reason=send_outcome_unknown`);
  }

  private async resolveSpace(spaceId: string, lineId?: string): Promise<Space> {
    const cached = this.spaces.get(spaceId);
    if (cached) return cached;
    if (!this.app) throw new Error("spectrum app not started");
    const context = await loadConversationContext(spaceId);
    if (this.config.hostMode === "dot-local" && (!context || context.senderId !== this.config.authorizedSenderId)) throw new Error("unverified_conversation");
    const phone = lineId ?? context?.lineId;
    const im = imessage(this.app);
    const space = await im.space.get(spaceId, phone ? { phone } : undefined);
    if (!space) throw new Error(`space not found: ${spaceId}`);
    this.spaces.set(spaceId, space);
    return space;
  }
}
