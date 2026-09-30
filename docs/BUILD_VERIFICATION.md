# Local build verification

Implementation snapshot: 2026-09-30, 14:06 UTC. See `PUBLICATION.md` for subsequent publication-only checks. This is verification of the local dot integration, not a remote deployment or physical-device certification.

## Proven locally

- Bridge: Bun 1.4.2, official `@spectrum-ts/core` and `@spectrum-ts/imessage` 12.10.1, TypeScript check passes
- `bun test`: 103 registered tests / 504 expectations pass, zero failures, plus the repository's existing top-level assertion suites
- `bun run preflight`: SDK, hosted provider import, kernel flock, ffmpeg, ffprobe, Python/Moonshine import and every required model file pass
- Multi-process queue contention, exclusive claim, idempotent retries, changed-content rejection, journal recovery, unknown-send quarantine, receipt correlation including early events, one-time confetti, preserved follow-up text, non-blocking media, graceful stop, and read-only receipt handling tested without opening a provider connection
- Documented dot CLI smoke: pending/status/read/claim/lease renewal/enqueue/idempotency/completion and negative owner/space/claim guards pass using synthetic private state
- Card tests cover seven aligned options in one mapping, any added emoji, saved details/qualified known price/original link, missing-data honesty, reaction removal metadata, and original nested reply/effect/attachment identity
- Ten direct-inbox-wait tests pass: existing work, new atomic publication, two-owner claim race, completed/busy work skipping, timeout, cancellation, same-owner resume, invalid bounds, a busy claim lock without late post-timeout claiming, and a cancellation/deadline guard closing under the lock before mutation
- Nine timing/receipt regressions pass: pre-storage stream timing, retained/legacy media times, early reads with slow cleanup, never-resolving cleanup, rejected cleanup/error sanitization, unknown/undefined sends, reply/rich-send acceptance, best-effort typing without fabricated return evidence, and app-edit/no-session outcomes
- Sixteen direct-stdin-reply tests pass: existing live owner required, original-space inference, durable enqueue before completion, safe completed retry, unfinished idempotent retry, changed-content rejection, routing/target guards, malformed stdin, invalid/expired claims, output validation, corrupt state, interrupted audit append and exact package-script invocations with/without the optional separator
- Three real isolated process-group lock regressions pass: SIGINT and SIGTERM keep a contender blocked throughout a held owner shutdown until explicit release; parent death after interruption still releases the helper through stdin EOF. All three reproduced early lock release before the targeted fix
- `git diff --check` passes

## Moonshine: actual speech, not a placeholder

Installed `moonshine-voice` 0.1.5 in the bridge virtual environment, Python 3.12.14 and ffmpeg 7.1.5. `ModelArch.SMALL_STREAMING` is 4.

All nine files of `small-streaming-en/quantized_26_08_21` were downloaded from the official `moonshine-ai/moonshine-voice-assets` repository at revision `0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae`: 224,067,582 bytes (213.69 MiB). Publisher hashes verified for all files.

The wheel's 44.37-second spoken fixture passed:

1. `tools/moonshine_stt.py`: 9.807 seconds
2. `tools/moonshine-transcribe.py`: 9.277 seconds
3. Full TypeScript CAF → 16 kHz mono WAV → Moonshine pipeline: 8.812 seconds

All returned exit zero and empty stderr, producing a coherent speech transcript with minor recognition/punctuation errors. Missing WAV/model negative tests returned structured errors and nonzero exit status. Model binaries, the virtual environment, transcripts, and private runtime state are excluded from the source handoff.

## Optional Live Mini

- 123 application tests and 7 skill tests pass
- Syntax/example check: 59 modules, four task examples and two loader assets
- Build produces 39 Vercel output files without secret or registry files
- Handoff packaging verifies 108 files; clean extraction passes tests/check/build again
- Actual loopback HTTP server: health, authorization rejection, authenticated doctor, gallery/layout/animation assets, create, two same-URL revisions, terminal release and retained history pass
- Blob initialization concurrency and missing-ETag safety repaired with eight regression tests

No public deployment, storage account, persistent credentials, or paid service was created. Browser visual QA could not launch Chromium in this environment (socket operation denied), so only HTTP/assets and automated logic were verified.

## What this does not prove

- No native automatic dot wake endpoint exists here. Local inbox processing needs an active dot task
- Provider acceptance is not a delivered/read claim. A separately correlated provider read event is recorded when observed
- Spectrum 12.10.1 carries reaction-removal metadata in `reactionRecord.selected`, but its current live stream maps additions only. The handler correctly treats a removal if received; automatic live removal detection is not established
- Generated image ingestion/grouping is implemented and tested; actual generated artwork and phone rendering need a real requested image workflow
- Audio, polls, effects, grouped cards, app sheets and Live Mini still need end-to-end phone checks on this runtime. Local builders/mocks cannot prove the Messages UI rendering
- Live Mini needs an authorized stable HTTPS deployment and private durable storage before a phone can use it
- Task-scoped worker responsibilities are documented; no six permanent autonomous bots or hidden replacement model are running
- At this implementation snapshot, no remote push, merge, public deployment, background startup service, or billing change was part of the build; source publication is documented separately

## Live cutover status

The previous minimal proof listener exited successfully at 06:55:38 UTC on 2026-09-30. The full repository runtime then started at 07:00:19 UTC and emitted its hosted-provider-connected startup event. Its sole active reader uses the fresh private runtime data directory, seeded only with the two already-handled proof message/receipt IDs. Initial inbox and outbox were empty. No second Spectrum client was started.

At 07:21 UTC, the full runtime received the authorized user's fresh “hi”, durably batched it and explicitly marked it read. Its once-only automatic greeting, “it’s dot here”, was sent with a confetti effect request; Spectrum returned a provider message ID. A matching provider read receipt was observed at 07:21:17 UTC. That first exchange verified the automatic setup greeting; the separate authored-reply proof follows below.

This first exchange is live evidence of full-runtime inbound text, inbound read control, automatic setup greeting/effect request, outbound provider acceptance and correlated recipient-read receipt.

A subsequent authorized message was claimed by the active dot workflow. Dot authored its response, submitted it through `dot-agent enqueue`, and the full runtime sent the resulting outbound item. The bridge recorded provider acceptance at **07:23:33.952 UTC** (legacy sentAt, after typing cleanup), and its matching provider read receipt arrived at **07:23:37.254 UTC**. This separately verifies the full-runtime active dot → claimed batch → durable outbound queue → provider acceptance → recipient-read path.

The observed active-task handoff had noticeable latency: approximately 42 seconds in receive-to-forward handling and 26 seconds in reply-forward handling for that exchange. These are measured host-coordination components, not a general latency guarantee or evidence that Spectrum caused the delay. The reusable repository command `dot-agent wait <owner> [timeout-ms]` now lets the active dot task await, claim and read an inbox batch directly, followed by direct enqueue. It replaces the temporary external helper and removes the extra receive/send forwarding hops. Its claim/race/timeout behavior is machine-tested; later individual live observations are described below without claiming a general speed guarantee. The inbox-wait addition itself required no provider restart or additional connection.

A real phone voice note and the visual rendering of confetti and other rich modalities remain unverified. The earlier minimal adapter's exchange remains separate evidence.

## Timing/receipt follow-up source status

The 13:39 UTC source update records live stream entry before storage and SDK send return/acceptance before typing cleanup. A successful send's accepted state and message ID are persisted first. Cleanup is nonblocking for later queued messages, bounded to five seconds, and emits content-free outcome/timing evidence. Early read receipts remain authoritative; failed/unknown sends do not gain acceptance timestamps. Tests use isolated state and injected providers, with no extra Spectrum connection. TypeScript and complete local preflight pass.

After the approved review, the runtime owner confirmed that the previous full-runtime process had exited with code 1 and no observed graceful-shutdown log. Only after confirming that exit, the owner started one replacement against the unchanged private data directory and existing project. The replacement explicitly reported its hosted provider connected. The reviewed runtime source predates the replacement start, so the timing/receipt patch is loaded. This was an observed replacement after a nonzero exit, not a proven graceful shutdown; the exit cause was still being checked at this snapshot. No second simultaneous connection or state reset was introduced.

New stage-timing fields have not yet produced a fresh live performance measurement, so no new speed claim is made. The direct-stdin `dot-agent reply` command is a host CLI addition and requires no provider restart. Neither change alters debounce defaults or prompts.

A later direct-wait exchange took about 42 seconds from provider timestamp to legacy sentAt: batch-to-claim was about 26 ms and claim-to-enqueue about 14 seconds. Another observed exchange was dominated by approximately 43 seconds in active-task decision/tool orchestration, with about 2.43 seconds from enqueue to legacy sentAt. These are individual historical observations. Legacy receivedAt includes storage/media work and legacy sentAt includes typing cleanup; the earlier 20.45-second gap cannot be attributed wholly to the provider. Future timestamps separate those boundaries, without claiming exact network RPC timing or a guaranteed speedup.

## Process-group lock follow-up (loaded after confirmed replacement)

Independent signal testing found an integration-introduced defect in our added `file-lock.ts`: the helper shared the owner's foreground process group. Group SIGINT/SIGTERM could kill that helper and release the kernel lock while the owner was still alive in asynchronous shutdown. The fix adds `detached: true` to the helper spawn, preserving its parent-owned stdin pipe so explicit release or parent death/EOF still releases the lock. No broad runtime lifecycle change was made.

Three isolated subprocess regressions failed on the old helper and pass on the fixed helper. Independent review repeated the actual-helper test with three-second SIGINT and SIGTERM shutdown holds, verified a different helper process group, and confirmed normal-release/parent-death cleanup without surviving helper groups. Existing killed-owner, contention, queue, claim, recovery and timing tests still pass. These tests open no provider connection and do not touch live state. After review, the owner coordinated one further replacement with confirmed old-process exit. The final lock fix is now loaded, as detailed below.

This defect does not establish the cause of the earlier exit code 1. The observed previous exit followed a Ctrl+C at 13:37:23 UTC with only `^C` output and no graceful-shutdown or runtime-failure marker. The replacement was created at 13:38:05 UTC and its provider-connected log was observed at 13:38:29 UTC. Old-process exit was confirmed first, preventing actual overlap during that replacement.

## Final deployment evidence

The prior runtime received Ctrl+C through its owned PTY and exited at **14:03:06 UTC**, with exit code 1 and only `^C` output observed. Direct PID signaling was skipped because the expected owner PID was not visible and matching in that shell namespace. No graceful-shutdown marker was observed; graceful cleanup and the cause of exit code 1 remain unproven.

Only after confirming that exit, the owner created the sole replacement at **14:03:25 UTC**. Its explicit hosted-provider-connected log was observed at **14:03:46 UTC**. The reviewed final lock-helper source predates this start, so both the timing/receipt fix and process-group-isolation fix are loaded. The existing project, approved credentials and private data directory were reused, with no reset, reseed, test send, or simultaneous extra provider connection.

This final step changed deployment evidence only. The **103 tests / 504 assertions / zero failures**, TypeScript and preflight results stand; no code was edited during this documentation/package refresh. A fresh stage-timed live speed measurement, real phone voice note and visual rich-message rendering remain unverified.
