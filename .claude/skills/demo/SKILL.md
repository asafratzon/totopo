---
name: demo
description: Create or update the animated terminal demos (GIFs) embedded in the README. Use whenever the README demo needs to reflect UI changes, a new totopo version, or when a new demo GIF is requested (e.g. showing a specific feature like voice mode, auto-start, git modes, or shadow paths). Triggers include "update the demo", "record a demo", "the demo GIF is outdated", or any release that changes visible CLI output.
---

# README terminal demos

The demos are **synthetic**: no real container is run. A Node script hand-authors
an asciicast v2 file simulating a totopo session, which is rendered to a GIF.
This makes demos deterministic, fast, and runnable inside a sandbox without Docker.

## Files

- `demos/generate-cast.js` — the scenario. Edit this to change what the demo shows.
- `demos/add-window.py` — wraps the GIF in a macOS-style window (title bar,
  traffic lights, transparent rounded corners). Rarely needs changes.
- `demos/render.sh` — full pipeline: downloads agg + JetBrains Mono from GitHub
  releases on first run, then cast → GIF → windowed GIF into `.github/assets/`.
- `.github/assets/quickstart.gif` — the committed output, embedded in README.md as
  `![totopo demo](.github/assets/quickstart.gif)`.

## Workflow for any change

1. **Fidelity first.** The demo must match the real UI verbatim. Read the actual
   source of the CLI output (menu labels, box contents, startup messages, status
   line format) before editing the scenario. Never invent text. The version
   number in the header box must match the release being shipped.
2. Edit the scenario section of `demos/generate-cast.js`.
3. Run `demos/render.sh`.
4. **Verify visually.** Extract frames with PIL and view them:
   ```python
   from PIL import Image
   im = Image.open('.github/assets/quickstart.gif'); im.seek(N)
   im.convert('RGB').save('/tmp/frame.png')
   ```
   Check at least: the header box (all four corners connected), the menu, and
   the final frame. Zoom (crop + resize with NEAREST) when checking borders.
5. To add a second demo (e.g. an advanced-features one), copy
   `generate-cast.js` to a new name, change the scenario and output filenames,
   and add a matching render line in `render.sh`.

## Hard-won rendering rules — violating these produces broken output

- **Renderer is agg, never svg-term.** SVG text rendering depends on the
  viewer's fonts and breaks box-drawing characters.
- **Square box corners only** (`┌ ┐ └ ┘`). agg vector-draws straight
  box-drawing characters pixel-perfectly, but rounded arcs (`╭ ╮ ╰ ╯`) fall
  back to font glyphs that misalign with the vector lines.
- **Every line of a drawn box must be the exact same column width**, counted
  in characters excluding ANSI escapes, or corners and the right border float.
  Verify with a quick `python3 -c "print(len(line))"` check.
- **`--line-height 1.0`** is required, or vertical `│` segments won't connect.
- **Emit each multi-line block as a single cast event.** Renderers may drop
  events that share identical timestamps.
- Keep the terminal 90 columns wide; verify no line exceeds it (the Claude
  status line is the usual offender).
- Use `\u001b[38;5;245m` for grey rails/dim text — theme "bright black" can be
  near-invisible.

## Style conventions

- Theme `github-dark`, font JetBrains Mono, font-size 16, ~15s total duration.
- Human typing pace: 40–80 ms per keystroke, pauses before "output" appears.
- Menu redraws (select → collapsed) use cursor-up + clear: `\u001b[NA\u001b[0J`.
- Basic quickstart demo shows only the core flow. Advanced features (ports,
  shadow paths, audio server, auto-start) belong in separate demo GIFs.
