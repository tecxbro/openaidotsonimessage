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
async function runningFixture(s: Space) {
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
  clearInterval(probe.outboundTimer); clearInterval(probe.cardsReadyTimer); clearInterval(probe.webhookTimer);
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
