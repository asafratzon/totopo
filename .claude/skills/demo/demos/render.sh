#!/usr/bin/env bash
# Regenerate the README demos: edit a scenario (quickstart.js / advanced.js), then run this.
# Usage: ./render.sh [name ...]   e.g. ./render.sh advanced   (default: all scenarios)
#
# Renderer: agg (asciinema GIF generator) with JetBrains Mono.
# Hard-won notes for future sessions:
#  - Don't use svg-term: viewer-dependent fonts break box-drawing chars.
#  - Pass --line-height 1.0 or vertical │ segments won't connect.
#  - Every line of a drawn box must be the exact same column width,
#    or corners and the right border will float (see the scenario files).
#  - Use SQUARE corners (┌ ┐ └ ┘): agg vector-draws straight box chars
#    pixel-perfectly, but rounded arcs (╭ ╮ ╰ ╯) fall back to font glyphs
#    that do not align with the vector lines.
#  - Emit multi-line blocks as a single cast event; renderers may drop
#    events that share identical timestamps.
set -euo pipefail
cd "$(dirname "$0")"

# All scenario files; add new demos here.
ALL_DEMOS=(quickstart advanced)
if [ $# -gt 0 ]; then DEMOS=("$@"); else DEMOS=("${ALL_DEMOS[@]}"); fi

# Pick the agg build for this machine's architecture (the demo renders inside
# the Linux container, so we always want a linux-gnu binary).
case "$(uname -m)" in
  x86_64)        AGG_ARCH=x86_64 ;;
  aarch64|arm64) AGG_ARCH=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if [ ! -x ./agg ]; then
  curl -sL -o agg "https://github.com/asciinema/agg/releases/latest/download/agg-${AGG_ARCH}-unknown-linux-gnu"
  chmod +x agg
fi
if [ ! -f fonts/JetBrainsMono-Regular.ttf ]; then
  mkdir -p fonts && curl -sL -o jbm.zip \
    https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
  (cd fonts && unzip -oqj ../jbm.zip "fonts/ttf/*.ttf") && rm jbm.zip
fi
# Fallback font for glyphs JetBrains Mono lacks - notably the braille spinner
# frames (U+2800 block) used by the AI CLI update loader in advanced.js.
# NOTE: DejaVu Sans Mono does NOT cover braille (only the proportional DejaVu
# Sans does); Cascadia Code covers it and is monospace, so it fits the grid.
if [ ! -f fonts/CascadiaCode-Regular.ttf ]; then
  curl -sL -o cascadia.zip \
    https://github.com/microsoft/cascadia-code/releases/download/v2404.23/CascadiaCode-2404.23.zip
  (cd fonts && unzip -oqj ../cascadia.zip "ttf/static/CascadiaCode-Regular.ttf") && rm cascadia.zip
fi

# add-window.py needs Pillow. Provision it automatically, like agg and the fonts above,
# so a fresh container needs zero manual setup. Prefer an isolated venv (never touches the
# system site-packages, which Debian marks externally-managed); fall back to a
# --break-system-packages install if venv is unavailable. PYBIN can import PIL.
if python3 -c 'import PIL' 2>/dev/null; then
  PYBIN=python3
elif [ -x .venv/bin/python3 ] && .venv/bin/python3 -c 'import PIL' 2>/dev/null; then
  PYBIN=.venv/bin/python3
elif python3 -m venv .venv 2>/dev/null; then
  .venv/bin/pip install -q --disable-pip-version-check Pillow
  PYBIN=.venv/bin/python3
else
  python3 -m pip install -q --break-system-packages Pillow
  PYBIN=python3
fi

# The committed GIFs live at the repo root, not next to this skill-local tooling.
ASSETS_DIR="$(git rev-parse --show-toplevel)/.github/assets"
for name in "${DEMOS[@]}"; do
  node "$name.js"
  ./agg --font-dir fonts --font-family "JetBrains Mono,Cascadia Code" \
        --theme github-dark --font-size 16 --line-height 1.0 \
        "$name.cast" "$name-raw.gif"
  "$PYBIN" add-window.py "$name-raw.gif" "$ASSETS_DIR/$name.gif"
  rm "$name-raw.gif"
done
