# Local dispatch verification

Implemented on `codex/immediate-dispatch` from reviewed dot main `970574e9679354aeb84753a21d9147b3cf66cf43`. Grok main was verified as `8c710413c99a6fd8022727326ca682d267393953`; its webhook path was not changed. No push, deployment, live bridge restart, real provider connection or device send occurred.

## Completed behavior

- Ordinary input publishes immediately through serialized persistence; batch and wake intent precede buffer clearing. Remote wake responses run outside the commit chain, with durable retries and per-batch single-flight notification.
- Directory notifications wake the existing durable sender and complete-card final enqueue. Same-process callbacks supplement queue notifications. Periodic scans remain recovery, including legacy card stability inference.
- Card completion validates the original conversation, complete files, exact count and aligned metadata. Five and seven cards stay one group. The producer profile and skill use `cards-complete`; this snapshot has no executable image generator to integrate.
- Conversation claim ownership prevents competing owners across later batches. Completed notices retire after synced completion publication, and startup preserves completion/deduplication evidence. Lazy scans and ownership bootstrap honor deadlines; cancelled uncommitted reservations are removed.
- Pre-send retries are bounded; documented validation/auth rejection fails explicitly. Uncertain sends quarantine and block later sends in that conversation. Shutdown attempts controlled teardown and fails while old work remains unresolved. Media concurrency is capped and pending identities appear alongside following text.
- Outgoing typing/read controls are restored using Stable Spectrum 12.10.1. Authorized input is marked read, and typing starts for pending work and stops after a response or at shutdown. Ancillary calls stay independent of message dispatch and tracked through teardown. Passive receipts, reactions, rich actions, threaded replies, card mappings and app sessions remain.
- Content-free timing covers the eight requested boundaries. Durable publications sync contents and directory entries. New canonical idempotency hashes are additive; the legacy raw hash remains for rollback. Historical outbound/receipt/target records are retained.

## Final checks

Bun 1.4.2 and pinned Spectrum 12.10.1:

```bash
cd bridge
bun run typecheck
bun test
```

TypeScript passed after restoring the controls. **149 tests passed, 0 failed, 777 assertions**, across 23 bridge test files. This includes cross-process enqueues, atomic replacement, missed notifications, active sends, card completion/races, ownership, large history/deadlines, recovery cutoffs, failure classification, media limits, shutdown, controls, receipts and rollback-compatible idempotency. Control checks cover authorized reads, typing through tapbacks, cleanup without holding later sends, a delayed start after the reply, controlled teardown and refusal to hand off ownership while a read operation remains unresolved.

Offline preflight passed Bun, SDK/provider imports, flock, FFmpeg and ffprobe. It failed Moonshine import, model-file presence and model integrity because the local transcription runtime/models are absent. Real voice transcription, host activation/pickup, real model/tool execution, provider transport and device rendering remain unverified.

## Saved fake measurements

100 measured samples after 10 excluded warmups, macOS, one injected provider connection, substantive fake answers. No credentials or network. These results **precede the final file/directory sync changes and the restored typing/read controls**; final timings were not rerun.

| Producer | Input commit to publication p95 | Outbox commit to SDK entry p95 |
| --- | ---: | ---: |
| Same process | 20.694 ms | 28.647 ms |
| Separate stdin-reply CLI process | 21.644 ms | 77.950 ms |

Reports: [same process](../artifacts/latency/instant-local.json), [separate process](../artifacts/latency/instant-external-agent.json). The [initial measurement](../artifacts/latency/initial-local.json) recorded 101.500 ms outbox p95 before supplemental callbacks. Reported claim-to-answer submission includes tool validation/process overhead; it is not a real model reasoning benchmark. SDK-to-return includes SDK work and is not pure provider latency. No live host comparison or one-second phone response is promised.

The publication manifest and legacy pack manifest remain provenance for the reviewed published snapshot; this local implementation has not been published.
