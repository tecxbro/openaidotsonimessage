# dot on iMessage, powered by Photon

Full reusable source for the dot adaptation of [tecxbro/photongrokbot](https://github.com/tecxbro/photongrokbot), plus the setup guide, issue and verification reports, architecture article, and editable motion explainer.

This publication snapshots the cloud implementation from 30 September 2026. The bridge receives iMessages through Photon Spectrum, saves durable batches, lets an **active dot task** claim and process them, and sends authorized replies through the same connection. It does not create automatic dot activation or include an external model API.

## Start here

- [Runtime setup and operating guide](docs/DOT_RUNTIME.md)
- [Issues, fixes, and remaining boundaries](docs/ISSUES_AND_FIXES.md)
- [Implementation verification and live evidence](docs/BUILD_VERIFICATION.md)
- [Publication inventory, privacy exclusions, and fresh checks](docs/PUBLICATION.md)
- [Role responsibilities](docs/DOT_ROLES.md)
- [Architecture article](extras/article/dot-imessage-architecture.md), [editable Word version](extras/article/dot-imessage-architecture.docx), and [PDF](extras/article/dot-imessage-architecture.pdf)
- [60-second motion explainer](extras/video/photon-dot-imessage-final.mp4), [storyboard](extras/video/storyboard-and-caption-script.md), and [editing/rendering guide](extras/video/RENDER.md)

## What is included

- `bridge/`: complete Bun/TypeScript runtime, durable local inbox, claim/wait/reply CLI, queue recovery, idempotent sends, receipt timing, signal-safe kernel locking, tests, and local Moonshine transcription scripts
- `live-mini/`: optional editable live task cards, application/skill tests, host source, and deployment guidance
- `stt/`: pinned Python dependency, official model download instructions, and exact model checksums
- `skills/`, `photon-skills/`, `agents/`, and `routines/`: reusable project-specific skills and legacy adopter templates
- `extras/article/`: article sources and final editable/exported documents
- `extras/video/`: final MP4, deterministic animation source, captions, storyboard, licensed fonts, quality evidence, and reusable rendering skill

The original Grok-oriented material is retained in [README-GROK-LEGACY.md](README-GROK-LEGACY.md) and the numbered guides. Its webhook provisioning and permanent-agent setup are historical reference. Use `docs/DOT_RUNTIME.md` for this dot integration.

## Requirements

Linux with util-linux `flock`; Bun 1.4.2; Node 22+ for Live Mini; Python with `moonshine-voice==0.1.5`; FFmpeg/ffprobe; the nine official Moonshine model files; and an existing authorized Photon CLI login, Spectrum project, hosted line, and sender restriction. The lockfile pins both Spectrum SDK packages to 12.10.1.

```sh
cd bridge
bun install --frozen-lockfile
bun run typecheck
bun test
```

Follow the runtime guide to configure private paths, install Moonshine, run preflight, and start `bun run start:dot`. Tests use isolated synthetic state and do not connect to Spectrum. Do not start a second bridge against a project that already has a live runtime.

## Verification boundaries

The full implementation previously passed 103 registered bridge tests / 504 expectations plus its legacy assertions, TypeScript and complete model-integrity preflight. Live Mini passed 123 application and 7 skill tests. See the publication report for the checks repeated on this exact snapshot.

A dot-authored text round trip, provider acceptance, and correlated read receipt were observed on the original authorized setup. Real-phone voice and rich-message rendering still need end-to-end checks. Live Mini has no public deployment in this publication. The bridge requires both a running runtime and an active dot task to respond.

## Privacy and provenance

Credentials, live project/sender IDs, message histories, queues, logs, private assistant notes, dependencies, virtual environments, and 224 MB of model weights are excluded. Download models from the pinned official sources in `stt/MODEL_MANIFEST.json`; preflight verifies their hashes.

The source comes from upstream commit `8c710413c99a6fd8022727326ca682d267393953` plus the local dot integration. This repository starts with a clean publication history rather than importing development history or private state. Existing third-party notices are retained. See [publication details](docs/PUBLICATION.md).
