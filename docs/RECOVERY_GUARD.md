# Offline provider-event recovery guard

This is an **opt-in source change**, not an activated connection. It was prepared for a replacement filesystem with no recoverable private queues, handled IDs, or onboarding marker. Do not reconstruct historical actions or pretend that an onboarding message was sent. Normal startup without a policy retains the existing bridge behavior.

## What the boundary means

The pinned `@spectrum-ts/imessage` **12.10.1** hosted live stream maps remote `event.occurredAt` into the universal `message.timestamp`. Reaction and poll events use the same event field; read receipts use `readAt` when present, otherwise `occurredAt`. The Advanced iMessage parser requires the remote `occurredAt` field. The bridge only accepts a valid SDK `Date` strictly **after** the saved UTC cutoff; equality, older times, missing times, invalid dates, strings and numeric guesses are rejected.

This is a **provider-event cutoff**, not proof of original Apple message creation or send time. Native `dateCreated` is not exposed on the live universal message metadata. A newly recorded provider event about an older Apple message may pass. Source inspection does not establish server-side historical-import behavior, and no live replay experiment was performed. Do not advertise a hard guarantee that every Apple message predating the cutoff is excluded.

The guard runs before bridge-side receipt recording/mark-read, attachment downloads, transcription jobs, conversation persistence, batching, wakes, typing and automatic replies. The SDK may already have resolved referenced messages or performed profile/contact-sharing work before emitting a universal message; a bridge-level guard cannot prevent that SDK preprocessing. Photon replay availability or delivery of messages received while offline is not guaranteed.

Pinned source inspected locally:

- `@spectrum-ts/imessage/dist/index.js`: `toInboundMessages`, `toReactionMessages`, `buildPollOptionMessage`, `toReadReceiptMessages`, `rebuildFromAppleMessage`, `toMessageItem`
- `@spectrum-ts/core/dist/index.js`: `wrapProviderMessage` preserves the supplied timestamp but falls back to local time if a provider omits it
- `@photon-ai/advanced-imessage/dist/chunk-5WYZRCOS.js`: event parsing unwraps required `occurredAt`; message mapping requires native `dateCreated`

These are implementation-version assumptions. Re-review timestamp provenance and pre-emission effects before upgrading SDKs.

## Proposed bootstrap, after authorization

No command below was run against live state. Login, provider startup and any response remain separately authorized operations. Use a new private directory, not the missing old directory's reconstructed contents. Choose the exact cutoff deliberately and keep it; never replace it with the current time on each restart.

```bash
cd /absolute/path/to/photongrokbot/bridge
umask 077
export BRIDGE_DATA_DIR="/absolute/path/to/new-private-recovery-state"

# Replace the placeholder with an explicitly approved UTC instant.
bun run recovery-init -- --event-cutover-utc "<YYYY-MM-DDTHH:mm:ss.sssZ>" --suppress-onboarding

# Keep this requirement on every future runtime invocation.
export BRIDGE_REQUIRE_RECOVERY_POLICY=1

# Only after the existing account/project/sender and login are authorized:
# bun run start:dot
```

`recovery-init` is offline: it imports no SDK, retrieves no credentials, starts no provider, and queues no message. It takes the runtime lock and exclusively creates `recovery-policy.json`, mode 0600, then syncs the file and directory. Initialization requires fresh state, allowing only `.gitkeep` and the runtime lock artifacts. Existing queues, files or directories cause refusal. A repeat with the identical boundary is idempotent; a different boundary or a malformed existing policy is refused. There is no reset or disable command.

The persisted policy enables the guard on every runtime start, even if the environment requirement is omitted. `BRIDGE_REQUIRE_RECOVERY_POLICY=1` additionally refuses startup when the file is missing, avoiding a silent fallback to normal behavior after another state loss. The dot bootstrap validates it before retrieving the existing project credential. Invalid requirement values, corrupt policy or unreadable policy fail closed.

The file stores `{version:1, mode:"provider-event-cutover", eventCutoverUtc:"…Z", suppressOnboarding:true}`. Suppression is an explicit operational decision. It does **not** create or alter `onboarding-celebrated.json`, claim a past send, or seed handled IDs. Accepted new events use the existing handled-ID deduplication, immutable batch, claim and outbound queue contracts. The ordinary optional greeting fast path remains controlled separately; dot startup already disables that path.

On restart, recovered inbound records must still have valid timestamps after the original boundary. An in-progress media job must retain its admitted `recoveryEventTimestamp`; absent/old/invalid values refuse startup before provider connection. Resuming media uses that saved event time, not the fetched message's potentially different `dateCreated` or a local-time fallback. Do not merge old state into this fresh recovery directory or reset the cutoff to admit rejected work.

## Verification

Run offline with the repository's temporary test-state preload:

```bash
bun run typecheck
bun test
```

The dedicated `recovery-policy.test.ts` covers immutable initialization, private file mode, freshness and lock refusal, strict UTC parsing, required/corrupt policy, old/equal/missing/invalid events across text/reaction/poll/receipt/media kinds, no rejected-event reads/downloads/wakes/queues, accepted-event batches, explicit onboarding suppression without a fake marker, and cutoff/deduplication persistence across injected-provider restarts. Existing default-mode tests must continue passing.

Tests use synthetic fixtures and an injected in-memory provider. They do not validate Photon server semantics, contact-sharing settings, live reception, actual sends or phone rendering. Final pass counts and review findings belong in the accompanying source-only bundle manifest.
