import { beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './types.ts';
import { LATENCY_STAGES, latencyKey, recordLatency } from './latency.ts';
import { enqueueOutbound, loadOutboundQueue } from './storage.ts';
import { subscribeOutboundPublication } from './runtime-notifications.ts';

beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
test('latency records contain only stage, hashed correlation and observed timestamps', async () => {
  for (const stage of LATENCY_STAGES) recordLatency(stage, 'PRIVATE_REFERENCE_SENTINEL', 1700000000000.25);
  const raw = await readFile(join(DATA_DIR, 'latency.jsonl'), 'utf8');
  expect(raw).not.toContain('PRIVATE_');
  const rows = raw.trim().split('\n').map(line => JSON.parse(line));
  expect(rows.map(row => row.stage)).toEqual([...LATENCY_STAGES]);
  expect(rows.every(row => row.key === latencyKey('PRIVATE_REFERENCE_SENTINEL') && row.atMs === 1700000000000.25)).toBe(true);
  expect(Object.keys(rows[0]).sort()).toEqual(['at', 'atMs', 'key', 'stage']);
});
test('unavailable timing storage cannot change a successful enqueue into a failed action', async () => {
  await mkdir(join(DATA_DIR, 'latency.jsonl'));
  const close = subscribeOutboundPublication(() => { throw new Error('broken_notification'); });
  try {
    const a = await enqueueOutbound({ spaceId: 'space', text: 'answer' }, 'stable');
    const b = await enqueueOutbound({ spaceId: 'space', text: 'answer' }, 'stable');
    expect(a[0]!.id).toBe(b[0]!.id); expect(await loadOutboundQueue()).toHaveLength(1);
  } finally { close(); }
});

test('stable-key idempotency preserves the legacy raw hash for code rollback', async () => {
  const { createHash } = await import('node:crypto');
  const original = { spaceId: 'space', text: 'unchanged answer' };
  const a = await enqueueOutbound(original, 'same-action');
  const b = await enqueueOutbound({ text: original.text, spaceId: original.spaceId }, 'same-action');
  expect(b[0]!.id).toBe(a[0]!.id);
  expect(a[0]!.requestHash).toBe(createHash('sha256').update(JSON.stringify(original)).digest('hex'));
  expect(a[0]!.canonicalRequestHash).toBeDefined();
  await expect(enqueueOutbound({ text: 'different answer', spaceId: 'space' }, 'same-action')).rejects.toThrow('content_mismatch');
});
