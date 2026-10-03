import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { DATA_DIR, type OutboundItem } from './types.ts';
import { GpProofRuntime } from './runtime.ts';
import { enqueueOutbound, loadOutboundQueue, updateOutbound } from './storage.ts';
import { markSetupConfettiSent } from './setup-confetti.ts';
import { pendingDotBatches } from './dot-inbox.ts';
import { pendingMediaJobs } from './media-jobs.ts';
import type { Message, Space } from '@spectrum-ts/core';

beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); await markSetupConfettiSent(); });
type Probe = {
  spaces: Map<string, Space>;
  app: { stop(): Promise<void> };
  resolveSpace(spaceId: string): Promise<Space>;
  sendOutbound(item: OutboundItem): Promise<void>;
  drainOutbound(): Promise<void>;
  onMessage(space: Space, message: Message): Promise<void>;
  flushPending(): Promise<void>;
};
function fixture(options: { operationTimeoutMs?: number; shutdownGraceMs?: number; mediaTimeoutMs?: number; mediaConcurrency?: number } = {}) {
  let calls = 0;
  const space = { id: 'space', type: 'dm', send: async () => ({ id: `sent-${++calls}` }), getMessage: async () => undefined, startTyping: async () => {}, stopTyping: async () => {} } as unknown as Space;
  const runtime = new GpProofRuntime({ projectId: 'fake', projectSecret: 'fake', authorizedSenderId: 'owner', hostMode: 'dot-local', ...options });
  const probe = runtime as unknown as Probe; probe.spaces.set('space', space);
  return { runtime, probe, space, calls: () => calls };
}
const message = (id: string, content: unknown): Message => ({ id, content, sender: { id: 'owner' }, platform: 'imessage', direction: 'inbound', timestamp: new Date() }) as unknown as Message;

test('a transient lookup retries before invocation and sends the same action once', async () => {
  const f = fixture(); let lookups = 0;
  f.probe.resolveSpace = async () => { if (++lookups === 1) throw new Error('lookup unavailable'); return f.space; };
  try {
    const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' }, 'stable-action');
    await f.probe.drainOutbound();
    let queued = (await loadOutboundQueue())[0]!;
    expect(queued.status).toBe('queued'); expect(queued.nextAttemptAt).toBeDefined(); expect(f.calls()).toBe(0);
    await updateOutbound(item!.id, { nextAttemptAt: new Date(0).toISOString() });
    await f.probe.drainOutbound();
    queued = (await loadOutboundQueue())[0]!;
    expect(queued.status).toBe('sent'); expect(queued.attempts).toBe(2); expect(f.calls()).toBe(1);
  } finally { await f.runtime.stop(); }
});

test('permanent authorization failures and exhausted pre-send retries are explicit', async () => {
  for (const permanent of [false, true]) {
    const f = fixture(); let lookups = 0;
    f.probe.resolveSpace = async () => { lookups++; throw new Error(permanent ? 'unverified_conversation' : 'lookup unavailable'); };
    try {
      const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' }, `action-${permanent}`);
      for (let i = 0; i < (permanent ? 1 : 3); i++) {
        await updateOutbound(item!.id, { nextAttemptAt: new Date(0).toISOString() });
        await f.probe.drainOutbound();
      }
      const result = (await loadOutboundQueue()).find(row => row.id === item!.id)!;
      expect(result.status).toBe('failed'); expect(f.calls()).toBe(0); expect(lookups).toBe(permanent ? 1 : 3);
    } finally { await f.runtime.stop(); }
  }
});

test('an uncertain send blocks later sends in that conversation and is never repeated', async () => {
  const f = fixture(); let calls = 0;
  (f.space as unknown as { send(): Promise<never> }).send = async () => { calls++; throw new Error('uncertain'); };
  try {
    const [first] = await enqueueOutbound({ spaceId: 'space', text: 'first' });
    const [later] = await enqueueOutbound({ spaceId: 'space', text: 'later' });
    await f.probe.drainOutbound(); await f.probe.drainOutbound();
    const queue = await loadOutboundQueue();
    expect(queue.find(row => row.id === first!.id)!.status).toBe('unknown');
    expect(queue.find(row => row.id === later!.id)!.blockedBy).toBe(first!.id);
    expect(queue.find(row => row.id === later!.id)!.status).toBe('queued'); expect(calls).toBe(1);
  } finally { await f.runtime.stop(); }
});

test('held SDK invocation times out, attempts teardown, and refuses successful shutdown while it can still act', async () => {
  const f = fixture({ operationTimeoutMs: 40, shutdownGraceMs: 30 }); let closed = 0; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  (f.space as unknown as { send(): Promise<{id: string}> }).send = async () => { await held; return { id: 'late-result' }; };
  f.probe.app = { stop: async () => { closed++; } };
  const [item] = await enqueueOutbound({ spaceId: 'space', text: 'held answer' });
  try {
    await f.probe.drainOutbound();
    await expect(f.runtime.stop()).rejects.toThrow('runtime_stop_failed');
    expect(closed).toBe(1);
    expect((await loadOutboundQueue()).find(row => row.id === item!.id)!.status).toBe('unknown');
  } finally { release(); await held; await f.runtime.stop().catch(() => {}); }
});

test('media bursts are bounded, text sees pending identities, and unresolved media stays recoverable', async () => {
  const f = fixture({ mediaConcurrency: 2 }); let active = 0, maximum = 0;
  const release: Array<() => void> = [];
  const jobs = Array.from({ length: 6 }, (_, i) => f.probe.onMessage(f.space, message(`media-${i}`, {
    type: 'attachment', name: 'sample.txt', mimeType: 'text/plain', read: async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => release.push(resolve)); active--; return Buffer.from('fixture');
    },
  })));
  try {
    for (let i = 0; i < 100 && (await pendingMediaJobs()).length < 6; i++) await Bun.sleep(2);
    expect((await pendingMediaJobs()).length).toBe(6);
    await f.probe.onMessage(f.space, message('text-after-media', { type: 'text', text: 'use those images' }));
    await f.probe.flushPending();
    const batch = (await pendingDotBatches()).find(batch => batch.messages.some(row => row.id === 'text-after-media'))!;
    expect(batch.pendingMedia).toHaveLength(6); expect(maximum).toBe(2);
    for (let i = 0; i < 100 && (await pendingMediaJobs()).length; i++) { release.splice(0).forEach(done => done()); await Bun.sleep(5); }
    await Promise.all(jobs); expect(maximum).toBe(2); expect(await pendingMediaJobs()).toEqual([]);
  } finally { release.splice(0).forEach(done => done()); await Promise.allSettled(jobs); await f.runtime.stop(); }
});

test('documented SDK auth rejection is a failure, while connection failures stay unknown', async () => {
  const f = fixture();
  (f.space as unknown as { send(): Promise<never> }).send = async () => { const error = new Error('private'); error.name = 'AuthenticationError'; throw error; };
  try {
    const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' });
    await f.probe.sendOutbound(item!);
    const result = (await loadOutboundQueue()).find(row => row.id === item!.id)!;
    expect(result.status).toBe('failed'); expect(result.lastError).toBe('send_rejected_validation_or_auth');
  } finally { await f.runtime.stop(); }
});

test('a media deadline leaves a visible pending identity and does not release its occupied slot early', async () => {
  const f = fixture({ mediaTimeoutMs: 30, mediaConcurrency: 1 }); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const processing = f.probe.onMessage(f.space, message('held-media', { type: 'attachment', name: 'a.txt', mimeType: 'text/plain', read: async () => { await held; return Buffer.from('late bytes'); } }));
  try {
    await expect(processing).rejects.toThrow('operation_timeout');
    expect((await pendingMediaJobs())[0]!.lastError).toBe('media_operation_timeout');
    await f.probe.onMessage(f.space, message('following-text', { type: 'text', text: 'about that attachment' }));
    await f.probe.flushPending();
    const batch = (await pendingDotBatches()).find(batch => batch.messages.some(row => row.id === 'following-text'))!;
    expect(batch.pendingMedia?.[0]?.messageId).toBe('held-media');
    expect(batch.pendingMedia?.[0]?.lastError).toBe('media_operation_timeout');
  } finally { release(); await held; await f.runtime.stop(); }
});
