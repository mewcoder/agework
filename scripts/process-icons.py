#!/usr/bin/env python3
"""AgeWork 图标处理脚本：macOS squircle 圆角 + 边缘描边 + ICNS 生成。

用法:
  python3 scripts/process-icons.py          # 处理全部
  python3 scripts/process-icons.py --logo    # 仅处理 logo
  python3 scripts/process-icons.py --favicon # 仅处理 favicon
  python3 scripts/process-icons.py --desktop # 仅处理 desktop icon
"""

import argparse
import os
import shutil
from PIL import Image, ImageDraw

# 配置
SQUIRCLE_RATIO = 0.224          # macOS squircle 圆角比例
STROKE_COLOR = (0, 0, 0, 55)    # 边缘描边颜色 + 透明度
STROKE_WIDTH = 1.5              # 描边宽度（基于 512px）
ICON_PADDING = 0.10             # Dock 图标内边距

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO_PATH = os.path.join(REPO_ROOT, "apps/web/src/assets/logo.png")
FAVICON_PATH = os.path.join(REPO_ROOT, "apps/web/public/favicon.ico")
DESKTOP_ICON_PATH = os.path.join(REPO_ROOT, "apps/desktop/build/icon.png")
DESKTOP_ICNS_PATH = os.path.join(REPO_ROOT, "apps/desktop/build/icon.icns")


def round_with_stroke(img: Image.Image, radius: int, stroke_width: float) -> Image.Image:
    """对图片应用 squircle 圆角 + 边缘描边。"""
    w, h = img.size
    out = img.copy()
    if out.mode != "RGBA":
        out = out.convert("RGBA")

    # 完整圆角遮罩
    full_mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(full_mask).rounded_rectangle(
        [(0, 0), (w - 1, h - 1)], radius=radius, fill=255
    )

    # 内缩遮罩（用于描边区域）
    sw = max(1, round(stroke_width))
    inner_mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(inner_mask).rounded_rectangle(
        [(sw, sw), (w - 1 - sw, h - 1 - sw)], radius=max(0, radius - sw), fill=255
    )

    # 保留已有 alpha，用 squircle mask 裁剪（取交集，不覆盖已有透明）
    existing_alpha = out.split()[-1]
    final_alpha = Image.new("L", (w, h), 0)
    for y in range(h):
        for x in range(w):
            if existing_alpha.getpixel((x, y)) > 0 and full_mask.getpixel((x, y)) > 0:
                final_alpha.putpixel((x, y), 255)
    out.putalpha(final_alpha)

    # 描边：在可见区域内，full_mask 内但 inner_mask 外的像素
    stroke_alpha = Image.new("L", (w, h), 0)
    for y in range(h):
        for x in range(w):
            if final_alpha.getpixel((x, y)) > 0 and inner_mask.getpixel((x, y)) == 0:
                stroke_alpha.putpixel((x, y), STROKE_COLOR[3])

    stroke_layer = Image.new("RGBA", (w, h), (*STROKE_COLOR[:3], 0))
    stroke_layer.putalpha(stroke_alpha)
    return Image.alpha_composite(stroke_layer, out)


def add_padding(img: Image.Image, ratio: float) -> Image.Image:
    """在图片四周添加透明内边距。"""
    w, h = img.size
    scale = 1 - 2 * ratio
    new_size = (int(w * scale), int(h * scale))
    scaled = img.resize(new_size, Image.LANCZOS)

    padded = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ox = (w - new_size[0]) // 2
    oy = (h - new_size[1]) // 2
    padded.paste(scaled, (ox, oy))
    return padded


def process_logo():
    """处理 web logo（squircle 圆角 + 描边）。"""
    src = Image.open(LOGO_PATH)
    radius = round(min(src.size) * SQUIRCLE_RATIO)
    result = round_with_stroke(src, radius, STROKE_WIDTH)
    result.save(LOGO_PATH)
    print(f"Logo: {result.size}, radius={radius}px, stroke={STROKE_COLOR}")


def process_favicon():
    """处理 favicon（从 logo 生成 48/32/16 三尺寸，等比圆角 + 描边）。"""
    master = Image.open(LOGO_PATH).convert("RGBA")

    sizes = [48, 32, 16]
    frames = []
    for sz in sizes:
        frame = master.resize((sz, sz), Image.LANCZOS)
        r = round(sz * SQUIRCLE_RATIO)
        sw = max(0.5, sz / 512 * STROKE_WIDTH)
        frame = round_with_stroke(frame, r, stroke_width=sw)
        frames.append(frame)
        print(f"  Favicon {sz}x{sz} r={r}")

    frames[0].save(FAVICON_PATH, format="ICO", sizes=[f.size for f in frames])
    print(f"Favicon saved: {len(frames)} sizes")


def process_desktop():
    """处理 desktop icon + ICNS（512px icon.png + 全尺寸 iconset → icon.icns）。"""
    src = Image.open(LOGO_PATH)

    # icon.png — 填充 + squircle
    padded = add_padding(src, ICON_PADDING)
    radius = round(min(padded.size) * SQUIRCLE_RATIO)
    icon = round_with_stroke(padded, radius, STROKE_WIDTH)
    icon.save(DESKTOP_ICON_PATH)
    print(f"Desktop icon.png: {icon.size}, radius={radius}px")

    # icon.icns — 方形原图，系统自动加 squircle
    iconset = os.path.join(os.path.dirname(DESKTOP_ICNS_PATH), "icon.iconset")
    os.makedirs(iconset, exist_ok=True)

    icns_src = add_padding(Image.open(LOGO_PATH), ICON_PADDING)
    icns_src = icns_src.resize((1024, 1024), Image.LANCZOS)

    size_map = [
        (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
    ]

    for sz, name in size_map:
        frame = icns_src.resize((sz, sz), Image.LANCZOS)
        frame.save(os.path.join(iconset, name))

    os.system(f"iconutil -c icns {iconset} -o {DESKTOP_ICNS_PATH}")
    shutil.rmtree(iconset)
    print(f"Desktop icon.icns: generated with {ICON_PADDING*100:.0f}% padding")

    # icon.ico — Windows 多尺寸图标
    ico_path = os.path.join(os.path.dirname(DESKTOP_ICNS_PATH), "icon.ico")
    ico_sizes = [256, 128, 64, 48, 32, 16]
    ico_frames = []
    for sz in ico_sizes:
        frame = icns_src.resize((sz, sz), Image.LANCZOS)
        ico_frames.append(frame)
    ico_frames[0].save(ico_path, format="ICO", sizes=[f.size for f in ico_frames])
    print(f"Desktop icon.ico: {len(ico_sizes)} sizes")


def main():
    parser = argparse.ArgumentParser(description="处理 AgeWork 图标")
    parser.add_argument("--logo", action="store_true", help="仅处理 web logo")
    parser.add_argument("--favicon", action="store_true", help="仅处理 favicon")
    parser.add_argument("--desktop", action="store_true", help="仅处理 desktop icon")
    args = parser.parse_args()

    all_ = not (args.logo or args.favicon or args.desktop)

    if all_ or args.logo:
        process_logo()
    if all_ or args.favicon:
        process_favicon()
    if all_ or args.desktop:
        process_desktop()


if __name__ == "__main__":
    main()
