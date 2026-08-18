#!/usr/bin/env python3
"""Draw the two Chrome Web Store promotional tiles into store/.

    store/promo-small-440x280.png     "Riquadro promozionale piccolo"
    store/promo-marquee-1400x560.png  "Riquadro promozionale in primo piano"

Both are saved as 24-bit RGB with NO alpha channel, which the store requires and
silently rejects otherwise -- so every layer is composited down onto the slate
ground here rather than left transparent.

Same rule as scripts/make-icons.py: the shapes are drawn, not rasterised from the
SVG, so the output is identical on any machine. Everything is composed at 4x and
resized down (SS), which is what gives the discs and the type clean edges.

The artwork is the extension's own mark and palette. The right half of the marquee
is the product's core mechanic drawn literally: the character disc SHRINKS as focus
accumulates and then bursts into a new one, so a row of discs stepping down in size
says what the extension does without a caption.
"""
import math

from PIL import Image, ImageDraw, ImageFont

SS = 4
SLATE = (15, 23, 42)          # #0f172a -- the icon tile's ground
SLATE_800 = (30, 41, 59)
GREEN = (34, 197, 94)         # #22c55e
SLATE_400 = (148, 163, 184)
SLATE_300 = (203, 213, 225)
WHITE = (248, 250, 252)

INTER = "/usr/share/fonts/opentype/inter"
BOLD = f"{INTER}/InterDisplay-Bold.otf"
SEMI = f"{INTER}/Inter-SemiBold.otf"
REG = f"{INTER}/Inter-Regular.otf"

# Five of the character roster from CHARS in ui/companion.ts. Chosen for legibility
# side by side (no two mushrooms, no two greens); the roster's own order would put
# Mario and Toad next to each other in near-identical red.
#
# The last two have their colours SWAPPED against the roster, and it is the one place
# this file departs from it: an emoji is a coloured picture, not a glyph tinted by the
# fill under it, so a yellow bolt on Pikachu's yellow and a blue cap on Ness's blue
# both vanished into their own discs. Crossed over, each sits on its complement. The
# sprite in the product is unaffected -- there the disc is 156 px and alone on screen,
# not 44 px in a row of five that has to read at a glance.
CHARS = [
    ("\N{MUSHROOM}", (239, 68, 68)),                  # Mario   #ef4444
    ("\N{LEAFY GREEN}", (34, 197, 94)),               # Luigi   #22c55e
    ("\N{CROWN}", (236, 72, 153)),                    # Peach   #ec4899
    ("\N{HIGH VOLTAGE SIGN}", (37, 99, 235)),         # Pikachu's bolt on Ness's blue
    ("\N{BILLED CAP}", (250, 204, 21)),               # Ness's cap on Pikachu's yellow
]

# NotoColorEmoji is a bitmap (CBDT) font with exactly one strike, so it can only be
# opened at 109 px -- every other size raises. Render there and scale the result.
EMOJI = ImageFont.truetype("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", 109)


def emoji(img: Image.Image, ch: str, cx: float, cy: float, px: float) -> None:
    """Paste `ch` centred on cx,cy at `px` tall (supersampled units)."""
    box = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(box).text((80, 80), ch, font=EMOJI, embedded_color=True, anchor="mm")
    box = box.crop(box.getbbox())
    k = px / max(box.size)
    box = box.resize((max(1, round(box.width * k)), max(1, round(box.height * k))), Image.LANCZOS)
    img.paste(box, (round(cx - box.width / 2), round(cy - box.height / 2)), box)


def font(path: str, px: float) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, int(round(px * SS)))


def canvas(w: int, h: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (w * SS, h * SS), SLATE)
    return img, ImageDraw.Draw(img)


def tile(d: ImageDraw.ImageDraw, x: float, y: float, side: float) -> None:
    """The app mark at `side` px, top-left at x,y -- icons/icon128.png's geometry."""
    k = side * SS / 64.0
    d.rounded_rectangle(
        [x * SS, y * SS, x * SS + 64 * k, y * SS + 64 * k], radius=14 * k, fill=SLATE_800
    )
    c, r = 32 * k, 20 * k
    d.ellipse([x * SS + c - r, y * SS + c - r, x * SS + c + r, y * SS + c + r], fill=GREEN)


def disc(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    d.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=fill)


def text(d, xy, s, f, fill, anchor="la") -> None:
    d.text((xy[0] * SS, xy[1] * SS), s, font=f, fill=fill, anchor=anchor)


def save(img: Image.Image, w: int, h: int, path: str) -> None:
    img.resize((w, h), Image.LANCZOS).convert("RGB").save(path)
    print(f"{path}  {w}x{h}  RGB")


# ── Small tile: 440x280 ──────────────────────────────────────────────────────
# Centre-stacked, because at this size a side-by-side lockup leaves the wordmark
# no room to be the largest thing on the tile.
img, d = canvas(440, 280)
tile(d, 176, 44, 88)
text(d, (220, 152), "Focus", font(BOLD, 46), WHITE, anchor="ma")
text(d, (220, 214), "Hold your focus, and build it over time", font(REG, 17), SLATE_400, anchor="ma")
save(img, 440, 280, "store/promo-small-440x280.png")


# ── Marquee: 1400x560 ────────────────────────────────────────────────────────
img, d = canvas(1400, 560)

# Left: the lockup. The description is broken into two SHORT lines rather than set
# as one sentence -- the long form ran under the disc row on the right.
tile(d, 96, 168, 104)
text(d, (232, 176), "Focus", font(BOLD, 84), WHITE)
text(d, (236, 288), "It grows calm while you work,", font(REG, 26), SLATE_300)
text(d, (236, 328), "and cries when you drift.", font(REG, 26), SLATE_300)
text(d, (236, 390), "For studying and working · Chrome extension", font(SEMI, 21), GREEN)

# Right: the mechanic. Five characters stepping down along one baseline -- the sprite
# shrinking as focus accumulates -- and the burst it changes in. The row is laid out
# from its own centre so it stays inside the canvas; the store crops nothing, so
# anything past the edge is simply lost. It carries no caption: five discs getting
# smaller and then bursting is the one thing here that does not need one.
BASE_Y, MID_X = 290, 1070
radii = [52, 43, 35, 28, 22]
GAP, BURST_R = 24, 28
row_w = 2 * sum(radii) + GAP * (len(radii) - 1) + GAP + 2 * BURST_R

# The emoji is 84px on a r=78 disc in companion.ts, sitting 4px low; both ratios are
# carried over so a disc here is proportioned like the one the sprite draws.
x = MID_X - row_w / 2
for r, (ch, col) in zip(radii, CHARS):
    disc(d, x + r, BASE_Y, r, col)
    emoji(img, ch, (x + r) * SS, (BASE_Y + r * 4 / 78) * SS, r * (84 / 78) * SS)
    x += 2 * r + GAP

# The burst: short rays where the last disc has run out.
bx = x + BURST_R
for j in range(12):
    a = j * math.pi / 6
    d.line(
        [((bx + math.cos(a) * 11) * SS, (BASE_Y + math.sin(a) * 11) * SS),
         ((bx + math.cos(a) * BURST_R) * SS, (BASE_Y + math.sin(a) * BURST_R) * SS)],
        fill=(253, 224, 71), width=int(3.5 * SS),
    )


save(img, 1400, 560, "store/promo-marquee-1400x560.png")
