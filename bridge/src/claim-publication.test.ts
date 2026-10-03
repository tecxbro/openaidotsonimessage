import { beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './types.ts';
import { writeExclusiveFile } from './durable-file.ts';
import { tryClaimBatch, tryClaimBatchNow } from './batch-claim.ts';
import { writeUnreadBatch } from './storage.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
async function batch(batchId: string) { await writeUnreadBatch({ batchId, flushedAt: new Date().toISOString(), messages: [{ id: batchId, spaceId: 'space', senderId: 'owner', text: 'q', timestamp: new Date().toISOString(), receivedAt: new Date().toISOString() }] }); }
test('interrupted exclusive publication never exposes partial final content', async () => {
  const path = join(DATA_DIR, 'exclusive.json');
  await expect(writeExclusiveFile(path, '{"complete":true}', () => { expect(existsSync(path)).toBe(false); throw new Error('interrupted'); })).rejects.toThrow('interrupted');
  expect(existsSync(path)).toBe(false);
  await writeExclusiveFile(path, '{"complete":true}');
  await expect(writeExclusiveFile(path, 'replacement')).rejects.toThrow('EEXIST');
  expect(await readFile(path, 'utf8')).toBe('{"complete":true}');
});
test('publication failure after reservation restores ownership and permits the next batch', async () => {
  await batch('broken'); await batch('next'); let fail = false;
  await expect(tryClaimBatchNow('broken', 'first', () => {
    if (fail) return true;
    const path = join(DATA_DIR, 'batch-claims', 'conversation-owners.json');
    if (existsSync(path) && require('node:fs').readFileSync(path, 'utf8').includes('broken')) { fail = true; throw new Error('interrupted_after_reservation'); }
    return true;
  })).rejects.toThrow('interrupted_after_reservation');
  const owners = JSON.parse(await readFile(join(DATA_DIR, 'batch-claims', 'conversation-owners.json'), 'utf8'));
  expect(Object.values(owners).flat()).toEqual([]);
  expect((await tryClaimBatch('next', 'replacement')).ok).toBe(true);
});

test('corrupt ownership is retained until durable result evidence permits reconciliation', async () => {
  const claims = await import('./batch-claim.ts');
  const reconcile = (claims as unknown as { reconcileCorruptBatchClaim(batchId: string, owner: string): Promise<{ resolved: boolean }> }).reconcileCorruptBatchClaim;
  await batch('corrupted'); await batch('later'); await tryClaimBatch('corrupted', 'first');
  const path = join(DATA_DIR, 'batch-claims', 'corrupted.json');
  await writeFile(path, '{truncated');
  const originalOwners = await readFile(join(DATA_DIR, 'batch-claims', 'conversation-owners.json'), 'utf8');
  await expect(claims.readBatchClaim('corrupted')).rejects.toThrow('corrupt_or_unreadable_batch_claim');
  await claims.reconcileConversationOwners();
  expect(await readFile(join(DATA_DIR, 'batch-claims', 'conversation-owners.json'), 'utf8')).toBe(originalOwners);
  expect((await reconcile('corrupted', 'first')).resolved).toBe(false);
  expect(await readFile(path, 'utf8')).toBe('{truncated');
  await expect(tryClaimBatch('later', 'second')).rejects.toThrow('corrupt_or_unreadable_batch_claim');
  const { enqueueOutbound } = await import('./storage.ts');
  await enqueueOutbound({ spaceId: 'space', text: 'durable answer' }, 'corrupted:answer');
  await expect(reconcile('corrupted', 'wrong-owner')).rejects.toThrow('owner_mismatch');
  expect((await reconcile('corrupted', 'first')).resolved).toBe(true);
  expect((await claims.readBatchClaim('corrupted'))?.state).toBe('completed');
  expect((await tryClaimBatch('corrupted', 'third')).ok).toBe(false);
  expect((await tryClaimBatch('later', 'second')).ok).toBe(true);
  expect(await readFile(join(DATA_DIR, 'batch-claims', 'corrupted.corrupt'), 'utf8')).toBe('{truncated');
});
