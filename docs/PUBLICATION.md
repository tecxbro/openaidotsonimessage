# Public source publication

Prepared on 2026-09-30 in an isolated publication checkout for `tecxbro/openaidotsonimessage`. The target repository was empty, with `main` as its default branch. No existing remote files or history were overwritten. The original `tecxbro/photongrokbot` remote and the live bridge checkout were not changed by publication.

## Provenance and inventory

- Source base: `tecxbro/photongrokbot` commit `8c710413c99a6fd8022727326ca682d267393953`
- Implementation: the complete current working tree of `dot/full-runtime-20260930`, including dot-local inbox/wait/reply, recovery, timing, safe kernel locking, Moonshine scripts, and all existing rich-message modules
- All 272 reusable source files from the implementation checkout are included. Production runtime code is byte-for-byte identical to that checkout. Publication changes are confined to README/navigation, documentation status and portable paths, ignore rules, one old manifest path, and one test-only message identifier replaced with an explicitly synthetic UUID
- All preexisting adopter-template project skills and role documents are retained. These are reusable repository content, not the assistant's private notes or active conversation state
- Article: Markdown, text, editable DOCX, final PDF, and the Python DOCX builder
- Motion explainer: final 60-second 1080p/60fps MP4 (3,765,150 bytes), editable animation/project source, captions, storyboard, preview/poster, font assets/notices, quality records, and reusable rendering skill
- The original Grok guide is retained as `README-GROK-LEGACY.md`; the new root README links to dot setup
- `PUBLICATION-MANIFEST.json` records sizes and SHA-256 hashes for every delivered file except the manifest itself

This is a clean source snapshot. Development Git history is not imported, and there is no redundant source tarball, handoff ZIP, or incremental patch in this repository. The complete final source is directly inspectable instead.

## Deliberate exclusions

- No secrets, authentication tokens, live project/sender/phone identifiers, private configuration, environment values, or credentials
- No private messages, voice transcripts, inboxes, outboxes, delivery journals, runtime logs, process metadata, private assistant notes, or session information
- No dependency directories, virtual environments, build caches, compiled Python caches, or downloaded model weights
- No redundant video drafts, intermediate document exports, raw frame dumps, or duplicate ZIP packages; final deliverables, editable sources, compact previews, and relevant verification records are present
- The obsolete minimal proof listener is superseded by the complete reusable bridge and is excluded because its historical one-off configuration embedded live identity/path values

The nine Moonshine model files total 224,067,582 bytes. Use the pinned official URLs, revision, sizes, and SHA-256 hashes in `stt/MODEL_MANIFEST.json`; follow `stt/INSTALL.md` and install `stt/requirements.txt`. `bridge` preflight verifies model integrity offline. The publication does not provision a Photon project, login, public hosting, or any background startup service.

## Checks repeated for publication

All checks ran against the isolated publication source, without a provider connection, test sends, runtime stop/start, or changes to live data.

- TypeScript: `bun run typecheck` passed
- Full bridge suite: `bun test` passed 103 registered tests / 504 expectations / zero failures, plus the legacy top-level assertion suites
- The only later source edit replaced a test-only message UUID with an explicitly synthetic fixture; all 12 reaction-option tests / 66 expectations passed again
- Offline `bun run preflight`: Bun, SDK, hosted-provider import, flock, FFmpeg, ffprobe, Moonshine import/version, all nine model files, and every model hash passed
- Preflight used existing installed dependencies and model files through temporary local symlinks; these are not shipped, and a fresh checkout must install/download them
- Live Mini: all 123 application tests and 7 skill tests passed
- Live Mini syntax/example check: 59 JavaScript modules, four task examples, and two loader assets passed
- Live Mini build passed, creating its local Vercel output without credentials; generated build output is excluded
- Final MP4: ffprobe confirmed H.264, 1920 × 1080, 60 fps, exactly 60 seconds / 3,600 frames; full FFmpeg decode passed without errors
- Content review checked text, document metadata, and bundled assets for accidental secret/live identity data; production source and assets were compared against the prepared implementation

The detailed earlier implementation and live evidence remain in `BUILD_VERIFICATION.md`. Those historical observations do not constitute a new live speed test, phone-voice test, rich-message visual verification, or public deployment. No GitHub Actions workflow is configured by this snapshot; local verification is not represented as a remote CI run.

## Licenses

Existing third-party license notices are retained, including the bundled Open Sans fonts. Photon skill provenance remains documented in the original handoff manifest. No new blanket license is assigned to upstream or third-party material by this publication.

Inherited Live Mini illustrations have the upstream provenance caveat in [`live-mini/live-task-cards/docs/SOURCES.md`](../live-mini/live-task-cards/docs/SOURCES.md): independent third-party redistribution rights were not established for `study.png`, `hands.png`, and related reference imagery. They remain included as user-supplied project assets; this repository does not declare them newly open-licensed.

The initial full-tree `git diff --cached --check` flags preexisting Markdown trailing-space line breaks and terminal blank lines in legacy templates. These are inherited documentation formatting, not a new source-code error; they are preserved rather than silently rewritten.


## October 1 reliability update and upload status

The reviewed follow-up contains rejected background drain/flush/stop tasks and adds sanitized lifecycle/error diagnostics. The exact approved runtime files are `bridge/src/runtime.ts`, `runtime-diagnostics.ts`, and `runtime-diagnostics.test.ts`; the runtime, issue, and verification guides have been refreshed. Production source matches the reviewed implementation. Documentation retains portable paths and publication-specific navigation. The runtime owner separately verified the reviewed source was loaded and provider-connected at 03:48:16.225 UTC on October 1, following a plain-pipe launch. No message was resent during activation. This is point-in-time activation evidence, not a durability or device-rendering guarantee.

The source task reports **115 tests / 564 expectations / zero failures**, TypeScript and full offline preflight passing. Publication checks repeated the full 115-test / 564-expectation suite, TypeScript, and every offline preflight check successfully against this isolated checkout. An independent reviewer reran **12 focused tests / 60 expectations**. Tests use synthetic state and injected providers. Existing September 30 evidence above remains historical.

The intended complete snapshot now comprises **304 files**, including the manifest. The remote publication has **298 files** after this text update; six large binary assets are pending upload:

- `extras/video/photon-dot-imessage-final.mp4`
- `extras/video/storyboard-preview.jpg`
- `live-mini/live-task-cards/public/assets/study.png`
- `live-mini/live-task-cards/references/01-dot-grid.png`
- `live-mini/live-task-cards/references/02-segments.png`
- `live-mini/live-task-cards/references/03-stages.png`

The manifest records all audited local deliverable hashes and explicitly identifies those pending remote assets. The animation source is already published; remote MP4/preview/reference-image links will work once the remaining uploads complete. No credentials or runtime diagnostic journals are included.
