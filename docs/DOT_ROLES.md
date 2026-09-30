# dot role ownership

The original repository names six core Grok agents. In the dot integration these are **responsibilities**, handled by the active dot task and task-scoped workers. This document does not claim six permanent bots, independent model services, installed wake routines, or always-on workers exist.

## Six core responsibilities

| Original role | dot implementation responsibility | Expected result |
| --- | --- | --- |
| Front Door | Active dot task owns the conversation, reads/claims the batch, chooses response modality, applies user authorization, and final-enqueues actions | One coherent answer in the original `spaceId`; durable processing completion |
| Master Orchestrator | dot coordinates multiple dependent work streams only when needed; specialist tasks return to the same owner | Integrated outcome with explicit blockers and no duplicate sends |
| Creator | A scoped repair worker investigates regressions in the existing bridge, patches the affected module, and tests it | Minimal repair, verification evidence, and restart implications |
| Feature Add | A scoped implementation worker adds a requested new bridge capability, including schema and tests | Feature implementation and a clear updated contract |
| Image Cards | A visual-production worker creates the complete option set, local assets, and aligned card metadata | Ready grouped-attachment action or original cards-ready marker; no independent chat ownership |
| App Sheet | A UI/content worker prepares the requested static full-sheet app URL and content | Ready `app` action for the front-door owner |

An optional Live Mini worker prepares or updates read-only progress-card state when a usable host and trusted publisher path exist. Live Mini is not required for ordinary iMessage replies. Its four layouts and optional personal loaders remain in `live-mini/`; available source is not evidence of a deployed host.

## Batch ownership contract

1. The front-door task claims the incoming batch before acting. All workers receive only the relevant batch context and a concrete deliverable.
2. A worker returns its result and proposed outbound `input` to that owner. It does not start another Spectrum connection or enqueue a competing final response.
3. The front-door owner checks authorization, verifies the original `spaceId`, and uses a stable per-action ID with `dot-agent enqueue`.
4. Completion is recorded only after a durable result, accepted enqueue, or intentional no-send outcome. Queue acceptance is separate from delivery verification.
5. Long-running work refreshes the same owner's claim. If another owner holds an unexpired claim, do not bypass it.

The existing cards-ready watchdog can enqueue a prepared image stack. Treat a complete cards-ready marker as an outbound commitment, not an inert draft. Choose either that established path or direct front-door enqueue, and check existing queue state to avoid dual sends.

## Preserve the original interaction rules

- Pick whether a reaction, effect, or plain response is appropriate before producing a reply. Do not manufacture an extra acknowledgment when no response is useful
- Use plain text for conversation and open-ended questions, polls for real bounded choices, image stacks for visual comparisons, and app sheets for a requested richer surface
- Send a complete image-card set together and keep its `cards[]` metadata aligned with attachment order so reactions map to the correct option
- Any added emoji on an exactly known card returns that option's saved details, known price including its original qualifiers, and original direct URL. Do not branch by sentiment or ask whether details are wanted. Missing price stays missing; never invent content, substitute a link, or start replacement research because of a reaction. A removed reaction is not a selection. Ask one short clarification when the target is ambiguous. Reactions never authorize buying or booking
- Send only through the original authorized conversation. Keep final delivery with the front-door owner until a different ownership contract is explicitly implemented and verified
- Use actual task evidence for progress cards; animation and elapsed time do not prove completion
- Keep repairs separate from new feature work, and run relevant tests before proposing a restart

## Adapting the legacy instructions

`agents/*/PROFILE_TEMPLATE.md`, `skills/imessage-*`, and `routines/` remain useful descriptions of domain ownership. Their Grok-specific `CreateAgent`, `SendToAgent`, bot IDs, wake webhook provisioning, and automatic hosting steps are not executable dot APIs. Translate the responsibility into the active task's supported tooling; do not substitute guessed endpoints or fabricate agent identities.

No worker can expand user authorization. Publishing, deployment, account changes, new persistent access, or sensitive messages still need the applicable approval. The current implementation handoff includes no authorization to push or deploy.

For code paths, CLI examples, credentials, recovery, and verification limits, read [DOT_RUNTIME.md](DOT_RUNTIME.md).
