"""生成应用图标 assets/icon.ico（品牌绿六边形 + 成长环）。

只在需要时跑一次；生成的 .ico 已随仓库提供，日常启动不再依赖 Pillow。

运行：python tools/make_icon.py
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "assets", "icon.ico")

BG = (46, 160, 106, 255)      # 品牌绿（与 --accent 同色系）
FG = (245, 250, 246, 255)
RING = (168, 224, 194, 255)


def draw(size):
    S = size * 4                     # 超采样后缩小，边缘才不毛糙
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 六边形底（⬢ 的品牌符号）
    import math
    cx = cy = S / 2
    r = S * 0.46
    pts = [(cx + r * math.cos(math.radians(60 * i - 90)),
            cy + r * math.sin(math.radians(60 * i - 90))) for i in range(6)]
    d.polygon(pts, fill=BG)

    # 成长环：外圈细环 + 缺口，示意进度
    w = max(1, int(S * 0.055))
    d.arc([S * 0.22, S * 0.22, S * 0.78, S * 0.78], start=-90, end=200,
          fill=RING, width=w)

    # 中心向上的箭头：成长
    ax = S * 0.5
    d.polygon([(ax, S * 0.30), (S * 0.63, S * 0.46), (S * 0.55, S * 0.46),
               (S * 0.55, S * 0.66), (S * 0.45, S * 0.66), (S * 0.45, S * 0.46),
               (S * 0.37, S * 0.46)], fill=FG)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [draw(s) for s in sizes]
    imgs[-1].save(OUT, format="ICO", sizes=[(s, s) for s in sizes])
    print("已生成", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()