import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireFileLock } from './file-lock.ts';
import { DATA_DIR } from './types.ts';
import { writeUnreadBatch } from './storage.ts';
import { queueDotWake } from './dot-inbox.ts';
import { markBatchClaimCompleted, tryClaimBatch, tryClaimBatchNow, readBatchClaim } from './batch-claim.ts';
import { waitForDotBatch } from './dot-wait.ts';

beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
async function publish(batchId: string) {
  await writeUnreadBatch({ batchId, flushedAt: new Date().toISOString(), messages: [{ id: `${batchId}-message`, spaceId: 'space', senderId: 'owner', text: 'a real task', timestamp: new Date().toISOString(), receivedAt: new Date().toISOString() }] });
  await queueDotWake(batchId);
}

test('wait claims existing work immediately and returns its complete payload', async () => {
  await publish('existing');
  const result = await waitForDotBatch('dot-parent', { timeoutMs: 0 });
  expect(result.status).toBe('claimed');
  if (result.status === 'claimed') {
    expect(result.batch.messages[0]!.text).toBe('a real task');
    expect(result.claim.owner).toBe('dot-parent');
  }
});

test('wait notices an atomic inbox publish after it starts', async () => {
  const waiting = waitForDotBatch('dot-parent', { timeoutMs: 1000, pollMs: 1000 });
  await Bun.sleep(20); await publish('arrived');
  const result = await waiting;
  expect(result.status).toBe('claimed');
  if (result.status === 'claimed') expect(result.batch.batchId).toBe('arrived');
});

test('two waiters race safely: exactly one owner claims a batch', async () => {
  const a = waitForDotBatch('a', { timeoutMs: 150, pollMs: 20 });
  const b = waitForDotBatch('b', { timeoutMs: 150, pollMs: 20 });
  await Bun.sleep(15); await publish('race');
  const outcomes = await Promise.all([a, b]);
  expect(outcomes.filter(x => x.status === 'claimed')).toHaveLength(1);
  expect(outcomes.filter(x => x.status === 'timeout')).toHaveLength(1);
});

test('completed and other-owner batches do not block later available work', async () => {
  await publish('a-completed'); await tryClaimBatch('a-completed', 'other'); await markBatchClaimCompleted('a-completed', 'other');
  await publish('b-busy'); await tryClaimBatch('b-busy', 'other');
  await publish('c-ready');
  const result = await waitForDotBatch('dot-parent', { timeoutMs: 0 });
  expect(result.status).toBe('claimed');
  if (result.status === 'claimed') expect(result.batch.batchId).toBe('c-ready');
});

test('timeout has an explicit no-work result and leaves no timer running', async () => {
  const before = performance.now();
  const result = await waitForDotBatch('dot-parent', { timeoutMs: 35, pollMs: 20 });
  expect(result.status).toBe('timeout');
  expect(performance.now() - before).toBeLessThan(500);
});

test('cancellation returns without claiming new work', async () => {
  const controller = new AbortController();
  const waiting = waitForDotBatch('dot-parent', { timeoutMs: 1000, signal: controller.signal });
  await Bun.sleep(15); controller.abort();
  expect((await waiting).status).toBe('cancelled');
});

test('same owner resumes an existing claim instead of duplicating work', async () => {
  await publish('resume'); await tryClaimBatch('resume', 'dot-parent');
  const result = await waitForDotBatch('dot-parent', { timeoutMs: 0 });
  expect(result.status).toBe('claimed');
  if (result.status === 'claimed') expect(result.resumed).toBe(true);
});

test('invalid wait bounds and empty owners fail closed', async () => {
  await expect(waitForDotBatch('', { timeoutMs: 0 })).rejects.toThrow('owner_required');
  await expect(waitForDotBatch('owner', { timeoutMs: -1 })).rejects.toThrow('timeout_must');
  await expect(waitForDotBatch('owner', { timeoutMs: 300001 })).rejects.toThrow('timeout_must');
});

test('a busy claims lock cannot leave a late background claim after timeout', async () => {
  await publish('locked');
  const release = await acquireFileLock(join(DATA_DIR, 'batch-claims', '.claims-lock'), 0);
  try {
    const before = performance.now();
    expect((await waitForDotBatch('dot-parent', { timeoutMs: 45, pollMs: 15 })).status).toBe('timeout');
    expect(performance.now() - before).toBeLessThan(500);
  } finally { await release(); }
  const result = await waitForDotBatch('new-owner', { timeoutMs: 0 });
  expect(result.status).toBe('claimed');
  if (result.status === 'claimed') expect(result.claim.owner).toBe('new-owner');
});

test('a guard closing after lock acquisition prevents a claim mutation', async () => {
  let checks = 0;
  const attempt = await tryClaimBatchNow('cancelled-under-lock', 'dot-parent', () => ++checks === 1);
  expect(attempt).toBeNull();
  expect(await readBatchClaim('cancelled-under-lock')).toBeNull();
});
