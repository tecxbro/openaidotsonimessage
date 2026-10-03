/** Advisory cross-process publication events. Durable scans remain authoritative. */
import { watch, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const outboundListeners = new Set<() => void>();
/** Supplements the directory watcher for runtime-owned producers. */
export function subscribeOutboundPublication(listener: () => void): () => void {
  outboundListeners.add(listener);
  return () => { outboundListeners.delete(listener); };
}
export function notifyOutboundPublication(): void {
  for (const listener of outboundListeners) {
    try { listener(); } catch { /* Advisory notification cannot fail enqueue. */ }
  }
}

export async function watchPublicationDirectory(
  directory: string,
  matches: (name: string) => boolean,
  reconcile: () => void,
): Promise<() => void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let closed = false;
  const notify = () => { if (!closed) reconcile(); };
  try {
    // A coalesced directory event may name a lock or temporary file instead
    // of the published file. Check final directory entries on every event.
    // Fingerprints suppress the sender's own lock/audit events and avoid an
    // endless drain -> lock change -> drain feedback loop.
    const fingerprint = () => readdirSync(directory).filter(matches).sort().map(name => {
      try { const stat = statSync(join(directory, name)); return `${name}:${stat.ino}:${stat.mtimeMs}:${stat.size}`; }
      catch { return `${name}:removed`; }
    }).join("\n");
    let previous = fingerprint();
    const watcher = watch(directory, () => {
      try {
        const current = fingerprint();
        if (current !== previous) { previous = current; notify(); }
      } catch { notify(); }
    });
    watcher.on('error', () => { watcher.close(); notify(); });
    return () => { closed = true; watcher.close(); };
  } catch {
    // No producer depends on successful notification; periodic/restart recovery
    // still reads the committed queue. Registration precedes the initial scan.
    return () => { closed = true; };
  }
}
