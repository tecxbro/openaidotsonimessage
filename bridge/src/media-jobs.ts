/** Recover in-progress downloads/STT from original provider IDs after restart. */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './types.ts';
export type MediaJob = { messageId: string; spaceId: string; senderId: string; lineId?: string; state: 'pending' | 'done'; createdAt: string; streamReceivedAt?: string; recoveryEventTimestamp?: string };
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
