import { atomicWriteFile } from "./durable-file.ts";
/** Local host port. Files are durable work notices, not an autonomous dot wake. */
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, type UnreadBatch } from './types.ts';
import { readUnreadBatch, validateId } from './storage.ts';
import { readBatchClaim } from './batch-claim.ts';
export const DOT_INBOX_DIR = join(DATA_DIR, 'dot-inbox');
export async function queueDotWake(batchId: string): Promise<void> {
  validateId(batchId);
  if ((await readBatchClaim(batchId))?.state === "completed") return;
  await mkdir(DOT_INBOX_DIR, { recursive: true, mode: 0o700 });
  const path = join(DOT_INBOX_DIR, `${batchId}.json`);
  await atomicWriteFile(path, JSON.stringify({ batchId }));
  if ((await readBatchClaim(batchId))?.state === "completed") await unlink(path).catch(() => {});
}
export async function* iteratePendingDotBatches(shouldProceed: () => boolean = () => true, owner?: string): AsyncGenerator<UnreadBatch> {
  const names = await readdir(DOT_INBOX_DIR).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  for (const name of names.sort()) {
    if (!shouldProceed()) return;
    if (!name.endsWith('.json')) continue;
    const path = join(DOT_INBOX_DIR, name);
    let batchId: string;
    try { ({ batchId } = JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!shouldProceed()) return;
    const claim = await readBatchClaim(batchId);
    if (claim?.state === 'completed') {
      await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      continue;
    }
    if (!shouldProceed()) return;
    if (owner && claim?.state === "claimed" && claim.owner !== owner && Date.parse(claim.leaseExpiresAt) > Date.now()) continue;
    const batch = await readUnreadBatch(batchId);
    if (!shouldProceed()) return;
    yield batch;
  }
}
export async function pendingDotBatches(): Promise<UnreadBatch[]> {
  const batches: UnreadBatch[] = [];
  for await (const batch of iteratePendingDotBatches()) batches.push(batch);
  return batches;
}
