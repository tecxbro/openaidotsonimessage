# Frame-driven rendering and quality checks

## Composition contract

`render_frame(n)` returns a Pillow image at the composition dimensions. Frame zero and frame `round(DURATION * FPS) - 1` must both contain a designed state. Make seeking pure and deterministic. Cache font loading, rendered text, backgrounds, and other stable layers; never cache an unbounded number of full-resolution frames.

Keep scene start/end times explicit. For dissolves, render both scenes for the transition interval and blend them; do not fade both to black unless a blackout is an intentional story beat. Avoid dense text during dissolves.

The helper streams raw RGB to FFmpeg without storing thousands of large PNGs. It writes to a temporary MP4 and only replaces the destination after a successful encode and metadata check. Existing files require explicit `--overwrite`. `--start`/`--end` and a lower `--fps` are useful for test clips; final frame rate should match the agreed delivery target.

## QA commands

Extract and inspect selected stills with the helper. Include scene mids, transition mids, frame zero, and the last frame. A contact sheet proves composition consistency but is not enough to evaluate small labels; inspect full-size and phone-size frames too.

Decode the entire finished output:

    ffmpeg -v error -i explainer.mp4 -f null -

Inspect container and stream metadata:

    ffprobe -v error -show_streams -show_format -of json explainer.mp4

Use frame statistics or a low-resolution sample to flag unexpected blank frames. A deliberate dark background is not a blank frame: evaluate spatial contrast and compare flagged frames to expected scene content. Do not claim continuous playback QA from only a contact sheet.

## Official references consulted

- Remotion frame-driven composition model: https://www.remotion.dev/docs/the-fundamentals
- Animation interpolation, springs, and frame-based timing: https://www.remotion.dev/docs/animating-properties
- Official Remotion agent skills: https://www.remotion.dev/docs/ai/skills
- FFmpeg muxer and rawvideo input documentation: https://ffmpeg.org/ffmpeg-formats.html
- ffprobe machine-readable metadata: https://ffmpeg.org/ffprobe.html

These are tooling references, not copied templates. The included Python renderer is an offline alternative and does not claim Remotion compatibility.
