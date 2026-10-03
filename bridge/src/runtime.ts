import { latencyNow, recordLatency } from "./latency.ts";
import { OperationTimeout, withDeadline, settleWithin } from "./operation-deadline.ts";
import { readBatchClaim } from "./batch-claim.ts";
import { subscribeOutboundPublication, watchPublicationDirectory } from "./runtime-notifications.ts";
import { DATA_DIR } from "./types.ts";
import { RuntimeDiagnostics, type DiagnosticOperation } from "./runtime-diagnostics.ts";
import { MediaWorker, processInboundMedia, pendingMediaJobs, saveMediaJob, type MediaJob } from "./media-jobs.ts";
import { queueDotWake } from "./dot-inbox.ts";
import { recoverDurableState } from "./recovery.ts";
import { assertRecoveryTimestamp, isAfterRecoveryCutover, loadRecoveryPolicy, type RecoveryPolicy } from "./recovery-policy.ts";
import { hasSetupConfettiBeenSent, markSetupConfettiSent } from "./setup-confetti.ts";
import { Spectrum, app, attachment, edit, group, poll, voice, type Message, type Space } from "@spectrum-ts/core";
import { effect, imessage } from "@spectrum-ts/imessage";
import type { AttachmentGroupPart, Config, InboundRecord, OutboundItem } from "./types.ts";
import { isDefinitiveSendRejection, sendReplyWithFallback } from "./reply-fallback.ts";
import {
  TYPING_HEARTBEAT_MS,
  TYPING_TIMEOUT_MS,
} from "./types.ts";
import {
  shapeInboundContent,
  unwrapInboundContent,
  type ShapedInbound,
  type InboundMessageMetadata,
  toInboundRecord,
  type ContentLike,
} from "./inbound.ts";
import type { ReadableAttachmentContent } from "./inbound-attachment.ts";
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
  beginOutboundAttempt,
  writeUnreadBatch,
  savePollMeta,
  loadPollMeta,
  recordReadReceipt,
  recordTypingCleanup,
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
  hasAttachmentGroupMapping,
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


const TYPING_STOP_TIMEOUT_MS = 5_000;
type MaintenanceOperation = "outbound_drain" | "webhook_drain" | "cards_ready";
type TypingStopTiming = { startedAt: string; settledAt: string; outcome: "completed" | "failed" | "timeout" };

type MessageWithAppSession = Message & {
  miniAppCardSession?: AppCardSession;
};

function extractAppCardSession(message: unknown): AppCardSession | undefined {
  if (!message || typeof message !== "object") return undefined;
  const raw = (message as MessageWithAppSession).miniAppCardSession;
  if (!raw || typeof raw !== "object") return undefined;
  const { chatGuid, messageGuid, sessionId, targetMessageGuid } = raw as AppCardSession;
  if (
    [chatGuid, messageGuid, sessionId, targetMessageGuid].some(value => typeof value !== "string" || !value.trim())
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
  private outboundRequested = false;
  private maintenanceRequested = new Set<MaintenanceOperation>();
  private webhookTasks = new Set<Promise<void>>();
  private outboundTimer: ReturnType<typeof setInterval> | null = null;
  private webhookTimer: ReturnType<typeof setInterval> | null = null;
  private cardsReadyTimer: ReturnType<typeof setInterval> | null = null;
  private outboundDrain?: Promise<void>;
  private app: Awaited<ReturnType<typeof Spectrum>> | undefined;
  private stopped = false;
  private consumingStream = false;
  private stopping?: Promise<void>;
  private commits: Promise<void> = Promise.resolve();
  private inboundTasks = new Map<string, Promise<void>>();
  private webhookActive = new Set<string>();
  private typingStops = new Map<string, Promise<TypingStopTiming>>();
  private typingCleanupTasks = new Set<Promise<void>>();
  private controlTasks = new Set<Promise<unknown>>();
  private typingEpochs = new Map<string, number>();
  private readonly shutdownSignal = new AbortController();
  private readonly media: MediaWorker;
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
  /** Spaces where we showed typing after flush; cleared on first outbound or timeout. */
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Refresh startTyping while waiting for first text/reply. */
  private typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

  private readonly onSigint = () => { void this.stop("SIGINT").catch(() => {}); };
  private readonly onSigterm = () => { void this.stop("SIGTERM").catch(() => {}); };

  /** Keep underlying controls owned until they settle or provider teardown completes. */
  private trackControl<T>(work: Promise<T>): Promise<T> {
    this.controlTasks.add(work);
    work.then(() => this.controlTasks.delete(work), () => this.controlTasks.delete(work));
    return work;
  }

  /** Every ignored task settles successfully after recording a safe diagnostic. */
  private observeBackground(operation: DiagnosticOperation, work: () => Promise<unknown>): Promise<void> {
    return Promise.resolve().then(work).then(
      () => this.diagnostics.recovered(operation),
      error => this.diagnostics.failure(operation, error),
    );
  }

  /** Repeated timer ticks cannot overlap a maintenance pass or queue retries. */
  private runMaintenance(operation: MaintenanceOperation, work: () => Promise<void>): Promise<void> {
    if (operation === "outbound_drain") return this.drainOutbound();
    if (this.stopped) return Promise.resolve();
    const active = this.maintenance.get(operation);
    if (active) return active;
    const task = this.observeBackground(operation, work)
      .finally(() => {
        this.maintenance.delete(operation);
        if (this.maintenanceRequested.delete(operation) && !this.stopped) void this.runMaintenance(operation, work);
      });
    this.maintenance.set(operation, task);
    return task;
  }

  private requestMaintenance(operation: MaintenanceOperation, work: () => Promise<void>): void {
    if (operation === "outbound_drain") { void this.drainOutbound(); return; }
    if (this.stopped) return;
    if (this.maintenance.has(operation)) this.maintenanceRequested.add(operation);
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
    this.media = new MediaWorker(config.mediaConcurrency ?? 2, this.shutdownSignal.signal);
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

    this.notificationClosers.push(subscribeOutboundPublication(() => this.requestMaintenance("outbound_drain", () => this.drainOutbound())));
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
    for (const spaceId of [...this.typingTimers.keys()]) {
      const stop = this.stopTypingBestEffort(spaceId);
      void this.observeBackground("typing_control", () => stop);
    }
    const grace = this.config.shutdownGraceMs ?? 6_000;
    const deadline = performance.now() + grace;
    const remaining = () => Math.max(0, deadline - performance.now());
    let stopFailed = false;
    let stopError: unknown;
    const inboundSettled = await settleWithin(this.inboundTasks.values(), remaining());
    if (inboundSettled) {
      try { await withDeadline(this.flushPending(), remaining()); }
      catch (error) { stopFailed = true; stopError = error; }
    }
    const work = () => [this.outboundDrain, ...this.maintenance.values(), ...this.webhookTasks,
      ...this.typingCleanupTasks, ...this.typingStops.values(), ...this.controlTasks, ...this.providerTasks, ...this.media.tasks()];
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

    if (timing.streamReceivedAt) recordLatency("streamReceivedAt", message.id, Date.parse(timing.streamReceivedAt));
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
    await saveConversationContext(space.id, { senderId, lineId: (space as Space & { phone?: string }).phone });
    const contextSavedAt = new Date().toISOString();
    this.spaces.set(space.id, space);
    if (mediaJob) {
      void this.observeBackground("read_control", () => this.markReadBestEffort(message));
    }

    const finishInput = async (shaped: ShapedInbound, attachmentExtras?: Partial<InboundRecord>): Promise<void> => {
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
        if (this.handled.has(message.id)) return;
        await appendInbound(record);
        this.pending.push(record);
        await savePendingBatch(this.pending);
        this.handled.add(message.id);
        await addHandledId(message.id);
        recordLatency("inboundCommittedAt", message.id);
      });
      log(
        `queued inbound kind=${record.kind ?? "text"} id=${message.id} space=${space.id}`,
      );
      if (!mediaJob) void this.observeBackground("read_control", () => this.markReadBestEffort(message));
      if (!mediaJob) this.scheduleFlush();
    };
    if (!mediaJob) { await finishInput(shaped); return; }
    // The worker owns admission through durable completion. The deadline below
    // only bounds this observer; it cannot detach completion or release a slot.
    await this.media.observe(mediaJob, async () => {
      const content = unwrapInboundContent(message.content as ContentLike) as ReadableAttachmentContent;
      const result = await processInboundMedia(message.id, shaped, content, async () => {
        if (!this.app || !content.id) throw new Error("attachment_unavailable");
        const att = await imessage(this.app).getAttachment(content.id);
        if (!att) throw new Error("attachment_unavailable");
        return att.read();
      });
      await finishInput(result.shaped, result.extras);
    }, this.config.mediaTimeoutMs ?? 180_000, () => this.scheduleFlush());
  }

  private async markReadBestEffort(message: Message): Promise<void> {
    if (this.stopped) return;
    try {
      const work = this.trackControl(message.read());
      await withDeadline(work, 5_000);
      log(`marked read id=${message.id}`);
    } catch { log(`mark read unavailable id=${message.id}`); }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.stopped) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.stopped) void this.observeBackground("batch_flush", () => this.flushPending());
    });
  }

  private flushPending(): Promise<void> { return this.commit(() => this.flushPendingInner()); }

  private async flushPendingInner(): Promise<void> {
    if (this.pending.length === 0) return;
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
    for (const message of messages) recordLatency("batchPublishedAt", message.id);
    recordLatency("batchPublishedAt", batchId);
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

    // Ancillary controls run independently of durable publication and host pickup.
    const spaceIds = [...new Set(messages.map((m) => m.spaceId))];
    if (!this.stopped) for (const spaceId of spaceIds) {
      void this.observeBackground("typing_control", () => this.startTypingBestEffort(spaceId));
    }

    if (this.config.hostMode === "dot-local") await this.postWebhook(batchId);
    else this.notifyWebhook(batchId);
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

  private async startTypingBestEffort(spaceId: string): Promise<void> {
    if (this.stopped) return;
    const epoch = this.typingEpochs.get(spaceId) ?? 0;
    try {
      const work = this.trackControl((async () => {
        const space = await this.resolveSpace(spaceId);
        if (this.stopped || epoch !== (this.typingEpochs.get(spaceId) ?? 0)) return;
        await space.startTyping();
        // A response or shutdown during this call must not re-arm typing afterward.
        if (this.stopped || epoch !== (this.typingEpochs.get(spaceId) ?? 0)) {
          await this.typingStops.get(spaceId);
          await this.stopTypingBestEffort(spaceId);
          return;
        }
        const prev = this.typingTimers.get(spaceId);
        if (prev) clearTimeout(prev);
        this.typingTimers.set(
          spaceId,
          setTimeout(() => {
            void this.observeBackground("typing_control", () => this.stopTypingBestEffort(spaceId));
          }, TYPING_TIMEOUT_MS),
        );
        // iMessage typing fades; refresh until first text/reply or timeout.
        if (!this.typingHeartbeats.has(spaceId)) {
          this.typingHeartbeats.set(
            spaceId,
            setInterval(() => {
              void this.observeBackground("typing_control", async () => {
                try {
                  const refresh = this.trackControl((async () => {
                    const s = await this.resolveSpace(spaceId);
                    if (this.stopped || !this.typingTimers.has(spaceId)) return;
                    const refreshEpoch = this.typingEpochs.get(spaceId) ?? 0;
                    await s.startTyping();
                    if (this.stopped || refreshEpoch !== (this.typingEpochs.get(spaceId) ?? 0)) {
                      await this.typingStops.get(spaceId);
                      await this.stopTypingBestEffort(spaceId);
                    }
                  })());
                  await withDeadline(refresh, 5_000);
                  log(`typing heartbeat space=${spaceId}`);
                } catch (err) {
                  log(`typing heartbeat failed space=${spaceId}`);
                }
              });
            }, TYPING_HEARTBEAT_MS),
          );
        }
        log(`typing start space=${spaceId}`);
      })());
      await withDeadline(work, 5_000);
    } catch (err) {
      log(`typing start failed space=${spaceId}`);
    }
  }

  private stopTypingBestEffort(spaceId: string): Promise<TypingStopTiming> {
    this.typingEpochs.set(spaceId, (this.typingEpochs.get(spaceId) ?? 0) + 1);
    const prev = this.typingTimers.get(spaceId);
    if (prev) clearTimeout(prev);
    this.typingTimers.delete(spaceId);
    const beat = this.typingHeartbeats.get(spaceId);
    if (beat) clearInterval(beat);
    this.typingHeartbeats.delete(spaceId);
    const existing = this.typingStops.get(spaceId);
    if (existing) return existing;

    const startedAt = new Date().toISOString();
    const run = (async (): Promise<TypingStopTiming> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let outcome: TypingStopTiming["outcome"];
      try {
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), TYPING_STOP_TIMEOUT_MS);
        });
        const control = this.trackControl((async (): Promise<"completed" | "timeout"> => {
          const space = await this.resolveSpace(spaceId);
          // A late space lookup must not start a new control after the deadline.
          if (settled) return "timeout";
          await space.stopTyping();
          return "completed";
        })());
        // The SDK has no cancellation signal for this control. Timeout bounds
        // our bookkeeping; app.stop() closes the provider on runtime shutdown.
        outcome = await Promise.race([control, timeout]);
      } catch { outcome = "failed"; }
      finally { settled = true; if (timer) clearTimeout(timer); }
      log(`typing stop ${outcome} space=${spaceId}`);
      return { startedAt, settledAt: new Date().toISOString(), outcome };
    })();
    const tracked = run.finally(() => this.typingStops.delete(spaceId));
    this.typingStops.set(spaceId, tracked);
    return tracked;
  }

  /** Ancillary control cannot hold the send queue or change a persisted send outcome. */
  private stopTypingAfterSend(item: OutboundItem): void {
    const task = this.stopTypingBestEffort(item.spaceId)
      .then(timing => recordTypingCleanup(item.id, timing))
      .catch(() => log(`typing cleanup audit unavailable id=${item.id}`))
      .finally(() => this.typingCleanupTasks.delete(task));
    this.typingCleanupTasks.add(task);
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
    this.outboundRequested = true;
    if (this.outboundDrain) return this.outboundDrain;
    const run = (async () => {
      while (this.outboundRequested && !this.stopped) {
        this.outboundRequested = false;
        await this.drainOutboundInner();
      }
    })();
    this.outboundDrain = this.observeBackground("outbound_drain", () => run).finally(() => { this.outboundDrain = undefined; });
    return this.outboundDrain;
  }

  private async drainOutboundInner(): Promise<void> {
    const items = await loadOutboundQueue();
    const now = Date.now();
    const blocked = new Map<string, string>();
    for (const item of items) {
      if (this.stopped) break;
      if (item.status === "unknown" || item.status === "sending") { blocked.set(item.spaceId, item.id); continue; }
      if (item.status === "sent") { await this.repairOutboundMetadata(item); continue; }
      if (item.status !== "queued") continue;
      const blocker = blocked.get(item.spaceId);
      if (blocker) {
        if (item.blockedBy !== blocker) await updateOutbound(item.id, { blockedBy: blocker });
        continue;
      }
      if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now) { blocked.set(item.spaceId, item.id); continue; }
      this.outboundRequested = true; // Reconcile durable state after the pass, even if a watch event was missed.
      await this.sendOutbound(item);
      const current = (await loadOutboundQueue()).find(row => row.id === item.id);
      if (current?.status === "unknown" || current?.status === "queued" || current?.status === "sending") blocked.set(item.spaceId, item.id);

    }
  }

  private async sendOutbound(selected: OutboundItem): Promise<void> {
    if (this.stopped) return;
    const item = await beginOutboundAttempt(selected.id, selected.attempts);
    if (!item) return;
    const attemptId = item.attemptId!;
    const kind = outboundKind(item);
    const patch = (value: Partial<OutboundItem>) => updateOutbound(item.id, value, attemptId);
    let sdkInvoked = false;
    let invocationTimedOut = false;
    let editSession: AppCardSession | undefined;
    const lookup = <T>(work: Promise<T>) => withDeadline(work, this.config.operationTimeoutMs ?? 30_000);
    const accepted = async (result: unknown, returnedAt: string, allowSkip: boolean): Promise<void> => {
      if (allowSkip && result === undefined) return; // documented unsupported reply: fallback is safe
      const id = result && typeof result === "object" && "id" in result && typeof result.id === "string" && result.id.trim() ? result.id : undefined;
      const control = kind === "react" || kind === "typing" || (kind === "app_update" && result === undefined);
      if (!id && !control) {
        await patch({ status: "unknown", deliveryState: "unknown", providerReturnedAt: returnedAt, lastError: "send_not_confirmed", nextAttemptAt: undefined });
        return;
      }
      const session = extractAppCardSession(result) ?? editSession;
      const current = await patch({ status: "sent", deliveryState: control ? "control_requested" : "provider_accepted", sentAt: returnedAt,
        ...(kind !== "typing" ? { providerReturnedAt: returnedAt } : {}),
        ...(!control ? { providerAcceptedAt: returnedAt, messageId: id } : {}),
        ...(session ? { appSession: session } : {}),
        metadataPending: ["poll", "app", "app_update", "attachment_group"].includes(kind),
        lastError: undefined, nextAttemptAt: undefined, blockedBy: undefined });
      if (!current) return;
      if (!this.stopped && kind !== "react" && kind !== "typing") this.stopTypingAfterSend(item);
      await this.repairOutboundMetadata(current);
    };
    // This continuation owns the invocation AND durable reconciliation. Its
    // observer may time out, but shutdown tracks it through the storage commit.
    const invoke = async (call: () => Promise<unknown>, allowSkip = false): Promise<unknown> => {
      const work = Promise.resolve().then(async () => {
        if (this.stopped) throw new Error("runtime_stopping");
            sdkInvoked = true;
        const startedAt = latencyNow();
        let result: unknown;
        try { const pending = call(); recordLatency("sdkCallStartedAt", item.id, startedAt); result = await pending; }
        catch (error) {
          recordLatency("providerReturnedAt", item.id);
          await patch(isDefinitiveSendRejection(error)
            ? { status: "failed", failedAt: new Date().toISOString(), lastError: "send_rejected_validation_or_auth", nextAttemptAt: undefined }
            : { status: "unknown", deliveryState: "unknown", lastError: "send_outcome_unknown", nextAttemptAt: undefined });
          throw error;
        }
        recordLatency("providerReturnedAt", item.id);
        await accepted(result, new Date().toISOString(), allowSkip);
        return result;
      });
      this.providerTasks.add(work);
      work.then(() => this.providerTasks.delete(work), () => this.providerTasks.delete(work));
      try { return await withDeadline(work, this.config.operationTimeoutMs ?? 30_000); }
      catch (error) { if (error instanceof OperationTimeout) invocationTimedOut = true; throw error; }
    };
    try {
      const space = await lookup(this.resolveSpace(item.spaceId));
      if (this.stopped) throw new Error("runtime_stopping");
      if (item.kind === "typing") {
        if (item.state === "start") await this.startTypingBestEffort(item.spaceId);
        else await this.stopTypingBestEffort(item.spaceId);
        await accepted(undefined, new Date().toISOString(), false);
      } else if (item.kind === "react") {
        const target = await lookup(space.getMessage(item.targetMessageId));
        if (!target) throw new Error("target_message_not_found");
        await invoke(() => target.react(item.emoji));
      } else if (item.kind === "reply") {
        const delivery = await sendReplyWithFallback({
          getMessage: async id => { const target = await lookup(space.getMessage(id)); return target ? { reply: text => invoke(() => target.reply(text), true) } : undefined; },
          send: text => invoke(() => space.send(text)),
        }, item.targetMessageId, item.text);
        if (delivery.status === "unknown") await patch({ status: "unknown", deliveryState: "unknown", lastError: "send_outcome_unknown", nextAttemptAt: undefined });
        if (delivery.status === "failed") await patch({ status: "failed", failedAt: new Date().toISOString(), lastError: delivery.reason, nextAttemptAt: undefined });
      } else if (item.kind === "voice") {
        const payload = voice(item.audioPath, typeof item.durationSeconds === "number" ? { duration: item.durationSeconds } : {});
        await invoke(() => space.send(payload));
      } else if (item.kind === "poll") {
        const payload = poll(item.title, item.options); await invoke(() => space.send(payload));
      } else if (item.kind === "app" || item.kind === "app_update") {
        const payload = item.live === true ? app(item.url, { live: true }) : app(item.url);
        if (item.kind === "app") await invoke(() => space.send(payload));
        else {
          let target = await lookup(space.getMessage(item.targetMessageId));
          if (!target) throw new Error("target_message_not_found");
          target = await ensureAppCardSession(target, item.targetMessageId);
          editSession = extractAppCardSession(target);
          if (!editSession) { await patch({ status: "failed", failedAt: new Date().toISOString(), lastError: "missing_app_card_session" }); return; }
          const edited = edit(payload, target); await invoke(() => space.send(edited));
        }
      } else if (item.kind === "attachment_group") {
        const paths = item.attachmentPaths;
        if (paths.length < 2) throw new Error("attachment_group_requires_two_paths");
        const payload = group(attachment(paths[0]!), attachment(paths[1]!), ...paths.slice(2).map(p => attachment(p)));
        await invoke(() => space.send(payload));
      } else {
        let payload: Parameters<Space["send"]>[0] = item.attachmentPath ? attachment(item.attachmentPath) : item.text;
        if (item.effect) payload = effect(payload, resolveMessageEffect(item.effect) as never);
        await invoke(() => space.send(payload));
      }
    } catch (error) {
      if (sdkInvoked) {
        // The invocation owns definitive outcomes. Only an observation timeout
        // needs an interim unknown record; CAS cannot downgrade late success.
        if (invocationTimedOut) await patch({ status: "unknown", deliveryState: "unknown", lastError: "send_outcome_unknown", nextAttemptAt: undefined });
      } else await this.retryBeforeSend(item, error);
      log(`outbound failure kind=${kind} id=${item.id}`);
    } finally {
      if (invocationTimedOut) void this.stop().catch(() => {});
    }
  }

  private async retryBeforeSend(item: OutboundItem, error: unknown): Promise<void> {
    const failure = error as { name?: string; status?: number; message?: string };
    const permanent = ["ValidationError", "AuthenticationError", "AuthorizationError", "UnauthorizedError", "ForbiddenError"].includes(failure?.name ?? "") || [401, 403].includes(failure?.status ?? 0) || failure?.message === "unverified_conversation";
    const patch: Partial<OutboundItem> = permanent
      ? { status: "failed", failedAt: new Date().toISOString(), lastError: "pre_send_validation_or_auth_failed", nextAttemptAt: undefined }
      : this.stopped || failure?.message === "runtime_stopping"
      ? { status: "queued", attempts: item.attempts - 1, lastError: "lifecycle_deferred_before_send", nextAttemptAt: undefined }
      : item.attempts >= 3
      ? { status: "failed", failedAt: new Date().toISOString(), lastError: "pre_send_retry_exhausted", nextAttemptAt: undefined }
      : { status: "queued", lastError: "pre_send_retry_pending", nextAttemptAt: new Date(Date.now() + 250 * 4 ** (item.attempts - 1)).toISOString() };
    await updateOutbound(item.id, patch, item.attemptId);
  }

  /** Derived metadata is repairable from accepted evidence, never by resending. */
  private async repairOutboundMetadata(item: OutboundItem): Promise<void> {
    if (item.status !== "sent" || !["poll", "app", "app_update", "attachment_group"].includes(outboundKind(item))) return;
    try {
      if (item.kind === "poll") {
        if (!item.messageId) return;
        const stored = await loadPollMeta(item.messageId);
        if (stored && !item.metadataPending) return;
        await savePollMeta(item.messageId, item.title, item.options);
      }
      if (item.kind === "app" || item.kind === "app_update") {
        const id = item.kind === "app_update" ? item.targetMessageId : item.messageId;
        if (!id) return;
        const stored = await loadAppCardSession(id);
        if (stored && !item.metadataPending) return;
        let session = item.appSession ?? stored;
        if (!session && !this.stopped) {
          // Lookup is safe; it cannot resend the accepted app. Track the
          // underlying request through shutdown even if observation times out.
          const lookup = this.trackControl((async () => (await this.resolveSpace(item.spaceId)).getMessage(id))());
          session = extractAppCardSession(await withDeadline(lookup, this.config.operationTimeoutMs ?? 30_000));
        }
        if (!session) { if (!item.metadataPending) await updateOutbound(item.id, { metadataPending: true }, item.attemptId); return; }
        await updateOutbound(item.id, { appSession: session }, item.attemptId);
        await saveAppCardSession(id, session, { live: item.live, url: item.url });
      }
      let mapping: Partial<OutboundItem> = {};
      if (item.kind === "attachment_group" && item.messageId) {
        if (!item.metadataPending && await hasAttachmentGroupMapping(item)) return;
        const mapped = await persistAttachmentGroupMapping({ outboundId: item.id, spaceId: item.spaceId, parentMessageId: item.messageId, paths: item.attachmentPaths, batchId: item.batchId, cards: item.cards });
        mapping = { parts: mapped.parts, batchId: mapped.batchId };
      }
      await updateOutbound(item.id, { ...mapping, metadataPending: false }, item.attemptId);
    } catch { log(`outbound metadata repair pending id=${item.id}`); }
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
