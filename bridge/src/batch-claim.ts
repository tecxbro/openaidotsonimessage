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
import { createHash } from "node:crypto";
import { readUnreadBatch } from "./storage.ts";
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
  spaceIds?: string[];
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
    const claim = JSON.parse(raw) as BatchClaim;
    if (claim.batchId !== batchId || typeof claim.owner !== "string" || !["claimed", "completed", "released"].includes(claim.state) || !Number.isFinite(Date.parse(claim.updatedAt)) || !Number.isFinite(Date.parse(claim.claimedAt)) || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) return null;
    return claim;
  } catch {
    return null;
  }
}

function leaseExpired(claim: BatchClaim, now = Date.now()): boolean {
  const exp = Date.parse(claim.leaseExpiresAt);
  return !Number.isFinite(exp) || exp <= now;
}

type Reservation = { batchId: string; owner: string; leaseExpiresAt: string };
type ConversationOwners = Record<string, Reservation[]>;
const OWNERS_PATH = join(CLAIMS_DIR, "conversation-owners.json");
async function batchSpaces(batchId: string): Promise<string[]> {
  try { return [...new Set((await readUnreadBatch(batchId)).messages.map(message => message.spaceId))]; }
  catch (error) {
    // Low-level legacy claims without payload cannot authorize an agent enqueue.
    if (error instanceof Error && error.message.startsWith("unread batch not found:")) return [];
    throw error;
  }
}
async function loadOwners(): Promise<ConversationOwners> {
  try { return JSON.parse(await readFile(OWNERS_PATH, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("corrupt_conversation_owners");
  }
  return rebuildOwners();
}
async function saveOwners(owners: ConversationOwners): Promise<void> {
  const tmp = `${OWNERS_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(owners), { mode: 0o600 });
  await rename(tmp, OWNERS_PATH);
}
async function rebuildOwners(): Promise<ConversationOwners> {
  const { readdir } = await import("node:fs/promises");
  const owners: ConversationOwners = {};
  for (const name of await readdir(CLAIMS_DIR).catch(() => [])) {
    if (!name.endsWith(".json") || name === "conversation-owners.json") continue;
    const claim = await readClaim(name.slice(0, -5));
    if (!claim || claim.state !== "claimed" || leaseExpired(claim)) continue;
    for (const spaceId of claim.spaceIds ?? await batchSpaces(claim.batchId)) {
      const key = createHash("sha256").update(spaceId).digest("hex");
      (owners[key] ??= []).push({ batchId: claim.batchId, owner: claim.owner, leaseExpiresAt: claim.leaseExpiresAt });
    }
  }
  await saveOwners(owners);
  return owners;
}
export async function reconcileConversationOwners(): Promise<void> {
  await withFileLock(join(CLAIMS_DIR, ".claims-lock"), async () => { await rebuildOwners(); });
}
async function reserveConversations(batchId: string, owner: string, leaseExpiresAt: string, guard: () => void): Promise<BatchClaim | null> {
  const owners = await loadOwners();
  const spaces = await batchSpaces(batchId);
  for (const spaceId of spaces) {
    const key = createHash("sha256").update(spaceId).digest("hex");
    const live: Reservation[] = [];
    for (const reservation of owners[key] ?? []) {
      const record = await readClaim(reservation.batchId);
      if (record?.state === "completed") continue;
      if (Date.parse(reservation.leaseExpiresAt) <= Date.now()) continue;
      if (reservation.owner !== owner) return record ?? { ...reservation, state: "claimed", claimedAt: "", updatedAt: "" };
      if (reservation.batchId !== batchId) live.push(reservation);
    }
    owners[key] = [...live, { batchId, owner, leaseExpiresAt }];
  }
  // Reserve before claim publication. A crash retains a lease-bound owner;
  // another task cannot answer while that owner can still enqueue.
  guard();
  await saveOwners(owners);
  return null;
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
  if (existing?.state === "completed") return { ok: false, reason: "already_completed", claim: existing };
  if (existing?.state === "claimed" && existing.owner !== owner && !leaseExpired(existing)) return { ok: false, reason: "owned_by_other", claim: existing };
  const conflict = await reserveConversations(batchId, owner, leaseExpiresAt, assertCanProceed);
  if (conflict) return { ok: false, reason: "owned_by_other", claim: conflict };
  if (existing) {
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
    spaceIds: await batchSpaces(batchId),
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
  // Completion and deduplication evidence stay durable; only the active notice retires.
  await unlink(join(DATA_DIR, "dot-inbox", `${batchId}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  const owners = await loadOwners();
  for (const key of Object.keys(owners)) {
    owners[key] = owners[key]!.filter(reservation => reservation.batchId !== batchId);
    if (!owners[key]!.length) delete owners[key];
  }
  await saveOwners(owners);
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
