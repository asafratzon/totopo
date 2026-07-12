#!/usr/bin/env bash
# Regenerate the README demo: edit generate-cast.js, then run this.
#
# Renderer: agg (asciinema GIF generator) with JetBrains Mono.
# Hard-won notes for future sessions:
#  - Don't use svg-term: viewer-dependent fonts break box-drawing chars.
#  - Pass --line-height 1.0 or vertical │ segments won't connect.
#  - Every line of a drawn box must be the exact same column width,
#    or corners and the right border will float (see generate-cast.js).
#  - Use SQUARE corners (┌ ┐ └ ┘): agg vector-draws straight box chars
#    pixel-perfectly, but rounded arcs (╭ ╮ ╰ ╯) fall back to font glyphs
#    that do not align with the vector lines.
#  - Emit multi-line blocks as a single cast event; renderers may drop
#    events that share identical timestamps.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x ./agg ]; then
  curl -sL -o agg https://github.com/asciinema/agg/releases/latest/download/agg-x86_64-unknown-linux-gnu
  chmod +x agg
fi
if [ ! -f fonts/JetBrainsMono-Regular.ttf ]; then
  mkdir -p fonts && curl -sL -o jbm.zip \
    https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
  (cd fonts && unzip -oqj ../jbm.zip "fonts/ttf/*.ttf") && rm jbm.zip
fi

node generate-cast.js
./agg --font-dir fonts --font-family "JetBrains Mono" \
      --theme github-dark --font-size 16 --line-height 1.0 \
      quickstart.cast quickstart-raw.gif
python3 add-window.py quickstart-raw.gif ../.github/assets/quickstart.gif
rm quickstart-raw.gif
