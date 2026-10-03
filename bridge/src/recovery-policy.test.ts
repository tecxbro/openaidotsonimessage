import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, Space, Spectrum } from "@spectrum-ts/core";
import { DATA_DIR } from "./types.ts";
import { acquireFileLock } from "./file-lock.ts";
import { GpProofRuntime } from "./runtime.ts";
import { pendingDotBatches } from "./dot-inbox.ts";
import { appendInbound, loadHandledIds, loadOutboundQueue, loadPendingBatch, savePendingBatch, writeUnreadBatch } from "./storage.ts";
import { pendingMediaJobs, saveMediaJob, type MediaJob } from "./media-jobs.ts";
import { hasSetupConfettiBeenSent, SETUP_CONFETTI_MARKER_PATH } from "./setup-confetti.ts";
import { canonicalUtc, initializeRecoveryPolicy, isAfterRecoveryCutover, loadRecoveryPolicy, RECOVERY_POLICY_NAME, recoveryPolicyRequired } from "./recovery-policy.ts";

const CUTOFF = "2026-01-01T00:00:00.000Z";
const NEW_TIME = "2026-01-01T00:00:01.000Z";
const policyPath = join(DATA_DIR, RECOVERY_POLICY_NAME);
const config = { projectId: "test-only", projectSecret: "test-only", authorizedSenderId: "owner", hostMode: "dot-local" as const, greetingFastPath: false, requireRecoveryPolicy: true };
type Probe = {
  onMessage(space: Space, message: Message): Promise<void>;
  flushPending(): Promise<void>;
};

beforeEach(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
});

function fixture() {
  let reads = 0, downloads = 0, typing = 0, sends = 0, lookups = 0;
  const space = { id: "space", type: "dm", phone: "line", send: async () => { sends++; return { id: "sent" }; }, startTyping: async () => { typing++; }, stopTyping: async () => {}, getMessage: async () => { lookups++; return undefined; } } as unknown as Space;
  const message = (id: string, timestamp: unknown, content: unknown = { type: "text", text: "fresh fixture question" }) => ({ id, timestamp, content, platform: "imessage", direction: "inbound", sender: { id: "owner" }, read: async () => { reads++; } }) as unknown as Message;
  const media = { type: "attachment", name: "fixture.txt", mimeType: "text/plain", read: async () => { downloads++; return Buffer.from("fixture only"); } };
  const runtime = new GpProofRuntime(config);
  return { runtime, probe: runtime as unknown as Probe, space, message, media, counts: () => ({ reads, downloads, typing, sends, lookups }) };
}

async function startOfflineRuntime() {
  let finish: ((value: IteratorResult<[Space, Message]>) => void) | undefined;
  let connected = 0;
  const messages: AsyncIterable<[Space, Message]> = { [Symbol.asyncIterator]() { return { next: () => new Promise(resolve => { finish = resolve; }) }; } };
  const connect = (async () => { connected++; return { messages, stop: async () => { finish?.({ done: true, value: undefined }); } }; }) as unknown as typeof Spectrum;
  const runtime = new GpProofRuntime(config, connect);
  const running = runtime.start();
  for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(5);
  expect(connected).toBe(1);
  expect(finish).toBeDefined();
  return { runtime, probe: runtime as unknown as Probe, stop: async () => { await runtime.stop(); await running; } };
}

describe("explicit offline recovery initialization", () => {
  test("persists one immutable UTC boundary without inventing onboarding history", async () => {
    const policy = await initializeRecoveryPolicy(CUTOFF, true);
    expect(await loadRecoveryPolicy(true)).toEqual(policy);
    expect((await stat(policyPath)).mode & 0o777).toBe(0o600);
    expect(await hasSetupConfettiBeenSent()).toBe(false);
    expect(existsSync(SETUP_CONFETTI_MARKER_PATH)).toBe(false);
    await writeFile(join(DATA_DIR, "later-state.json"), "{}");
    const before = await readFile(policyPath, "utf8");
    expect(await initializeRecoveryPolicy("2026-01-01T00:00:00Z", true)).toEqual(policy);
    await expect(initializeRecoveryPolicy(NEW_TIME, true)).rejects.toThrow("recovery_cutover_already_set");
    expect(await readFile(policyPath, "utf8")).toBe(before);
  });

  test("refuses existing state and active runtime ownership", async () => {
    await writeFile(join(DATA_DIR, "outbound-queue.json"), '{"items":[]}');
    await expect(initializeRecoveryPolicy(CUTOFF, true)).rejects.toThrow("fresh_data_directory");
    expect(existsSync(policyPath)).toBe(false);
    await rm(join(DATA_DIR, "outbound-queue.json"));
    const release = await acquireFileLock(join(DATA_DIR, ".runtime-lock"), 0);
    try { await expect(initializeRecoveryPolicy(CUTOFF, true)).rejects.toThrow("lock_busy"); }
    finally { await release(); }
    expect(existsSync(policyPath)).toBe(false);
  });

  test("missing, corrupt and disabled required policy fail closed", async () => {
    expect(await loadRecoveryPolicy()).toBeUndefined();
    await expect(loadRecoveryPolicy(true)).rejects.toThrow("recovery_policy_required");
    for (const body of ["{", "null", '{}', JSON.stringify({ version: 1, mode: "provider-event-cutover", eventCutoverUtc: CUTOFF, suppressOnboarding: false })]) {
      await writeFile(policyPath, body);
      await expect(loadRecoveryPolicy()).rejects.toThrow("invalid_recovery_policy");
      await expect(initializeRecoveryPolicy(CUTOFF, true)).rejects.toThrow("invalid_recovery_policy");
    }
    expect(recoveryPolicyRequired(undefined)).toBe(false);
    expect(recoveryPolicyRequired("1")).toBe(true);
    expect(() => recoveryPolicyRequired("true")).toThrow("invalid_recovery_requirement");
  });

  test("strict UTC rejects ambiguous dates, rollout, strings and local-arrival fallbacks", async () => {
    for (const value of ["now", "2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00.0000Z", undefined, 123]) {
      expect(() => canonicalUtc(value)).toThrow("invalid_recovery_timestamp");
    }
    const policy = await initializeRecoveryPolicy(CUTOFF, true);
    for (const timestamp of [undefined, null, "2026-01-01T00:00:01Z", 1767225601000, new Date(NaN), new Date(CUTOFF), new Date("2025-01-01")]) {
      expect(isAfterRecoveryCutover(policy, timestamp)).toBe(false);
    }
    expect(isAfterRecoveryCutover(policy, new Date(NEW_TIME))).toBe(true);
  });

  test("CLI initializes offline and required-policy failure precedes credential retrieval", async () => {
    const directory = join(DATA_DIR, "cli-fixture");
    const env = { ...process.env, BRIDGE_DATA_DIR: directory, SPECTRUM_PROJECT_ID: "test-only", AUTHORIZED_SENDER_ID: "owner", PHOTON_CLI: "/nonexistent-never-invoked-cli", BRIDGE_REQUIRE_RECOVERY_POLICY: "1" };
    const start = Bun.spawn([process.execPath, new URL("./start-dot.ts", import.meta.url).pathname], { env, stdout: "pipe", stderr: "pipe" });
    expect(await start.exited).toBe(1);
    const error = await new Response(start.stderr).text();
    expect(error).toContain('"stage":"validate_configuration"');
    expect(error).not.toContain("read_existing_credential_via_cli");
    const cli = new URL("./recovery-init.ts", import.meta.url).pathname;
    const init = Bun.spawn([process.execPath, cli, "--event-cutover-utc", CUTOFF, "--suppress-onboarding"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await init.exited).toBe(0);
    expect((await loadRecoveryPolicy(true, directory))!.eventCutoverUtc).toBe(CUTOFF);
    expect(existsSync(join(directory, "outbound-queue.json"))).toBe(false);
    expect(existsSync(join(directory, "runtime-diagnostics.jsonl"))).toBe(false);
  });
});

describe("provider-event cutoff at bridge ingress", () => {
  test("old, equal, missing and invalid events have no bridge side effects for any supported kind", async () => {
    await initializeRecoveryPolicy(CUTOFF, true);
    const f = fixture();
    try {
      const contents = [
        { type: "text", text: "PRIVATE_OLD_TEXT" },
        { type: "text", text: "hi" },
        { type: "reaction", emoji: "👍", target: { id: "old-card" } },
        { type: "poll_option", title: "PRIVATE_OLD_OPTION", selected: true },
        { type: "read", target: { id: "old-send" } },
        f.media,
        { ...f.media, type: "voice" },
      ];
      let id = 0;
      for (const timestamp of [new Date("2025-12-31T23:59:59Z"), new Date(CUTOFF), undefined, new Date(NaN), NEW_TIME]) {
        for (const content of contents) await f.probe.onMessage(f.space, f.message(`rejected-${++id}`, timestamp, content));
      }
      await f.probe.flushPending();
      expect(f.counts()).toEqual({ reads: 0, downloads: 0, typing: 0, sends: 0, lookups: 0 });
      expect(await loadPendingBatch()).toEqual([]);
      expect(await loadHandledIds()).toEqual(new Set());
      expect(await pendingDotBatches()).toEqual([]);
      expect(await loadOutboundQueue()).toEqual([]);
      expect(await pendingMediaJobs()).toEqual([]);
      for (const name of ["inbound.jsonl", "conversation-context.json", "receipts.jsonl", "receipt-targets.json", "dot-inbox", "media-jobs", "inbound-attachments"]) {
        expect(existsSync(join(DATA_DIR, name))).toBe(false);
      }
      expect(existsSync(SETUP_CONFETTI_MARKER_PATH)).toBe(false);
    } finally { await f.runtime.stop(); }
  });

  test("new events preserve the normal batch contract and suppress only onboarding without a fake marker", async () => {
    await initializeRecoveryPolicy(CUTOFF, true);
    const f = fixture();
    try {
      await f.probe.onMessage(f.space, f.message("fresh-text", new Date(NEW_TIME)));
      await f.probe.onMessage(f.space, f.message("fresh-media", new Date(NEW_TIME), f.media));
      await f.probe.flushPending();
      const batches = await pendingDotBatches();
      const records = batches.flatMap(batch => batch.messages);
      expect(records.map(m => m.id)).toEqual(["fresh-text", "fresh-media"]);
      expect(records.map(m => m.timestamp)).toEqual([NEW_TIME, NEW_TIME]);
      expect(f.counts().reads).toBe(2);
      expect(f.counts().downloads).toBe(1);
      const job = JSON.parse(await readFile(join(DATA_DIR, "media-jobs", "fresh-media.json"), "utf8"));
      expect(job.recoveryEventTimestamp).toBe(NEW_TIME);
      expect(await loadOutboundQueue()).toEqual([]);
      expect(existsSync(SETUP_CONFETTI_MARKER_PATH)).toBe(false);
    } finally { await f.runtime.stop(); }
  });

  test("restart keeps the original cutoff and standard handled-ID deduplication", async () => {
    await initializeRecoveryPolicy(CUTOFF, true);
    const f = fixture();
    const first = await startOfflineRuntime();
    await first.probe.onMessage(f.space, f.message("accepted-once", new Date(NEW_TIME)));
    await first.stop();
    const before = await readFile(policyPath, "utf8");
    const second = await startOfflineRuntime();
    try {
      await second.probe.onMessage(f.space, f.message("accepted-once", new Date(NEW_TIME)));
      await second.probe.onMessage(f.space, f.message("old-after-restart", new Date("2025-12-31")));
      await second.probe.onMessage(f.space, f.message("new-after-restart", new Date("2026-01-01T00:00:02Z")));
    } finally { await second.stop(); }
    expect(f.counts().reads).toBe(2);
    expect((await readFile(join(DATA_DIR, "inbound.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await readFile(policyPath, "utf8")).toBe(before);
    expect(await loadOutboundQueue()).toEqual([]);
    expect(existsSync(SETUP_CONFETTI_MARKER_PATH)).toBe(false);
  });

  test("media restart requires original admitted event time before lookup and preserves it", async () => {
    await initializeRecoveryPolicy(CUTOFF, true);
    const f = fixture();
    let lookups = 0;
    const probe = f.runtime as unknown as { spaces: Map<string, Space>; resumeMedia(job: MediaJob): Promise<void> };
    (f.space as unknown as { getMessage(): Promise<Message> }).getMessage = async () => {
      lookups++;
      return f.message("resumed-media", new Date("2020-01-01"), f.media);
    };
    probe.spaces.set("space", f.space);
    const job: MediaJob = { messageId: "resumed-media", spaceId: "space", senderId: "owner", state: "pending", createdAt: NEW_TIME };
    try {
      await probe.resumeMedia(job);
      await probe.resumeMedia({ ...job, recoveryEventTimestamp: CUTOFF });
      expect(lookups).toBe(0);
      await probe.resumeMedia({ ...job, recoveryEventTimestamp: NEW_TIME });
      expect(lookups).toBe(1);
      expect((await loadPendingBatch())[0]!.timestamp).toBe(NEW_TIME);
      expect(f.counts().downloads).toBe(1);
    } finally { await f.runtime.stop(); }
  });

  test("missing or corrupt policy and old persisted work refuse startup before provider connection", async () => {
    for (const state of ["missing", "corrupt", "pending", "unread", "inbound", "media"] as const) {
      await rm(DATA_DIR, { recursive: true, force: true });
      await mkdir(DATA_DIR, { recursive: true });
      if (state !== "missing") await initializeRecoveryPolicy(CUTOFF, true);
      if (state === "corrupt") await writeFile(policyPath, '{"secret":"PRIVATE_SENTINEL"');
      const old = { id: "old", spaceId: "space", senderId: "owner", text: "PRIVATE_SENTINEL", timestamp: "2025-01-01T00:00:00.000Z", receivedAt: NEW_TIME };
      if (state === "pending") await savePendingBatch([old]);
      if (state === "inbound") await appendInbound(old);
      if (state === "unread") await writeUnreadBatch({ batchId: "old-batch", flushedAt: NEW_TIME, messages: [old] });
      if (state === "media") await saveMediaJob({ messageId: "old", spaceId: "space", senderId: "owner", state: "pending", createdAt: NEW_TIME });
      let connected = false;
      const runtime = new GpProofRuntime(config, (async () => { connected = true; throw new Error("provider must not start"); }) as unknown as typeof Spectrum);
      await expect(runtime.start()).rejects.toThrow("runtime_start_failed");
      await runtime.stop();
      expect(connected).toBe(false);
      expect(await pendingDotBatches()).toEqual([]);
      expect(await loadOutboundQueue()).toEqual([]);
      expect(await readFile(join(DATA_DIR, "runtime-diagnostics.jsonl"), "utf8")).not.toContain("PRIVATE_SENTINEL");
    }
  });
});
