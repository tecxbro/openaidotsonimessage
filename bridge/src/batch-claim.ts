/**
 * Exclusive batch claim for agent-side processing.
 *
 * Webhook HTTP 200 / removeWebhookPending only means the wake was accepted by
 * Cursor — not that batch work finished. Agents must claim before processing
 * and mark completed only after a durable result (handled record and/or
 * enqueue acceptance) is recorded.
 *
 * Cross-process safety: exclusive file create (`flag: "wx"`). In-process
 * locking alone is not sufficient across agent shells.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireFileLock, withFileLock } from "./file-lock.ts";
import { DATA_DIR } from "./types.ts";

export const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type BatchClaimState = "claimed" | "completed" | "released";

export type BatchClaim = {
  batchId: string;
  owner: string;
  state: BatchClaimState;
  claimedAt: string;
  updatedAt: string;
  leaseExpiresAt: string;
  note?: string;
};

const CLAIMS_DIR = join(DATA_DIR, "batch-claims");

function claimPath(batchId: string): string {
  if (!batchId || batchId.includes("/") || batchId.includes("..")) {
    throw new Error(`invalid batchId for claim: ${batchId}`);
  }
  return join(CLAIMS_DIR, `${batchId}.json`);
}

function isExistError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return (
    e?.code === "EEXIST" ||
    e?.errno === -17 ||
    (typeof e?.message === "string" && e.message.includes("EEXIST"))
  );
}

async function readClaim(batchId: string): Promise<BatchClaim | null> {
  const path = claimPath(batchId);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as BatchClaim;
  } catch {
    return null;
  }
}

function leaseExpired(claim: BatchClaim, now = Date.now()): boolean {
  const exp = Date.parse(claim.leaseExpiresAt);
  return !Number.isFinite(exp) || exp <= now;
}

export type ClaimAttempt =
  | { ok: true; claim: BatchClaim; resumed: boolean }
  | {
      ok: false;
      reason: "owned_by_other" | "already_completed";
      claim: BatchClaim | null;
    };

async function tryClaimBatchUnlocked(
  batchId: string,
  owner: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
  assertCanProceed: () => void = () => {},
): Promise<ClaimAttempt> {
  await mkdir(CLAIMS_DIR, { recursive: true });
  const path = claimPath(batchId);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const leaseExpiresAt = new Date(now + leaseMs).toISOString();

  const existing = await readClaim(batchId);
  if (existing) {
    if (existing.state === "completed") {
      return { ok: false, reason: "already_completed", claim: existing };
    }
    if (existing.owner === owner && existing.state === "claimed") {
      const refreshed: BatchClaim = {
        ...existing,
        updatedAt: nowIso,
        leaseExpiresAt,
      };
      assertCanProceed();
      const tmp = `${path}.${process.pid}.refresh.tmp`;
      await writeFile(tmp, `${JSON.stringify(refreshed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      assertCanProceed();
      await rename(tmp, path);
      return { ok: true, claim: refreshed, resumed: true };
    }
    if (!leaseExpired(existing, now)) {
      return { ok: false, reason: "owned_by_other", claim: existing };
    }
    assertCanProceed();
    await unlink(path).catch(() => undefined);
  }

  const claim: BatchClaim = {
    batchId,
    owner,
    state: "claimed",
    claimedAt: nowIso,
    updatedAt: nowIso,
    leaseExpiresAt,
  };

  try {
    assertCanProceed();
    await writeFile(path, `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { ok: true, claim, resumed: false };
  } catch (err) {
    if (!isExistError(err)) throw err;
    // Race: another creator won. Never rethrow EEXIST.
    const raced = await readClaim(batchId);
    if (raced?.state === "completed") {
      return { ok: false, reason: "already_completed", claim: raced };
    }
    if (raced?.owner === owner) {
      return { ok: true, claim: raced, resumed: true };
    }
    return { ok: false, reason: "owned_by_other", claim: raced };
  }
}

async function markBatchClaimCompletedUnlocked(
  batchId: string,
  owner: string,
  note?: string,
): Promise<BatchClaim> {
  const existing = await readClaim(batchId);
  if (!existing) {
    throw new Error(`no claim to complete for ${batchId}`);
  }
  if (existing.state !== "claimed" || leaseExpired(existing)) {
    throw new Error(`live claim required for ${batchId}`);
  }
  if (existing.owner !== owner) {
    throw new Error(
      `owner mismatch completing ${batchId}: ${owner} vs ${existing.owner}`,
    );
  }
  const nowIso = new Date().toISOString();
  const done: BatchClaim = {
    ...existing,
    state: "completed",
    updatedAt: nowIso,
    note: note ?? existing.note,
  };
  const path = claimPath(batchId);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(done, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
  return done;
}

export async function readBatchClaim(
  batchId: string,
): Promise<BatchClaim | null> {
  return readClaim(batchId);
}

export async function tryClaimBatch(batchId: string, owner: string, leaseMs = DEFAULT_CLAIM_LEASE_MS): Promise<ClaimAttempt> {
  claimPath(batchId);
  return withFileLock(join(CLAIMS_DIR, ".claims-lock"), () => tryClaimBatchUnlocked(batchId, owner, leaseMs));
}
export async function markBatchClaimCompleted(batchId: string, owner: string, note?: string): Promise<BatchClaim> {
  claimPath(batchId);
  return withFileLock(join(CLAIMS_DIR, ".claims-lock"), () => markBatchClaimCompletedUnlocked(batchId, owner, note));
}

export async function assertLiveBatchClaim(batchId: string, owner: string): Promise<void> {
  const claim = await readClaim(batchId);
  if (!claim || claim.owner !== owner || claim.state !== "claimed" || leaseExpired(claim)) throw new Error("live_claim_required");
}
export async function withLiveBatchClaim<T>(batchId: string, owner: string, fn: () => Promise<T>): Promise<T> {
  claimPath(batchId);
  return withFileLock(join(CLAIMS_DIR, ".claims-lock"), async () => {
    await assertLiveBatchClaim(batchId, owner);
    return fn();
  });
}

/** Nonblocking claim attempt for a bounded inbox waiter. A busy lock does not
 * leave a background claim pending after the wait command has timed out. */
class ClaimGuardClosed extends Error {}
export async function tryClaimBatchNow(batchId: string, owner: string, shouldProceed: () => boolean = () => true): Promise<ClaimAttempt | null> {
  claimPath(batchId);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireFileLock(join(CLAIMS_DIR, ".claims-lock"), 0);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("lock_busy:")) return null;
    throw error;
  }
  try {
    const guard = () => { if (!shouldProceed()) throw new ClaimGuardClosed(); };
    guard();
    return await tryClaimBatchUnlocked(batchId, owner, DEFAULT_CLAIM_LEASE_MS, guard);
  } catch (error) {
    if (error instanceof ClaimGuardClosed) return null;
    throw error;
  } finally { await release(); }
}
