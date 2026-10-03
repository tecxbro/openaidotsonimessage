/** Advisory cross-process publication events. Durable scans remain authoritative. */
import { watch } from 'node:fs';
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
    const watcher = watch(directory, (_event, filename) => {
      if (filename === null || matches(filename.toString())) notify();
    });
    watcher.on('error', () => { watcher.close(); notify(); });
    return () => { closed = true; watcher.close(); };
  } catch {
    // No producer depends on successful notification; periodic/restart recovery
    // still reads the committed queue. Registration precedes the initial scan.
    return () => { closed = true; };
  }
}
