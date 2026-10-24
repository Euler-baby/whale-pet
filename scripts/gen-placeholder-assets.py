#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 whale-pet 的占位美术素材（M0，占位素材 / MIT / 可复现）。

背景与约束
----------
- **占位素材**：M0/M1/M2 期间让界面与构建链路先跑通，不是最终美术。
- **MIT**：本脚本与它生成的 PNG/ICO 均属本项目原创，随项目以 MIT 授权（见 LICENSE / assets/NOTICE）。
- **可复现**：所有图形都用 Pillow 几何绘制（椭圆/多边形/圆弧/直线），不依赖任何第三方美术资源；
  改参数后重跑即可得到同风格素材，便于 Codex 接手后继续迭代。
- **美术红线**（PLAN §2/§12、docs/04-review.md）：严禁复制或改写 dsh-whale-widget 的 assets
  与 deep-whale 皮肤（两套均不可商用 / 不可再分发）。正式素材在 M3 前由画师交付并以同名同尺寸替换。
- 仅使用系统 Python + Pillow，不联网、不下载字体；表情/姿态差异全部由几何图形表达。

产物（相对仓库根目录）
----------------------
    assets/sprites/{state}.png         240×240 RGBA（@1x）
    assets/sprites/{state}@2x.png      480×480 RGBA（DPR=2 时用）
    assets/tray.ico                    16/32/48 多尺寸（M1 托盘）
    assets/icon.png                    512×512（应用图标/通知兜底）
    build/icon.ico                     16/32/48/64/128/256（electron-builder win.icon）
    build/icon.png                     512×512（electron-builder 备用）

用法
----
    python scripts/gen-placeholder-assets.py    # 需要 Pillow >= 10

「不透明占位色」注意：Pillow 的 ImageDraw 写 RGBA 是覆盖而不是 alpha 合成，
所以除阴影/水花外一律用不透明色，避免半透明像素露出桌面色。
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

# ---------------------------------------------------------------------------
# 路径与配色（DeepSeek 蓝 + 白；RGB 不透明，阴影单独处理）
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
SPRITE_DIR = ROOT / "assets" / "sprites"
ASSET_DIR = ROOT / "assets"
BUILD_DIR = ROOT / "build"

DEEPSEEK_BLUE = (77, 107, 254, 255)  # #4D6BFE
BLUE_LIGHT = (126, 150, 255, 255)  # #7E96FF 胸鳍/高光
BLUE_DEEP = (43, 63, 158, 255)  # #2B3F9E 尾鳍/耳机/呼吸孔
NAVY = (18, 32, 74, 255)  # #12204A 眼睛/嘴
BELLY = (234, 241, 255, 255)  # #EAF1FF 肚皮
WHITE = (255, 255, 255, 255)
SPOUT = (198, 214, 255, 255)  # 喷水/水花（不透明浅蓝，替代半透明白）
PINK = (255, 107, 107, 255)  # 爱心/感叹号/舌头
BLUSH = (250, 168, 192, 255)  # 腮红
GOLD = (255, 210, 90, 255)  # 烟花/彩纸
MINT = (139, 224, 200, 255)  # 彩纸
SHADOW = (40, 60, 130, 46)  # 脚下软阴影（画在最底层，透明底上可接受）

STATES = ("idle", "happy", "sleepy", "focus", "remind", "celebrate")

SS = 4  # 精灵超采样倍数：240 → 960 绘制后 LANCZOS 缩放，边缘更柔和


# ---------------------------------------------------------------------------
# 画布：统一在 240 逻辑坐标系作画，内部自动乘以超采样倍数
# ---------------------------------------------------------------------------


class Canvas:
    def __init__(self, size: int = 240, supersample: int = SS) -> None:
        self.size = size
        self.ss = supersample
        self.image = Image.new("RGBA", (size * supersample, size * supersample), (0, 0, 0, 0))
        self.pen = ImageDraw.Draw(self.image)

    # -- 坐标换算 ---------------------------------------------------------
    def _v(self, value: float) -> int:
        return int(round(value * self.ss))

    def _box(self, box: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
        x0, y0, x1, y1 = box
        return (self._v(x0), self._v(y0), self._v(x1), self._v(y1))

    # -- 图元 -------------------------------------------------------------
    def ellipse(
        self,
        box: tuple[float, float, float, float],
        fill: tuple[int, int, int, int] | None = None,
        outline: tuple[int, int, int, int] | None = None,
        width: float = 1.0,
    ) -> None:
        self.pen.ellipse(self._box(box), fill=fill, outline=outline, width=max(1, self._v(width)))

    def rect(
        self,
        box: tuple[float, float, float, float],
        fill: tuple[int, int, int, int] | None = None,
        outline: tuple[int, int, int, int] | None = None,
        width: float = 1.0,
    ) -> None:
        self.pen.rectangle(self._box(box), fill=fill, outline=outline, width=max(1, self._v(width)))

    def rounded_rect(
        self,
        box: tuple[float, float, float, float],
        radius: float,
        fill: tuple[int, int, int, int] | None = None,
        outline: tuple[int, int, int, int] | None = None,
        width: float = 1.0,
    ) -> None:
        self.pen.rounded_rectangle(
            self._box(box),
            radius=self._v(radius),
            fill=fill,
            outline=outline,
            width=max(1, self._v(width)),
        )

    def polygon(
        self,
        points: list[tuple[float, float]],
        fill: tuple[int, int, int, int] | None = None,
    ) -> None:
        self.pen.polygon([(self._v(x), self._v(y)) for x, y in points], fill=fill)

    def line(
        self,
        points: list[tuple[float, float]],
        fill: tuple[int, int, int, int],
        width: float = 1.0,
    ) -> None:
        self.pen.line(
            [(self._v(x), self._v(y)) for x, y in points],
            fill=fill,
            width=max(1, self._v(width)),
            joint="curve",
        )

    def arc(
        self,
        box: tuple[float, float, float, float],
        start: float,
        end: float,
        fill: tuple[int, int, int, int],
        width: float = 1.0,
    ) -> None:
        self.pen.arc(
            self._box(box),
            start=start,
            end=end,
            fill=fill,
            width=max(1, self._v(width)),
        )

    # -- 输出 -------------------------------------------------------------
    def render(self, target: int) -> Image.Image:
        """按目标边长缩放输出（target 小于绘制尺寸即降采样，等效抗锯齿）。"""
        return self.image.resize((target, target), Image.LANCZOS)


# ---------------------------------------------------------------------------
# 通用零件
# ---------------------------------------------------------------------------


def draw_body(c: Canvas) -> None:
    """鲸鱼本体（不含脸/配件）：阴影 → 尾鳍 → 身体 → 肚皮 → 呼吸孔。"""
    # 脚下软阴影：先画，身体会覆盖重叠部分；透明底上只留一圈淡淡的影子
    c.ellipse((64, 214, 176, 236), fill=SHADOW)

    # 尾鳍（画在身体后面，只从右侧露出一部分）
    c.polygon(
        [
            (150.0, 194.0),
            (212.0, 208.0),
            (204.0, 226.0),
            (186.0, 222.0),
            (170.0, 230.0),
            (172.0, 202.0),
        ],
        fill=BLUE_DEEP,
    )

    # 身体
    c.ellipse((38, 58, 202, 228), fill=DEEPSEEK_BLUE)
    # 肚皮（浅色椭圆，占下半部，Q 版鲸鱼的关键识别特征）
    c.ellipse((64, 124, 176, 224), fill=BELLY)
    # 呼吸孔
    c.ellipse((113, 82, 127, 90), fill=BLUE_DEEP)


def draw_flippers(c: Canvas, raised_right: bool = False) -> None:
    """两侧胸鳍；remind 状态右胸鳍抬起举牌。"""
    c.polygon([(46.0, 168.0), (18.0, 196.0), (44.0, 204.0), (60.0, 188.0)], fill=BLUE_LIGHT)
    if raised_right:
        c.polygon([(188.0, 150.0), (220.0, 128.0), (232.0, 152.0), (204.0, 178.0)], fill=BLUE_LIGHT)
    else:
        c.polygon([(194.0, 168.0), (222.0, 196.0), (196.0, 204.0), (180.0, 188.0)], fill=BLUE_LIGHT)


# -- 眼睛（4 种表情） --------------------------------------------------------


def draw_eyes_open(c: Canvas, eye_y: float = 128.0) -> None:
    """圆眼睛 + 高光：默认/睁眼。"""
    for eye_x in (94.0, 146.0):
        c.ellipse((eye_x - 9, eye_y - 9, eye_x + 9, eye_y + 9), fill=NAVY)
        c.ellipse((eye_x + 1, eye_y - 7, eye_x + 7, eye_y - 1), fill=WHITE)


def draw_eyes_happy(c: Canvas, eye_y: float = 128.0) -> None:
    """开心眯眼：∩ 形（上半圆弧）。"""
    for eye_x in (94.0, 146.0):
        c.arc((eye_x - 10, eye_y - 10, eye_x + 10, eye_y + 10), 180, 360, fill=NAVY, width=5)


def draw_eyes_closed(c: Canvas, eye_y: float = 128.0) -> None:
    """睡着/闭眼：∪ 形（下半圆弧）。"""
    for eye_x in (94.0, 146.0):
        c.arc((eye_x - 10, eye_y - 10, eye_x + 10, eye_y + 10), 0, 180, fill=NAVY, width=5)


def draw_eyes_focus(c: Canvas, eye_y: float = 127.0) -> None:
    """专注：压低的横线眼睛。"""
    c.line([(84.0, eye_y), (102.0, eye_y)], fill=NAVY, width=5)
    c.line([(138.0, eye_y), (156.0, eye_y)], fill=NAVY, width=5)


# -- 嘴（4 种） --------------------------------------------------------------


def draw_smile(c: Canvas) -> None:
    c.arc((108, 142, 132, 160), 20, 160, fill=NAVY, width=3.5)


def draw_mouth_open(c: Canvas, y: float = 142.0) -> None:
    """张嘴：深色椭圆 + 粉色舌头。"""
    c.ellipse((106, y, 134, y + 20), fill=NAVY)
    c.ellipse((114, y + 11, 126, y + 19), fill=PINK)


def draw_mouth_flat(c: Canvas) -> None:
    c.line([(112.0, 150.0), (128.0, 150.0)], fill=NAVY, width=3.5)


def draw_mouth_small(c: Canvas) -> None:
    c.ellipse((115, 148, 125, 156), fill=NAVY)


def draw_blush(c: Canvas) -> None:
    c.ellipse((64, 138, 86, 150), fill=BLUSH)
    c.ellipse((154, 138, 176, 150), fill=BLUSH)


# -- 装饰小件 ---------------------------------------------------------------


def draw_spout(c: Canvas) -> None:
    """喷水（idle）。"""
    c.ellipse((108, 66, 118, 76), fill=SPOUT)
    c.ellipse((117, 50, 124, 57), fill=SPOUT)
    c.ellipse((100, 52, 107, 59), fill=SPOUT)


def draw_heart(c: Canvas, x: float, y: float, size: float, fill: tuple[int, int, int, int]) -> None:
    """爱心：两瓣圆 + 三角。"""
    half = size / 2
    c.ellipse((x - half, y - half, x, y), fill=fill)
    c.ellipse((x, y - half, x + half, y), fill=fill)
    c.polygon([(x - half, y - half * 0.3), (x + half, y - half * 0.3), (x, y + half * 0.8)], fill=fill)


def draw_sparkle(c: Canvas, x: float, y: float, size: float, fill: tuple[int, int, int, int]) -> None:
    c.line([(x - size, y), (x + size, y)], fill=fill, width=max(1.5, size / 5))
    c.line([(x, y - size), (x, y + size)], fill=fill, width=max(1.5, size / 5))


def draw_z(c: Canvas, x: float, y: float, size: float, fill: tuple[int, int, int, int]) -> None:
    c.line([(x, y), (x + size, y)], fill=fill, width=3.5)
    c.line([(x + size, y), (x, y + size)], fill=fill, width=3.5)
    c.line([(x, y + size), (x + size, y + size)], fill=fill, width=3.5)


def draw_burst(
    c: Canvas,
    x: float,
    y: float,
    radius: float,
    fill: tuple[int, int, int, int],
    rays: int = 6,
) -> None:
    """烟花：从中心向外的短线。"""
    for index in range(rays):
        angle = 2 * math.pi * index / rays + 0.35
        c.line(
            [
                (x + math.cos(angle) * radius * 0.45, y + math.sin(angle) * radius * 0.45),
                (x + math.cos(angle) * radius, y + math.sin(angle) * radius),
            ],
            fill=fill,
            width=3,
        )


def draw_headphones(c: Canvas) -> None:
    """耳机（focus）：头梁 + 两个耳罩。"""
    c.arc((56, 44, 184, 176), 190, 350, fill=BLUE_DEEP, width=9)
    c.rounded_rect((28, 102, 58, 154), 13, fill=BLUE_DEEP)
    c.rounded_rect((182, 102, 212, 154), 13, fill=BLUE_DEEP)
    c.ellipse((36, 116, 52, 142), fill=BLUE_LIGHT)
    c.ellipse((188, 116, 204, 142), fill=BLUE_LIGHT)


def draw_clock(c: Canvas, x: float, y: float, radius: float) -> None:
    """小闹钟（focus 右上角）。"""
    c.ellipse((x - radius, y - radius, x + radius, y + radius), fill=WHITE, outline=BLUE_DEEP, width=3)
    c.line([(x, y), (x, y - radius * 0.55)], fill=BLUE_DEEP, width=2.5)
    c.line([(x, y), (x + radius * 0.5, y + radius * 0.2)], fill=BLUE_DEEP, width=2.5)


def draw_sign(c: Canvas) -> None:
    """举牌（remind）：白色圆角牌 + 蓝色描边 + 粉色感叹号 + 牌杆。"""
    c.line([(178.0, 84.0), (198.0, 154.0)], fill=BLUE_DEEP, width=7)
    c.rounded_rect((130, 20, 224, 86), 12, fill=WHITE, outline=DEEPSEEK_BLUE, width=4)
    c.rect((172, 34, 181, 57), fill=PINK)
    c.ellipse((172, 63, 181, 72), fill=PINK)
    # 牌子左右轻微抖动线，暗示提醒的急迫感（真正的抖动由 CSS 做）
    c.arc((108, 32, 130, 62), 120, 240, fill=BLUE_LIGHT, width=3)
    c.arc((108, 50, 128, 78), 120, 220, fill=BLUE_LIGHT, width=3)


def draw_hat(c: Canvas) -> None:
    """派对帽（celebrate）：金色三角 + 彩条 + 顶点球。"""
    c.polygon([(98.0, 62.0), (120.0, 16.0), (142.0, 62.0)], fill=GOLD)
    c.line([(106.0, 50.0), (134.0, 50.0)], fill=PINK, width=4)
    c.line([(102.0, 58.0), (138.0, 58.0)], fill=BLUE_LIGHT, width=4)
    c.ellipse((112, 6, 128, 22), fill=PINK)


def draw_confetti(c: Canvas) -> None:
    """彩纸屑（固定坐标，保证可复现）。"""
    dots = [
        (34.0, 108.0, 3.0, GOLD),
        (206.0, 44.0, 3.0, MINT),
        (72.0, 34.0, 2.5, BLUE_LIGHT),
        (210.0, 152.0, 3.0, PINK),
        (30.0, 150.0, 2.5, PINK),
        (170.0, 26.0, 2.5, GOLD),
        (48.0, 32.0, 2.0, MINT),
    ]
    for x, y, radius, fill in dots:
        c.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


# ---------------------------------------------------------------------------
# 六状态：在通用身体上叠加脸与配件（PLAN §4 / 03 §7）
# ---------------------------------------------------------------------------


def draw_idle(c: Canvas) -> None:
    draw_body(c)
    draw_flippers(c)
    draw_spout(c)
    draw_eyes_open(c)
    draw_smile(c)


def draw_happy(c: Canvas) -> None:
    draw_body(c)
    draw_flippers(c)
    draw_heart(c, 44.0, 94.0, 22.0, PINK)
    draw_heart(c, 198.0, 66.0, 14.0, PINK)
    draw_eyes_happy(c)
    draw_blush(c)
    draw_mouth_open(c)
    draw_sparkle(c, 206.0, 130.0, 7.0, GOLD)


def draw_sleepy(c: Canvas) -> None:
    draw_body(c)
    draw_flippers(c)
    draw_eyes_closed(c)
    draw_mouth_small(c)
    draw_z(c, 176.0, 56.0, 18.0, SPOUT)
    draw_z(c, 198.0, 32.0, 12.0, SPOUT)


def draw_focus(c: Canvas) -> None:
    draw_body(c)
    draw_flippers(c)
    draw_headphones(c)
    draw_eyes_focus(c)
    draw_mouth_flat(c)
    draw_clock(c, 214.0, 52.0, 12.0)


def draw_remind(c: Canvas) -> None:
    draw_body(c)
    draw_flippers(c, raised_right=True)
    draw_sign(c)
    draw_eyes_open(c, eye_y=126.0)
    draw_mouth_open(c, y=144.0)


def draw_celebrate(c: Canvas) -> None:
    draw_body(c)
    draw_flippers(c)
    draw_hat(c)
    draw_burst(c, 40.0, 62.0, 26.0, GOLD)
    draw_burst(c, 208.0, 96.0, 22.0, PINK)
    draw_confetti(c)
    draw_eyes_happy(c)
    draw_blush(c)
    draw_mouth_open(c)


SPRITE_PAINTERS = {
    "idle": draw_idle,
    "happy": draw_happy,
    "sleepy": draw_sleepy,
    "focus": draw_focus,
    "remind": draw_remind,
    "celebrate": draw_celebrate,
}


# ---------------------------------------------------------------------------
# 应用/托盘图标：蓝色圆角方块 + 白色鲸鱼剪影
# ---------------------------------------------------------------------------


def draw_app_icon() -> Image.Image:
    c = Canvas(512, supersample=2)  # 1024 绘制 → 512 输出
    c.rounded_rect((0, 0, 512, 512), 112, fill=DEEPSEEK_BLUE)
    # 尾鳍（白色，从身体右侧露出）
    c.polygon(
        [
            (316.0, 330.0),
            (430.0, 372.0),
            (410.0, 430.0),
            (360.0, 412.0),
            (330.0, 424.0),
            (322.0, 372.0),
        ],
        fill=WHITE,
    )
    # 身体
    c.ellipse((104, 196, 408, 428), fill=WHITE)
    # 胸鳍
    c.polygon([(120.0, 330.0), (58.0, 372.0), (96.0, 400.0), (132.0, 366.0)], fill=WHITE)
    c.polygon([(392.0, 330.0), (452.0, 372.0), (416.0, 400.0), (380.0, 366.0)], fill=WHITE)
    # 呼吸孔 + 水花
    c.ellipse((244, 200, 268, 214), fill=BLUE_DEEP)
    c.ellipse((228, 142, 256, 170), fill=WHITE)
    c.ellipse((262, 104, 282, 124), fill=WHITE)
    c.ellipse((200, 112, 218, 130), fill=WHITE)
    # 眼睛 + 高光
    for eye_x in (202.0, 310.0):
        c.ellipse((eye_x - 21, 266, eye_x + 21, 308), fill=NAVY)
        c.ellipse((eye_x + 4, 272, eye_x + 16, 284), fill=WHITE)
    # 微笑
    c.arc((224, 322, 288, 360), 20, 160, fill=NAVY, width=9)
    return c.render(512)


# ---------------------------------------------------------------------------
# 保存
# ---------------------------------------------------------------------------


def save_sprite(state: str) -> tuple[Path, Path, int, int]:
    canvas = Canvas(240)
    SPRITE_PAINTERS[state](canvas)
    path_1x = SPRITE_DIR / f"{state}.png"
    path_2x = SPRITE_DIR / f"{state}@2x.png"
    canvas.render(240).save(path_1x, format="PNG", optimize=True)
    canvas.render(480).save(path_2x, format="PNG", optimize=True)
    return path_1x, path_2x, path_1x.stat().st_size, path_2x.stat().st_size


def save_icon(path: Path, image: Image.Image, sizes: list[tuple[int, int]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".ico":
        image.save(path, format="ICO", sizes=sizes)
    else:
        image.save(path, format="PNG", optimize=True)
    return path.stat().st_size


def main() -> None:
    SPRITE_DIR.mkdir(parents=True, exist_ok=True)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    print("== sprites ==")
    for state in STATES:
        path_1x, path_2x, bytes_1x, bytes_2x = save_sprite(state)
        print(
            f"  {path_1x.relative_to(ROOT)}  240x240  {bytes_1x / 1024:.1f} KB"
            f"  |  {path_2x.name}  480x480  {bytes_2x / 1024:.1f} KB"
        )

    icon = draw_app_icon()
    print("== icons ==")
    tray_bytes = save_icon(ASSET_DIR / "tray.ico", icon, [(16, 16), (32, 32), (48, 48)])
    print(f"  assets/tray.ico  16/32/48  {tray_bytes / 1024:.1f} KB")
    icon_png_bytes = save_icon(ASSET_DIR / "icon.png", icon, [])
    print(f"  assets/icon.png  512x512  {icon_png_bytes / 1024:.1f} KB")
    build_ico_bytes = save_icon(
        BUILD_DIR / "icon.ico",
        icon,
        [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"  build/icon.ico  16..256  {build_ico_bytes / 1024:.1f} KB")
    build_png_bytes = save_icon(BUILD_DIR / "icon.png", icon, [])
    print(f"  build/icon.png  512x512  {build_png_bytes / 1024:.1f} KB")

    print("\n完成：占位素材全部由本脚本生成（MIT，可复现）；M3 前用正式素材同名同尺寸替换。")


if __name__ == "__main__":
    main()
