/** One-shot active-host inbox wait. This never opens a Spectrum connection. */
import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { DOT_INBOX_DIR, pendingDotBatches } from './dot-inbox.ts';
import { readBatchClaim, tryClaimBatchNow, type BatchClaim } from './batch-claim.ts';
import type { UnreadBatch } from './types.ts';

export type DotWaitResult =
  | { status: 'claimed'; ok: true; claim: BatchClaim; resumed: boolean; batch: UnreadBatch }
  | { status: 'timeout' | 'cancelled'; ok: false; waitedMs: number };

/** Returns one claimable batch, or a bounded no-work result. Filesystem events
 * provide prompt notice; a small fallback interval covers missed watch events. */
export async function waitForDotBatch(
  owner: string,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<DotWaitResult> {
  if (!owner.trim()) throw new Error('owner_required');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) throw new Error('timeout_must_be_0_to_300000_ms');
  if (!Number.isFinite(pollMs) || pollMs < 10 || pollMs > 10_000) throw new Error('invalid_poll_interval');
  await mkdir(DOT_INBOX_DIR, { recursive: true, mode: 0o700 });
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let revision = 0;
  let wakePending: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  const wake = () => { revision++; wakePending?.(); wakePending = undefined; };
  try {
    // Subscribe before scanning so a rename between scan and wait isn't lost.
    try {
      watcher = watch(DOT_INBOX_DIR, wake);
      watcher.on('error', wake); // interval fallback remains available
    } catch { /* unsupported watch surface: use bounded fallback scan */ }
    options.signal?.addEventListener('abort', wake);
    for (;;) {
      if (options.signal?.aborted) return { status: 'cancelled', ok: false, waitedMs: elapsed() };
      const seen = revision;
      for (const batch of await pendingDotBatches()) {
        const claim = await readBatchClaim(batch.batchId);
        if (claim?.state === 'claimed' && claim.owner !== owner && Date.parse(claim.leaseExpiresAt) > Date.now()) continue;
        if (options.signal?.aborted) return { status: 'cancelled', ok: false, waitedMs: elapsed() };
        const attempt = await tryClaimBatchNow(batch.batchId, owner, () =>
          !options.signal?.aborted && (timeoutMs === 0 || performance.now() - started < timeoutMs));
        if (attempt?.ok) return { status: 'claimed', ...attempt, batch };
      }
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) return { status: 'timeout', ok: false, waitedMs: elapsed() };
      if (revision !== seen) continue;
      await new Promise<void>(resolve => {
        wakePending = resolve;
        timer = setTimeout(resolve, Math.min(pollMs, remaining));
        if (revision !== seen || options.signal?.aborted) resolve();
      });
      if (timer) clearTimeout(timer);
      timer = undefined;
      wakePending = undefined;
    }
  } finally {
    if (timer) clearTimeout(timer);
    watcher?.close();
    options.signal?.removeEventListener('abort', wake);
  }
}
