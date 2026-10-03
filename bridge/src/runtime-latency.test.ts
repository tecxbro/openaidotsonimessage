import { beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, type Config } from './types.ts';
import { GpProofRuntime } from './runtime.ts';
import { pendingDotBatches } from './dot-inbox.ts';
import { enqueueOutbound, loadOutboundQueue } from './storage.ts';
import { markSetupConfettiSent } from './setup-confetti.ts';
import type { Message, Space, Spectrum } from '@spectrum-ts/core';

beforeEach(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
  await markSetupConfettiSent();
});
const config: Config = { projectId: 'fake', projectSecret: 'fake', authorizedSenderId: 'owner', hostMode: 'dot-local', greetingFastPath: false };
async function until(check: () => Promise<boolean>, timeoutMs = 1500) {
  const deadline = performance.now() + timeoutMs;
  while (!await check()) {
    if (performance.now() > deadline) throw new Error('fixture_timeout');
    await Bun.sleep(2);
  }
}
type Probe = {
  onMessage(space: Space, message: Message): Promise<void>;
  spaces: Map<string, Space>;
  maintenance: Map<string, Promise<void>>;
  outboundTimer: ReturnType<typeof setInterval>;
  webhookTimer: ReturnType<typeof setInterval>;
  cardsReadyTimer: ReturnType<typeof setInterval>;
  notificationClosers: Array<() => void>;
  drainOutbound(): Promise<void>;
};
const message = (id: string): Message => ({ id, platform: 'imessage', direction: 'inbound', sender: { id: 'owner' }, timestamp: new Date(), content: { type: 'text', text: 'substantive input' }, read: async () => {} }) as unknown as Message;
function space(send = async () => ({ id: 'accepted' })): Space {
  return { id: 'space', type: 'dm', phone: 'line', send, startTyping: async () => {}, stopTyping: async () => {} } as unknown as Space;
}
async function runningFixture(s: Space, disablePolling = true) {
  let finish!: () => void;
  const connect = (async () => ({
    messages: { async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { finish = resolve; }); } },
    stop: async () => finish(),
  })) as unknown as typeof Spectrum;
  const runtime = new GpProofRuntime(config, connect);
  const probe = runtime as unknown as Probe;
  probe.spaces.set('space', s);
  const running = runtime.start();
  await until(async () => Boolean(finish));
  if (disablePolling) clearInterval(probe.outboundTimer);
  clearInterval(probe.cardsReadyTimer); clearInterval(probe.webhookTimer);
  await Promise.all(probe.maintenance.values());
  return { runtime, probe, running };
}

test('isolated ordinary input publishes immediately and a burst preserves all IDs', async () => {
  const runtime = new GpProofRuntime(config); const probe = runtime as unknown as Probe;
  try {
    const start = performance.now();
    await probe.onMessage(space(), message('isolated'));
    await until(async () => (await pendingDotBatches()).length > 0, 1000);
    expect(performance.now() - start).toBeLessThan(1000);
    await Promise.all(Array.from({ length: 12 }, (_, i) => probe.onMessage(space(), message(`burst-${i}`))));
    await until(async () => (await pendingDotBatches()).flatMap(b => b.messages).length === 13);
    const records = (await pendingDotBatches()).flatMap(b => b.messages);
    expect(new Set(records.map(m => m.id)).size).toBe(13);
    expect(records.every(m => m.spaceId === 'space')).toBe(true);
  } finally { await runtime.stop(); }
});

test('a slow webhook cannot hold persistence or publication of following input', async () => {
  const original = globalThis.fetch; let calls = 0; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async () => { calls++; await held; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
  const runtime = new GpProofRuntime({ ...config, hostMode: 'webhook', webhookUrl: 'https://example.com/wake', webhookKey: 'fake' });
  const probe = runtime as unknown as Probe;
  try {
    await probe.onMessage(space(), message('first'));
    await until(async () => calls === 1);
    await probe.onMessage(space(), message('second'));
    await until(async () => calls === 2);
    expect(JSON.parse(await readFile(join(DATA_DIR, 'inbound', 'second.json'), 'utf8')).id).toBe('second');
    const names = await import('node:fs/promises').then(fs => fs.readdir(join(DATA_DIR, 'unread')));
    expect(names).toHaveLength(2);
  } finally { release(); await runtime.stop(); globalThis.fetch = original; }
});

test('separate-process enqueue and repeated atomic replacement wake without polling', async () => {
  let calls = 0;
  const f = await runningFixture(space(async () => ({ id: `sent-${++calls}` })));
  const source = new URL('./storage.ts', import.meta.url).pathname;
  try {
    for (let i = 0; i < 2; i++) {
      const child = Bun.spawn([process.execPath, '-e', `import { enqueueOutbound } from ${JSON.stringify(source)}; await enqueueOutbound({spaceId:'space',text:'answer'},'action-${i}');`], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(0);
      await until(async () => calls === i + 1);
      await until(async () => (await loadOutboundQueue()).every(item => item.status === 'sent'));
    }
    await f.runtime.stop(); await f.running;
    expect(f.probe.notificationClosers).toHaveLength(0);
    await enqueueOutbound({ spaceId: 'space', text: 'after stop' });
    await Bun.sleep(30); expect(calls).toBe(2);
  } finally { await f.runtime.stop(); await f.running; }
});

test('enqueue while sending is reconciled after settlement and duplicate notifications do not resend', async () => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await runningFixture(space(async () => { const id = `sent-${++calls}`; if (calls === 1) await gate; return { id }; }));
  try {
    await enqueueOutbound({ spaceId: 'space', text: 'first' });
    await until(async () => calls === 1);
    await enqueueOutbound({ spaceId: 'space', text: 'second' });
    const a = f.probe.drainOutbound(), b = f.probe.drainOutbound();
    release(); await Promise.all([a, b]);
    await until(async () => (await loadOutboundQueue()).every(item => item.status === 'sent'));
    expect(calls).toBe(2);
    await f.probe.drainOutbound(); expect(calls).toBe(2);
  } finally { release(); await f.runtime.stop(); await f.running; }
});

test('complete card publication wakes final enqueue without maintenance or stability timers', async () => {
  const { writeCardsReadyMarker, CARDS_READY_DIR } = await import('./cards-ready.ts');
  const { writeUnreadBatch } = await import('./storage.ts');
  const { copyFile, writeFile } = await import('node:fs/promises');
  let calls = 0;
  const f = await runningFixture(space(async () => ({ id: `cards-${++calls}` })));
  try {
    for (const count of [5, 7]) {
      const batchId = `stack-${count}`;
      await writeUnreadBatch({ batchId, flushedAt: new Date().toISOString(), messages: [{ id: `input-${count}`, spaceId: 'space', senderId: 'owner', text: 'options', timestamp: new Date().toISOString(), receivedAt: new Date().toISOString() }] });
      const paths = Array.from({ length: count }, (_, i) => join(DATA_DIR, `${batchId}-${i}.png`));
      for (const path of paths) await copyFile('/tmp/gpproof-1x1.png', path);
      const marker = { batchId, spaceId: 'space', attachmentPaths: paths, expectedCount: count, cards: paths.map((_, i) => ({ optionId: `option-${i}`, title: `Option ${i}`, url: `https://example.com/${i}`, price: '$10 / month' })), readyAt: new Date().toISOString() };
      await expect(writeCardsReadyMarker({ ...marker, expectedCount: count + 1 })).rejects.toThrow('complete_card_metadata');
      await expect(writeCardsReadyMarker({ ...marker, cards: marker.cards.slice(1) })).rejects.toThrow('metadata');
      const original = await readFile(paths[0]!);
      await writeFile(paths[0]!, original.subarray(0, -12));
      await expect(writeCardsReadyMarker(marker)).rejects.toThrow('incomplete');
      await writeFile(paths[0]!, original);
      await writeCardsReadyMarker(marker);
      await enqueueOutbound({ kind: 'attachment_group', batchId, spaceId: 'space', attachmentPaths: paths, cards: marker.cards });
      await until(async () => (await loadOutboundQueue()).some(item => item.kind === 'attachment_group' && item.batchId === batchId && item.status === 'sent'));
      const groups = (await loadOutboundQueue()).filter(item => item.kind === 'attachment_group' && item.batchId === batchId);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.kind === 'attachment_group' && groups[0]!.attachmentPaths.length).toBe(count);
      const consumed = JSON.parse(await readFile(join(CARDS_READY_DIR, `${batchId}.json`), 'utf8'));
      expect(consumed.cards).toEqual(marker.cards);
    }
    expect(calls).toBe(2);
  } finally { await f.runtime.stop(); await f.running; }
});

 test('missed publication notifications recover through the retained periodic scan', async () => {
  let calls = 0;
  const f = await runningFixture(space(async () => ({ id: `recovered-${++calls}` })), false);
  try {
    for (const close of f.probe.notificationClosers.splice(0)) close();
    await enqueueOutbound({ spaceId: 'space', text: 'missed notification' });
    await until(async () => (await loadOutboundQueue()).every(item => item.status === 'sent'));
    expect(calls).toBe(1);
  } finally { await f.runtime.stop(); await f.running; }
});
