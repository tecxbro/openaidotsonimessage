import { atomicWriteFile, writeExclusiveFile } from "./durable-file.ts";
import { recordLatency } from "./latency.ts";
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
import { mkdir, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireFileLock, withFileLock } from "./file-lock.ts";
import { createHash } from "node:crypto";
import { readUnreadBatch, loadOutboundQueue } from "./storage.ts";
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

async function readClaim(batchId: string): Promise<BatchClaim | null> {
  const path = claimPath(batchId);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) throw new Error();
    const claim = JSON.parse(raw) as BatchClaim;
    if (!claim || typeof claim !== "object" || Array.isArray(claim) || claim.batchId !== batchId || typeof claim.owner !== "string" || !claim.owner.trim() || (claim.spaceIds !== undefined && (!Array.isArray(claim.spaceIds) || claim.spaceIds.some(id => typeof id !== "string" || !id.trim()))) || !["claimed", "completed", "released"].includes(claim.state) || [claim.updatedAt, claim.claimedAt, claim.leaseExpiresAt].some(value => typeof value !== "string") || (claim.note !== undefined && typeof claim.note !== "string") || !Number.isFinite(Date.parse(claim.updatedAt)) || !Number.isFinite(Date.parse(claim.claimedAt)) || !Number.isFinite(Date.parse(claim.leaseExpiresAt))) throw new Error();
    return claim;
  } catch {
    throw new Error("corrupt_or_unreadable_batch_claim");
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
async function loadOwners(guard: () => void = () => {}): Promise<ConversationOwners> {
  try {
    const owners = JSON.parse(await readFile(OWNERS_PATH, "utf8")) as ConversationOwners;
    if (!owners || typeof owners !== "object" || Array.isArray(owners) || Object.entries(owners).some(([key, reservations]) => !/^[a-f0-9]{64}$/.test(key) || !Array.isArray(reservations) || reservations.some(row => !row || typeof row.batchId !== "string" || typeof row.owner !== "string" || !Number.isFinite(Date.parse(row.leaseExpiresAt))))) throw new Error("corrupt_conversation_owners");
    return owners;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("corrupt_conversation_owners");
  }
  return rebuildOwners(guard);
}
async function saveOwners(owners: ConversationOwners, guard: () => void = () => {}): Promise<void> {
  await atomicWriteFile(OWNERS_PATH, JSON.stringify(owners), guard);
}
async function rebuildOwners(guard: () => void = () => {}): Promise<ConversationOwners> {
  const { readdir } = await import("node:fs/promises");
  const owners: ConversationOwners = {};
  for (const name of await readdir(CLAIMS_DIR).catch(() => [])) {
    guard();
    if (!name.endsWith(".json") || name === "conversation-owners.json") continue;
    const claim = await readClaim(name.slice(0, -5)).catch(() => null);
    if (!claim || claim.state !== "claimed" || leaseExpired(claim)) continue;
    for (const spaceId of claim.spaceIds ?? await batchSpaces(claim.batchId)) {
      const key = createHash("sha256").update(spaceId).digest("hex");
      (owners[key] ??= []).push({ batchId: claim.batchId, owner: claim.owner, leaseExpiresAt: claim.leaseExpiresAt });
    }
  }
  // Never discard reservations backed by unreadable ownership records. Their
  // leases cannot authorize work; only explicit evidence-based reconciliation
  // may retire them. Missing claims cannot have authorized an enqueue.
  if (existsSync(OWNERS_PATH)) {
    const previous = JSON.parse(await readFile(OWNERS_PATH, "utf8")) as ConversationOwners;
    for (const [key, reservations] of Object.entries(previous)) for (const row of reservations) {
      try { await readClaim(row.batchId); }
      catch { (owners[key] ??= []).push(row); }
    }
  }
  guard();
  await saveOwners(owners, guard);
  return owners;
}
export async function reconcileConversationOwners(): Promise<void> {
  await withFileLock(join(CLAIMS_DIR, ".claims-lock"), async () => { await rebuildOwners(); });
}
async function reserveConversations(batchId: string, owner: string, leaseExpiresAt: string, guard: () => void): Promise<BatchClaim | null> {
  const owners = await loadOwners(guard);
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
  await saveOwners(owners, guard);
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
  // This function runs under .claims-lock. An existing unreadable/invalid
  // claim is not permission to create a new conversation reservation.
  if (existing === null && existsSync(path)) {
    throw new Error("corrupt_or_unreadable_batch_claim");
  }
  if (existing?.state === "completed") return { ok: false, reason: "already_completed", claim: existing };
  if (existing?.state === "claimed" && existing.owner !== owner && !leaseExpired(existing)) return { ok: false, reason: "owned_by_other", claim: existing };
  if (existing && existing.state !== "claimed" && !leaseExpired(existing, now)) return { ok: false, reason: "owned_by_other", claim: existing };
  const priorOwners = await loadOwners(assertCanProceed);
  let published = false;
  try {
    const conflict = await reserveConversations(batchId, owner, leaseExpiresAt, assertCanProceed);
    if (conflict) return { ok: false, reason: "owned_by_other", claim: conflict };
    const resumed = existing?.owner === owner && existing.state === "claimed";
    const claim: BatchClaim = resumed ? { ...existing, updatedAt: nowIso, leaseExpiresAt } : {
      batchId, owner, state: "claimed", claimedAt: nowIso, updatedAt: nowIso, leaseExpiresAt, spaceIds: await batchSpaces(batchId),
    };
    assertCanProceed();
    const body = `${JSON.stringify(claim, null, 2)}\n`;
    if (existing) await atomicWriteFile(path, body, assertCanProceed);
    else await writeExclusiveFile(path, body, assertCanProceed);
    published = true;
    recordLatency("claimedAt", batchId);
    return { ok: true, claim, resumed };
  } finally {
    if (!published) {
      // If sync failed after atomic publication, the valid claim is visible.
      // Preserve its reservation; otherwise restore the complete prior state.
      const current = await readClaim(batchId).catch(() => undefined);
      if (!current || current.updatedAt !== nowIso || current.owner !== owner) await saveOwners(priorOwners);
    }
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
  await atomicWriteFile(path, `${JSON.stringify(done, null, 2)}\n`);
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
  let claim: BatchClaim | null;
  try { claim = await readClaim(batchId); }
  catch { throw new Error("live_claim_required: corrupt_or_unreadable_batch_claim"); }
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
    if (error instanceof ClaimGuardClosed) {
      return null;
    }
    throw error;
  } finally { await release(); }
}

/** Deliberate offline reconciliation, never automatic stealing/reprocessing.
 * A corrupt claim remains blocking unless queue acceptance (the completion
 * contract) or a runtime-handled batch supplies durable result evidence. */
export async function reconcileCorruptBatchClaim(batchId: string, owner: string): Promise<{ resolved: boolean; evidence: string[] }> {
  const path = claimPath(batchId);
  return withFileLock(join(CLAIMS_DIR, '.claims-lock'), async () => {
    try { await readClaim(batchId); throw new Error('corrupt_claim_required'); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'corrupt_or_unreadable_batch_claim') throw error; }
    const owners = await loadOwners();
    const reservations = Object.values(owners).flat().filter(row => row.batchId === batchId);
    if (!owner.trim() || reservations.some(row => row.owner !== owner)) throw new Error('reconciliation_owner_mismatch');
    const batch = await readUnreadBatch(batchId);
    const actions = (await loadOutboundQueue()).filter(item => (item.requestId?.startsWith(`${batchId}:`) || item.requestId === `cards:${batchId}`) && batch.messages.some(message => message.spaceId === item.spaceId));
    const evidence = batch.handledBy ? ['runtime-handled-batch'] : actions.filter(item => item.requestHash || item.canonicalRequestHash).map(item => item.id);
    if (!evidence.length) return { resolved: false, evidence };
    const corrupt = await readFile(path, 'utf8');
    const archive = join(CLAIMS_DIR, `${batchId}.corrupt`);
    if (existsSync(archive)) {
      if (await readFile(archive, 'utf8') !== corrupt) throw new Error('corrupt_claim_archive_conflict');
    } else await writeExclusiveFile(archive, corrupt);
    const at = new Date().toISOString();
    const completed: BatchClaim = { batchId, owner, state: 'completed', claimedAt: at, updatedAt: at, leaseExpiresAt: at, spaceIds: await batchSpaces(batchId), note: `corrupt claim reconciled from durable results: ${evidence.join(',')}` };
    await atomicWriteFile(path, JSON.stringify(completed));
    for (const key of Object.keys(owners)) {
      owners[key] = owners[key]!.filter(row => row.batchId !== batchId);
      if (!owners[key]!.length) delete owners[key];
    }
    await saveOwners(owners);
    await unlink(join(DATA_DIR, 'dot-inbox', `${batchId}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    return { resolved: true, evidence };
  });
}
