import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchClaim } from './batch-claim.ts';
import type { OutboundItem } from './types.ts';

// Every subprocess gets its own temp data root, including when this test is run
// from a shell that has BRIDGE_DATA_DIR pointed at a running bridge.
let root: string;
const command = new URL('./dot-agent.ts', import.meta.url).pathname;
const request = { batchId: 'direct-reply', owner: 'task-owner', actionId: 'reply-1', text: 'First paragraph\n\nSecond paragraph' };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'photon-direct-reply-test-'));
  // Some Bun packages resolve process.execPath to bun.exe, even on Linux.
  // Supply the package script's "bun" command without relying on the shell PATH.
  await mkdir(join(root, 'bin'));
  await symlink(process.execPath, join(root, 'bin', 'bun'));
  await publish(['original-space']);
  expect((await run(['claim', request.batchId, request.owner])).code).toBe(0);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function publish(spaces: string[]) {
  await mkdir(join(root, 'unread'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(root, 'unread', `${request.batchId}.json`), JSON.stringify({
    batchId: request.batchId, flushedAt: now,
    messages: spaces.map((spaceId, i) => ({ id: `message-${i}`, spaceId, senderId: 'sender', text: 'question', timestamp: now, receivedAt: now })),
  }));
}
async function run(args: string[], stdin = '', packageScript = false) {
  const child = Bun.spawn([process.execPath, 'run', packageScript ? 'dot-agent' : command, ...args], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...process.env, BRIDGE_DATA_DIR: root, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}` },
    stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
const reply = (body: unknown = request) => run(['reply'], JSON.stringify(body));
async function queue(): Promise<OutboundItem[]> {
  try { return JSON.parse(await readFile(join(root, 'outbound-queue.json'), 'utf8')).items; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function claim(): Promise<BatchClaim | null> {
  try { return JSON.parse(await readFile(join(root, 'batch-claims', `${request.batchId}.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function claimAndEnqueue(text = request.text) {
  const claimed = await run(['claim', request.batchId, request.owner]);
  expect(claimed.code).toBe(0);
  const path = join(root, 'action.json');
  await writeFile(path, JSON.stringify({ actionId: request.actionId, input: { kind: 'text', spaceId: 'original-space', text } }));
  const enqueued = await run(['enqueue', request.batchId, request.owner, path]);
  expect(enqueued.code).toBe(0);
  return JSON.parse(enqueued.stdout) as OutboundItem[];
}

test('stdin reply enqueues validated text under its live claim, then completes', async () => {
  const result = await reply();
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.ok).toBe(true);
  expect(output.claim.state).toBe('completed');
  expect(output.claim.note).toBe('reply-1 accepted by queue');
  const items = await queue();
  expect(items).toHaveLength(2);
  expect(items.map(item => item.spaceId)).toEqual(['original-space', 'original-space']);
  expect(items.map(item => item.kind === 'text' ? item.text : '')).toEqual(['First paragraph', 'Second paragraph']);
  expect(items.every(item => item.requestId === `${request.batchId}:${request.actionId}` && item.requestHash && item.status === 'queued')).toBe(true);
  expect(output.outbound.map((item: OutboundItem) => item.id)).toEqual(items.map(item => item.id));
  expect((await claim())?.state).toBe('completed');
});

test.each([false, true])('package-script reply supports its optional -- separator: %s', async (separator) => {
  const result = await run(separator ? ['--', 'reply'] : ['reply'], JSON.stringify(request), true);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).ok).toBe(true);
  expect(await queue()).toHaveLength(2);
  expect((await claim())?.state).toBe('completed');
});

test('same-owner retry after durable enqueue reuses its records and completes', async () => {
  const original = await claimAndEnqueue();
  const result = await reply();
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.ok).toBe(true);
  expect(output.outbound.map((item: OutboundItem) => item.id)).toEqual(original.map(item => item.id));
  expect(await queue()).toEqual(original);
  expect((await claim())?.state).toBe('completed');
});

test('completed-batch retry returns already_completed and cannot send again', async () => {
  expect((await reply()).code).toBe(0);
  const original = await queue();
  for (const body of [request, { ...request, text: 'changed text' }, { ...request, actionId: 'different-action' }]) {
    const result = await reply(body);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, reason: 'already_completed' });
    expect(await queue()).toEqual(original);
  }
});

test('changing content for the same unfinished action rejects without completion', async () => {
  const original = await claimAndEnqueue('Original response');
  const result = await reply();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('idempotency_key_content_mismatch');
  expect(await queue()).toEqual(original);
  expect((await claim())?.state).toBe('claimed');
});

test('a different live claim owner blocks direct reply without queue or claim changes', async () => {
  const original = await claim();
  const result = await reply({ ...request, owner: 'other-owner' });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('live_claim_required');
  expect(await queue()).toEqual([]);
  expect(await claim()).toEqual(original);
});

test('outbound text validation rejects empty text and proof markers without completion', async () => {
  for (const text of ['', ' \n ', 'SPECTRUM_DONE', 'Valid paragraph\n\nSPECTRUM_ROUTED']) {
    const result = await reply({ ...request, text });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('refusing');
    expect(await queue()).toEqual([]);
    expect((await claim())?.state).toBe('claimed');
  }
});

test('enqueue storage failure leaves the claim unfinished and supports same-action retry', async () => {
  // Force the journal append to fail after the queue is already durable.
  await mkdir(join(root, 'outbound.jsonl'));
  const failed = await reply();
  expect(failed.code).not.toBe(0);
  expect((await claim())?.state).toBe('claimed');
  const accepted = await queue();
  expect(accepted).toHaveLength(2);
  await rm(join(root, 'outbound.jsonl'), { recursive: true });
  const retried = await reply();
  expect(retried.code).toBe(0);
  expect(JSON.parse(retried.stdout).ok).toBe(true);
  expect(await queue()).toEqual(accepted);
  expect((await claim())?.state).toBe('completed');
});

test('a corrupt outbound queue fails closed and leaves the claim unfinished', async () => {
  await writeFile(join(root, 'outbound-queue.json'), 'not JSON');
  const result = await reply();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('corrupt_state');
  expect((await claim())?.state).toBe('claimed');
  expect(await readFile(join(root, 'outbound-queue.json'), 'utf8')).toBe('not JSON');
});

test('ambiguous, empty, and invalid original conversations reject without changing the claim', async () => {
  const original = await claim();
  for (const spaces of [[], ['space-a', 'space-b'], [''], [' ']]) {
    await publish(spaces);
    const result = await reply();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('single_original_batch_space_required');
    expect(await queue()).toEqual([]);
    expect(await claim()).toEqual(original);
  }
});

test('multiple messages in the same conversation still permit one direct response', async () => {
  await publish(['original-space', 'original-space']);
  expect((await reply()).code).toBe(0);
  expect(await queue()).toHaveLength(2);
});

test('malformed stdin, invalid IDs, empty owner, and routing overrides reject without changing the claim', async () => {
  const original = await claim();
  const bodies: unknown[] = [null, [], 'text', {}, { ...request, owner: ' ' }, { ...request, batchId: '../escape' },
    { ...request, actionId: '../escape' }, { ...request, text: 3 }, { ...request, spaceId: 'other-space' }];
  for (const body of bodies) {
    expect((await reply(body)).code).not.toBe(0);
    expect(await queue()).toEqual([]);
    expect(await claim()).toEqual(original);
  }
  expect((await run(['reply'], '{broken JSON')).code).not.toBe(0);
  expect((await run(['reply', 'unexpected-argument'], JSON.stringify(request))).code).not.toBe(0);
  expect(await claim()).toEqual(original);
});

test('missing, expired, and invalid-expiration claims cannot enqueue or be refreshed by reply', async () => {
  const original = (await claim())!;
  const path = join(root, 'batch-claims', `${request.batchId}.json`);
  await rm(path);
  expect((await reply()).code).not.toBe(0);
  expect(await claim()).toBeNull();
  expect(await queue()).toEqual([]);
  for (const leaseExpiresAt of [new Date(Date.now() - 1000).toISOString(), 'invalid-date']) {
    const expired = { ...original, leaseExpiresAt };
    await writeFile(path, JSON.stringify(expired));
    const result = await reply();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('live_claim_required');
    expect(await claim()).toEqual(expired);
    expect(await queue()).toEqual([]);
  }
});

test('a completed claim belonging to another owner still rejects', async () => {
  expect((await reply()).code).toBe(0);
  const original = await queue();
  const completed = await claim();
  const result = await reply({ ...request, owner: 'other-owner' });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('live_claim_required');
  expect(await queue()).toEqual(original);
  expect(await claim()).toEqual(completed);
});

test('the existing action-file path still rejects cross-conversation and unverified targets', async () => {
  expect((await run(['claim', request.batchId, request.owner])).code).toBe(0);
  for (const input of [
    { kind: 'text', spaceId: 'other-space', text: 'wrong destination' },
    { kind: 'reply', spaceId: 'original-space', targetMessageId: 'unverified', text: 'wrong target' },
  ]) {
    const path = join(root, 'rejected-action.json');
    await writeFile(path, JSON.stringify({ actionId: 'guard-check', input }));
    expect((await run(['enqueue', request.batchId, request.owner, path])).code).not.toBe(0);
    expect(await queue()).toEqual([]);
    expect((await claim())?.state).toBe('claimed');
  }
});
