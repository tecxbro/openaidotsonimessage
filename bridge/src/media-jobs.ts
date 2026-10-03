import { atomicWriteFile } from "./durable-file.ts";
/** Recover in-progress downloads/STT from original provider IDs after restart. */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './types.ts';
export type MediaJob = { messageId: string; spaceId: string; senderId: string; lineId?: string; state: 'pending' | 'done'; kind?: 'attachment' | 'voice'; phase?: 'queued' | 'running' | 'deferred'; lastError?: 'media_operation_timeout' | 'media_job_cancelled' | 'media_completion_pending'; createdAt: string; streamReceivedAt?: string; recoveryEventTimestamp?: string };
const DIR = join(DATA_DIR, 'media-jobs');
export async function saveMediaJob(job: MediaJob): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const path = join(DIR, `${encodeURIComponent(job.messageId)}.json`);
  await atomicWriteFile(path, JSON.stringify(job));
}
export async function pendingMediaJobs(): Promise<MediaJob[]> {
  const jobs: MediaJob[] = [];
  for (const name of await readdir(DIR).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const job: MediaJob = JSON.parse(await readFile(join(DIR, name), 'utf8'));
    if (job.state === 'pending') jobs.push(job);
  }
  return jobs;
}

/** Slots stay held until underlying heavy work settles, even if its observer times out. */
export class MediaJobLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly maximum = 2) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) throw new Error('invalid_media_concurrency');
  }
  async run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error('media_job_cancelled');
    let reserved = false;
    if (this.active >= this.maximum) await new Promise<void>((resolve, reject) => {
      const abort = () => { this.waiting = this.waiting.filter(item => item !== ready); reject(new Error('media_job_cancelled')); };
      const ready = () => { signal.removeEventListener('abort', abort); this.active++; reserved = true; resolve(); };
      this.waiting.push(ready); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    if (signal.aborted) { if (reserved) this.active--; this.waiting.shift()?.(); throw new Error('media_job_cancelled'); }
    if (!reserved) this.active++;
    try { return await work(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
}

/** Queued work remains valid until shutdown deliberately cancels admission.
 * Running work has its own download/subprocess bounds; an observer deadline
 * never cancels execution. Slots include durable completion and stay occupied
 * until the work really settles. */
export class MediaWorker {
  private readonly limiter: MediaJobLimiter;
  private readonly owned = new Map<string, { job: MediaJob; work: Promise<void>; writes: Promise<void> }>();
  constructor(maximum: number, private readonly shutdown: AbortSignal) { this.limiter = new MediaJobLimiter(maximum); }
  tasks(): Promise<void>[] { return [...this.owned.values()].map(entry => entry.work); }
  async observe(job: MediaJob, complete: () => Promise<void>, observerMs: number, published: () => void = () => {}): Promise<void> {
    let entry = this.owned.get(job.messageId);
    if (!entry) {
      entry = { job: { ...job, phase: 'queued' }, work: Promise.resolve(), writes: Promise.resolve() };
      const owner = entry;
      this.owned.set(job.messageId, owner);
      owner.work = (async () => {
        await this.write(owner);
        try {
          await this.limiter.run(async () => {
            owner.job.phase = 'running'; await this.write(owner);
            await complete();
            owner.job.state = 'done'; owner.job.lastError = undefined;
            await this.write(owner);
            published();
          }, this.shutdown);
        } catch (error) {
          owner.job.phase = 'deferred';
          owner.job.lastError = error instanceof Error && error.message === 'media_job_cancelled' ? 'media_job_cancelled' : 'media_completion_pending';
          await this.write(owner);
          throw error;
        }
      })().finally(() => this.owned.delete(job.messageId));
      // Observers can leave before settlement. Keep rejections observed while
      // leaving the actual task available to lifecycle teardown.
      owner.work.catch(() => {});
    }
    try { await withDeadline(entry.work, observerMs); }
    catch (error) {
      if (error instanceof OperationTimeout && entry.job.state === 'pending') {
        entry.job.lastError = 'media_operation_timeout'; await this.write(entry);
      }
      throw error;
    }
  }
  private write(entry: { job: MediaJob; writes: Promise<void> }): Promise<void> {
    const snapshot = { ...entry.job };
    const write = entry.writes.then(() => saveMediaJob(snapshot));
    entry.writes = write.catch(() => {});
    return write;
  }
}

import { OperationTimeout, withDeadline } from './operation-deadline.ts';
import { attachmentDisplayText, persistInboundAttachment, type ReadableAttachmentContent } from './inbound-attachment.ts';
import { transcribeInboundVoice, voiceDisplayText } from './voice-stt.ts';
import type { ShapedInbound } from './inbound.ts';
import type { InboundRecord } from './types.ts';

export async function processInboundMedia(messageId: string, input: ShapedInbound, content: ReadableAttachmentContent, fallbackRead: () => Promise<Buffer | Uint8Array>): Promise<{ shaped: ShapedInbound; extras?: Partial<InboundRecord> }> {
  const shaped = { ...input };
  try {
    const saved = await persistInboundAttachment(messageId, content, { fallbackRead });
    const extras: Partial<InboundRecord> = { attachmentPath: saved.path, attachmentBytes: saved.bytes, attachmentOriginalPath: saved.originalPath, attachmentOriginalMimeType: saved.originalMimeType };
    shaped.attachmentName = saved.name; shaped.attachmentMimeType = saved.mimeType;
    if (saved.attachmentId) shaped.attachmentId = saved.attachmentId;
    if (shaped.kind === 'voice') {
      const stt = await transcribeInboundVoice(saved.path);
      if (stt.text) extras.transcript = stt.text;
      shaped.text = voiceDisplayText(saved.name, saved.mimeType, saved.bytes, shaped.attachmentDuration, stt.text || undefined);
    } else shaped.text = attachmentDisplayText(saved.name, saved.mimeType, saved.bytes);
    return { shaped, extras };
  } catch {
    // Preserve the existing completed-input representation for a definitive
    // download failure; unresolved promises never enter this branch.
    shaped.text += ' [download failed: attachment_unavailable]';
    return { shaped };
  }
}
