# Repair verification — October 2, 2026 (America/Los_Angeles)

Repository: `tecxbro/openaidotsonimessage`. Branch: `codex/immediate-dispatch-with-controls`.
The initial checkout was clean and HEAD exactly matched reviewed baseline `4ff6c4799716300b17c5d246ca58c9eb385d6a95`. No unrelated changes existed to preserve. Source tested and benchmarked: `5d2408194461176656a2f9c10440c489dd13a235` (later evidence-only commits do not change that source).

All requested code findings applied at that baseline; none was already fixed. The existing deadline helper correctly bounded observation, but callers discarded durable completion ownership. Existing tests named journal-only recovery and media deadline did not cover a missing snapshot or late input commit.

## Findings and ownership

| Finding | Repair and result |
| --- | --- |
| A1: media timeout/completion | `MediaWorker` owns admission, execution and synced job completion. Observer deadlines neither cancel valid queued work nor detach completion. Per-message ownership prevents duplicate processing after observer departure. Queued work has no execution deadline while the runtime remains alive; shutdown cancels admission and records deferred pending work. Running execution uses existing download/STT subprocess policies and keeps its slot until actual settlement and durable completion. Later text includes pending media. |
| A2: late send success | An SDK invocation's continuation persists its own acceptance and message ID. Durable attempt tokens fence old callbacks; timeout cannot downgrade sent/read state. Provider tasks include reconciliation through teardown. Missing IDs remain unknown; ambiguous sends are never resent automatically. |
| A3: shutdown before send | Lifecycle cancellation preserves the original queued action without consuming a retry. Validation/auth failures remain failures; invoked uncertain sends remain quarantined. The SDK boundary checks shutdown and owner authority immediately before the call. |
| A4: corrupt claims | Missing claims return null; valid claims return ownership; unreadable/invalid claims throw explicitly before reservation. Initial publication uses a synced temporary file and an exclusive atomic hard link. Failed unpublished attempts restore prior reservations. Corrupt reservations survive owner rebuild. Explicit offline reconciliation requires durable queue-result/runtime-completion evidence, archives the corrupt contents, and completes the claim instead of reauthorizing work. Without evidence it returns unresolved and preserves ownership. |
| A5: coordination | Outbound has one pump and one rerun flag. Removed outbound participation in maintenance coordination, the per-item sending set, and the flushing flag. All flushes use the existing commit chain. `mediaWork`/runtime limiter coordination was replaced by the worker's per-message ownership map, which includes durable completion; media execution moved out of intake. Existing ancillary maintenance remains separate. |
| B-A: journal recovery | Recovery reads both synced inbound journal and snapshots, merges with pending input, excludes already-published input, deduplicates by ID, and applies cutoff checks before recovery admission. Invalid journal JSON fails explicitly. |
| B-B: JSON validation | One queue validation gate checks action object/kind/fields and concrete types before preparation. Action-file envelopes are validated too. App helpers reject wrong URL/live types; omitted live still defaults to false. |
| B-C: accepted retries | Authorized idempotency/hash checks precede file preparation and are repeated at commit after preparation. Unchanged retries reuse original records even when source files disappeared. Key ordering remains canonical, array order remains meaningful, and changed content is rejected. Legacy raw hashes remain supported. |
| B-D: metadata repair | Accepted poll/app/card work is reconciled on the same pump. Session evidence is saved with acceptance before derived files. Missing app evidence can be recovered by safe lookup; unavailable evidence stays pending. Poll/card reconstruction needs no send or source-file read. Presentation writes now reuse the synced atomic helper. |
| B-E: lost ownership | Acquired file leases expose loss and assert authority. Startup wrappers pass the lease to the runtime; helper loss triggers controlled teardown and blocks new sends. Releasing a lost lease cannot delete a replacement's metadata. Diagnostic greeting uses the verified original conversation's durable queue rather than another provider connection. |

The original-conversation gates, recovery cutoff, prompt/routing files, provider/model versions, text formatting, threaded replies, reactions, effects, poll/voice payloads, grouped cards, app sheets and Live Mini payloads are preserved. Typing/read controls remain enabled. No provider switch, database migration, framework, wake endpoint, dependency installation or live operation was performed.

The narrow guard and boolean fixes alone did not resolve the broader findings; the worker, claim publication/reconciliation and canonical action validation repairs above address those separately. Unresolved corrupt claims without durable evidence and unavailable accepted-app session evidence deliberately remain pending/blocking and require reconciliation or new evidence.

## Exact production changes

| File | Changed functions/types |
| --- | --- |
| `bridge/src/runtime.ts` | `GpProofRuntime.constructor`, `startInner`, `stop`, `stopInner`, `onMessage` (owned `finishInput`), `scheduleFlush`, `flushPending`/new `flushPendingInner`, `runMaintenance`, `requestMaintenance`, `drainOutbound`, `drainOutboundInner`, `sendOutbound` (owned `invoke`/acceptance continuation), `retryBeforeSend`, new `repairOutboundMetadata`, `extractAppCardSession`; removed `quarantineSend` and overlapping state. `resumeMedia` continues into the same repaired intake/worker path. |
| `bridge/src/media-jobs.ts` | Extended `MediaJob`; new `MediaWorker.observe`, `tasks`, `write`; new `processInboundMedia`. Existing `MediaJobLimiter.run` now owns a callback that includes durable completion. |
| `bridge/src/operation-deadline.ts` | Inspected and reused unchanged: `withDeadline` and `settleWithin` bound observation, not cancellation. |
| `bridge/src/storage.ts` | New `loadDurableInbound`, `validateOutboundInput`, `beginOutboundAttempt`; changed `validateId`, `enqueueOutbound`, `updateOutbound` (attempt fencing and accepted-state protection). |
| `bridge/src/recovery.ts` | `recoverDurableState`. |
| `bridge/src/batch-claim.ts` | `readClaim`, `rebuildOwners`, `tryClaimBatchUnlocked`, `assertLiveBatchClaim`, `tryClaimBatchNow`; new `reconcileCorruptBatchClaim`; removed redundant cancellation rollback and exclusive-create race branch under the existing lock. |
| `bridge/src/durable-file.ts` | `writeExclusiveFile`; existing `atomicWriteFile` reused for presentations. |
| `bridge/src/dot-agent.ts` | `enqueueBatchAction`, `replyToBatch` corruption error compatibility, action-file CLI JSON boundary. |
| `bridge/src/outbound-app.ts` | `prepareOutboundApp`. |
| `bridge/src/reply-fallback.ts` | `messageId`, `sendReplyWithFallback`. |
| `bridge/src/reaction-option.ts` | `atomicWriteJson`; new `hasAttachmentGroupMapping`. |
| `bridge/src/file-lock.ts` | `acquireFileLock`, `withFileLock`, new `FileLockLease`. |
| `bridge/src/index.ts`, `start-dot.ts` | Startup lease binding/authority check; CLI credential retrieval remains unchanged. |
| `bridge/src/send-hello.ts` | New `enqueueDiagnosticGreeting` and CLI queue submission; removed standalone provider creation/send. |
| `bridge/src/reconcile-claim.ts` | New offline evidence-based claim reconciliation CLI. |
| `bridge/src/runtime-notifications.ts` | `watchPublicationDirectory` now checks final entry fingerprints on directory events, because this host's watcher coalesced publication events under lock/temp filenames. No timeout relaxation or polling dependency was added. |
| `bridge/src/runtime-diagnostics.ts` | `RuntimeDiagnostics.lifecycle` accepts fixed `ownership_lost` trigger. |
| `bridge/src/types.ts` | Additive attempt/session/metadata evidence and pending-media error types; existing durable formats remain readable. |
| `bridge/src/benchmark-latency.ts` | Fake read/typing implementations, counters and assertions; controls are exercised in both benchmark modes. |

## Regression evidence and tests

Applicable failures were reproduced offline before their repair. Initial narrow tests failed 2/2; runtime repair tests failed 5/5; initial claim publication/rollback tests failed 2/2; missing corruption reconciliation failed; reply missing-ID/lifecycle tests failed 2/2; journal-only/cutoff tests failed 2/2; action validation failed 2/2; accepted-source retry tests failed 2/2; metadata tests failed 3/3; killed-helper test timed out waiting for teardown; the diagnostic source check demonstrated a second-provider executable without running it. Additional fencing, unavailable-evidence, replacement-metadata and late-rich-action assertions extend coverage after those reproductions.

| New/extended test file | Coverage |
| --- | --- |
| `runtime-repair.test.ts` (10) | Late media commit once and duplicate intake; queued deadline; shutdown with queued/running media; late successful send during teardown; lookup/shutdown/replacement with same action; old attempt fencing; late reply/poll/app/group outcomes and metadata. |
| `claim-publication.test.ts` (3) | Interrupted atomic exclusive publication; failure after reservation; corrupt ownership/evidence reconciliation, archive preservation, owner mismatch and later-batch safety. |
| `batch-claim.test.ts` (+1) | Truncated JSON and invalid schema do not reserve another conversation; valid ownership/renewal/competition tests preserved. |
| `outbound-app.test.ts` (+1), `reply-fallback.test.ts` (+2) | Mistyped URL/live rejection; missing message ID stays unknown; lifecycle cancellation propagates without fallback. |
| `recovery-journal.test.ts` (2) | True journal-only input, deduplication across representations and recovery cutoff. |
| `action-validation.test.ts` (2) | Malformed runtime values, unknown kinds/fields, boolean coercion, malformed action-file envelopes; no queue publication. |
| `accepted-action.test.ts` (2) | Deleted source files, canonical object ordering, significant array ordering, changed-content rejection and authorization. |
| `metadata-repair.test.ts` (4) | Accepted poll/group recovery without files or sends; app metadata write failure; legacy session lookup; unavailable evidence pending. |
| `lock-loss.test.ts` (2), `diagnostic-owner.test.ts` (1) | Killed disposable helper revokes sends; lost release preserves replacement metadata; diagnostics retain conversation authorization and idempotency on the existing queue. |
| `runtime-diagnostics.test.ts` | Fixtures now target the sole outbound pump/work boundary. Existing failure, single-flight, recovery, signal and secrecy assertions retained. |

Final `bun run --cwd bridge typecheck`: passed. Final `bun test --cwd bridge`: **179 pass, 0 fail, 916 assertions, 31 files, 30.23 s**, plus existing top-level assertion suites. Phase A gate: 162 pass, 0 fail, 839 assertions. Existing cross-process enqueue/notification, kernel/signal ownership, recovery cutoff, card grouping/mapping, formatting and control tests ran in the complete suite. No existing assertions were weakened or fixture timeouts extended.

Installed versions: Bun **1.3.14**, Node **23.11.0**, TypeScript **6.0.3**, Spectrum core/imessage **12.10.1**. The package declares Bun **>=1.4.2**, so this successful local run does not validate the declared supported Bun version.

Offline preflight exited 1. Passed: Bun availability, SDK import, hosted provider import, flock, FFmpeg, ffprobe. Failed: Moonshine import/version, model file presence, model integrity. It used an empty temporary data directory and did not inspect or modify live queues. Preflight's Bun check only checks availability, not its minimum version. No STT installation/model download was performed.

## Final synthetic latency

100 measured samples per producer after 10 excluded warmups; macOS/Bun 1.3.14; source `5d2408194461176656a2f9c10440c489dd13a235`. One injected provider connection and 110 substantive fake responses per run. Each run recorded 110 reads, 110 typing starts and 110 typing stops; controls were enabled and completed.

All values below are **p50 / p95 / maximum milliseconds**.

| Boundary | Same-process fake agent | Separate CLI fake agent |
| --- | ---: | ---: |
| Input commit to publication | 17.960 / 36.782 / 122.447 | 17.056 / 26.186 / 53.592 |
| Publication to claim | 47.910 / 71.611 / 109.401 | 47.536 / 57.767 / 78.083 |
| Claim to answer submission | 1.499 / 3.339 / 6.511 | 27.010 / 33.936 / 43.240 |
| Outbox commit to SDK entry | 19.529 / 30.565 / 62.575 | 33.785 / 74.882 / 84.520 |
| SDK entry to fake return | 0.124 / 0.195 / 0.423 | 0.117 / 0.174 / 0.744 |

The benchmark has no network, real model, real host activation, provider transport or device. Claim-to-answer measures submission/tool/process overhead around a constant fake answer. SDK entry-to-return is an injected provider result, not real provider performance. These final runs include sync and current controls. Older saved runs predate those changes and use another runtime; they are not a controlled speed comparison.

Evidence: [machine-readable verification](../artifacts/verification/repair-final.json), [preflight](../artifacts/verification/offline-preflight-final.json), [same-process benchmark](../artifacts/latency/final-local-with-controls.json), [CLI benchmark](../artifacts/latency/final-external-agent-with-controls.json).

## Intentional behavior changes and verdicts

Late definitive SDK outcomes now reconcile their exact attempt rather than remain unknown forever. Pre-invocation shutdown defers unsent work. Invalid JSON values/unknown fields fail explicitly, including string/null live flags. Corrupt ownership fails closed and has an offline result-evidence path. Metadata repair reads/reconstructs accepted evidence without another send. Unexpected owner loss initiates teardown. Diagnostic greeting now requires an existing verified space and is idempotently queued.

Offline reconciliation command (not run against live state):

```sh
BRIDGE_DATA_DIR=<private-data-dir> bun run bridge/src/reconcile-claim.ts <batch-id> <original-owner>
```

It only retires a corrupt claim with durable queue/runtime completion evidence; unresolved work is not automatically repeated.

**Branch approval:** requested code-level findings are repaired and local gates pass. Ready for code review; unconditional approval remains conditional on validation with the declared supported Bun 1.4.2 runtime. There are no known remaining requested code repairs. The below-minimum runtime is an explicit validation limitation.

**Public-release readiness: not ready.** Requirements remain separate:

- Installation: supported Bun; clean dependency install and pinned Moonshine 0.1.5/models/hash validation; approved CLI login and fresh recovery policy on the intended host.
- CI: no tracked GitHub Actions workflow exists in this checkout. No remote CI run or reproducible supported-runtime installation was verified.
- Devices/live behavior: authorized provider transport, phone rendering, threaded replies/reactions/effects/polls/groups/apps/Live Mini, and actual voice transcription/voice delivery still need applicable end-to-end checks. None were authorized or run here.
- Unattended operation: host pickup remains active-task-only; no native wake endpoint was invented. Target-host service lifecycle, long-run disconnection/recovery, resource bounds and ownership handoff need operational soak verification.
- Packaging: historical publication/provenance manifests were not regenerated; installation completeness and remote availability of the listed pending large assets were not re-audited. This repair is local and unpublished.
- Asset rights: repository source notices still do not establish independent redistribution rights for inherited reference imagery, including study/hands imagery. This code repair does not resolve those rights.

No push, merge, deploy, live bridge restart, real message, credential fetch, production-state write, provider/model change or migration occurred.
