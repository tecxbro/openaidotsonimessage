import { beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeDiagnostics } from './runtime-diagnostics.ts';
import { GpProofRuntime } from './runtime.ts';
import { DATA_DIR } from './types.ts';
import { enqueueOutbound, loadOutboundQueue, updateOutbound } from './storage.ts';
import { pendingDotBatches } from './dot-inbox.ts';
import type { Message, Space, Spectrum } from '@spectrum-ts/core';

beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
const config = { projectId: 'PRIVATE_PROJECT_SENTINEL', projectSecret: 'PRIVATE_SECRET_SENTINEL', authorizedSenderId: 'owner', hostMode: 'dot-local' as const, greetingFastPath: false };
const diagnosticPath = join(DATA_DIR, 'runtime-diagnostics.jsonl');
async function records() {
  return (await readFile(diagnosticPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function until(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('fixture_wait_timeout');
    await Bun.sleep(10);
  }
}
type Probe = {
  spaces: Map<string, Space>;
  maintenance: Map<string, Promise<void>>;
  runMaintenance(operation: 'outbound_drain' | 'webhook_drain', work: () => Promise<void>): Promise<void>;
  drainOutbound(): Promise<void>;
  drainOutboundInner(): Promise<void>;
  drainWebhooks(): Promise<void>;
  onMessage(space: Space, message: Message): Promise<void>;
  scheduleFlush(): void;
  onSigterm(): void;
  stopInner(): Promise<void>;
};
function fixture() {
  let sends = 0;
  const space = { id: 'space', type: 'dm', phone: 'line', send: async () => ({ id: `provider-${++sends}` }), startTyping: async () => {}, stopTyping: async () => {} } as unknown as Space;
  const runtime = new GpProofRuntime(config);
  const probe = runtime as unknown as Probe;
  probe.spaces.set(space.id, space);
  return { runtime, probe, space, sends: () => sends };
}

test('diagnostics use a fixed schema and rate-limit repeated failures with recovery evidence', async () => {
  let now = 1_700_000_000_000;
  const diagnostics = new RuntimeDiagnostics(DATA_DIR, () => now);
  const error = Object.assign(new Error('PRIVATE_PAYLOAD_SENTINEL'), { code: 'EACCES', cause: { authorization: 'PRIVATE_SECRET_SENTINEL' } });
  diagnostics.lifecycle('runtime_starting');
  diagnostics.failure('outbound_drain', error);
  for (let i = 0; i < 100; i++) diagnostics.failure('outbound_drain', error);
  now += 60_001; diagnostics.failure('outbound_drain', error);
  diagnostics.recovered('outbound_drain'); diagnostics.recovered('outbound_drain');
  const rows = await records();
  expect(rows.map(row => row.event)).toEqual(['runtime_starting', 'operation_failed', 'operation_failed', 'operation_recovered']);
  expect(rows[1].code).toBe('EACCES'); expect(rows[2].suppressed).toBe(100); expect(rows[3].failureCount).toBe(102);
  const serialized = JSON.stringify(rows);
  expect(serialized).not.toContain('PRIVATE_'); expect(serialized).not.toContain('authorization');
  expect(serialized).not.toContain('stack'); expect(serialized).not.toContain(DATA_DIR);
  expect(rows.every(row => typeof row.at === 'string' && row.pid === process.pid && typeof row.runId === 'string')).toBe(true);
});

test('unknown error codes and throwing code getters cannot leak or reject diagnostics', async () => {
  const diagnostics = new RuntimeDiagnostics();
  diagnostics.failure('outbound_drain', { code: 'PRIVATE_TOKEN_SENTINEL', message: 'PRIVATE_PAYLOAD_SENTINEL' });
  diagnostics.failure('webhook_drain', Object.defineProperty({}, 'code', { get() { throw new Error('PRIVATE_SECRET_SENTINEL'); } }));
  const rows = await records();
  expect(rows.map(row => row.code)).toEqual(['operation_failed', 'operation_failed']);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
});

test('diagnostic storage failure is contained and its stderr fallback is rate limited', async () => {
  await mkdir(diagnosticPath);
  let now = 1_700_000_000_000;
  const diagnostics = new RuntimeDiagnostics(DATA_DIR, () => now);
  const old = console.error; const output: unknown[][] = [];
  console.error = (...args: unknown[]) => { output.push(args); };
  try {
    for (let i = 0; i < 50; i++) diagnostics.lifecycle('runtime_starting');
    expect(output).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain(DATA_DIR);
    expect(JSON.stringify(output)).not.toContain('Error');
    await rm(diagnosticPath, { recursive: true });
    now += 60_001; diagnostics.lifecycle('provider_connected');
    expect((await records()).map(row => row.event)).toEqual(['provider_connected']);
  } finally { console.error = old; }
});

test('a failed outbound pass is single-flight and recovery sends only the original queued action once', async () => {
  const f = fixture();
  const [alreadySent] = await enqueueOutbound({ spaceId: 'space', text: 'previous answer' });
  const [unknown] = await enqueueOutbound({ spaceId: 'space', text: 'uncertain answer' });
  const [queued] = await enqueueOutbound({ spaceId: 'space', text: 'PRIVATE_PAYLOAD_SENTINEL' });
  await updateOutbound(alreadySent!.id, { status: 'sent', deliveryState: 'provider_accepted', messageId: 'old-provider-id' });
  await updateOutbound(unknown!.id, { status: 'unknown', deliveryState: 'unknown' });
  const queuePath = join(DATA_DIR, 'outbound-queue.json');
  const originalQueue = await readFile(queuePath, 'utf8');
  await writeFile(queuePath, 'PRIVATE_SECRET_SENTINEL invalid JSON');
  let release!: () => void; let calls = 0; let active = 0; let maximumActive = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.probe.drainOutboundInner.bind(f.probe);
  f.probe.drainOutboundInner = async () => {
    calls++; active++; maximumActive = Math.max(maximumActive, active);
    try { await gate; await original(); } finally { active--; }
  };
  try {
    const first = f.probe.runMaintenance('outbound_drain', () => f.probe.drainOutbound());
    const same = f.probe.runMaintenance('outbound_drain', () => f.probe.drainOutbound());
    expect(first).toBe(same);
    await Bun.sleep(10); expect(calls).toBe(1); release(); await first;
    expect(await readFile(queuePath, 'utf8')).toBe('PRIVATE_SECRET_SENTINEL invalid JSON');
    expect(f.sends()).toBe(0); expect(f.probe.maintenance.size).toBe(0);
    await writeFile(queuePath, originalQueue);
    await Promise.all([
      f.probe.runMaintenance('outbound_drain', () => f.probe.drainOutbound()),
      f.probe.runMaintenance('outbound_drain', () => f.probe.drainOutbound()),
    ]);
    expect(maximumActive).toBe(1); expect(calls).toBe(2); expect(f.sends()).toBe(1);
    const items = await loadOutboundQueue();
    expect(items.find(i => i.id === alreadySent!.id)!.messageId).toBe('old-provider-id');
    expect(items.find(i => i.id === unknown!.id)!.status).toBe('unknown');
    expect(items.find(i => i.id === queued!.id)!.status).toBe('sent');
    expect(items.find(i => i.id === queued!.id)!.attempts).toBe(1);
    const diagnostics = await records();
    expect(diagnostics.filter(row => row.operation === 'outbound_drain').map(row => row.event)).toEqual(['operation_failed', 'operation_recovered']);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
    expect(JSON.stringify(diagnostics)).not.toContain(queued!.id);
  } finally { release(); await f.runtime.stop(); }
});

test('webhook queue corruption is preserved, reported, and a later repaired pass recovers', async () => {
  const f = fixture(); const path = join(DATA_DIR, 'webhook-pending.json');
  try {
    await writeFile(path, 'PRIVATE_SECRET_SENTINEL invalid JSON');
    await f.probe.runMaintenance('webhook_drain', () => f.probe.drainWebhooks());
    expect(await readFile(path, 'utf8')).toBe('PRIVATE_SECRET_SENTINEL invalid JSON');
    await writeFile(path, JSON.stringify({ batchIds: [] }));
    await f.probe.runMaintenance('webhook_drain', () => f.probe.drainWebhooks());
    expect((await records()).filter(row => row.operation === 'webhook_drain').map(row => row.event)).toEqual(['operation_failed', 'operation_recovered']);
  } finally { await f.runtime.stop(); }
});

test('a rejected deferred flush is contained; next input flushes both preserved messages after repair', async () => {
  const f = fixture();
  const message = (id: string, text: string) => ({ id, content: { type: 'text', text }, platform: 'imessage', direction: 'inbound', sender: { id: 'owner' }, timestamp: new Date(), read: async () => {} }) as unknown as Message;
  const unread = join(DATA_DIR, 'unread');
  await writeFile(unread, 'fixture blocks directory creation');
  try {
    await f.probe.onMessage(f.space, message('first', 'hi'));
    await until(async () => (await records().catch(() => [])).some(row => row.operation === 'batch_flush' && row.event === 'operation_failed'));
    expect(JSON.parse(await readFile(join(DATA_DIR, 'pending-batch.json'), 'utf8')).messages.map((m: { id: string }) => m.id)).toEqual(['first']);
    await rm(unread); await mkdir(unread);
    await f.probe.onMessage(f.space, message('second', 'hello'));
    await until(async () => (await pendingDotBatches()).length === 1);
    expect((await pendingDotBatches())[0]!.messages.map(m => m.id)).toEqual(['first', 'second']);
    await until(async () => (await records()).some(row => row.operation === 'batch_flush' && row.event === 'operation_recovered'));
    expect((await records()).filter(row => row.operation === 'batch_flush').map(row => row.event)).toEqual(['operation_failed', 'operation_recovered']);
  } finally { await f.runtime.stop(); }
});

test('normal stream EOF and stop record lifecycle events without config or payloads', async () => {
  const connect = (async () => ({ messages: { async *[Symbol.asyncIterator]() {} }, stop: async () => {} })) as unknown as typeof Spectrum;
  const runtime = new GpProofRuntime(config, connect);
  await runtime.start(); await runtime.stop();
  const rows = await records();
  expect(rows.map(row => row.event)).toEqual(['runtime_starting', 'provider_connected', 'provider_stream_eof', 'stop_requested', 'runtime_stopped']);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
});

for (const failureStage of ['post-connect setup', 'provider iterator'] as const) {
  test(`lifecycle classifies ${failureStage} failure without exposing the external error`, async () => {
    if (failureStage === 'post-connect setup') {
      await mkdir(join(DATA_DIR, 'media-jobs'));
      await writeFile(join(DATA_DIR, 'media-jobs', 'invalid.json'), 'PRIVATE_SECRET_SENTINEL invalid JSON');
    }
    const connect = (async () => ({
      messages: { async *[Symbol.asyncIterator]() { throw new Error('PRIVATE_SECRET_SENTINEL'); } },
      stop: async () => {},
    })) as unknown as typeof Spectrum;
    const runtime = new GpProofRuntime(config, connect);
    await expect(runtime.start()).rejects.toThrow('runtime_start_failed');
    await runtime.stop();
    const failed = (await records()).filter(row => row.event === 'operation_failed');
    expect(failed.map(row => row.operation)).toEqual([failureStage === 'post-connect setup' ? 'runtime_start' : 'provider_stream']);
    expect(JSON.stringify(await records())).not.toContain('PRIVATE_');
  });
}

test('failed final flush still waits for active send and closes the provider without a false stop success', async () => {
  let finish!: () => void; let releaseSend!: () => void; let sends = 0; let providerStops = 0;
  const gate = new Promise<void>(resolve => { releaseSend = resolve; });
  const connect = (async () => ({
    messages: { async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => { finish = resolve; }); } },
    stop: async () => { providerStops++; finish(); },
  })) as unknown as typeof Spectrum;
  const runtime = new GpProofRuntime(config, connect);
  const probe = runtime as unknown as Probe;
  const space = { id: 'space', type: 'dm', send: async () => { sends++; await gate; return { id: 'accepted-before-stop' }; }, stopTyping: async () => {} } as unknown as Space;
  const running = runtime.start();
  await until(async () => Boolean(finish));
  await Promise.all(probe.maintenance.values());
  probe.spaces.set('space', space);
  await probe.onMessage(space, { id: 'pending-question', content: { type: 'text', text: 'PRIVATE_PAYLOAD_SENTINEL' }, platform: 'imessage', direction: 'inbound', sender: { id: 'owner' }, timestamp: new Date(), read: async () => {} } as unknown as Message);
  await enqueueOutbound({ spaceId: 'space', text: 'first' });
  const [later] = await enqueueOutbound({ spaceId: 'space', text: 'later' });
  await rm(join(DATA_DIR, 'unread'), { recursive: true });
  await writeFile(join(DATA_DIR, 'unread'), 'fixture blocks final flush');
  const drain = probe.runMaintenance('outbound_drain', () => probe.drainOutbound());
  await until(async () => sends === 1);
  const stopped = runtime.stop('SIGTERM').then(() => 'success', () => 'failed');
  try {
    await Bun.sleep(25);
    expect(providerStops).toBe(0); expect(sends).toBe(1);
    releaseSend();
    expect(await stopped).toBe('failed');
    await drain; await running;
    expect(providerStops).toBe(1); expect(sends).toBe(1);
    expect((await loadOutboundQueue()).find(item => item.id === later!.id)!.status).toBe('queued');
    expect(JSON.parse(await readFile(join(DATA_DIR, 'pending-batch.json'), 'utf8')).messages[0].id).toBe('pending-question');
    const rows = await records();
    expect(rows.some(row => row.operation === 'runtime_stop' && row.event === 'operation_failed')).toBe(true);
    expect(rows.some(row => row.event === 'runtime_stopped')).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
  } finally { releaseSend(); await stopped; await running; }
});

test('a signal-triggered stop rejection is observed and durably logged without raw provider errors', async () => {
  const f = fixture();
  f.probe.stopInner = async () => { throw new Error('PRIVATE_SECRET_SENTINEL'); };
  f.probe.onSigterm();
  await until(async () => (await records()).some(row => row.operation === 'runtime_stop'));
  const rows = await records();
  expect(rows[0]).toMatchObject({ event: 'stop_requested', trigger: 'SIGTERM' });
  expect(rows[1]).toMatchObject({ event: 'operation_failed', operation: 'runtime_stop' });
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
});

test('real Bun stays alive across failing startup and interval launches, then recovers', async () => {
  const runtimePath = new URL('./runtime.ts', import.meta.url).pathname;
  const script = `
    import { GpProofRuntime } from ${JSON.stringify(runtimePath)};
    import { readFile } from 'node:fs/promises';
    const runtime = new GpProofRuntime(${JSON.stringify(config)}, async () => ({
      messages: { async *[Symbol.asyncIterator]() { await new Promise(resolve => { globalThis.finish = resolve; }); } },
      stop: async () => { globalThis.finish(); },
    }));
    let failing = true; let outbound = 0; let webhooks = 0;
    runtime.drainOutbound = async () => { outbound++; if (failing) throw new Error('PRIVATE_SECRET_SENTINEL'); };
    runtime.drainWebhooks = async () => { webhooks++; if (failing) throw new Error('PRIVATE_PAYLOAD_SENTINEL'); };
    const running = runtime.start();
    await Bun.sleep(2200);
    if (outbound < 2 || webhooks < 2) throw new Error('timer_did_not_repeat');
    failing = false;
    await Bun.sleep(2200);
    await runtime.stop(); await running;
    const rows = (await readFile(${JSON.stringify(diagnosticPath)}, 'utf8')).trim().split('\\n').map(JSON.parse);
    for (const operation of ['outbound_drain', 'webhook_drain']) {
      if (!rows.some(r => r.operation === operation && r.event === 'operation_failed') || !rows.some(r => r.operation === operation && r.event === 'operation_recovered')) throw new Error('missing_failure_or_recovery');
    }
    console.log('SURVIVED_AND_RECOVERED');
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], { env: { ...process.env, BRIDGE_DATA_DIR: DATA_DIR }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(stdout).toContain('SURVIVED_AND_RECOVERED'); expect(stderr).toBe('');
  expect(await readFile(diagnosticPath, 'utf8')).not.toContain('PRIVATE_');
}, 10_000);
