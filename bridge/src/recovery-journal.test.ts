import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, type InboundRecord } from './types.ts';
import { recoverDurableState } from './recovery.ts';
import { appendInbound, loadHandledIds, savePendingBatch, writeUnreadBatch } from './storage.ts';
import type { RecoveryPolicy } from './recovery-policy.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
const record = (id: string, timestamp = '2026-10-02T01:00:00.000Z'): InboundRecord => ({ id, spaceId: 'space', senderId: 'owner', text: 'q', timestamp, receivedAt: timestamp });
const policy: RecoveryPolicy = { version: 1, mode: 'provider-event-cutover', eventCutoverUtc: '2026-10-02T00:00:00.000Z', suppressOnboarding: true };
test('journal-only input survives the crash before snapshot publication and deduplicates all representations', async () => {
  await appendInbound(record('snapshot')); await savePendingBatch([record('buffer')]);
  await writeUnreadBatch({ batchId: 'covered', flushedAt: record('covered').timestamp, messages: [record('covered')] });
  await writeFile(join(DATA_DIR, 'inbound.jsonl'), [record('journal'), record('journal'), record('snapshot'), record('buffer'), record('covered')].map(row => JSON.stringify(row)).join('\n') + '\n');
  expect((await recoverDurableState(policy)).map(row => row.id).sort()).toEqual(['buffer', 'journal', 'snapshot']);
  expect((await loadHandledIds()).has('journal')).toBe(true);
  expect((await recoverDurableState(policy)).map(row => row.id).sort()).toEqual(['buffer', 'journal', 'snapshot']);
});
test('journal-only input cannot bypass the recovery cutoff', async () => {
  await writeFile(join(DATA_DIR, 'inbound.jsonl'), JSON.stringify(record('old', policy.eventCutoverUtc)) + '\n');
  await expect(recoverDurableState(policy)).rejects.toThrow('recovery_state_timestamp_rejected');
  expect((await loadHandledIds()).has('old')).toBe(false);
});
