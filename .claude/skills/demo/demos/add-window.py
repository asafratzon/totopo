#!/usr/bin/env python3
"""Wrap an animated GIF in a macOS-style terminal window frame.

Adds a title bar with traffic-light buttons and rounded corners
(transparent, so it looks right on GitHub in light and dark mode).

Usage: python3 add-window.py input.gif output.gif
"""
import sys
from PIL import Image, ImageDraw, ImageSequence

SRC, DST = sys.argv[1], sys.argv[2]

PAD = 14           # inner padding around the terminal content
BAR = 36           # title bar height
RADIUS = 12        # window corner radius
DOT_R = 7          # traffic light radius
DOTS = [(0xFF5F57, 24), (0xFEBC2E, 46), (0x28C840, 68)]  # color, center x

im = Image.open(SRC)
bg = im.convert("RGB").getpixel((2, 2))  # terminal background color

W = im.width + PAD * 2
H = im.height + BAR + PAD

# rounded-rectangle mask, thresholded to 1-bit for GIF transparency
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], RADIUS, fill=255)
transparent = mask.point(lambda a: 0 if a > 128 else 255)  # inverted

frames, durations = [], []
for frame in ImageSequence.Iterator(im):
    durations.append(frame.info.get("duration", 100))
    canvas = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(canvas)
    for color, cx in DOTS:
        rgb = ((color >> 16) & 255, (color >> 8) & 255, color & 255)
        d.ellipse([cx - DOT_R, BAR // 2 - DOT_R, cx + DOT_R, BAR // 2 + DOT_R], fill=rgb)
    canvas.paste(frame.convert("RGB"), (PAD, BAR))

    p = canvas.quantize(colors=255)
    p.paste(255, transparent)  # palette index 255 = transparent corners
    frames.append(p)

frames[0].save(
    DST,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    transparency=255,
    disposal=2,
    optimize=False,
)
print(f"Wrote {DST} ({len(frames)} frames, {W}x{H})")
