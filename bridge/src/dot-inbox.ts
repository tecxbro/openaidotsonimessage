/** Local host port. Files are durable work notices, not an autonomous dot wake. */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, type UnreadBatch } from './types.ts';
import { readUnreadBatch, validateId } from './storage.ts';
import { readBatchClaim } from './batch-claim.ts';
export const DOT_INBOX_DIR = join(DATA_DIR, 'dot-inbox');
export async function queueDotWake(batchId: string): Promise<void> {
  validateId(batchId);
  await mkdir(DOT_INBOX_DIR, { recursive: true, mode: 0o700 });
  const path = join(DOT_INBOX_DIR, `${batchId}.json`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ batchId }), { mode: 0o600 });
  await rename(tmp, path);
}
export async function pendingDotBatches(): Promise<UnreadBatch[]> {
  const names = await readdir(DOT_INBOX_DIR).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  const batches: UnreadBatch[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const { batchId } = JSON.parse(await readFile(join(DOT_INBOX_DIR, name), 'utf8'));
    if ((await readBatchClaim(batchId))?.state === 'completed') continue;
    batches.push(await readUnreadBatch(batchId));
  }
  return batches;
}
