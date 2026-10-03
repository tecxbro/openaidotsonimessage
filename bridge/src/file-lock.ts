/** Linux kernel flock: released by the OS on process/pipe closure, no stale-owner stealing. */
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Callable release keeps existing users compatible. Loss revokes authority. */
export type FileLockLease = (() => Promise<void>) & {
  readonly lost: AbortSignal;
  readonly helperPid: number;
  assertHeld(): void;
};

export async function acquireFileLock(path: string, waitMs = 30_000): Promise<FileLockLease> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // This inode is permanent. Never rename/delete a flock file to recover it.
  const file = await open(`${path}.lock`, 'a', 0o600);
  await file.close();
  const wait = waitMs <= 0 ? ['-n'] : ['-w', String(waitMs / 1000)];
  const child = spawn('flock', ['-x', '-E', '75', ...wait, `${path}.lock`, 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'], {
    // Terminal signals must reach the owner, not release its kernel lock while
    // the owner's async shutdown is still running. Keep the stdin pipe owned by
    // the parent: explicit release or parent death/EOF still ends the helper.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
  const loss = new AbortController();
  let released = false;
  child.once('exit', () => { if (!released) loss.abort(); });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.once('error', () => reject(new Error('flock_unavailable')));
      child.once('exit', () => reject(new Error(`lock_busy: ${path}`)));
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('locked\n')) resolve();
      });
    });
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (loss.signal.aborted) throw new Error('file_lock_lost');
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, helperPid: child.pid, token: randomUUID(), backend: 'flock' }), { mode: 0o600 });
    if (loss.signal.aborted) throw new Error('file_lock_lost');
  } catch (error) {
    child.stdin.end();
    await exited;
    throw error;
  }
  const release = async () => {
    if (released) return;
    released = true;
    // An old owner must never remove a replacement owner's metadata.
    if (loss.signal.aborted) { child.stdin.end(); await exited; return; }
    // Metadata is removed while the kernel lock is still held.
    await rm(path, { recursive: true, force: true });
    child.stdin.end();
    await exited;
  };
  return Object.assign(release, { lost: loss.signal, helperPid: child.pid!, assertHeld: () => {
    if (released || loss.signal.aborted || child.exitCode !== null || child.signalCode !== null) throw new Error('file_lock_lost');
  } });
}

export async function withFileLock<T>(path: string, fn: (lease: FileLockLease) => Promise<T>): Promise<T> {
  const release = await acquireFileLock(path);
  try { release.assertHeld(); const result = await fn(release); release.assertHeld(); return result; } finally { await release(); }
}
