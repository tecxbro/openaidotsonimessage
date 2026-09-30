import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFileLock } from './file-lock.ts';

const source = new URL('./file-lock.ts', import.meta.url).pathname;

/** The entire owner process group is disposable; it never shares the test runner's group. */
function startOwner(path: string) {
  const script = `
    import { acquireFileLock } from ${JSON.stringify(source)};
    const release = await acquireFileLock(${JSON.stringify(path)}, 0);
    const keepAlive = setInterval(() => {}, 1000);
    let releasing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => console.log('SHUTDOWN_BEGIN:' + signal));
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async chunk => {
      if (!String(chunk).includes('RELEASE') || releasing) return;
      releasing = true;
      await release();
      clearInterval(keepAlive);
      console.log('RELEASE_FINISHED');
      process.exit(0);
    });
    process.stdin.resume();
    console.log('READY');
  `;
  const child = spawn(process.execPath, ['--eval', script], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; let error = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { error += String(data); });
  child.stdin.on('error', () => {});
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  const waitFor = async (marker: string) => {
    const deadline = Date.now() + 5_000;
    while (!output.includes(marker)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        throw new Error(`isolated owner missing ${marker}; stdout=${output}; stderr=${error}`);
      }
      await Bun.sleep(5);
    }
  };
  return { child, exited, waitFor };
}

function contender(path: string): number {
  return Bun.spawnSync(['flock', '-x', '-n', '-E', '75', `${path}.lock`, 'true'], { stdout: 'pipe', stderr: 'pipe' }).exitCode;
}

async function cleanup(owner: ReturnType<typeof startOwner>, root: string, path: string) {
  if (owner.child.exitCode === null && owner.child.signalCode === null) {
    // This targets only the isolated owner's group, never the test runner.
    try { process.kill(-owner.child.pid!, 'SIGKILL'); } catch { /* already exited */ }
  }
  await owner.exited;
  // The parent's death closes its helper stdin; do not leave an orphaned lock.
  const release = await acquireFileLock(path, 2_000);
  await release();
  await rm(root, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`group ${signal} keeps the lock held through delayed owner shutdown until explicit release`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dot-signal-lock-'));
    const path = join(root, 'instance');
    const owner = startOwner(path);
    try {
      await owner.waitFor('READY');
      const inode = (await stat(`${path}.lock`)).ino;
      expect(contender(path)).toBe(75);
      process.kill(-owner.child.pid!, signal);
      await owner.waitFor(`SHUTDOWN_BEGIN:${signal}`);
      await Bun.sleep(200);
      expect(owner.child.exitCode).toBeNull();
      expect(owner.child.signalCode).toBeNull();
      expect(contender(path)).toBe(75);
      await Bun.sleep(100);
      expect(contender(path)).toBe(75);
      owner.child.stdin.write('RELEASE\n');
      await owner.waitFor('RELEASE_FINISHED');
      expect(await owner.exited).toBe(0);
      expect(contender(path)).toBe(0);
      expect((await stat(`${path}.lock`)).ino).toBe(inode);
    } finally { await cleanup(owner, root, path); }
  }, 10_000);
}

test('owner death after group interruption releases the detached helper through stdin EOF', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dot-signal-death-'));
  const path = join(root, 'instance');
  const owner = startOwner(path);
  try {
    await owner.waitFor('READY');
    process.kill(-owner.child.pid!, 'SIGINT');
    await owner.waitFor('SHUTDOWN_BEGIN:SIGINT');
    await Bun.sleep(200);
    expect(contender(path)).toBe(75);
    owner.child.kill('SIGKILL');
    await owner.exited;
    const release = await acquireFileLock(path, 2_000);
    expect(contender(path)).toBe(75);
    await release();
    expect(contender(path)).toBe(0);
  } finally { await cleanup(owner, root, path); }
}, 10_000);
