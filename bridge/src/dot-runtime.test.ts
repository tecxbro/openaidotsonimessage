import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, type InboundRecord, type OutboundItem } from './types.ts';
import { acquireFileLock } from './file-lock.ts';
import { enqueueOutbound, loadOutboundQueue, appendInbound, savePendingBatch, writeUnreadBatch, updateOutbound, recordReadReceipt } from './storage.ts';
import { pendingDotBatches, queueDotWake } from './dot-inbox.ts';
import { tryClaimBatch, markBatchClaimCompleted, withLiveBatchClaim, assertLiveBatchClaim } from './batch-claim.ts';
import { recoverDurableState } from './recovery.ts';
import { GpProofRuntime } from './runtime.ts';
import { markSetupConfettiSent, SETUP_CONFETTI_MARKER_PATH } from './setup-confetti.ts';
import { pendingMediaJobs } from './media-jobs.ts';
import type { Message, Space, Spectrum } from '@spectrum-ts/core';

beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); await markSetupConfettiSent(); });
const record = (id: string): InboundRecord => ({ id, spaceId: 'space', senderId: 'owner', text: 'question', timestamp: new Date().toISOString(), receivedAt: new Date().toISOString() });
const config = { projectId: 'test-only', projectSecret: 'test-only', authorizedSenderId: 'owner', hostMode: 'dot-local' as const, greetingFastPath: false };
type Probe = { onMessage(s: Space, m: Message, timing?: { streamReceivedAt?: string }): Promise<void>; flushPending(): Promise<void>; sendOutbound(item: OutboundItem): Promise<void> };
function fixture() {
  let sent = 0; let read = 0;
  const space = { id: 'space', type: 'dm', phone: 'line', send: async () => ({ id: `sent-${++sent}` }), startTyping: async () => {}, stopTyping: async () => {}, getMessage: async () => undefined } as unknown as Space;
  const message = (id: string, content: unknown = { type: 'text', text: 'please do the actual task' }): Message => ({ id, content, platform: 'imessage', direction: 'inbound', sender: { id: 'owner' }, timestamp: new Date(), read: async () => { read++; } }) as unknown as Message;
  const runtime = new GpProofRuntime(config);
  return { runtime, probe: runtime as unknown as Probe, space, message, readCount: () => read, sendCount: () => sent };
}

describe('dot host durability', () => {
  test('a second runtime lock is rejected and release permits restart', async () => {
    const path = join(DATA_DIR, 'lock'); const release = await acquireFileLock(path, 0);
    await expect(acquireFileLock(path, 0)).rejects.toThrow('lock_busy');
    await release(); await (await acquireFileLock(path, 0))();
  });
  test('kernel lock is released on killed owner and simultaneous contenders cannot steal it', async () => {
    const path = join(DATA_DIR, 'crash-lock');
    const source = new URL('./file-lock.ts', import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, '-e', `import { acquireFileLock } from ${JSON.stringify(source)}; await acquireFileLock(${JSON.stringify(path)},0); console.log('locked'); process.stdin.resume();`], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
    child.kill(9); await child.exited;
    const recovered = await acquireFileLock(path, 2_000); await recovered();
    const attempts = await Promise.allSettled([acquireFileLock(path, 0), acquireFileLock(path, 0)]);
    expect(attempts.filter(x => x.status === 'fulfilled').length).toBe(1);
    for (const result of attempts) if (result.status === 'fulfilled') await result.value();
  });
  test('a claim expiring during preparation cannot authorize a later queue commit', async () => {
    await tryClaimBatch('expiring', 'owner', 5);
    await expect(withLiveBatchClaim('expiring', 'owner', async () => {
      await Bun.sleep(12);
      return enqueueOutbound({ spaceId: 's', text: 'too late' }, 'late', () => assertLiveBatchClaim('expiring', 'owner'));
    })).rejects.toThrow('live_claim_required');
    expect(await loadOutboundQueue()).toEqual([]);
  });
  test('concurrent process enqueue preserves every action', async () => {
    const source = new URL('./storage.ts', import.meta.url).pathname;
    const workers = Array.from({ length: 10 }, (_, i) => Bun.spawn([process.execPath, '-e', `import { enqueueOutbound } from ${JSON.stringify(source)}; await enqueueOutbound({spaceId:'s',text:'${i}'},'action-${i}');`], { env: process.env, stdout: 'pipe', stderr: 'pipe' }));
    expect(await Promise.all(workers.map(p => p.exited))).toEqual(Array(10).fill(0));
    expect((await loadOutboundQueue()).length).toBe(10);
  });
  test('idempotent action retries never duplicate; content changes fail closed', async () => {
    const a = await enqueueOutbound({ spaceId: 's', text: 'hello' }, 'same');
    const b = await enqueueOutbound({ spaceId: 's', text: 'hello' }, 'same');
    expect(a[0]!.id).toBe(b[0]!.id);
    await expect(enqueueOutbound({ spaceId: 's', text: 'changed' }, 'same')).rejects.toThrow('content_mismatch');
  });
  test('recovery restores journal-only input and removes already-flushed pending', async () => {
    await appendInbound(record('a')); await appendInbound(record('b'));
    await savePendingBatch([record('a')]);
    await writeUnreadBatch({ batchId: 'done-batch', flushedAt: new Date().toISOString(), messages: [record('a')] });
    expect((await recoverDurableState()).map(m => m.id)).toEqual(['b']);
  });
  test('a restart quarantines sends that might have reached the provider', async () => {
    const [item] = await enqueueOutbound({ spaceId: 's', text: 'hello' });
    await updateOutbound(item!.id, { status: 'sending' }); await recoverDurableState();
    expect((await loadOutboundQueue())[0]!.status).toBe('unknown');
  });
  test('an early receipt is reconciled after send completion and cannot be downgraded', async () => {
    const [item] = await enqueueOutbound({ spaceId: 's', text: 'hello' });
    await recordReadReceipt('s', 'early', 'receipt-first');
    await updateOutbound(item!.id, { messageId: 'early', status: 'sent', deliveryState: 'provider_accepted' });
    await updateOutbound(item!.id, { deliveryState: 'provider_accepted' });
    expect((await loadOutboundQueue())[0]!.deliveryState).toBe('read');
  });
  test('durable notice survives until explicitly claimed and completed', async () => {
    await writeUnreadBatch({ batchId: 'work', flushedAt: new Date().toISOString(), messages: [record('m')] });
    await queueDotWake('work'); expect((await pendingDotBatches()).length).toBe(1);
    expect((await tryClaimBatch('work', 'dot-reader')).ok).toBe(true);
    expect((await tryClaimBatch('work', 'other')).ok).toBe(false);
    await markBatchClaimCompleted('work', 'dot-reader', 'no reply needed');
    expect(await pendingDotBatches()).toEqual([]);
  });
  test('actual receipt only marks its exact accepted outbound', async () => {
    const [a] = await enqueueOutbound({ spaceId: 's', text: 'one' });
    const [b] = await enqueueOutbound({ spaceId: 's', text: 'two' });
    await updateOutbound(a!.id, { status: 'sent', messageId: 'provider-a', deliveryState: 'provider_accepted' });
    await updateOutbound(b!.id, { status: 'sent', messageId: 'provider-b', deliveryState: 'provider_accepted' });
    await recordReadReceipt('s', 'provider-a', 'receipt');
    expect((await loadOutboundQueue()).map(x => x.deliveryState)).toEqual(['read', 'provider_accepted']);
  });
});

describe('existing runtime through dot host', () => {
  test('runtime startup and graceful stop use exactly one injected provider connection', async () => {
    let finish!: (value: IteratorResult<[Space, Message]>) => void;
    let calls = 0; let stopped = 0;
    const messages: AsyncIterable<[Space, Message]> = { [Symbol.asyncIterator]() { return { next: () => new Promise(resolve => { finish = resolve; }) }; } };
    const connect = (async () => { calls++; return { messages, stop: async () => { stopped++; finish({ done: true, value: undefined }); } }; }) as unknown as typeof Spectrum;
    const runtime = new GpProofRuntime(config, connect);
    const running = runtime.start();
    for (let i = 0; i < 30 && !finish; i++) await Bun.sleep(5);
    // Settle the initial filesystem-only maintenance passes before removing the
    // fixture directory in the next test. This is not a production restart.
    const maintenance = runtime as unknown as { drainWebhooks(): Promise<void>; drainCardsReadyWatchdog(): Promise<void>; drainOutbound(): Promise<void> };
    await Promise.all([maintenance.drainWebhooks(), maintenance.drainCardsReadyWatchdog(), maintenance.drainOutbound()]);
    await runtime.stop(); await running; await runtime.stop();
    expect(calls).toBe(1); expect(stopped).toBe(1);
  });
  test('marks read, preserves question, queues once-only confetti and durable wake', async () => {
    const f = fixture();
    await rm(SETUP_CONFETTI_MARKER_PATH, { force: true });
    try {
      await f.probe.onMessage(f.space, f.message('first')); await f.probe.flushPending();
      expect(f.readCount()).toBe(1);
      expect((await pendingDotBatches())[0]!.messages[0]!.text).toBe('please do the actual task');
      expect((await loadOutboundQueue()).filter(x => x.kind === 'text' && x.effect === 'confetti').length).toBe(1);
      await f.probe.onMessage(f.space, f.message('second', { type: 'text', text: 'okay' })); await f.probe.flushPending();
      expect((await pendingDotBatches()).length).toBe(2);
      expect((await loadOutboundQueue()).length).toBe(1);
    } finally { await f.runtime.stop(); }
  });
  test('stream entry precedes blocked context storage and preserves the provider timestamp', async () => {
    const f = fixture();
    const release = await acquireFileLock(join(DATA_DIR, '.storage-lock'));
    const message = f.message('timed-source');
    const providerTimestamp = message.timestamp.toISOString();
    const started = Date.now();
    const inbound = f.probe.onMessage(f.space, message);
    await Bun.sleep(40);
    const releasing = Date.now();
    await release();
    try {
      await inbound; await f.probe.flushPending();
      const record = (await pendingDotBatches())[0]!.messages[0]!;
      expect(record.timestamp).toBe(providerTimestamp);
      expect(Date.parse(record.streamReceivedAt!)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(record.streamReceivedAt!)).toBeLessThan(releasing);
      expect(Date.parse(record.contextSavedAt!)).toBeGreaterThanOrEqual(releasing);
      expect(Date.parse(record.receivedAt)).toBeGreaterThanOrEqual(Date.parse(record.contextSavedAt!));
    } finally { await f.runtime.stop(); }
  });
  test('media records retain their original stream timestamp and old recovery does not invent one', async () => {
    const f = fixture();
    const original = '2020-01-01T00:00:00.000Z';
    const content = { type: 'attachment', name: 'sample.txt', mimeType: 'text/plain', read: async () => Buffer.from('fixture') };
    try {
      await f.probe.onMessage(f.space, f.message('timed-media', content), { streamReceivedAt: original });
      await f.probe.onMessage(f.space, f.message('old-media', content), { streamReceivedAt: undefined });
      await f.probe.flushPending();
      const records = (await pendingDotBatches()).flatMap(batch => batch.messages);
      expect(records.find(r => r.id === 'timed-media')!.streamReceivedAt).toBe(original);
      expect(records.find(r => r.id === 'old-media')!.streamReceivedAt).toBeUndefined();
      const job = JSON.parse(await readFile(join(DATA_DIR, 'media-jobs', 'timed-media.json'), 'utf8'));
      expect(job.streamReceivedAt).toBe(original);
    } finally { await f.runtime.stop(); }
  });
  test('accepted sends and early receipts persist before slow typing cleanup; the next send progresses', async () => {
    const f = fixture(); let calls = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (f.space as unknown as { stopTyping: () => Promise<void> }).stopTyping = () => gate;
    (f.space as unknown as { send: () => Promise<{ id: string }> }).send = async () => {
      const id = `timed-${++calls}`;
      if (calls === 1) await recordReadReceipt('space', id, 'early-timed-receipt');
      return { id };
    };
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      const [first] = await enqueueOutbound({ spaceId: 'space', text: 'first answer' });
      const [second] = await enqueueOutbound({ spaceId: 'space', text: 'second answer' });
      const started = Date.now();
      await (f.runtime as unknown as { drainOutbound(): Promise<void> }).drainOutbound();
      expect(Date.now() - started).toBeLessThan(1500);
      expect(calls).toBe(2);
      const items = (await loadOutboundQueue()).filter(i => [first!.id, second!.id].includes(i.id));
      expect(items.map(i => i.status)).toEqual(['sent', 'sent']);
      expect(items[0]!.deliveryState).toBe('read');
      expect(items[1]!.deliveryState).toBe('provider_accepted');
      for (const item of items) {
        expect(item.sentAt).toBe(item.providerReturnedAt);
        expect(item.providerAcceptedAt).toBe(item.providerReturnedAt);
        expect(Date.parse(item.providerAcceptedAt!)).toBeGreaterThanOrEqual(Date.parse(item.dispatchStartedAt!));
      }
      await Bun.sleep(20);
      const releasedAt = Date.now(); release();
      await f.runtime.stop();
      const audit = (await readFile(join(DATA_DIR, 'outbound.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
      const timings = audit.filter(row => row.event === 'typing_cleanup' && [first!.id, second!.id].includes(row.id));
      expect(timings).toHaveLength(2);
      for (const timing of timings) {
        const item = items.find(i => i.id === timing.id)!;
        expect(timing.outcome).toBe('completed');
        expect(Date.parse(timing.settledAt)).toBeGreaterThanOrEqual(releasedAt);
        expect(Date.parse(item.providerAcceptedAt!)).toBeLessThan(Date.parse(timing.settledAt));
        expect(timing).not.toHaveProperty('item'); expect(timing).not.toHaveProperty('text');
      }
      await recoverDurableState();
      expect((await loadOutboundQueue()).find(i => i.id === first!.id)!.deliveryState).toBe('read');
      expect(calls).toBe(2);
    } finally { release(); await f.runtime.stop(); }
  });
  test('never-resolving typing cleanup times out without holding sends or reclassifying acceptance', async () => {
    const f = fixture();
    let release!: () => void;
    const control = new Promise<void>(resolve => { release = resolve; });
    (f.space as unknown as { stopTyping: () => Promise<void> }).stopTyping = () => control;
    (f.runtime as unknown as { app: { stop(): Promise<void> } }).app = { stop: async () => { release(); } };
    await f.probe.onMessage(f.space, f.message('source'));
    const [first] = await enqueueOutbound({ spaceId: 'space', text: 'first answer' });
    const [second] = await enqueueOutbound({ spaceId: 'space', text: 'second answer' });
    const started = Date.now();
    await (f.runtime as unknown as { drainOutbound(): Promise<void> }).drainOutbound();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(f.sendCount()).toBe(2);
    await f.runtime.stop();
    expect(Date.now() - started).toBeLessThan(7500);
    const items = (await loadOutboundQueue()).filter(i => [first!.id, second!.id].includes(i.id));
    expect(items.map(i => i.deliveryState)).toEqual(['provider_accepted', 'provider_accepted']);
    expect(items.map(i => i.attempts)).toEqual([1, 1]);
    const timings = (await readFile(join(DATA_DIR, 'outbound.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row)).filter(row => row.event === 'typing_cleanup');
    expect(timings.map(row => row.outcome)).toEqual(['timeout', 'timeout']);
  }, 10_000);
  test('rejected typing cleanup cannot leak provider errors or change an accepted result', async () => {
    const f = fixture();
    (f.space as unknown as { stopTyping: () => Promise<void> }).stopTyping = async () => { throw new Error('CREDENTIAL_SENTINEL_typing'); };
    await f.probe.onMessage(f.space, f.message('source'));
    const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' });
    await f.probe.sendOutbound(item!); await f.runtime.stop();
    const sent = (await loadOutboundQueue()).find(i => i.id === item!.id)!;
    expect(sent.status).toBe('sent'); expect(sent.messageId).toBe('sent-1');
    expect(sent.deliveryState).toBe('provider_accepted'); expect(sent.lastError).toBeUndefined();
    const audit = await readFile(join(DATA_DIR, 'outbound.jsonl'), 'utf8');
    expect(audit).not.toContain('CREDENTIAL_SENTINEL'); expect(audit).toContain('"outcome":"failed"');
  });
  test('undefined sends and rejected sends never gain acceptance timestamps', async () => {
    for (const mode of ['undefined', 'throw'] as const) {
      const f = fixture(); let calls = 0;
      (f.space as unknown as { send: () => Promise<undefined> }).send = async () => { calls++; if (mode === 'throw') throw new Error('private transport detail'); return undefined; };
      try {
        await f.probe.onMessage(f.space, f.message(`source-${mode}`));
        const [item] = await enqueueOutbound({ spaceId: 'space', text: `answer-${mode}` });
        await f.probe.sendOutbound(item!);
        const sent = (await loadOutboundQueue()).find(i => i.id === item!.id)!;
        expect(sent.status).toBe('unknown'); expect(sent.providerAcceptedAt).toBeUndefined();
        expect(sent.sentAt).toBeUndefined(); expect(sent.messageId).toBeUndefined();
        expect(Boolean(sent.providerReturnedAt)).toBe(mode === 'undefined'); expect(calls).toBe(1);
      } finally { await f.runtime.stop(); }
    }
  });
  test('reply and rich sends use the same accepted-before-cleanup timestamp contract', async () => {
    const f = fixture(); let calls = 0;
    (f.space as unknown as { stopTyping: () => Promise<void> }).stopTyping = async () => { throw new Error('cleanup unavailable'); };
    (f.space as unknown as { getMessage: () => Promise<unknown> }).getMessage = async () => ({ reply: async () => ({ id: `reply-${++calls}` }) });
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      const inputs = [
        { kind: 'reply' as const, spaceId: 'space', targetMessageId: 'source', text: 'answer' },
        { kind: 'voice' as const, spaceId: 'space', audioPath: '/tmp/gpproof-1x1.png' },
        { kind: 'poll' as const, spaceId: 'space', title: 'Choose', options: ['One', 'Two'] },
        { kind: 'app' as const, spaceId: 'space', url: 'https://example.com/app' },
        { kind: 'attachment_group' as const, spaceId: 'space', attachmentPaths: ['/tmp/gpproof-1x1.png', '/tmp/gpproof-1x1.png'] },
      ];
      const ids: string[] = [];
      for (const input of inputs) {
        const [item] = await enqueueOutbound(input); ids.push(item!.id);
        await f.probe.sendOutbound(item!);
      }
      await f.runtime.stop();
      const sent = (await loadOutboundQueue()).filter(i => ids.includes(i.id));
      expect(sent).toHaveLength(inputs.length);
      for (const item of sent) {
        expect(item.status).toBe('sent'); expect(item.deliveryState).toBe('provider_accepted');
        expect(item.messageId).toBeDefined(); expect(item.providerAcceptedAt).toBeDefined();
        expect(item.providerReturnedAt).toBe(item.providerAcceptedAt); expect(item.sentAt).toBe(item.providerAcceptedAt);
        expect(item.attempts).toBe(1);
      }
    } finally { await f.runtime.stop(); }
  });
  test('a swallowed typing failure is only a requested control, without a fabricated SDK return', async () => {
    const f = fixture();
    (f.space as unknown as { stopTyping: () => Promise<void> }).stopTyping = async () => { throw new Error('private control error'); };
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      const [item] = await enqueueOutbound({ kind: 'typing', spaceId: 'space', state: 'stop' });
      await f.probe.sendOutbound(item!);
      const sent = (await loadOutboundQueue()).find(i => i.id === item!.id)!;
      expect(sent.deliveryState).toBe('control_requested'); expect(sent.status).toBe('sent');
      expect(sent.providerReturnedAt).toBeUndefined(); expect(sent.providerAcceptedAt).toBeUndefined();
    } finally { await f.runtime.stop(); }
  });
  test('unsupported app edits and missing sessions never fabricate provider acceptance', async () => {
    const f = fixture();
    (f.space as unknown as { send: () => Promise<undefined> }).send = async () => undefined;
    (f.space as unknown as { getMessage: () => Promise<unknown> }).getMessage = async () => ({
      miniAppCardSession: { chatGuid: 'chat', messageGuid: 'message', sessionId: 'session', targetMessageGuid: 'target' },
    });
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      const [item] = await enqueueOutbound({ kind: 'app_update', spaceId: 'space', targetMessageId: 'target', url: 'https://example.com/app' });
      await f.probe.sendOutbound(item!);
      const sent = (await loadOutboundQueue()).find(i => i.id === item!.id)!;
      expect(sent.deliveryState).toBe('control_requested'); expect(sent.providerReturnedAt).toBeDefined();
      expect(sent.providerAcceptedAt).toBeUndefined();
      (f.space as unknown as { getMessage: () => Promise<unknown> }).getMessage = async () => ({});
      const [missing] = await enqueueOutbound({ kind: 'app_update', spaceId: 'space', targetMessageId: 'missing', url: 'https://example.com/app' });
      await f.probe.sendOutbound(missing!);
      const failed = (await loadOutboundQueue()).find(i => i.id === missing!.id)!;
      expect(failed.status).toBe('failed'); expect(failed.providerAcceptedAt).toBeUndefined(); expect(failed.providerReturnedAt).toBeUndefined();
    } finally { await f.runtime.stop(); }
  });
  test('outbound send acceptance records provider id without claiming delivery', async () => {
    const f = fixture();
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' });
      await f.probe.sendOutbound(item!);
      const sent = (await loadOutboundQueue()).find(x => x.id === item!.id)!;
      expect(sent.status).toBe('sent'); expect(sent.messageId).toBe('sent-1'); expect(sent.deliveryState).toBe('provider_accepted');
    } finally { await f.runtime.stop(); }
  });
  test('blocked media download does not block later text and creates recovery job', async () => {
    const f = fixture(); let release!: (b: Buffer) => void;
    const bytes = new Promise<Buffer>(resolve => { release = resolve; });
    const media = f.probe.onMessage(f.space, f.message('image', { type: 'attachment', name: 'file.txt', mimeType: 'text/plain', read: () => bytes }));
    try {
      for (let i = 0; i < 20 && !(await pendingMediaJobs()).length; i++) await Bun.sleep(5);
      expect((await pendingMediaJobs()).length).toBe(1);
      await f.probe.onMessage(f.space, f.message('later')); await f.probe.flushPending();
      expect((await pendingDotBatches())[0]!.messages[0]!.id).toBe('later');
      release(Buffer.from('attachment body')); await media;
      expect(await pendingMediaJobs()).toEqual([]);
    } finally { release(Buffer.from('attachment body')); await media; await f.runtime.stop(); }
  });
  test('send throws are quarantined rather than repeated', async () => {
    const f = fixture(); let calls = 0;
    (f.space as unknown as { send: () => Promise<never> }).send = async () => { calls++; throw new Error('uncertain transport'); };
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      const [item] = await enqueueOutbound({ spaceId: 'space', text: 'answer' });
      await f.probe.sendOutbound(item!);
      expect((await loadOutboundQueue()).find(x => x.id === item!.id)!.status).toBe('unknown');
      expect(calls).toBe(1);
    } finally { await f.runtime.stop(); }
  });
  test('overlapping drain loops do not resend a later item from an old snapshot', async () => {
    const f = fixture(); let calls = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (f.space as unknown as { send: () => Promise<{ id: string }> }).send = async () => { calls++; if (calls === 1) await gate; return { id: `transport-${calls}` }; };
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      await enqueueOutbound({ spaceId: 'space', text: 'first' });
      await enqueueOutbound({ spaceId: 'space', text: 'second' });
      const probe = f.runtime as unknown as { drainOutbound(): Promise<void> };
      const first = probe.drainOutbound(); await Bun.sleep(10); const second = probe.drainOutbound(); release(); await Promise.all([first, second]);
      expect(calls).toBe(2);
    } finally { release(); await f.runtime.stop(); }
  });
  test('shutdown waits for current send and prevents later snapshot sends', async () => {
    const f = fixture(); let calls = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (f.space as unknown as { send: () => Promise<{ id: string }> }).send = async () => { calls++; await gate; return { id: 'sent-before-stop' }; };
    await f.probe.onMessage(f.space, f.message('source'));
    await enqueueOutbound({ spaceId: 'space', text: 'first' });
    const [second] = await enqueueOutbound({ spaceId: 'space', text: 'second' });
    const draining = (f.runtime as unknown as { drainOutbound(): Promise<void> }).drainOutbound();
    for (let i = 0; i < 100 && calls === 0; i++) await Bun.sleep(2);
    let stopped = false; const stop = f.runtime.stop().then(() => { stopped = true; });
    await Bun.sleep(20); expect(stopped).toBe(false);
    release(); await Promise.all([draining, stop]);
    expect(calls).toBe(1);
    expect((await loadOutboundQueue()).find(x => x.id === second!.id)!.status).toBe('queued');
  });
  test('a held read control does not delay durable text and settles through provider teardown', async () => {
    const f = fixture(); const message = f.message('hung-read');
    let release!: () => void;
    const control = new Promise<void>(resolve => { release = resolve; });
    (message as unknown as { read: () => Promise<void> }).read = () => control;
    (f.runtime as unknown as { app: { stop(): Promise<void> } }).app = { stop: async () => { release(); } };
    // Use a short shutdown grace to exercise teardown without a real provider.
    (f.runtime as unknown as { config: { shutdownGraceMs: number } }).config.shutdownGraceMs = 30;
    await f.probe.onMessage(f.space, message); await f.probe.flushPending();
    expect((await pendingDotBatches())[0]!.messages[0]!.id).toBe('hung-read');
    const start = Date.now(); await f.runtime.stop(); expect(Date.now() - start).toBeLessThan(1000);
  });
  test('authorized work starts typing, tapbacks preserve it, and a response stops it', async () => {
    const f = fixture(); let starts = 0; let stops = 0;
    (f.space as unknown as { startTyping(): Promise<void> }).startTyping = async () => { starts++; };
    (f.space as unknown as { stopTyping(): Promise<void> }).stopTyping = async () => { stops++; };
    (f.space as unknown as { getMessage(): Promise<{ react(): Promise<undefined> }> }).getMessage = async () => ({ react: async () => undefined });
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      await f.probe.flushPending();
      for (let i = 0; i < 100 && starts === 0; i++) await Bun.sleep(2);
      expect(starts).toBeGreaterThan(0); expect(f.readCount()).toBe(1);
      const [reaction] = await enqueueOutbound({ kind: 'react', spaceId: 'space', targetMessageId: 'source', emoji: '❤️' });
      await f.probe.sendOutbound(reaction!); expect(stops).toBe(0);
      const [answer] = await enqueueOutbound({ spaceId: 'space', text: 'substantive answer' });
      await f.probe.sendOutbound(answer!); await f.runtime.stop();
      expect(stops).toBeGreaterThan(0); expect(f.sendCount()).toBe(1);
      expect((f.runtime as unknown as { typingHeartbeats: Map<string, unknown> }).typingHeartbeats.size).toBe(0);
    } finally { await f.runtime.stop(); }
  });
  test('a typing start that settles after the reply cannot re-arm its heartbeat', async () => {
    const f = fixture(); const events: string[] = []; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (f.space as unknown as { startTyping(): Promise<void> }).startTyping = async () => { events.push('start'); await gate; events.push('start-return'); };
    (f.space as unknown as { stopTyping(): Promise<void> }).stopTyping = async () => { events.push('stop'); };
    try {
      await f.probe.onMessage(f.space, f.message('source'));
      await f.probe.flushPending();
      for (let i = 0; i < 100 && events.length === 0; i++) await Bun.sleep(2);
      expect(events).toEqual(['start']);
      const [answer] = await enqueueOutbound({ spaceId: 'space', text: 'answer' });
      await f.probe.sendOutbound(answer!);
      release();
      const probe = f.runtime as unknown as { controlTasks: Set<Promise<unknown>>; typingHeartbeats: Map<string, unknown> };
      for (let i = 0; i < 100 && probe.controlTasks.size > 0; i++) await Bun.sleep(2);
      expect(probe.controlTasks.size).toBe(0); expect(probe.typingHeartbeats.size).toBe(0);
      expect(events.at(-1)).toBe('stop');
      expect(events.lastIndexOf('stop')).toBeGreaterThan(events.indexOf('start-return'));
    } finally { release(); await f.runtime.stop(); }
  });
  test('provider error text cannot leak into persisted media records', async () => {
    const f = fixture();
    try {
      await f.probe.onMessage(f.space, f.message('failed-media', { type: 'attachment', name: 'file.txt', mimeType: 'text/plain', read: async () => { throw new Error('CREDENTIAL_SENTINEL_never_persist'); } }));
      await f.probe.flushPending();
      const serialized = JSON.stringify(await pendingDotBatches());
      expect(serialized).not.toContain('CREDENTIAL_SENTINEL'); expect(serialized).toContain('attachment_unavailable');
    } finally { await f.runtime.stop(); }
  });
  test('read events are evidence only and do not wake dot', async () => {
    const f = fixture();
    try { await f.probe.onMessage(f.space, f.message('read', { type: 'read', target: { id: 'outbound' } })); await f.probe.flushPending(); expect(await pendingDotBatches()).toEqual([]); }
    finally { await f.runtime.stop(); }
  });
});
