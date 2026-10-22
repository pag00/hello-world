"""Render the StepTrack app icons (SVG + PNG) from one geometry definition.

    uv run --with pillow python apps/web/scripts/generate-icons.py

Writes apps/web/public/icons/{icon.svg, icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png}.
The glyph is a short checklist: two completed steps and one open step.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
BG = "#1f5fbf"
FG = "#ffffff"
SIZE = 512
RADIUS = 104

# glyph in 512-space: (cy, done) per row
ROWS = [(150, True), (256, True), (362, False)]
CX, R = 150, 38
BAR_X0, BAR_X1, BAR_H = 220, 404, 30


def check_points(cy: float) -> list[tuple[float, float]]:
    return [(CX - 17, cy + 1), (CX - 4, cy + 14), (CX + 19, cy - 13)]


def svg() -> str:
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" width="{SIZE}" height="{SIZE}">',
        f'<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{BG}"/>',
    ]
    for cy, done in ROWS:
        if done:
            parts.append(f'<circle cx="{CX}" cy="{cy}" r="{R}" fill="{FG}"/>')
            pts = " ".join(f"{x},{y}" for x, y in check_points(cy))
            parts.append(
                f'<polyline points="{pts}" fill="none" stroke="{BG}" stroke-width="11" '
                'stroke-linecap="round" stroke-linejoin="round"/>'
            )
        else:
            parts.append(f'<circle cx="{CX}" cy="{cy}" r="{R - 5}" fill="none" stroke="{FG}" stroke-width="10"/>')
        opacity = "1" if done else "0.6"
        parts.append(
            f'<rect x="{BAR_X0}" y="{cy - BAR_H / 2}" width="{BAR_X1 - BAR_X0}" height="{BAR_H}" '
            f'rx="{BAR_H / 2}" fill="{FG}" fill-opacity="{opacity}"/>'
        )
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def render(px: int, maskable: bool = False) -> Image.Image:
    # supersample for smooth edges, then downscale
    ss = 4
    s = px * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, s, s], fill=BG)
        k, off = s / SIZE * 0.78, s * 0.11  # keep the glyph inside the maskable safe zone
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=RADIUS * s / SIZE, fill=BG)
        k, off = s / SIZE, 0.0

    def t(x: float, y: float) -> tuple[float, float]:
        return (off + x * k, off + y * k)

    for cy, done in ROWS:
        x0, y0 = t(CX - R, cy - R)
        x1, y1 = t(CX + R, cy + R)
        if done:
            d.ellipse([x0, y0, x1, y1], fill=FG)
            pts = [t(x, y) for x, y in check_points(cy)]
            w = round(11 * k)
            d.line(pts, fill=BG, width=w, joint="curve")
            for p in (pts[0], pts[-1]):
                d.ellipse([p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2], fill=BG)
        else:
            a0, b0 = t(CX - R + 5, cy - R + 5)
            a1, b1 = t(CX + R - 5, cy + R - 5)
            d.ellipse([a0 - 5 * k, b0 - 5 * k, a1 + 5 * k, b1 + 5 * k], outline=FG, width=round(10 * k))
        bx0, by0 = t(BAR_X0, cy - BAR_H / 2)
        bx1, by1 = t(BAR_X1, cy + BAR_H / 2)
        fill = (255, 255, 255, 255 if done else 153)
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).rounded_rectangle([bx0, by0, bx1, by1], radius=BAR_H / 2 * k, fill=fill)
        img = Image.alpha_composite(img, layer)
        d = ImageDraw.Draw(img)
    return img.resize((px, px), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "icon.svg").write_text(svg(), encoding="utf-8")
    render(192).save(OUT / "icon-192.png", optimize=True)
    render(512).save(OUT / "icon-512.png", optimize=True)
    render(512, maskable=True).save(OUT / "maskable-512.png", optimize=True)
    render(180, maskable=True).convert("RGB").save(OUT / "apple-touch-icon.png", optimize=True)
    print(f"icons written to {OUT}")


if __name__ == "__main__":
    main()
