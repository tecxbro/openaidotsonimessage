import { beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, Space } from '@spectrum-ts/core';
import { DATA_DIR, type OutboundItem } from './types.ts';
import { GpProofRuntime } from './runtime.ts';
import { enqueueOutbound, loadOutboundQueue } from './storage.ts';
import { pendingMediaJobs } from './media-jobs.ts';
import { markSetupConfettiSent } from './setup-confetti.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); await markSetupConfettiSent(); });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(5); } throw new Error('fixture_timeout'); }
type Probe = { spaces: Map<string, Space>; app: { stop(): Promise<void> }; resolveSpace(id: string): Promise<Space>; drainOutbound(): Promise<void>; onMessage(space: Space, message: Message): Promise<void> };
function fixture() {
  const runtime = new GpProofRuntime({ projectId: 'fake', projectSecret: 'fake', authorizedSenderId: 'owner', hostMode: 'dot-local', operationTimeoutMs: 40, mediaTimeoutMs: 30, mediaConcurrency: 1, shutdownGraceMs: 80 });
  let calls = 0;
  const space = { id: 'space', type: 'dm', send: async () => ({ id: `sent-${++calls}` }), startTyping: async () => {}, stopTyping: async () => {}, getMessage: async () => undefined } as unknown as Space;
  const probe = runtime as unknown as Probe; probe.spaces.set(space.id, space);
  return { runtime, probe, space, calls: () => calls };
}
function media(id: string, read: () => Promise<Buffer>): Message { return { id, platform: 'imessage', direction: 'inbound', sender: { id: 'owner' }, timestamp: new Date(), read: async () => {}, content: { type: 'attachment', name: 'fixture.txt', mimeType: 'text/plain', read } } as unknown as Message; }
async function commits(id: string) { return (await readFile(join(DATA_DIR, 'inbound.jsonl'), 'utf8').catch(() => '')).split('\n').filter(line => line && JSON.parse(line).id === id).length; }
test('late media success commits exactly once after observer timeout and duplicate intake', async () => {
  const f = fixture(), bytes = gate<Buffer>(); let reads = 0;
  const m = media('late-media', () => { reads++; return bytes.promise; });
  try {
    await expect(f.probe.onMessage(f.space, m)).rejects.toThrow('operation_timeout');
    const duplicate = f.probe.onMessage(f.space, m).catch(() => {});
    bytes.resolve(Buffer.from('late')); await duplicate;
    await until(async () => (await pendingMediaJobs()).length === 0);
    expect(await commits(m.id)).toBe(1); expect(reads).toBe(1);
  } finally { bytes.resolve(Buffer.from('late')); await f.runtime.stop(); }
});
test('queued media remains valid past its observer deadline and later commits', async () => {
  const f = fixture(), bytes = gate<Buffer>(); let secondReads = 0;
  const first = f.probe.onMessage(f.space, media('first', () => bytes.promise));
  const second = f.probe.onMessage(f.space, media('second', async () => { secondReads++; return Buffer.from('second'); }));
  try {
    await Promise.all([expect(first).rejects.toThrow('operation_timeout'), expect(second).rejects.toThrow('operation_timeout')]);
    expect(secondReads).toBe(0); expect(await pendingMediaJobs()).toHaveLength(2);
    bytes.resolve(Buffer.from('first'));
    await until(async () => (await pendingMediaJobs()).length === 0);
    expect(secondReads).toBe(1); expect(await commits('first')).toBe(1); expect(await commits('second')).toBe(1);
  } finally { bytes.resolve(Buffer.from('first')); await Promise.allSettled([first, second]); await f.runtime.stop(); }
});
test('shutdown cancels queued media admission, records running success, and leaves cancelled work recoverable', async () => {
  const f = fixture(), bytes = gate<Buffer>(); let secondReads = 0;
  const first = f.probe.onMessage(f.space, media('running', () => bytes.promise)).catch(() => {});
  const second = f.probe.onMessage(f.space, media('queued', async () => { secondReads++; return Buffer.from('queued'); })).catch(() => {});
  try {
    await until(async () => (await pendingMediaJobs()).length === 2);
    const stopping = f.runtime.stop(); bytes.resolve(Buffer.from('running'));
    await stopping; await Promise.all([first, second]);
    expect(secondReads).toBe(0); expect(await commits('running')).toBe(1); expect(await commits('queued')).toBe(0);
    expect((await pendingMediaJobs()).map(job => job.messageId)).toEqual(['queued']);
  } finally { bytes.resolve(Buffer.from('running')); await f.runtime.stop().catch(() => {}); }
});
test('send returning a message ID during deadline teardown durably accepts without another send', async () => {
  const f = fixture(), sent = gate<{ id: string }>(); let calls = 0, closed = 0;
  (f.space as unknown as { send(): Promise<{id: string}> }).send = () => { calls++; return sent.promise; };
  f.probe.app = { stop: async () => { closed++; sent.resolve({ id: 'definitive-late-success' }); } };
  const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' }, 'stable');
  await enqueueOutbound({ spaceId: 'space', text: 'following' });
  try {
    await f.probe.drainOutbound(); await f.runtime.stop();
    const rows = await loadOutboundQueue(), result = rows.find(row => row.id === item!.id)!;
    expect(calls).toBe(1); expect(closed).toBe(1); expect(result.status).toBe('sent'); expect(result.messageId).toBe('definitive-late-success'); expect(result.deliveryState).toBe('provider_accepted');
    expect(rows[1]!.status).toBe('queued');
  } finally { sent.resolve({ id: 'definitive-late-success' }); await f.runtime.stop().catch(() => {}); }
});
test('shutdown during lookup preserves the original queued action for its replacement', async () => {
  const f = fixture(), lookup = gate<Space>(); let looking = false;
  f.probe.resolveSpace = () => { looking = true; return lookup.promise; };
  const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' }, 'stable');
  const draining = f.probe.drainOutbound();
  try {
    await until(async () => looking);
    const stopping = f.runtime.stop(); lookup.resolve(f.space); await draining; await stopping;
    expect(f.calls()).toBe(0); expect((await loadOutboundQueue())[0]!.status).toBe('queued');
    const replacement = fixture();
    try { await replacement.probe.drainOutbound(); const row = (await loadOutboundQueue())[0]!; expect(row.id).toBe(item!.id); expect(row.status).toBe('sent'); expect(replacement.calls()).toBe(1); } finally { await replacement.runtime.stop(); }
  } finally { lookup.resolve(f.space); await draining; await f.runtime.stop().catch(() => {}); }
});

test('attempt CAS ignores an old continuation and timeout cannot downgrade acceptance', async () => {
  const { beginOutboundAttempt, updateOutbound } = await import('./storage.ts');
  const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' });
  const first = await beginOutboundAttempt(item!.id, 0);
  await updateOutbound(item!.id, { status: 'queued' }, first!.attemptId);
  const second = await beginOutboundAttempt(item!.id, 1);
  expect(await updateOutbound(item!.id, { status: 'sent', messageId: 'old-result' }, first!.attemptId)).toBeUndefined();
  await updateOutbound(item!.id, { status: 'sent', messageId: 'new-result', deliveryState: 'provider_accepted' }, second!.attemptId);
  await updateOutbound(item!.id, { status: 'unknown', deliveryState: 'unknown' }, second!.attemptId);
  const row = (await loadOutboundQueue())[0]!;
  expect(row.messageId).toBe('new-result'); expect(row.status).toBe('sent'); expect(row.deliveryState).toBe('provider_accepted');
});

test.each(['reply', 'poll', 'app', 'attachment_group'] as const)('late %s acceptance repairs rich metadata during shutdown without repeating the SDK', async kind => {
  const f = fixture(), sent = gate<{ id: string; miniAppCardSession?: object }>(); let calls = 0;
  const session = { chatGuid: 'chat', messageGuid: 'message', sessionId: 'session', targetMessageGuid: 'target' };
  const invoke = () => { calls++; return sent.promise; };
  (f.space as unknown as { send(): Promise<unknown>; getMessage(): Promise<unknown> }).send = invoke;
  (f.space as unknown as { getMessage(): Promise<unknown> }).getMessage = async () => ({ reply: invoke });
  f.probe.app = { stop: async () => { sent.resolve({ id: `late-${kind}`, ...(kind === 'app' ? { miniAppCardSession: session } : {}) }); } };
  const { writeFile } = await import('node:fs/promises');
  const paths = [join(DATA_DIR, 'a.jpg'), join(DATA_DIR, 'b.jpg')];
  for (const path of paths) await writeFile(path, 'fixture');
  const input = kind === 'reply' ? { kind, spaceId: 'space', targetMessageId: 'target', text: 'answer' }
    : kind === 'poll' ? { kind, spaceId: 'space', title: 'Choose', options: ['A', 'B'] }
    : kind === 'app' ? { kind, spaceId: 'space', url: 'https://example.com', live: true }
    : { kind, spaceId: 'space', attachmentPaths: paths, cards: [{ title: 'A' }, { title: 'B' }], batchId: 'cards' };
  const [item] = await enqueueOutbound(input);
  try {
    await f.probe.drainOutbound(); await f.runtime.stop();
    const row = (await loadOutboundQueue()).find(row => row.id === item!.id)!;
    expect(row.status).toBe('sent'); expect(row.messageId).toBe(`late-${kind}`); expect(calls).toBe(1);
    if (kind === 'poll') { const { loadPollMeta } = await import('./storage.ts'); expect((await loadPollMeta('late-poll'))?.title).toBe('Choose'); }
    if (kind === 'app') { const { loadAppCardSession } = await import('./storage.ts'); expect(await loadAppCardSession('late-app')).toEqual(session); }
    if (row.kind === 'attachment_group') expect(row.parts?.map(part => part.title)).toEqual(['A', 'B']);
  } finally { sent.resolve({ id: `late-${kind}` }); await f.runtime.stop().catch(() => {}); }
});
