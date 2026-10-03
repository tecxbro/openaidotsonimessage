import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Space, Spectrum } from '@spectrum-ts/core';
import { DATA_DIR } from './types.ts';
import { acquireFileLock } from './file-lock.ts';
import { GpProofRuntime } from './runtime.ts';
import { enqueueOutbound, loadOutboundQueue } from './storage.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
async function until(check: () => Promise<boolean>) { for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(5); } throw new Error('fixture_timeout'); }
function helper(path: string): number {
  // Restrict process selection to the unique disposable test lock pathname.
  const row = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').find(row => row.includes(` ${path}.lock sh -c `) && /flock -x -E 75/.test(row));
  if (!row) throw new Error('test_helper_missing');
  return Number(row.trim().split(/\s+/)[0]);
}
test('loss of the acquired helper revokes send authority and stops its provider owner', async () => {
  const path = join(DATA_DIR, '.runtime-lock'), lease = await acquireFileLock(path, 0);
  let finish!: () => void, sends = 0, closed = 0, ready = false;
  const space = { id: 'space', send: async () => { sends++; return { id: 'unexpected' }; }, stopTyping: async () => {} } as unknown as Space;
  const connect = (async () => ({ messages: { async *[Symbol.asyncIterator]() { ready = true; await new Promise<void>(resolve => { finish = resolve; }); } }, stop: async () => { closed++; finish?.(); } })) as unknown as typeof Spectrum;
  const Runtime = GpProofRuntime as unknown as new (...args: unknown[]) => GpProofRuntime;
  const runtime = new Runtime({ projectId: 'fake', projectSecret: 'fake', authorizedSenderId: 'owner', hostMode: 'dot-local' }, connect, lease);
  const probe = runtime as unknown as { spaces: Map<string, Space>; drainOutbound(): Promise<void> }; probe.spaces.set('space', space);
  const running = runtime.start();
  try {
    await until(async () => ready);
    process.kill(helper(path), 'SIGKILL');
    await until(async () => closed === 1);
    const [item] = await enqueueOutbound({ spaceId: 'space', text: 'never send' }, 'retained');
    await probe.drainOutbound(); expect(sends).toBe(0); expect((await loadOutboundQueue()).find(row => row.id === item!.id)!.status).toBe('queued');
    await runtime.stop(); await running;
    const replacement = await acquireFileLock(path, 0); await replacement();
  } finally { await runtime.stop().catch(() => {}); await running.catch(() => {}); await lease(); }
});

test('a lost lease fails closed and releasing it cannot remove replacement metadata', async () => {
  const path = join(DATA_DIR, 'disposable-lock'), old = await acquireFileLock(path, 0);
  try {
    process.kill(helper(path), 'SIGKILL'); await until(async () => old.lost.aborted);
    expect(() => old.assertHeld()).toThrow('file_lock_lost');
    const replacement = await acquireFileLock(path, 0);
    try { const before = await readFile(join(path, 'owner.json'), 'utf8'); await old(); expect(await readFile(join(path, 'owner.json'), 'utf8')).toBe(before); replacement.assertHeld(); } finally { await replacement(); }
  } finally { await old(); }
});
