# Edit and render

The final video is `photon-dot-imessage-final.mp4`: a 60-second, 1920 × 1080, 60 fps silent-first explainer. All graphics, captions, colors, timing, and typography are editable.

## Contents

- `animation.py`: eight original frame-driven scenes
- `project.json`: canvas, timing, chapter names, and evidence copy
- `assets/fonts/`: bundled licensed fonts and required notices
- `captions.srt`: optional subtitle file; the video already carries its essential story on screen
- `storyboard-and-caption-script.md`: scene-by-scene visual and editorial script
- `assets-and-licenses.json`: media provenance and official tooling references
- `technical-motion-explainer/`: reusable skill and streaming renderer

## Re-render

Use Python 3.10+ with Pillow and NumPy, plus FFmpeg and ffprobe on PATH. No browser, network, paid service, or external media is needed for rendering.

```sh
python technical-motion-explainer/scripts/render_motion.py animation.py --stills qa --times 0,3.7,10,18,26,34,42,50,57,59.98
python technical-motion-explainer/scripts/render_motion.py animation.py --output revised.mp4 --preset fast --crf 18
ffmpeg -v error -i revised.mp4 -f null -
```

The renderer refuses to replace an existing destination unless `--overwrite` is given. For a faster draft, use `--fps 30`. To render a section, specify `--start` and `--end` in seconds.

Each frame is derived only from its index. Edit a scene function for layout and motion; edit `project.json` for evidence-panel wording. Changing dimensions also requires relayout because this composition is deliberately art-directed for 1920 × 1080. Keep any new claims consistent with what the implementation actually verifies.

## Skill use

The `technical-motion-explainer` folder is a self-contained skill package. Place that folder in the skill directory of the Codex environment where you want to use it. It was validated and tested here; packaging it does not install it into other environments.
