---
name: technical-motion-explainer
description: Create or revise short, evidence-grounded technical motion-graphic explainers, including storyboards, editable frame-driven animation, MP4 rendering, and visual QA. Use for animated architecture and product-flow videos; not for live-action editing or static slide decks.
---

# Technical motion explainers

Build a readable, silent-ready story that explains one system or workflow. Deliver the rendered video alongside editable source, timed captions, and an asset/license manifest. Preserve the user's selected aspect ratio, engine, platform, and publishing scope.

## Turn facts into motion

- Establish which claims are implemented, locally tested, verified on-device, or still proposed. For an implementation in progress, prepare the visual system immediately but lock the final script only against a named implementation freeze. Keep important limitations on screen long enough to read.
- Show the exact direction and ownership of data flows. Differentiate transport, queues, execution, and UI. Avoid depicting an automatic trigger, deployment guarantee, or delivery status the implementation does not have.
- Use one main idea per scene and short supporting text. For 1080p mobile-feed delivery, keep primary text roughly 70–110 px and essential labels roughly 32–44 px. Test at phone-feed size. Technical details should move to the accompanying article when they crowd the frame.
- Animate the causal relationship, such as a packet entering a queue or an authorized reply leaving it. Use restrained easing and staggered entrances; give the viewer a stable reading interval.
- Use original vector assets or explicitly licensed media. Never include real credentials, private inbox contents, phone numbers, or account identifiers in example UI. Mark mock conversations as illustrative.

## Choose the renderer

Use the user's existing animation project when supplied. For a browser-capable React workspace, consult current official [Remotion documentation](https://www.remotion.dev/docs/) and [official skills](https://www.remotion.dev/docs/ai/skills). Do not assume a community install script is safe or that a browser launch is permitted.

For authored offline graphics, `scripts/render_motion.py` accepts a Python composition exposing WIDTH, HEIGHT, FPS, DURATION and `render_frame(frame_index) -> PIL.Image`. All visible state must be derived from the frame index; do not use wall-clock timers or nondeterministic random input. Seed procedural assets if needed.

The helper renders an H.264/yuv420p fast-start MP4, validates encoded dimensions, duration and frame count, and saves machine-readable probe metadata. It also generates selected full-size PNGs and a contact sheet. Run it only on trusted or authored source.

Example:

    python scripts/render_motion.py animation.py --stills qa --times 0,4,9,15,21
    python scripts/render_motion.py animation.py --output explainer.mp4

Dependencies are Python with Pillow, FFmpeg and ffprobe. A composition may add its own documented dependencies. Use an existing toolchain first. See `references/rendering-and-qa.md` for testing and codec checks.

## Finalize

Inspect actual rendered pixels, including first/last frames, each scene, and both sides of every transition. Decode the entire final MP4. Check reading time, type clipping, scene gaps, unintended blank frames, aspect ratio, frame rate, and output size. If audio is added, disclose its provenance and check sync, clipping, and audible transitions; a complete silent-first explainer does not require audio.

Record what was actually verified. Package only the deliverable, edit-ready source, required assets/licenses, timed captions, and concise render instructions. Keep drafts and private evidence out of the user-facing archive. Deliver privately unless publishing was requested and authorized.
