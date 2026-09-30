import { pendingMediaJobs, saveMediaJob, type MediaJob } from "./media-jobs.ts";
import { queueDotWake } from "./dot-inbox.ts";
import { recoverDurableState } from "./recovery.ts";
import { hasSetupConfettiBeenSent, markSetupConfettiSent } from "./setup-confetti.ts";
import { Spectrum, app, attachment, edit, group, poll, voice, type Message, type Space } from "@spectrum-ts/core";
import { effect, imessage } from "@spectrum-ts/imessage";
import type { AttachmentGroupPart, Config, InboundRecord, OutboundItem } from "./types.ts";
import { sendReplyWithFallback } from "./reply-fallback.ts";
import {
  DEBOUNCE_MS,
  TYPING_HEARTBEAT_MS,
  TYPING_TIMEOUT_MS,
} from "./types.ts";
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
  recordTypingCleanup,
  saveConversationContext,
  loadConversationContext,
  saveAppCardSession,
  loadAppCardSession,
  type AppCardSession,
} from "./storage.ts";
import { drainCardsReady } from "./cards-ready.ts";
import {
  applyResolvedOptionToInbound,
  persistAttachmentGroupMapping,
  resolveReactionOption,
} from "./reaction-option.ts";
import {
  GREETING_DEBOUNCE_MS,
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
  private readonly spaces = new Map<string, Space>();
  private handled = new Set<string>();
  private pending: InboundRecord[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private outboundTimer: ReturnType<typeof setInterval> | null = null;
  private webhookTimer: ReturnType<typeof setInterval> | null = null;
  private cardsReadyTimer: ReturnType<typeof setInterval> | null = null;
  private sending = new Set<string>();
  private outboundDrain?: Promise<void>;
  private flushing = false;
  private app: Awaited<ReturnType<typeof Spectrum>> | undefined;
  private stopped = false;
  private stopping?: Promise<void>;
  private commits: Promise<void> = Promise.resolve();
  private inboundTasks = new Map<string, Promise<void>>();
  private webhookActive = new Set<string>();
  private typingStops = new Map<string, Promise<TypingStopTiming>>();
  private typingCleanupTasks = new Set<Promise<void>>();
  private commit<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commits.then(fn, fn);
    this.commits = run.then(() => undefined, () => undefined);
    return run;
  }
  /** Spaces where we showed typing after flush; cleared on first outbound or timeout. */
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Refresh startTyping while waiting for first text/reply. */
  private typingHeartbeats = new Map<string, ReturnType<typeof setInterval>>();

  private readonly onStop = () => { void this.stop(); };

  constructor(config: Config, private readonly connect: typeof Spectrum = Spectrum) {
    this.config = config;
  }

  async start(): Promise<void> {
    await ensureDataDir();
    this.pending = await recoverDurableState();
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
    log("hosted iMessage provider connected");
    for (const job of await pendingMediaJobs()) {
      if (this.handled.has(job.messageId)) { await saveMediaJob({ ...job, state: "done" }); continue; }
      if (job.senderId !== this.config.authorizedSenderId) continue;
      const task = this.resumeMedia(job).finally(() => this.inboundTasks.delete(job.messageId));
      this.inboundTasks.set(job.messageId, task);
    }

    this.outboundTimer = setInterval(() => {
      void this.drainOutbound();
    }, 500);
    this.webhookTimer = setInterval(() => {
      void this.drainWebhooks();
    }, 2000);
    this.cardsReadyTimer = setInterval(() => {
      void this.drainCardsReadyWatchdog();
    }, 3000);
    void this.drainOutbound();
    void this.drainWebhooks();
    void this.drainCardsReadyWatchdog();

    process.on("SIGINT", this.onStop);
    process.on("SIGTERM", this.onStop);

    for await (const [space, message] of app.messages) {
      const streamReceivedAt = new Date().toISOString();
      if (this.stopped) break;
      try {
        if (this.inboundTasks.has(message.id)) continue;
        const task = this.onMessage(space, message, { streamReceivedAt }).catch(() => log(`inbound handler failed id=${message.id}`)).finally(() => this.inboundTasks.delete(message.id));
        this.inboundTasks.set(message.id, task);
      } catch (err) {
        log("inbound handler error");
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.stopInner();
    return this.stopping;
  }

  private async stopInner(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    process.off("SIGINT", this.onStop);
    process.off("SIGTERM", this.onStop);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.outboundTimer) clearInterval(this.outboundTimer);
    if (this.webhookTimer) clearInterval(this.webhookTimer);
    if (this.cardsReadyTimer) clearInterval(this.cardsReadyTimer);
    for (const spaceId of [...this.typingTimers.keys()]) {
      void this.stopTypingBestEffort(spaceId);
    }
    await Promise.allSettled(this.inboundTasks.values());
    await this.commit(() => this.flushPending());
    // No next queued action may begin after stopped. Hold lifetime lock until
    // the current drain has settled before closing its provider connection.
    await this.outboundDrain;
    await Promise.allSettled(this.typingCleanupTasks);
    await Promise.allSettled(this.typingStops.values());
    await this.app?.stop();
    log("stopped");

  }

  private async resumeMedia(job: MediaJob): Promise<void> {
    try {
      const space = await this.resolveSpace(job.spaceId, job.lineId);
      const message = await space.getMessage(job.messageId);
      if (!message) { log(`media recovery source unavailable id=${job.messageId}`); return; }
      await this.onMessage(space, message, { streamReceivedAt: job.streamReceivedAt });
    } catch { log(`media recovery pending id=${job.messageId}`); }
  }

  private async onMessage(
    space: Space,
    message: Message,
    timing: { streamReceivedAt?: string } = { streamReceivedAt: new Date().toISOString() },
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
      state: "pending", createdAt: new Date().toISOString(), streamReceivedAt: timing.streamReceivedAt,
    } : undefined;
    await saveConversationContext(space.id, { senderId, lineId: (space as Space & { phone?: string }).phone });
    const contextSavedAt = new Date().toISOString();
    this.spaces.set(space.id, space);
    if (mediaJob) {
      await saveMediaJob(mediaJob);
      void this.markReadBestEffort(message);
    }

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
    }

    let record = toInboundRecord(
      shaped,
      {
        id: message.id,
        spaceId: space.id,
        senderId,
        timestamp: message.timestamp.toISOString(),
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
    else void this.markReadBestEffort(message);
    this.scheduleFlush();
  }

  private async markReadBestEffort(message: Message): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("read_timeout")), 5_000);
        timer.unref();
      });
      await Promise.race([message.read(), timeout]);
      log(`marked read id=${message.id}`);
    } catch { log(`mark read unavailable id=${message.id}`); }
    finally { if (timer) clearTimeout(timer); }
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const delay = isGreetingOnlyBatch(this.pending)
      ? GREETING_DEBOUNCE_MS
      : DEBOUNCE_MS;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.commit(() => this.flushPending());
    }, delay);
  }

  private async flushPending(): Promise<void> {
    if (this.flushing) return;
    if (this.pending.length === 0) return;
    this.flushing = true;
    try {
      const messages = this.pending;
      const batchId = newId("b");
      const greetingOnly = this.config.greetingFastPath === true && isGreetingOnlyBatch(messages);

      await writeUnreadBatch({
        batchId,
        flushedAt: new Date().toISOString(),
        messages,
        ...(greetingOnly ? { handledBy: "runtime-greeting" as const } : {}),
      });
      this.pending = [];
      await savePendingBatch([]);
      log(`flushed unread batchId=${batchId} count=${messages.length}`);
      if (!(await hasSetupConfettiBeenSent())) {
        for (const spaceId of new Set(messages.map(m => m.spaceId))) {
          await enqueueOutbound({ kind: "text", spaceId, text: "it’s dot here", effect: "confetti" }, "setup-confetti");
        }
        await markSetupConfettiSent();
      }

      if (greetingOnly) {
        await this.enqueueGreetingFastPath(batchId, messages);
        return;
      }

      await addWebhookPending(batchId);

      // Best-effort typing while Grok thinks.
      const spaceIds = [...new Set(messages.map((m) => m.spaceId))];
      if (!this.stopped) for (const spaceId of spaceIds) {
        void this.startTypingBestEffort(spaceId);
      }

      await this.postWebhook(batchId);
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

  private async startTypingBestEffort(spaceId: string): Promise<void> {
    if (this.stopped) return;
    try {
      const space = await this.resolveSpace(spaceId);
      await space.startTyping();
      if (this.stopped) { await this.stopTypingBestEffort(spaceId); return; }
      const prev = this.typingTimers.get(spaceId);
      if (prev) clearTimeout(prev);
      this.typingTimers.set(
        spaceId,
        setTimeout(() => {
          void this.stopTypingBestEffort(spaceId);
        }, TYPING_TIMEOUT_MS),
      );
      // iMessage typing fades; refresh until first text/reply or timeout.
      if (!this.typingHeartbeats.has(spaceId)) {
        this.typingHeartbeats.set(
          spaceId,
          setInterval(() => {
            void (async () => {
              try {
                const s = await this.resolveSpace(spaceId);
                await s.startTyping();
                log(`typing heartbeat space=${spaceId}`);
              } catch (err) {
                log(`typing heartbeat failed space=${spaceId}`);
              }
            })();
          }, TYPING_HEARTBEAT_MS),
        );
      }
      log(`typing start space=${spaceId}`);
    } catch (err) {
      log(`typing start failed space=${spaceId}`);
    }
  }

  private stopTypingBestEffort(spaceId: string): Promise<TypingStopTiming> {
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
        const control = (async (): Promise<"completed" | "timeout"> => {
          const space = await this.resolveSpace(spaceId);
          // A late space lookup must not start a new control after the deadline.
          if (settled) return "timeout";
          await space.stopTyping();
          return "completed";
        })();
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
    try {
      const n = await drainCardsReady();
      if (n > 0) {
        log(`cards-ready enqueued stacks=${n}`);
      }
    } catch (err) {
      log(`cards-ready drain error`);
    }
  }

  private drainOutbound(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.outboundDrain) return this.outboundDrain;
    const run = this.drainOutboundInner();
    this.outboundDrain = run.finally(() => { this.outboundDrain = undefined; });
    return this.outboundDrain;
  }

  private async drainOutboundInner(): Promise<void> {
    const items = await loadOutboundQueue();
    const now = Date.now();
    for (const item of items) {
      if (this.stopped) break;
      if (item.status !== "queued") continue;
      if (this.sending.has(item.id)) continue;
      if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > now) continue;
      this.sending.add(item.id);
      try {
        await this.sendOutbound(item);
      } finally {
        this.sending.delete(item.id);
      }
    }
  }

  private async sendOutbound(item: OutboundItem): Promise<void> {
    const nextAttempts = item.attempts + 1;
    const kind = outboundKind(item);
    let providerCompleted = false;
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
        lastError: undefined, nextAttemptAt: undefined,
      });
      if (kind !== "react" && kind !== "typing") this.stopTypingAfterSend(item);
    };
    try {
      const dispatchStartedAt = new Date().toISOString();
      await updateOutbound(item.id, { status: "sending", attempts: nextAttempts, dispatchStartedAt });
      const space = await this.resolveSpace(item.spaceId);

      if (kind === "typing") {
        if (item.kind !== "typing") throw new Error("typing kind mismatch");
        if (item.state === "start") {
          await this.startTypingBestEffort(item.spaceId);
        } else {
          await this.stopTypingBestEffort(item.spaceId);
        }
      } else if (kind === "react") {
        if (item.kind !== "react") throw new Error("react kind mismatch");
        const target = await space.getMessage(item.targetMessageId);
        if (!target) {
          throw new Error(`target message not found: ${item.targetMessageId}`);
        }
        // undefined = platform skipped reactions → treat as done (no retry loop)
        await target.react(item.emoji);
        // Keep typing through a tapback; stop only on text/reply.
      } else if (kind === "reply") {
        if (item.kind !== "reply") throw new Error("reply kind mismatch");
        const delivery = await sendReplyWithFallback(
          space,
          item.targetMessageId,
          item.text,
        );
        if (delivery.status === "unknown") {
          await this.scheduleRetry(item.id, nextAttempts, delivery.reason);
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
        const sent = await space.send(
          voice(item.audioPath, {
            ...(typeof item.durationSeconds === "number"
              ? { duration: item.durationSeconds }
              : {}),
          }),
        );
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.scheduleRetry(item.id, nextAttempts, "undefined-result", providerReturnedAt);
          return;
        }
        await complete(providerReturnedAt, sent.id);
        log(
          `outbound sent kind=voice id=${item.id} space=${item.spaceId} messageId=${sent.id} path=${item.audioPath}`,
        );
        return;
      } else if (kind === "poll") {
        if (item.kind !== "poll") throw new Error("poll kind mismatch");
        const sent = await space.send(poll(item.title, item.options));
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.scheduleRetry(item.id, nextAttempts, "undefined-result", providerReturnedAt);
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
        const sent = await space.send(
          live ? app(item.url, { live: true }) : app(item.url),
        );
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.scheduleRetry(item.id, nextAttempts, "undefined-result", providerReturnedAt);
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
        let target = await space.getMessage(item.targetMessageId);
        if (!target) {
          throw new Error(`target message not found: ${item.targetMessageId}`);
        }
        target = await ensureAppCardSession(target, item.targetMessageId);
        if (!extractAppCardSession(target)) {
          await updateOutbound(item.id, { status: "failed", attempts: nextAttempts, failedAt: new Date().toISOString(), lastError: "missing_app_card_session" });
          return;
        }
        const sent = await space.send(
          edit(live ? app(item.url, { live: true }) : app(item.url), target),
        );
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
        const sent = await space.send(payload);
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.scheduleRetry(item.id, nextAttempts, "undefined-result", providerReturnedAt);
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
        const sent = await space.send(payload);
        const providerReturnedAt = new Date().toISOString();
        if (sent === undefined) {
          await this.scheduleRetry(item.id, nextAttempts, "undefined-result", providerReturnedAt);
          return;
        }
        await complete(providerReturnedAt, sent.id);
      }

      // Best-effort typing may swallow a timeout/failure, so its wrapper return
      // is not evidence of a provider return. Reactions await the SDK directly.
      if (!providerCompleted) await complete(new Date().toISOString(), undefined, "control_requested", kind !== "typing");
      log(`outbound sent kind=${kind} id=${item.id} space=${item.spaceId}`);
    } catch {
      if (providerCompleted) {
        log(`outbound completion bookkeeping failed kind=${kind} id=${item.id}`);
        return;
      }
      await this.scheduleRetry(item.id, nextAttempts, "send-threw");
      log(`outbound throw kind=${kind} id=${item.id}`);
    }
  }

  private async scheduleRetry(
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
