"""生成扩展图标（iOS 风格圆角方块 + 长页面图形）。"""
from PIL import Image, ImageDraw

SIZE = 1024
BG1 = (96, 165, 250)   # #60a5fa
BG2 = (29, 78, 216)    # #1d4ed8
PAGE = (255, 255, 255)
LINE = (37, 99, 235)   # #2563eb


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_gradient(size, radius, top_left, bottom_right):
    gradient = Image.new("RGB", (size, size))
    pixels = gradient.load()
    for y in range(size):
        for x in range(size):
            t = (x / (size - 1) * 0.45) + (y / (size - 1) * 0.55)
            pixels[x, y] = lerp(top_left, bottom_right, t)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(gradient, (0, 0), mask)
    return out


def build():
    img = rounded_gradient(SIZE, radius=228, top_left=BG1, bottom_right=BG2)
    draw = ImageDraw.Draw(img)

    # 页面主体
    page_box = (330, 196, 694, 828)
    draw.rounded_rectangle(page_box, radius=52, fill=PAGE)

    # 文本行
    draw.rounded_rectangle((404, 306, 620, 338), radius=16, fill=LINE)
    draw.rounded_rectangle((404, 392, 620, 424), radius=16, fill=LINE)
    draw.rounded_rectangle((404, 478, 548, 510), radius=16, fill=LINE)
    draw.rounded_rectangle((404, 564, 596, 596), radius=16, fill=LINE)

    # 底部虚线，表示“还在继续”
    dash_width, gap, y1, y2 = 38, 24, 700, 732
    x = 404
    while x < 620:
        draw.rounded_rectangle((x, y1, min(x + dash_width, 620), y2), radius=14, fill=LINE)
        x += dash_width + gap

    return img


def main():
    icon = build()
    for size in (128, 48, 32, 16):
        resized = icon.resize((size, size), Image.LANCZOS)
        resized.save(f"extension/icons/icon{size}.png")
        print(f"written extension/icons/icon{size}.png")


if __name__ == "__main__":
    main()
