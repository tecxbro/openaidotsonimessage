/** Offline, explicit recovery policy. Never derives a new cutoff on startup. */
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "./file-lock.ts";
import { DATA_DIR } from "./types.ts";

export const RECOVERY_POLICY_NAME = "recovery-policy.json";
export type RecoveryPolicy = Readonly<{
  version: 1;
  mode: "provider-event-cutover";
  eventCutoverUtc: string;
  suppressOnboarding: true;
}>;

/** Strict UTC only: no locale parsing, epoch guesses, or calendar rollover. */
export function canonicalUtc(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error("invalid_recovery_timestamp");
  }
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new Error("invalid_recovery_timestamp");
  }
  return normalized;
}

export function recoveryPolicyRequired(value = process.env.BRIDGE_REQUIRE_RECOVERY_POLICY): boolean {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("invalid_recovery_requirement");
}

export async function loadRecoveryPolicy(required = false, directory = DATA_DIR): Promise<RecoveryPolicy | undefined> {
  let body: string;
  try { body = await readFile(join(directory, RECOVERY_POLICY_NAME), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("recovery_policy_unreadable");
    if (required) throw new Error("recovery_policy_required");
    return undefined;
  }
  try {
    const policy = JSON.parse(body);
    if (policy?.version !== 1 || policy.mode !== "provider-event-cutover" || policy.suppressOnboarding !== true) {
      throw new Error();
    }
    return Object.freeze({ version: 1, mode: "provider-event-cutover", eventCutoverUtc: canonicalUtc(policy.eventCutoverUtc), suppressOnboarding: true });
  } catch { throw new Error("invalid_recovery_policy"); }
}

/** Runtime input is the pinned SDK Date, never local arrival time or an ID. */
export function isAfterRecoveryCutover(policy: RecoveryPolicy, timestamp: unknown): boolean {
  return timestamp instanceof Date && Number.isFinite(timestamp.getTime()) &&
    timestamp.getTime() > Date.parse(policy.eventCutoverUtc);
}

/** Durable records store the exact admitted provider event time as UTC. */
export function assertRecoveryTimestamp(policy: RecoveryPolicy, timestamp: unknown): void {
  let normalized: string;
  try { normalized = canonicalUtc(timestamp); }
  catch { throw new Error("recovery_state_timestamp_rejected"); }
  if (!isAfterRecoveryCutover(policy, new Date(normalized))) throw new Error("recovery_state_timestamp_rejected");
}

/** Requires empty private state, not a forgotten queue or a reconstructed history. */
export async function initializeRecoveryPolicy(eventCutoverUtc: string, suppressOnboarding: true, directory = DATA_DIR): Promise<RecoveryPolicy> {
  const policy: RecoveryPolicy = { version: 1, mode: "provider-event-cutover", eventCutoverUtc: canonicalUtc(eventCutoverUtc), suppressOnboarding };
  if (suppressOnboarding !== true) throw new Error("explicit_onboarding_suppression_required");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(join(directory, ".runtime-lock"), 0);
  try {
    const existing = await loadRecoveryPolicy(false, directory);
    if (existing) {
      if (existing.eventCutoverUtc !== policy.eventCutoverUtc) throw new Error("recovery_cutover_already_set");
      return existing;
    }
    const allowed = new Set([".gitkeep", ".runtime-lock", ".runtime-lock.lock"]);
    if ((await readdir(directory)).some(name => !allowed.has(name))) throw new Error("recovery_requires_fresh_data_directory");
    // Exclusive creation + fsync. A crash leaving a partial file fails closed;
    // never replace an existing boundary or silently repair a corrupt policy.
    const file = await open(join(directory, RECOVERY_POLICY_NAME), "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(policy, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    return Object.freeze(policy);
  } finally { await release(); }
}
