"""Рисует значок письма из icons/mark.svg в размерах Chrome. Требуется Pillow."""
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parents[1] / "icons"


def render(size):
    source = ElementTree.parse(ICONS / "mark.svg").getroot()
    scale = size * 8 / 48
    image = Image.new("RGBA", (size * 8, size * 8))
    draw = ImageDraw.Draw(image)
    rect, envelope, folds, stamp, slash = source
    def points(coords):
        return [(round(x * scale), round(y * scale)) for x, y in coords]
    def line(coords, element):
        draw.line(points(coords), fill=element.get("stroke"), width=max(1, round(float(element.get("stroke-width")) * scale)), joint="curve")
    draw.rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius=round(12 * scale), fill=rect.get("fill"))
    draw.polygon(points([(9, 14), (39, 14), (39, 35), (9, 35)]), fill=envelope.get("fill"))
    for coords in [[(9, 14), (24, 25), (39, 14)], [(10, 34), (20, 24)], [(38, 34), (28, 24)]]:
        line(coords, folds)
    draw.polygon(points([(31, 8), (41, 8), (41, 18), (31, 18)]), fill=stamp.get("fill"))
    line([(33, 15), (38, 11)], slash)
    return image.resize((size, size), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    for dimension in (16, 32, 48, 128):
        render(dimension).save(ICONS / f"icon{dimension}.png", optimize=True)
