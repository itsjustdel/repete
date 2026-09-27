"""Regenerate the app icons in app/icons/ (needs Pillow). Run once; the PNGs are committed."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
INK, CREAM, RED = (27, 34, 48), (245, 239, 228), (210, 69, 47)
S = 1024  # draw large, downsample for smooth edges


def glyph(d: ImageDraw.ImageDraw, cx: float, cy: float, scale: float) -> None:
    """Speech bubble with a small waveform inside."""
    w, h = 560 * scale, 420 * scale
    x0, y0 = cx - w / 2, cy - h / 2 - 30 * scale
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=140 * scale, fill=CREAM)
    tail = [(x0 + 120 * scale, y0 + h - 10 * scale), (x0 + 90 * scale, y0 + h + 120 * scale), (x0 + 250 * scale, y0 + h - 10 * scale)]
    d.polygon(tail, fill=CREAM)
    bars = [120, 230, 320, 230, 120]
    bw, gap = 46 * scale, 34 * scale
    total = len(bars) * bw + (len(bars) - 1) * gap
    bx = cx - total / 2
    by = y0 + h / 2
    for i, bh in enumerate(bars):
        x = bx + i * (bw + gap)
        d.rounded_rectangle([x, by - bh * scale / 2, x + bw, by + bh * scale / 2], radius=bw / 2, fill=RED if i == 2 else INK)


def make(maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, S, S], fill=INK)
        glyph(d, S / 2, S / 2, 1.0)  # stays inside the 80% safe zone
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=INK)
        glyph(d, S / 2, S / 2, 1.25)
    return img


OUT.mkdir(parents=True, exist_ok=True)
anyi, mask = make(False), make(True)
for size in (192, 512):
    anyi.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png")
mask.resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png")
mask.resize((180, 180), Image.LANCZOS).convert("RGB").save(OUT / "apple-touch-icon.png")
anyi.resize((32, 32), Image.LANCZOS).save(OUT / "favicon-32.png")
print("icons written to", OUT)
