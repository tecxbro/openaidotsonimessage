# Issues, fixes, and remaining boundaries

This report separates original repository defects from the dot host adaptation. Base: `8c710413c99a6fd8022727326ca682d267393953`; local branch: `dot/full-runtime-20260930`. This describes the original implementation; `PUBLICATION.md` records its publication as a source snapshot.

## Reused product

The implementation keeps the repository's Spectrum runtime, authenticated inbound shaping, debounce/batch files, queue and enqueue contracts, read/typing helpers, attachment downloads and JPEG normalization, Moonshine speech pipeline, text/reply/reaction/effect/poll/voice/app/group send branches, image-card watchdog/part mapping, prompt/role structure, and optional Live Mini host. It does not rebuild these capabilities as an unrelated listener.

## dot-specific additions

| Change | Reason | Primary files |
| --- | --- | --- |
| Local durable inbox and batch-control CLI | Replace the unavailable Grok wake port with work the active dot task can actually consume | `bridge/src/dot-inbox.ts`, `dot-agent.ts` |
| Direct stdin text reply | Remove the action-file wrapper and separate completion step while retaining existing live-claim, original-space, validation and idempotency guards | `bridge/src/dot-agent.ts`, `dot-agent-reply.test.ts` |
| One-shot direct inbox wait | Avoid extra receive/send forwarding hops while retaining atomic ownership and bounded waits | `bridge/src/dot-wait.ts`, `dot-wait.test.ts`, `dot-agent.ts`, `batch-claim.ts` |
| Existing CLI credential loaded only into memory | Use already-approved project access without creating a secret-bearing bridge file | `bridge/src/start-dot.ts` |
| Exact hosted service endpoints and SDK imports | Match the official working hosted provider and avoid unused-provider dependencies | `start-dot.ts`, `runtime.ts`, `package.json`, `bun.lock` |
| Runtime/test state override | Keep live private state separate from tests and reproducible source | `types.ts`, `bunfig.toml`, `test/setup.ts` |
| Roles and developer commands | Explain how existing responsibilities map to actual task-scoped dot work | `docs/DOT_RUNTIME.md`, `DOT_ROLES.md` |

## Existing-main defects repaired

| Issue | Repair / evidence |
| --- | --- |
| A Promise chain did not lock separate enqueue/runtime processes | Cross-process file lock around JSON-store mutation; ten concurrent process enqueues preserve all actions |
| Inbound IDs could be marked handled before durable work; debounce state cleared before batch persisted | Journal-first commit, batch-before-clear ordering, startup reconciliation from inbound and unread records |
| A second process could own the same queue/provider instance | Lifetime data-directory lock, explicit startup wrapper and graceful release |
| Webhook posts could overlap or hang | Per-batch single-flight and 10-second HTTP timeout; dot-local requires no webhook |
| Greetings/okay/thanks fast path could swallow meaningful follow-up | Disabled for dot; every actual input remains available to the active task |
| Confetti helper existed but was not wired into first input | One idempotently reserved setup greeting, while preserving the original first question for dot |
| Slow attachment/STT blocked later text | Inbound tasks proceed independently; durable media jobs support restart recovery from original IDs |
| ffmpeg pipe output could block conversion or run indefinitely | Concurrent pipe draining and bounded conversion timeout |
| Ambiguous send errors could cause duplicates; reply throws immediately fell back | Unknown sends quarantined, interrupted `sending` records recovered as unknown, no fallback after an ambiguous reply send |
| Overlapping outbound drains could reuse stale queued snapshots | Single-flight drain covering the whole queue pass |
| Receive/send timestamps conflated context/media work and typing cleanup with provider timing | Add explicit stream/context and dispatch/SDK-return/acceptance times; persist accepted sends before bounded detached typing cleanup; preserve early reads and unknown-send quarantine |
| Text/reply provider IDs and recipient-read evidence were lost | Store outbound provider IDs and actual receipt targets; reconcile early receipts and prevent read-state downgrade |
| Original reply target/effect and sending-line context were discarded | Preserve reply/effect metadata, unwrap nested media without losing read methods, persist original conversation context |
| Card maps omitted details and known prices; emoji rules were inconsistent | Canonical aligned details/price/original-URL propagation; any added emoji returns existing details; removals are not selections |
| Card marker filtering could shift metadata relative to files; final enqueue could race | Require all paths and aligned metadata; stable idempotency key for one complete group |
| Tests depended on an absent `/tmp` PNG and did not typecheck | Self-contained fixture preload, isolated data directory, assertion type narrowing, full TypeScript check |
| Live Mini Blob first-write could overwrite a concurrent publisher | Conditional first write, fail-closed missing ETag and eight regression tests |
| Live Mini handoff manifest/docs were stale | Updated storage guidance and regenerated/verified clean archive |

## Remaining issues / external prerequisites

1. **Automatic activation:** no supported native dot wake endpoint is available here. The inbox is durable, but replies depend on an active dot task. An always-on host integration is still needed for unattended operation after that task ends
2. **Provider/offline replay:** messages durably received by the bridge can recover locally. Provider replay of messages sent while the bridge itself is down is not guaranteed by this adapter
3. **Reaction removal transport:** the installed provider streams additions only. The handler's removal semantics are tested when metadata is present, but live removal detection is not established
4. **Phone UX:** machine tests and provider acceptance cannot establish visible iPhone behavior. Full-runtime automatic and dot-authored text responses now have provider acceptance and correlated read evidence. Phone voice and visual rich-message rendering remain unverified
5. **Image production:** real generated assets can be ingested and grouped, but a local fixture is not a real generation/delivery proof. Generation stays with the active dot's image tools and user-authorized request
6. **Live Mini hosting:** local application and HTTP tests pass. A stable HTTPS host, private durable storage, approved secrets and deployment are required before phone use. No public deployment is included
7. **Browser QA:** Chromium launch was blocked by the environment's socket restriction. Live Mini visual browser/device checks remain unverified
8. **Task ownership:** six original roles are supported as scoped responsibilities, not six newly created permanent autonomous agents. Long tasks and amendments are coordinated by the active task; the bridge is the durable transport
9. **Resource bounds:** inbound media tasks currently run concurrently without a concurrency cap. A burst of large files/voice notes could exhaust CPU or memory; graceful shutdown can wait indefinitely on an unresponsive provider/media operation. Do not launch a replacement while the old process remains alive
10. **Host latency:** one live exchange showed approximately 42 seconds in receive-to-forward handling and 26 seconds in reply-forward handling. Repo-native `dot-agent wait` plus direct enqueue removes extra forwarding hops. A later exchange took about 42 seconds from provider timestamp to legacy sentAt, with only 26 ms from batch publication to claim and about 14 seconds from claim to enqueue. Another exchange was dominated by about 43 seconds of active-task decision/tool time; its enqueue-to-legacy-sentAt was about 2.43 seconds. These are individual observations, not a speed guarantee. Legacy timestamps conflate storage/cleanup costs; do not attribute the earlier 20.45-second gap wholly to the provider. The reviewed timing fix is now loaded in the sole replacement runtime and enables more accurate future measurement; a fresh stage-timed live speed measurement is still pending
11. **Operations:** no boot service, external supervisor, retention policy or distributed lock has been installed. Local JSON state uses file locks and atomic replacement, not an exactly-once transport guarantee

Read [BUILD_VERIFICATION.md](BUILD_VERIFICATION.md) for actual evidence, and [DOT_RUNTIME.md](DOT_RUNTIME.md) for commands and safe startup/shutdown.

## Independent integration review: introduced issues corrected before cutover

These were found while reviewing this local adaptation; they are not presented as proven upstream defects:

- The first directory-lock implementation could steal a newly acquired lock during concurrent stale-owner recovery. It was replaced with util-linux kernel `flock` on a permanent inode. Killed-owner reacquisition and simultaneous-contender tests pass
- Our added kernel-lock helper initially inherited the owner's foreground process group. A group SIGINT or SIGTERM could kill the helper and release its lock while the owner was still alive in asynchronous shutdown. The targeted fix isolates the helper process group with `detached: true` and retains parent-owned stdin/EOF lifetime. Three real isolated process-group/parent-death regressions failed before the fix and now pass. This is an integration-introduced defect, not an attributed Photon/upstream bug. The fix is in the packaged source and is loaded in the final connected replacement after confirmed old-process exit; the prior exit-code-1 cause remains unproven
- The first graceful-stop implementation did not wait for an active outbound drain. Stop now retains ownership until that drain settles and forbids a later queued item from starting. A held-first-send/queued-second/stop regression passes
- Receipt ordering still allowed a hung read control to delay durable input. Text is now committed before best-effort read, and media conversation/job state is saved first. A never-resolving-read regression still batches input and completes mocked shutdown promptly
- Provider attachment errors could reach logs and batches through an inherited error-string path. Fixed safe codes now replace external error text. A credential-like sentinel is absent from the resulting saved batch
- Direct card enqueue and the watchdog initially used different deduplication keys. Card keys are now canonicalized centrally, and claim validation is held/fenced through commit-time authorization. Renewal writes are atomic
- App edit completion could mislabel an undefined SDK result as provider acceptance. Complete app-session metadata is required first; fire-and-forget edit/reaction/typing results are recorded as `control_requested`, without claiming rendering or delivery

The independent review cleared the corrected source for a controlled text/read/audio cutover after updated tests. Rich phone behavior remains subject to the separate checks listed above.

## Current running status

The full repository runtime replaced the proof listener on 2026-09-30 after the old process exited successfully. The full runtime started at 07:00:19 UTC and reported its hosted provider connected, with empty initial inbox/outbox. A dedicated active task owns its sole connection and local inbox processing. At 07:21 UTC the full runtime received the authorized user’s fresh greeting, marked it read, sent its once-only automatic greeting with a confetti request, and received a matching provider read receipt at 07:21:17 UTC. A subsequent message also completed the active dot-authored claim/enqueue path: provider acceptance recorded at 07:23:33.952 UTC (legacy sentAt, after typing cleanup) and its matching read receipt at 07:23:37.254 UTC. A real phone voice note and visual rich-message rendering remain unverified. The active-task loop exhibited noticeable handoff latency; the repo-native one-shot inbox wait and direct enqueue now avoid extra receive/send relays, with individual subsequent observations described above. The reviewed timing/receipt fixes are now loaded in one replacement runtime on the unchanged private data directory and existing project. The runtime owner confirmed the prior process had exited before starting the replacement, which explicitly reported provider-connected. The prior exit was code 1 with no observed graceful-shutdown log; its cause was still being checked at this snapshot. A graceful old exit is not claimed. No simultaneous second connection or state reset was introduced. Fresh stage-timed live speed is not yet measured. No unattended activation or public Live Mini hosting is claimed.

The later lock-helper process-group fix is included in this full source package and loaded in the final connected replacement. The earlier intermediate transition was Ctrl+C/exit-code-1 at 13:37:23 UTC, replacement creation at 13:38:05 UTC, and provider-connected log observed at 13:38:29 UTC.

For the final activation, the prior runtime received Ctrl+C through its owned PTY and exited at 14:03:06 UTC with code 1 and only `^C` output observed. Direct PID signaling was skipped because the expected owner PID was not visible and matching in that shell namespace. Graceful old cleanup and the exit-code-1 cause remain unproven. Only after confirming that exit, the sole replacement was created at 14:03:25 UTC and explicitly reported provider-connected at 14:03:46 UTC. Final reviewed source predates the start. The same project, approved credentials and private data were reused, with no reset, reseed or simultaneous second provider connection. The isolated lock flaw is not evidence that live provider clients overlapped. No new measured speed, phone voice or rich-display proof is claimed.
