#!/usr/bin/env python3
"""Rasterise desktop/icon.svg into the extension's PNG sizes.

The SVG is the design source (viewBox 0 0 64 64):
    rect   64x64  rx=14  fill #0f172a
    circle 32,32  r=20   fill #22c55e

Drawn here rather than run through a rasteriser so the output is identical on any
machine (no rsvg/inkscape/cairo to disagree about). 8x supersampling for the edges.

Keep in step with makeIcon() in src/extension/background.ts, which redraws the same
two shapes from the same ratios so it can recolour the disc per state.
"""
from PIL import Image, ImageDraw

SS = 8
SLATE = (15, 23, 42, 255)     # #0f172a
GREEN = (34, 197, 94, 255)    # #22c55e


def art(side: int) -> Image.Image:
    """The 64-unit artwork rendered at `side` px, full bleed."""
    S = side * SS
    k = S / 64.0
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=14 * k, fill=SLATE)

    c, r = 32 * k, 20 * k
    d.ellipse([c - r, c - r, c + r, c + r], fill=GREEN)

    return img.resize((side, side), Image.LANCZOS)


for n in (16, 32, 48, 128):
    art(n).save(f"icons/icon{n}.png")
    print(f"icons/icon{n}.png")

# The Chrome Web Store listing icon is 128x128 with the graphic in the middle 96x96
# and transparent padding around it (the store draws its own frame). Same artwork,
# different framing. It lives in store/ and NOT in icons/, because vite copies the
# whole icons/ directory into dist/ -- an unreferenced PNG in the uploaded package is
# one more file a reviewer has to ask about.
store = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
store.paste(art(96), (16, 16))
store.save("store/icon-128.png")
print("store/icon-128.png")
