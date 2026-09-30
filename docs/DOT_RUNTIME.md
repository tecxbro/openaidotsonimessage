# dot runtime: developer handoff

This branch adapts the **existing `photongrokbot` repository** to dot. The Spectrum runtime, message feature modules, Moonshine pipeline, and optional Live Mini package remain in this checkout. There is no separate messaging service or external language-model API.

This document is the dot-specific entry point. `README-GROK-LEGACY.md`, `01-ARCHITECTURE.md`, agent profiles, and `routines/` describe the original Grok deployment. Their automatic bot creation, webhook provisioning, `.env` secret storage, and deployment instructions do **not** describe the dot-local path below.

Implementation branch: `dot/full-runtime-20260930`, based on `8c710413c99a6fd8022727326ca682d267393953`. The implementation is published here as a source snapshot; this does not deploy a new service. See `PUBLICATION.md` for publication checks.

## Architecture and activation boundary

```text
Authorized sender's iMessage
  → Photon Spectrum hosted iMessage
  → bridge/src/runtime.ts: filter, deduplicate, persist, transcribe, batch
  → BRIDGE_DATA_DIR/unread/<batchId>.json
  → BRIDGE_DATA_DIR/dot-inbox/<batchId>.json  { "batchId": "…" }
  → active dot task reads and exclusively claims the batch
  → dot authors actions, optionally using task-scoped workers
  → dot-agent enqueue: validate claim + original space + stable actionId
  → existing outbound-queue.json
  → same runtime and Spectrum connection
  → original iMessage conversation
```

**There is no native automatic dot wake endpoint in this integration.** `dot-inbox` is a durable local work notice, not a webhook, model call, or autonomous agent. `dot_batch_ready` is a runtime log event. An active task with access to this checkout must inspect and process pending batches. A running bridge can collect messages while dot is inactive; those stored batches wait until processing resumes. If the bridge itself is stopped, this implementation does not guarantee provider-side replay of messages that arrived while it was offline.

The bridge does not contain a model key, inference client, permanently running specialist bots, or a second native iMessage SDK connection. See [role ownership](DOT_ROLES.md) for the six original responsibilities.

## Configuration and credentials

Use an existing, approved Photon CLI login and an existing Spectrum project/hosted line. The authorized sender must also satisfy the project's Spectrum user restrictions. Starting this runtime does not create a project, register a sender, acquire a new line, or log in.

From the repository root:

```bash
cd /absolute/path/to/photongrokbot/bridge
umask 077
export BUN_BIN="/absolute/path/to/bun"
export PATH="$(dirname "$BUN_BIN"):$PATH"
export PHOTON_CLI="/absolute/path/to/photon"
export PHOTON_CONFIG_DIR="/absolute/path/to/existing/private/photon-config"
export SPECTRUM_PROJECT_ID="<existing-project-id>"
export AUTHORIZED_SENDER_ID="<exact-authorized-E164-or-Apple-ID>"
export BRIDGE_DATA_DIR="$PWD/data/dot-runtime"
mkdir -p "$BRIDGE_DATA_DIR"
chmod 700 "$BRIDGE_DATA_DIR"
```

Set these same variables in every shell running helper commands. Set `BUN_BIN` to the absolute path of your installed Bun binary. `BRIDGE_DATA_DIR` is read when modules load. Without it, the default is `bridge/data`, so forgetting it can make a helper inspect a different queue. `PHOTON_CLI` defaults to `photon` on `PATH`; keep it pointed at the official, trusted CLI binary. `PHOTON_CONFIG_DIR` points to the CLI's existing private configuration, not a new bridge credential file.

`start-dot.ts` internally invokes the CLI's read-only `projects secret <projectId> --api-host https://app.photon.codes --json` operation, validates the returned project ID, and supplies the project secret directly to the SDK in process memory. It does not print or write that secret, copy the CLI token, rotate credentials, or create a secret-bearing `.env`. The existing CLI login can already have its own credential storage. Do not paste credential output into logs or handoff files, and do not use shell tracing (`set -x`).

The dot entry point fixes the official service destinations before dynamically importing the runtime and SDK:

- Dashboard API: `https://app.photon.codes`
- Spectrum Cloud: `https://spectrum.photon.codes`
- Hosted iMessage transport: `imessage.spectrum.photon.codes:443`

It does not need `GROK_ORCHESTRATOR_WEBHOOK_URL` or `GROK_ORCHESTRATOR_WEBHOOK_KEY`. `bun run start` remains the legacy configuration entry point; use `start:dot` for this integration.

## Install, check, start, and stop

The implementation uses Bun **1.4.2**, `@spectrum-ts/core` **12.10.1**, and `@spectrum-ts/imessage` **12.10.1**. Dependencies and lockfile are in `bridge/`. Live Mini requires Node **22+**. Moonshine requires Python, its private virtual environment, and `ffmpeg`. Cross-process locks use Linux util-linux `flock`, verified by preflight.

```bash
# From bridge/, with the environment above
bun --version
bun install --frozen-lockfile
bun run preflight
bun run typecheck
bun test

# Foreground; Ctrl-C requests graceful shutdown
bun run start:dot
```

For a background process, invoke the entry file directly so the recorded PID belongs to Bun rather than a package-script wrapper:

```bash
nohup bun run src/start-dot.ts >"$BRIDGE_DATA_DIR/runtime.log" 2>&1 &
RUNTIME_PID=$!
printf '%s\n' "$RUNTIME_PID" >"$BRIDGE_DATA_DIR/runtime.pid"
ps -p "$RUNTIME_PID" -o pid=,etime=,args=
```

`preflight` checks local SDK, media tools, Python/Moonshine, and model-file prerequisites without retrieving credentials or connecting to Spectrum. Process existence alone is not readiness or delivery evidence. Check the runtime's startup/error events locally; `runtime_failed` reports the stage without raw credential output. The data directory and logs can contain private conversation metadata and must stay private.

To stop, read the runtime lock's owner PID and inspect it before sending `SIGTERM`:

```bash
RUNTIME_PID=$(bun -e '
  const p = process.env.BRIDGE_DATA_DIR + "/.runtime-lock/owner.json";
  const { pid } = await Bun.file(p).json();
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid runtime PID");
  console.log(pid);
')
ps -p "$RUNTIME_PID" -o pid=,etime=,args=
# Continue only after confirming this is this checkout's start-dot.ts process
kill -TERM "$RUNTIME_PID"
```

`SIGTERM`/`SIGINT` call `stop()`, clear timers, wait for inbound handlers, flush buffered input, and stop Spectrum. Shutdown can wait on a hung provider send or media operation. Confirm the process exits before restarting; never start a replacement while the old runtime remains alive. Avoid `SIGKILL`; a send interrupted at any point can have an unknown outcome. Do not delete a live lock to start a competing runtime. The fixed source isolates the flock helper from foreground terminal signals using its own process group, while retaining the parent-owned stdin/EOF lifetime. The lock uses a permanent kernel-flock inode; the OS releases it when its owner process/pipe closes. Never delete or rename a `.lock` file to recover it. Owner metadata is separate. For older snapshots without this fix, group Ctrl+C/SIGTERM can also terminate the helper prematurely; confirmed old-process exit remains mandatory. This is local-host exclusion, not a distributed service lease or process supervisor. No reboot/startup service is installed by these commands.

## Process a batch with agent-authored actions

These commands operate on the configured local data directory. Reading or claiming a batch does not send a message. Enqueueing does: a running runtime drains accepted actions automatically.

```bash
# Wait for one batch and atomically claim/read it in this active task
# Use the same owner string for follow-up enqueue/complete commands
bun run dot-agent -- wait "<task-owner-id>" 300000

# Or list uncompleted notices without claiming
bun run dot-agent -- pending

# Summary of pending IDs, outbound records, and activation mode
bun run dot-agent -- status

# Inspect one stored batch
bun run read-batch -- "<batchId>"

# Use a unique owner string for the active task
bun run dot-agent -- claim "<batchId>" "<task-owner-id>"
```

`wait <owner> [timeout-ms]` is a one-shot local helper, with a 30-second default and a maximum of 300 seconds. It returns `{status:"claimed", ok:true, claim, resumed, batch}` when it owns work, or `{status:"timeout", ok:false, waitedMs}` when no work becomes claimable. A filesystem watcher is installed before scanning; a 500 ms fallback scan covers missed notifications. It creates the inbox directory if missing, skips completed/other-owner live claims, and uses a nonblocking claim-lock attempt so a timeout cannot leave a late background claim. Cancellation and nonzero deadlines are rechecked after acquiring the claim lock and immediately before mutations; a closing guard does not leave a late claim. A zero timeout intentionally requests one nonblocking scan. No provider connection, credential lookup, model call or autonomous platform wake is created.

Only one active inbox consumer should use an owner string. Complete or intentionally retain each returned claim before waiting again; otherwise the same owner can resume its unfinished batch. When replacing an external waiter, let it exit or stop only that waiter first. Do not stop or duplicate the Spectrum runtime just to switch wait commands.

A successful claim returns `ok: true` and the batch. Stop if the result is `owned_by_other` or `already_completed`. The default lease is 15 minutes; repeating `claim` with the same owner refreshes it. A claim is exclusivity for processing, not permission to exceed the user's request.

For an approved routine plain-text response, `reply` accepts one JSON object on standard input, without an action file:

```bash
# After wait/claim has given this task a live claim
bun run dot-agent -- reply <<'JSON'
{
  "batchId": "<batchId>",
  "owner": "<task-owner-id>",
  "actionId": "reply-1",
  "text": "<dot-authored-response>"
}
JSON
```

The four fields shown are required strings; extra fields are rejected. The command infers the original conversation only when the batch contains exactly one distinct, nonempty `spaceId`, even if it has multiple messages. It sends ordinary text, with the existing paragraph splitting and text validation; use the action-file path below for threaded replies or other action kinds. `reply` requires an already-live claim and does not acquire or refresh one. It shares `enqueue`'s original-conversation, claim-lock, commit-time authorization, and idempotency guards, then calls the existing completion guard **only after durable enqueue succeeds**. Enqueue failure leaves the claim unfinished, including a journal error after queue persistence.

Retry an unfinished response with the **same batchId, owner, actionId, and unchanged text**; matching durable records are reused and changed content is rejected. Success returns `{ok:true, claim, outbound}`. A same-owner completed batch returns `{ok:false, reason:"already_completed", claim}` without sending; this is a safe no-op, not confirmation that newly supplied text was accepted. Missing, expired, or other-owner claims reject. Completion confirms queue acceptance, not provider acceptance or delivery; continue checking delivery separately. The optional `--` separator shown above is supported.

For other actions, read the actual batch, choose its existing `spaceId`, and create one action file per intended action. The original text action-file workflow also remains available:

```bash
cat >"$BRIDGE_DATA_DIR/reply-action.json" <<'JSON'
{
  "actionId": "reply-1",
  "input": {
    "kind": "text",
    "spaceId": "<spaceId-from-this-batch>",
    "text": "<dot-authored-response>"
  }
}
JSON

bun run dot-agent -- enqueue \
  "<batchId>" "<task-owner-id>" "$BRIDGE_DATA_DIR/reply-action.json"

# Only after durable enqueue acceptance or an intentional no-send decision
bun run dot-agent -- complete \
  "<batchId>" "<task-owner-id>" "reply-1 accepted by queue"

# Continue checking delivery separately
bun run dot-agent -- status
```

`enqueue` requires an unexpired claim owned by this task and a `spaceId` present in the original batch. Reply/reaction/edit targets must also be known in that batch or its verified outbound conversation. The claims lock stays held through commit-time revalidation. It derives the idempotency key `<batchId>:<actionId>`; card groups with a `batchId` use the centrally shared `cards:<batchId>` key for both direct enqueue and the watchdog. Retry the **same logical action with the same actionId and unchanged input JSON**; an existing matching key returns its existing outbound records. New records also retain an input hash: changing the input with the same key is rejected as `idempotency_key_content_mismatch`, not treated as an edit. Do not mint a new actionId to retry an uncertain send.

The `input` schema is `EnqueueOutboundInput` in `bridge/src/types.ts`. Supported variants are text/effect/attachment, reply, react, poll, voice, typing, attachment group, app, and app update. Examples of the fields to put inside `input`:

| Kind | Required fields besides `spaceId` |
| --- | --- |
| `text` | `text`; optional `attachmentPath` or `effect` |
| `reply` | `targetMessageId`, `text` |
| `react` | `targetMessageId`, `emoji` |
| `poll` | `title`, `options` |
| `voice` | `audioPath`; optional `text`, `durationSeconds` |
| `typing` | `state`: `start` or `stop` |
| `attachment_group` | `attachmentPaths`; provide aligned `cards` and `batchId` for option mapping |
| `app` | `url`; optional `live` |
| `app_update` | `targetMessageId`, `url`; optional `live` |

Keep paths local to the runtime host. An attachment group is one grouped send; preserve the original image-card workflow's all-options-together rule. Poll-vote follow-ups use plain text rather than replying to a poll/vote ID. A worker returns proposed actions to the front-door owner; do not have both enqueue the same result. Legacy `bun run enqueue` still exists but does not enforce the dot claim/original-space wrapper, so use `dot-agent enqueue` for batch replies. Do not hand-edit queue JSON or open a second provider connection.

## Persistence, recovery, and delivery safety

Under `BRIDGE_DATA_DIR`:

```text
inbound.jsonl, inbound/<encodedMessageId>.json   durable inbound records
handled-ids.json                               inbound deduplication
pending-batch.json                             debounce buffer, when nonempty
unread/<batchId>.json                          full immutable batch payload
webhook-pending.json                           retryable host-notice work
dot-inbox/<batchId>.json                       local notice containing batchId only
batch-claims/<batchId>.json                    owner, lease, processing completion
outbound-queue.json, outbound.jsonl            queued actions and audit records
receipts.jsonl                                actual provider read events
receipt-targets.json                          target receipts, including early read events
conversation-context.json                     verified sender and line by original space
media-jobs/<encodedMessageId>.json             pending/done attachment and STT work
inbound-attachments/                           received bytes and converted audio/images
cards-ready/, outbound-assets/                original image-card workflow
poll-meta.json, app-card-sessions.json          original rich-message state
onboarding-celebrated.json                     once-only setup greeting marker
.runtime-lock/, .storage-lock/                 cross-process exclusion
```

Inbox files remain after processing; `pending` filters completed claims. A completed claim means processing has durably finished or been intentionally skipped. It does **not** mean the recipient saw a response.

`file-lock.ts` coordinates runtime ownership, JSON-store mutation, and batch claims across local processes. JSON replacements are atomic; JSONL audit appends are flushed. `recovery.ts` rebuilds pending work from durable inbound records not already covered by unread batches, restores missing host notices, and quarantines records left in `sending` after interruption. Media jobs are written before download/transcription and resumed from their original provider message when still available. Persisted conversation context keeps the original sender/space/line association across restarts; dot mode refuses to resolve an unverified conversation. Corrupt store JSON should surface as an error rather than silently resetting a queue. This is a filesystem-backed recovery design, not an exactly-once transport guarantee or a substitute for private backups.

Outbound states have different meanings:

- `queued`: accepted durably, not yet attempted
- `sending`: an attempt is in progress
- `sent` / `provider_accepted`: Spectrum accepted the operation; this is not proof of device rendering
- `control_requested`: a fire-and-forget edit/reaction/typing dispatch completed without a returned Message; this is not a provider-accepted or visible-UX claim
- `deliveryState: read`: a matching provider read event was observed, where a target message ID was available; early receipts are retained and reconciled when the outbound message ID is saved
- `failed`: a terminal known failure reported by the operation
- `unknown`: delivery could not be established; automatic resend is disabled

**Never automatically replay `unknown`.** Inspect the existing item, provider message reference, receipt/audit evidence, and the recipient's observation when necessary. Reconcile what happened before considering any new authorized send. The CLI deliberately has no “retry all unknown” command. A thrown threaded reply also must not immediately fall back to a plain send; the first operation might already have reached the provider. See `reply-fallback.ts` for the narrower fallback cases.

## Timing evidence

New inbound records carry `streamReceivedAt`, captured at the bridge's SDK stream loop before storage, and `contextSavedAt` after conversation persistence. The provider's original `timestamp` is unchanged. Legacy `receivedAt` still marks shaping completion and includes context/media processing. Media recovery retains the original stream time when available; old records have no invented stream time.

New outbound records carry `dispatchStartedAt` (before storage/space lookup), `providerReturnedAt` (when the awaited SDK send returns), and `providerAcceptedAt` only for a successful send result. Message `sentAt` now equals the SDK return time rather than later typing cleanup. These times do not prove device delivery; `readAt` remains separate. The dispatch-to-return interval includes local storage, lookup, conversion/upload and SDK work, so it is not an exact Photon network-call duration. Best-effort typing controls omit `providerReturnedAt` because their wrapper can swallow a failure or timeout.

Accepted status and the provider message ID are persisted before ancillary typing cleanup. Cleanup is detached from queue progress, single-flight per space, tracked during shutdown and bounded to five seconds. Its content-free `outbound.jsonl` event is `{event:"typing_cleanup", id, startedAt, settledAt, outcome}`; outcome is `completed`, `failed` or `timeout`. A timeout bounds bridge bookkeeping but cannot cancel an already-issued SDK control, which has no cancellation parameter. The provider is closed on runtime shutdown. This does not bound other provider sends or media work.

No debounce default or prompt changed. Historical records cannot retroactively separate ingress/storage or send/cleanup time. The reviewed timing implementation is loaded in the replacement runtime. Its owner confirmed the prior process had exited before starting the sole replacement on unchanged private state; the prior exit was code 1 with no observed graceful-shutdown log, so it is not described as graceful. Fresh stage-timed live performance remains unmeasured.

## Existing features and where to edit

| Concern | Primary files |
| --- | --- |
| Startup, approved CLI credential retrieval, local prerequisites | `bridge/src/start-dot.ts`, `preflight.ts` |
| Local inbox and agent command contract | `bridge/src/dot-inbox.ts`, `dot-agent.ts` |
| Provider lifecycle, authorization, batching, sends | `bridge/src/runtime.ts` |
| Storage, claims, recovery, locking | `storage.ts`, `batch-claim.ts`, `recovery.ts`, `media-jobs.ts`, `file-lock.ts`, `dot-wait.ts` |
| Shapes and configuration constants | `types.ts`, `config.ts` |
| Existing text, polls, effects, apps | `outbound-text.ts`, `outbound-poll.ts`, `outbound-effect.ts`, `outbound-app.ts` |
| Existing inbound attachments and JPEG conversion | `inbound.ts`, `inbound-attachment.ts`, `outbound-jpeg.ts` |
| Existing option reactions and image-card completion | `reaction-option.ts`, `cards-ready.ts` |
| Existing voice-note transcription | `voice-stt.ts`, `bridge/tools/moonshine_stt.py` |
| Optional progress-card host | `live-mini/live-task-cards/`, `live-mini/runtime/` |

The feature modules above were retained rather than replaced by a text-only adapter. Inbound text, reactions, poll votes, attachments, HEIC conversion, and voice transcription continue through the original pipeline. Outbound replies, reactions, effects, polls, voice, grouped attachments, static app sheets, live app cards, and app updates remain available through the same queue/runtime.

Moonshine uses `bridge/.venv-moonshine` with `moonshine-voice` **0.1.5** and all nine files of `small-streaming-en/quantized_26_08_21`. Its current model path remains `bridge/data/models/moonshine/...`; changing `BRIDGE_DATA_DIR` does not relocate the model or virtual environment. See [`stt/INSTALL.md`](../stt/INSTALL.md). An actual speech sample was transcribed during environment preparation; that is separate from a device-to-bridge voice-note proof.

Live Mini retains the `dots`, `segments`, `stages`, and `matrix` layouts, read-only card capabilities, publisher authentication, durable revisions, and its one-initial-send contract. Updating saved card JSON should update the same URL; do not send or edit a Spectrum message for each milestone. The host's public deployment and device rendering are separate integration steps. Building the package does not deploy it or bind it to an actual dot task's progress events.

## Routine and behavior changes from the Grok baseline

These are semantic changes, separate from dependency pinning and test-tooling repairs:

1. Host notification in dot mode writes a local durable inbox notice instead of POSTing to a Grok wake routine. No dot wake endpoint or recurring worker has been invented.
2. Six Grok bot IDs are replaced operationally by dot's front-door ownership and task-scoped specialist responsibilities. No `CreateAgent` migration is required or claimed.
3. Startup reads an existing project secret through the approved CLI into process memory; it does not write bridge secret files or require Grok webhook credentials.
4. Generic canned greeting replies require an explicit `greetingFastPath` option and are disabled by `start:dot`. Ordinary responses are agent-authored. The runtime still enqueues a one-time “it’s dot here” + confetti setup greeting on the first flushed batch; its marker records enqueue, not device delivery.
5. The runtime now rejects spaces explicitly identified as non-DM, in addition to exact-sender, inbound-direction, and iMessage-platform checks. Sender checks remain essential where provider space type is absent.
6. Inbound persistence precedes handled-ID bookkeeping; startup recovery covers interruption windows. Media jobs persist before download/transcription, and verified conversation context preserves original sender/space/line routing after restart. Local cross-process locks protect queue and claim updates, and a runtime lock prevents competing entry points sharing this data directory.
7. Agent actions require batch ownership, the original conversation, and a stable idempotency key with an input hash. Processing completion and delivery state are separate.
8. Ambiguous sends become `unknown` instead of entering automatic exponential retry. Reply exceptions do not trigger a potentially duplicate fallback send. Only one outbound drain runs at a time. Correlated read receipts are recorded separately from provider acceptance and reconciled even when they arrive before the send result is saved.
9. SDK imports use pinned `@spectrum-ts/core` and `@spectrum-ts/imessage`; the dot bootstrap configures official endpoints before dynamically importing them, and telemetry is disabled. Generated IDs default to the `dot` prefix and can use `DEPLOY_ID_PREFIX`.
10. Live Mini's private Blob store refuses an unconditional overwrite when an existing registry lacks an ETag; first creation is no-overwrite and updates require compare-and-swap. This preserves the existing host design while fixing its concurrency boundary.
11. Inbound reply/effect wrappers preserve their target and effect metadata, including wrapped media. Option mappings preserve card price/details and supplied reaction-removal metadata. This does not manufacture removal events: the pinned provider's ordinary reaction stream emits additions only.
12. Cards-ready processing waits for all expected files and aligned metadata, checks the explicit batch identity, and uses the stable `cards:<batchId>` enqueue key. The original watchdog remains an outbound path; direct and watchdog enqueue now converge on the same central card key, and differing content under that key is rejected.
13. Any added emoji on an exactly known card returns its saved details, known price with original qualifiers, and original direct URL. Missing information is not invented and no replacement research is triggered. Removed reactions are not selections; ambiguous targets receive one clarification. This replaces the legacy sentiment-based shortlist behavior and never grants transaction approval.

Original routine templates remain for historical/legacy deployment. Importing one does not activate dot. The old instruction to auto-deploy Live Mini when a hosting connector exists is not authorization to publish this work.

## Verification and remaining work

Environment preparation established the pinned bridge dependencies and Moonshine files/transcription. Live Mini's local tests, consistency check, build, and local HTTP smoke passed during implementation. The documented batch CLI was also exercised end-to-end with private synthetic state, including lease refresh, duplicate enqueue, wrong-space rejection, competing ownership, and completion; no provider runtime was started for that smoke test. Final aggregate bridge results must be taken from the final implementation report, not inferred from this document or an earlier run.

Re-run checks after your changes:

```bash
cd /absolute/path/to/photongrokbot/bridge
bun run preflight
bun run typecheck
bun test

cd ../live-mini/live-task-cards
npm test
npm run check
npm run build
```

The bridge test preload uses a temporary `BRIDGE_DATA_DIR`; never point ad hoc test scripts at the live inbox. For a fresh acceptance run, verify claim contention and lease refresh, duplicate enqueue, interruption recovery, unknown-send quarantine, graceful stop/restart, and the feature path you changed. Then separately verify an authorized inbound message, its actual agent-authored response in the same conversation, and requested rich-message/voice rendering on the device.

Outstanding boundaries: automatic dot activation; a public Live Mini host and trusted real-task milestone wiring; browser/device visual QA; production supervision and backup policy. No push, public deployment, or production readiness is claimed here. Retain the existing private runtime state when editing code; a new empty data directory resets deduplication and the setup-greeting marker.

## Handoff freeze status: 2026-09-30 07:33 UTC

The old minimal listener exited successfully before the full runtime started. The full runtime emitted its hosted-provider-connected event at startup (07:00:19 UTC) and is owned by one active reader. Initial queues were empty; only already-handled proof IDs were migrated. At 07:21 UTC, a fresh authorized phone greeting reached this runtime, was marked read, and triggered the once-only automatic “it’s dot here” greeting with a confetti effect request. Spectrum accepted it and a matching provider read receipt arrived at 07:21:17 UTC. A subsequent message was claimed, answered by dot and submitted through `dot-agent enqueue`; the bridge recorded provider acceptance at 07:23:33.952 UTC (legacy sentAt, after typing cleanup) and its matching provider read receipt arrived at 07:23:37.254 UTC. This verifies both the automatic greeting and active dot-authored queue transport/read paths. Phone-originated voice and visual rich-message rendering remain pending. The active-task loop showed noticeable handoff latency (approximately 42 seconds in receive-to-forward and 26 seconds in reply-forward handling for the observed exchange). Dot now uses the repository’s one-shot `dot-agent wait` command to await, claim and read work directly, then enqueues its response directly. The host-side wait and direct-reply commands remove extra forwarding/action-file steps without requiring a provider restart. The later timing/receipt runtime patch was activated through the confirmed-exit replacement described above. Subsequent individual direct-wait observations and the legacy timestamp caveats are documented in BUILD_VERIFICATION.md; no general speed guarantee is established. No additional provider client was introduced. See [BUILD_VERIFICATION.md](BUILD_VERIFICATION.md) and [ISSUES_AND_FIXES.md](ISSUES_AND_FIXES.md) for the exact machine-tested evidence and remaining limits.

### Latest lock-source activation status

Both the timing/receipt patch and the later process-group isolation fix in `file-lock.ts` are loaded in the sole connected replacement. The prior runtime exited at 14:03:06 UTC after Ctrl+C through its owned PTY, with exit code 1 and only `^C` output observed. Direct PID signaling was skipped because the expected owner PID was not visible and matching in that shell namespace. Its graceful cleanup and exit-code-1 cause remain unproven.

After that confirmed exit, the replacement was created at 14:03:25 UTC and its explicit provider-connected log was observed at 14:03:46 UTC. The reviewed source predates the new start. The same project, approved credentials and private data directory were reused, with no reset, reseed or simultaneous additional provider connection. Isolated SIGINT/SIGTERM/parent-death tests pass, but no new live speed or rich-device-rendering claim follows from startup alone.
