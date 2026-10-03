import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './types.ts';
import { enqueueOutbound, loadOutboundQueue, writeUnreadBatch } from './storage.ts';
import { tryClaimBatch } from './batch-claim.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
test('actual action JSON rejects wrong types, unknown kinds, and invalid fields before preparation', async () => {
  const invalid = [
    null, [], { kind: 'made_up', spaceId: 'space', text: 'answer' },
    { kind: 'react', spaceId: 42, targetMessageId: 'm', emoji: '👍' },
    { kind: 'react', spaceId: 'space', targetMessageId: '', emoji: true },
    { kind: 'voice', spaceId: 'space', audioPath: '/tmp/audio', durationSeconds: '2' },
    { kind: 'voice', spaceId: 'space', audioPath: '/tmp/audio', durationSeconds: -1 },
    { kind: 'typing', spaceId: 'space', state: 'false' },
    { kind: 'app', spaceId: 'space', url: 'https://example.com', live: null },
    { kind: 'app', spaceId: 'space', url: 'https://example.com', live: 'false' },
    { kind: 'text', spaceId: 'space', text: 'answer', live: true },
    { kind: 'poll', spaceId: 'space', title: 'q', options: ['a', 2] },
    { kind: 'attachment_group', spaceId: 'space', attachmentPaths: ['/tmp/missing-a', '/tmp/missing-b'], cards: [{ title: 42 }, {}] },
  ];
  for (const input of invalid) await expect(enqueueOutbound(input as never)).rejects.toThrow('invalid_outbound_action');
  expect(await loadOutboundQueue()).toEqual([]);
});
test('action-file CLI validates its envelope and input before authorizing queue publication', async () => {
  await writeUnreadBatch({ batchId: 'batch', flushedAt: new Date().toISOString(), messages: [{ id: 'm', spaceId: 'space', senderId: 'owner', text: 'q', timestamp: new Date().toISOString(), receivedAt: new Date().toISOString() }] });
  await tryClaimBatch('batch', 'owner');
  for (const request of [null, { actionId: 42, input: {} }, { actionId: 'a', input: { kind: 'typing', spaceId: 'space', state: 'invalid' } }, { actionId: 'a', input: { spaceId: 'space', text: 'answer' }, extra: true }]) {
    const path = join(DATA_DIR, 'action.json'); await writeFile(path, JSON.stringify(request));
    const child = Bun.spawn([process.execPath, new URL('./dot-agent.ts', import.meta.url).pathname, 'enqueue', 'batch', 'owner', path], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0); expect(stderr).toContain('invalid_');
  }
  expect(await loadOutboundQueue()).toEqual([]);
});
