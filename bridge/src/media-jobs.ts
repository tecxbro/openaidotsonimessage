/** Recover in-progress downloads/STT from original provider IDs after restart. */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './types.ts';
export type MediaJob = { messageId: string; spaceId: string; senderId: string; lineId?: string; state: 'pending' | 'done'; kind?: 'attachment' | 'voice'; lastError?: 'media_operation_timeout'; createdAt: string; streamReceivedAt?: string; recoveryEventTimestamp?: string };
const DIR = join(DATA_DIR, 'media-jobs');
export async function saveMediaJob(job: MediaJob): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const path = join(DIR, `${encodeURIComponent(job.messageId)}.json`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(job), { mode: 0o600 });
  await rename(tmp, path);
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
