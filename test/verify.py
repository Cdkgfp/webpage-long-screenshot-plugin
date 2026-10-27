"""校验端到端测试生成的长图：尺寸与关键位置的像素颜色。

用法：python test/verify.py
依赖：Pillow（DSH 内置 Python 已包含）
"""
import json
import sys
from pathlib import Path

from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "out"

BLOCK_COLORS = [
    "#e11d48", "#ea580c", "#d97706", "#65a30d", "#16a34a", "#0d9488",
    "#0891b2", "#2563eb", "#7c3aed", "#c026d3", "#db2777", "#475569",
]
GROW_COLORS = [
    "#be123c", "#c2410c", "#a16207", "#4d7c0f", "#15803d",
    "#0f766e", "#0e7490", "#1d4ed8", "#6d28d9", "#a21caf",
]
HEADER_COLOR = "#111827"
FOOTER_COLOR = "#1e293b"
SHORT_BG = "#0f766e"
TOLERANCE = 4


def hex_to_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def close(actual, expected, tolerance=TOLERANCE):
    return all(abs(actual[i] - expected[i]) <= tolerance for i in range(3))


def load_image(entry):
    return Image.open(Path(entry["file"])).convert("RGB")


def check_index(entry, errors):
    img = load_image(entry)
    dpr = entry["metrics"]["dpr"]
    width, height = img.size
    expected_width = round(entry["metrics"]["innerWidth"] * dpr)
    expected_height = round(entry["metrics"]["scrollHeight"] * dpr)

    if abs(width - expected_width) > 2:
        errors.append(f"index 宽度不符：{width} != {expected_width}")
    if abs(height - expected_height) > 2:
        errors.append(f"index 高度不符：{height} != {expected_height}")

    center_x = width // 2
    inner_height = round(entry["metrics"]["innerHeight"] * dpr)

    def expected_color_at(y_css):
        if y_css >= 7200:
            return hex_to_rgb(FOOTER_COLOR)
        idx = min(11, int(y_css // 600))
        return hex_to_rgb(BLOCK_COLORS[idx])

    # 各区块中心颜色（同时验证顺序与纵向对齐）
    for index in range(12):
        y_css = index * 600 + 300
        y = round(y_css * dpr)
        if y >= height:
            errors.append(f"index 缺少第 {index + 1} 区块（y={y_css}）")
            continue
        actual = img.getpixel((center_x, y))
        if not close(actual, expected_color_at(y_css)):
            errors.append(f"index 第 {index + 1} 区块颜色错误：{actual} @ y={y}")

    # 固定顶栏应被隐藏：页面最上方应是第 1 区块的颜色
    top_actual = img.getpixel((center_x, round(28 * dpr)))
    if not close(top_actual, hex_to_rgb(BLOCK_COLORS[0])):
        errors.append(f"index 顶部固定栏未被隐藏：{top_actual} @ y=28")

    # 每个视口顶部都不应出现固定顶栏的颜色
    for frame in range(1, 12):
        y = round(frame * inner_height * 0.5)
        if y >= height:
            break
        actual = img.getpixel((center_x, y))
        if close(actual, hex_to_rgb(HEADER_COLOR), 2):
            errors.append(f"index 第 {frame + 1} 帧位置出现固定顶栏：{actual} @ y={y}")

    # 不应有整行纯白（拼接漏帧）
    white_rows = 0
    sample_xs = [width // 5, width // 2, width * 4 // 5]
    for y in range(0, height, 3):
        if all(close(img.getpixel((x, y)), (255, 255, 255), 1) for x in sample_xs):
            white_rows += 1
    if white_rows > 0:
        errors.append(f"index 出现 {white_rows} 行纯白（疑似漏帧）")

    # 抽样多个位置验证纵向连续、无错位
    for y_css in (5, 300, 640, 900, 1150, 1300, 1700, 2500, 3599, 3600, 4800, 5999, 6000, 7199, 7200, 7599):
        y = round(y_css * dpr)
        if y >= height:
            continue
        # 吸顶条所在的 1200~1244 区域跳过
        if 1200 <= y_css <= 1250:
            continue
        actual = img.getpixel((center_x, y))
        expected = expected_color_at(y_css)
        if not close(actual, expected):
            errors.append(f"index 纵向错位：y={y_css} 实际 {actual} 期望 {expected}")


def check_grow(entry, errors):
    img = load_image(entry)
    dpr = entry["metrics"]["dpr"]
    width, height = img.size
    expected_width = round(entry["metrics"]["innerWidth"] * dpr)
    if abs(width - expected_width) > 2:
        errors.append(f"grow 宽度不符：{width} != {expected_width}")

    css_height = height / dpr
    # 初始只有 3 屏（1800px），滚动加载后应至少 9 屏
    if css_height < 5400:
        errors.append(f"grow 高度偏小（滚动加载未全部截取）：{css_height}px")
    if css_height > 6600:
        errors.append(f"grow 高度偏大：{css_height}px")

    center_x = width // 2
    for index, color in enumerate(GROW_COLORS):
        y_css = index * 600 + 300
        y = round(y_css * dpr)
        if y >= height:
            break
        actual = img.getpixel((center_x, y))
        if not close(actual, hex_to_rgb(color)):
            errors.append(f"grow 第 {index + 1} 屏颜色错误：{actual} @ y={y}")


def check_short(entry, errors):
    img = load_image(entry)
    dpr = entry["metrics"]["dpr"]
    width, height = img.size
    expected_width = round(entry["metrics"]["innerWidth"] * dpr)
    expected_height = round(entry["metrics"]["innerHeight"] * dpr)
    if abs(width - expected_width) > 2:
        errors.append(f"short 宽度不符：{width} != {expected_width}")
    if abs(height - expected_height) > 2:
        errors.append(f"short 高度不符：{height} != {expected_height}")
    actual = img.getpixel((width // 2, height // 2))
    if not close(actual, hex_to_rgb(SHORT_BG)):
        errors.append(f"short 背景色错误：{actual}")


def check_csp(entry, errors):
    """带 CSP sandbox 的页面：应能正常截图（insertCSS 绕过页面 CSP）。"""
    img = load_image(entry)
    dpr = entry["metrics"]["dpr"]
    width, height = img.size
    expected_width = round(entry["metrics"]["innerWidth"] * dpr)
    expected_height = round(entry["metrics"]["innerHeight"] * dpr)
    if abs(width - expected_width) > 2:
        errors.append(f"sandbox 宽度不符：{width} != {expected_width}")
    if abs(height - expected_height) > 2:
        errors.append(f"sandbox 高度不符：{height} != {expected_height}")
    actual = img.getpixel((width // 2, 10))
    if not close(actual, hex_to_rgb("#7c3aed")):
        errors.append(f"sandbox 背景色错误：{actual}")


def check_fallback(entry, errors):
    """无法注入脚本的页面：应退化为当前可视区域截图（只截一屏，不滚动拼接）。"""
    if not entry["status"].get("fallback"):
        errors.append("fallback 没有走兜底截图（返回不是 fallback）")
    img = load_image(entry)
    dpr = entry["metrics"]["dpr"]
    width, height = img.size
    expected_width = round(entry["metrics"]["innerWidth"] * dpr)
    expected_height = round(entry["metrics"]["innerHeight"] * dpr)
    if abs(width - expected_width) > 2:
        errors.append(f"fallback 宽度不符：{width} != {expected_width}")
    if abs(height - expected_height) > 2:
        errors.append(f"fallback 高度不符：{height} != {expected_height}（应为可视区域高度）")
    # 页面背景 #2563eb，首屏应被截到
    actual = img.getpixel((10, 10))
    if not close(actual, hex_to_rgb("#2563eb")):
        errors.append(f"fallback 背景色错误：{actual}")


TRANSIENT_BAR_COLORS = ["#ff00aa", "#22d3ee"]


def check_transient(entry, errors):
    """首屏浮层（评论框 / 固定底栏）不应被截进长图。"""
    img = load_image(entry)
    dpr = entry["metrics"]["dpr"]
    width, height = img.size
    expected_width = round(entry["metrics"]["innerWidth"] * dpr)
    expected_height = round(entry["metrics"]["scrollHeight"] * dpr)
    if abs(width - expected_width) > 2:
        errors.append(f"transient 宽度不符：{width} != {expected_width}")
    if abs(height - expected_height) > 2:
        errors.append(f"transient 高度不符：{height} != {expected_height}")

    forbidden = [hex_to_rgb(value) for value in TRANSIENT_BAR_COLORS]
    hits = []
    for y in range(0, height, 2):
        for x in range(0, width, 3):
            pixel = img.getpixel((x, y))
            if any(close(pixel, color, 2) for color in forbidden):
                hits.append((x, y))
                break
        if len(hits) >= 3:
            break
    if hits:
        errors.append(f"transient 长图中残留首屏浮层颜色：{hits[:3]}")


def main():
    results_file = OUT / "results.json"
    if not results_file.exists():
        print("缺少 test/out/results.json，请先运行 node test/e2e.mjs")
        return 1
    results = json.loads(results_file.read_text(encoding="utf-8"))
    errors = []
    checks = {
        "index": check_index,
        "grow": check_grow,
        "short": check_short,
        "sandbox": check_csp,
        "fallback": check_fallback,
        "transient": check_transient,
    }

    for entry in results:
        name = entry["case"]
        image = Path(entry["file"])
        if not image.exists():
            errors.append(f"{name} 缺少图片 {image}")
            continue
        print(f"检查 {name}: {image.name} {Image.open(image).size}")
        checks[name](entry, errors)

    if errors:
        print("\n发现问题：")
        for item in errors:
            print("  [X]", item)
        return 1

    print("\n全部像素校验通过 OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
