# -*- coding: utf-8 -*-
"""把 `out/<曲名>_notes.json` 渲染成带合成主旋律的 mp4。

**三种风格共用同一条管线**（读 JSON → 排时间轴 → 逐帧画 → 合成音频 → mux 成 mp4），
**只有"画一帧"的函数不同** —— 所以加一种风格就是加一个画帧函数 + 一个装配函数：

  tiles  落块音游   7 车道；块高 = 时值，块底边碰「现在」线 = 该弹的时刻；
                    块上挂歌词标签，最底部一条整句字幕带（当前字高亮）
  play   原谱跟弹   上半 = 字母谱（默认）或原谱 + 粉色游标压在当前音上；
                    下半 = **电脑键盘**，当前音要按的键按下去高亮
  roll   小球下坡   蛇形下坡楼梯：小球一路往右滚、碰到边缘换行反向；木板只降不升

拍速取 JSON 里的 `tempo_qpm`（没有就 100）。音频是按 `n/o/key` 合成的主旋律。

用法：
    python make_video.py out/1_notes.json                    # 默认 tiles，输出到 视频/
    python make_video.py out/1_notes.json --style roll --size 1920x1080
    python make_video.py out/1_notes.json --stills 10,45     # 只出静止帧（快速试版式）
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import wave
from bisect import bisect_right
from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:                                     # noqa: BLE001
    FFMPEG = "ffmpeg"

# ── 取自你网页 app 的视觉常量（game.css）─────────────────────────────
BG        = (11, 13, 18)          # #0b0d12
INK       = (247, 244, 237)       # #f7f4ed
HIT_LINE  = (255, 122, 26)        # #ff7a1a
HIT_SOFT  = (255, 176, 120)       # #ffb078
REG_COLOR = {"low": (97, 216, 151), "middle": (255, 174, 84), "high": (118, 168, 255)}
REG_FILL  = {"low": (23, 59, 43), "middle": (75, 45, 23), "high": (26, 42, 74)}
DEFAULT_TEMPO = 100.0             # 与 jianpu_api.DEFAULT_TEMPO 一致

# 生成的 mp4 统一放这个子目录（命令行默认输出、以及网页 `-o` 都落这儿）。
# ⚠ 这个名字和 `webapp.py` 里的 `_video_path()` 必须一致 —— 那边写、这边读，
#   一边改一边不改就会"渲出来了但页面说没有"。
VIDEO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "视频")

# ── roll 风格（蛇形下坡楼梯 + 弹珠）的配色 ─────────────────────────
BALL_BG_TOP = (22, 33, 56)        # 深藏蓝，上浅下深
BALL_BG_BOT = (8, 12, 20)
BALL_GLOW = (44, 62, 96)          # 右上一块柔光
PLANK_TOP = (222, 178, 112)       # 木纹亮面
PLANK_MID = (176, 126, 62)
PLANK_BOT = (104, 66, 28)         # 木纹暗面（当"厚度"的阴影）
PLANK_EDGE = (58, 36, 14)
BALL_BODY = (240, 234, 226)       # 弹珠
BALL_SHADE = (146, 140, 132)
BALL_EDGE = (70, 66, 62)
LYRIC_INK = (252, 240, 216)

LANE_COUNT = 7
PARTS_PER_LANE = 4
STRIPS = LANE_COUNT * PARTS_PER_LANE          # 28
TILE_STRIPS = 2                               # 块宽 = 2 条
# 主音阶里 1~7 相对主音的半音数（大调音阶）
RANK_SEMITONES = [0, 2, 4, 5, 7, 9, 11]
PITCH_CLASS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# ═══ 共用：换算 ═══

def register_of(o):
    """音区 → 'low' / 'middle' / 'high'（±2/±3 先归到最近的一档）。"""
    if o < 0:
        return "low"
    if o > 0:
        return "high"
    return "middle"


def strip_offset(o):
    """音区 → 横向偏移（单位=条）。低音 0、中音 1、高音 2，即 o+1（夹到 0~2）。"""
    return max(0, min(2, int(o) + 1))


def parse_key(key_mark):
    """`1=C` / `1=♭B` / `1=F#` → 主音的 MIDI 号（中音区，C=60）。"""
    text = (key_mark or "1=C").split("=")[-1].strip()
    text = text.replace("♭", "b").replace("♯", "#").replace("＃", "#")
    base = text[0].upper()
    if base not in PITCH_CLASS:
        base = "C"
    midi = 60 + PITCH_CLASS[base]
    for ch in text[1:]:
        if ch == "#":
            midi += 1
        elif ch in ("b", "B"):
            midi -= 1
    return midi


def midi_of(note, tonic_midi):
    """一个音 → MIDI 号；休止/未识别返回 None。"""
    n = note.get("n")
    if n is None or int(n) == 0:
        return None
    n = int(n)
    o = int(note.get("o", 0) or 0)
    # ±2/±3 没有 7 个新车道，折到 ±1 那一档（和 layering 的 register_of 一致）
    octave = 1 if o > 1 else (-1 if o < -1 else o)
    return tonic_midi + RANK_SEMITONES[n - 1] + 12 * octave


def timeline(score, bpm, lead_in_beats):
    """算出每个音的起止秒（相对视频开头）与画面坐标参数。"""
    sec_per_beat = 60.0 / bpm
    notes, t = [], lead_in_beats * sec_per_beat
    for line in score["lines"]:
        for item in line["notes"]:
            q = float(item.get("q") or 1.0) * sec_per_beat
            notes.append({"item": item, "start": t, "dur": q})
            t += q
    return notes, t, sec_per_beat


def _current_idx(starts, t):
    """t 时刻"当前音"的下标（最后一个已经开始的音；t 在开头之前就取第 0 个）。"""
    i = bisect_right(starts, t) - 1
    return i if i >= 0 else 0


# ═══ 共用：绘图工具 ═══

@lru_cache(maxsize=64)


def font(size):
    """拉丁字母用的字体（块上的键位字母）。"""
    for name in ("arialbd.ttf", "seguisb.ttf", "arial.ttf", "segoeui.ttf"):
        path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.isfile(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


@lru_cache(maxsize=16)


def cjk_font(size):
    """**中文**用的字体 —— 必须单独找。用 Arial 画「现在」会得到两个豆腐块 □□，
    因为拉丁字体里没有汉字字形（第一版就踩了）。"""
    for name in ("msyhbd.ttc", "msyh.ttc", "simhei.ttf", "simsun.ttc", "msyhl.ttc"):
        path = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", name)
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_tile(dr, box, color, fill, current):
    x0, y0, x1, y1 = box
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    radius = max(4, min(int((x1 - x0) * 0.28), int((y1 - y0) * 0.28), 14))
    dr.rounded_rectangle(box, radius=radius, fill=fill,
                         outline=color, width=3 if current else 2)

# ═══ tiles 风格：落块音游 ═══

def draw_lyric_strip(ctx, img, dr, idx):
    """底部**独立字幕带**：整句歌词，当前唱的字高亮。

    为什么放最底部、而不是「现在」线下面（第一版就放那儿）：
      * 线下面正是落下来的块经过的地方 —— 字幕压在那儿既挡块，又因为半透明底
        透出块的亮边而显得脏；
      * 它还在视觉焦点上（你正看着块碰线），字幕在那儿会抢注意力；
      * 挪到底部做成一条**不透明**字幕带：和块完全不重叠（越界的块被它盖住，
        正好是"弹过的音往下滚出画面"的效果），字始终清楚，位置也符合
        "字幕在底部"的直觉。
    窗口以当前字为中心滚动 —— 句子再长也不溢出，当前字永远在视野里。
    """
    anchor = ctx.get("anchor")
    if idx is None or not anchor or ctx.get("band_h", 0) <= 0:
        return
    top = ctx["H"] - ctx["band_h"]
    dr.rectangle([0, top, ctx["W"], ctx["H"]], fill=(9, 11, 15))
    dr.line([0, top, ctx["W"], top], fill=(40, 44, 54), width=2)
    i = anchor[min(max(idx, 0), len(anchor) - 1)]
    if i < 0:
        return
    s, e = ctx["pos_of"][i]
    if s >= len(ctx["flat"]):
        return
    n_show = ctx["lyric_show"]
    lo = max(0, (s + e) // 2 - n_show // 2)
    hi = min(len(ctx["flat"]), lo + n_show)
    lo = max(0, hi - n_show)
    f, W = ctx["f_lyric"], ctx["W"]
    y = top + (ctx["H"] - top) / 2
    cells = [(k, ctx["flat"][k], s <= k < e) for k in range(lo, hi)]
    widths = [dr.textlength(ch, font=f) for _, ch, _ in cells]
    x = max(ctx["margin"], (W - sum(widths)) / 2)
    for (_, ch, cur), w in zip(cells, widths):
        if cur:                                    # 当前字：琥珀 + 底下一条短线
            dr.line([x, y + f.size * 0.62, x + w, y + f.size * 0.62], fill=HIT_SOFT, width=3)
        dr.text((x, y), ch, font=f,
                fill=HIT_SOFT if cur else (198, 203, 212), anchor="lm")
        x += w


def draw_tile_lyrics(ctx, dr, labels):
    """把歌词挂在每个块的**底边外侧**：黑底白字的小标签，允许比块宽。

    为什么挂外侧而不是写进块里：块的**高度 = 时值**，这是它最核心的读数；
    歌词塞进块里会跟时值和键位字母搅在一起。挂在外侧，块高度还是纯粹的时值。

    为什么允许溢出块宽：块只有 74px、一个汉字就 ~34px，两字就顶满；
    像参考图那样让标签比块宽一点反而更好认（实测相邻音间距最小 88px，
    标签高约 45px，不会压到下一块）。
    """
    if not labels:
        return
    H = ctx["H"]
    tile_w = TILE_STRIPS * ctx["strip_w"]
    for x0, x1, yb, lyric in labels:
        f = ctx["f_tile_lyric"]
        # 字多就缩字号，缩到"块宽的 1.5 倍"以内；再不济就截断（留第一个字 + …）
        while f.size > 12 and dr.textlength(lyric, font=f) > tile_w * 1.5:
            f = cjk_font(f.size - 2)
        if dr.textlength(lyric, font=f) > tile_w * 1.5 and len(lyric) > 1:
            lyric = lyric[0] + "…"
        # 标签做"厚"一点：内边距给到约一个字宽，整体和块差不多宽（参考图就是这样
        # 更醒目）；竖向 1.45 倍字高，块间距最小 88px，不会压到下一块。
        box_w = dr.textlength(lyric, font=f) + f.size * 1.05
        box_h = f.size * 1.45
        cx = (x0 + x1) / 2
        top = yb - box_h * 0.30            # 压住块的底边一点（跟参考图一致）
        if top > H or top + box_h < 0:
            continue                       # 完全出画就不画
        dr.rounded_rectangle([cx - box_w / 2, top, cx + box_w / 2, top + box_h],
                             radius=box_h * 0.28, fill=(15, 17, 21),
                             outline=(96, 102, 114), width=1)
        dr.text((cx, top + box_h / 2), lyric, font=f, fill=INK, anchor="mm")


def render_frame(t, ctx, img, dr):
    """画第 t 秒这一帧（t 是视频时间）。"""
    W, H = ctx["W"], ctx["H"]
    hit_y = ctx["hit_y"]
    v = ctx["px_per_second"]

    dr.rectangle([0, 0, W, H], fill=BG)
    # 车道底色（很淡的竖向分区）
    for lane in range(LANE_COUNT):
        x0 = ctx["margin"] + lane * PARTS_PER_LANE * ctx["strip_w"]
        x1 = x0 + PARTS_PER_LANE * ctx["strip_w"]
        dr.rectangle([x0, 0, x1, H], fill=(17, 21, 30) if lane % 2 else (15, 18, 26))
    # 「现在」横线
    dr.line([0, hit_y, W, hit_y], fill=HIT_LINE, width=3)
    dr.text((10, hit_y - int(H * 0.022)), "现在", font=ctx["f_small"], fill=HIT_SOFT)

    # 块：远的先画，近的后画（挡住远处的）。标签**不在这里画**，见下面第二次遍历。
    visible = []
    for note in ctx["notes"]:
        bottom = hit_y - (note["start"] - t) * v
        top = bottom - note["dur"] * v
        if bottom < -40 or top > H + 40:
            continue
        visible.append((bottom, top, note))
    visible.sort(key=lambda r: -r[0])

    labels = []                                        # (块左, 块右, 块底边, 歌词)
    for bottom, top, note in visible:
        item = note["item"]
        if item.get("n") is None or int(item.get("n") or 0) == 0:
            continue                                   # 休止不画块
        x0 = ctx["margin"] + (int(item["n"]) - 1) * PARTS_PER_LANE * ctx["strip_w"] \
            + strip_offset(int(item.get("o", 0) or 0)) * ctx["strip_w"]
        x1 = x0 + TILE_STRIPS * ctx["strip_w"]
        top_c = max(top, ctx["top_clip"])
        bottom_c = min(bottom, H)
        if bottom_c - top_c < 3:
            continue
        reg = register_of(int(item.get("o", 0) or 0))
        current = note["start"] <= t < note["start"] + note["dur"]
        draw_tile(dr, (x0, top_c, x1, bottom_c), REG_COLOR[reg], REG_FILL[reg], current)
        letter = item.get("letter")
        if letter and x1 - x0 >= 16:
            size = max(12, min(int((x1 - x0) * 0.5), 46))
            f = font(size)
            cx = (x0 + x1) / 2
            cy = min(max((top_c + bottom_c) / 2, top_c + size * 0.7), bottom_c - size * 0.7)
            dr.text((cx, cy), str(letter), font=f, fill=INK, anchor="mm",
                    stroke_width=1, stroke_fill=BG)
        lyric = str(item.get("lyric") or "")
        if lyric:
            labels.append((x0, x1, bottom_c, lyric))
    # 块上歌词标签 → 底部字幕带。字幕带**最后画**（不透明，盖住越界的块和标签，
    # 正好是"弹过的音往下滚出画面"的效果）。
    draw_tile_lyrics(ctx, dr, labels)
    draw_lyric_strip(ctx, img, dr, _current_idx(ctx["starts"], t))
    return img


# ── play 风格（原谱 + 粉色游标 / 虚拟键盘）的常量 ──────────────────────
PLAY_BAR = (242, 160, 168)        # 游标粉（半透明，音数字透出来发红）
PLAY_BAR_A = 165
KEY_FACE = (233, 235, 240)        # 字母键面板
KEY_MOD = (204, 208, 216)         # 修饰键（Tab/Caps/Shift/Enter…）
KEY_TEXT = (58, 62, 72)
KEY_EDGE = (168, 172, 182)
KEY_PRESSED = (255, 174, 84)      # 按下的键用中音那支琥珀色


# ── play 风格下半屏：**电脑键盘**（不是钢琴）──────────────────────────
# 这是字母谱 —— 那些字母就是你按的电脑键盘键。映射2 的三档正好落在键盘三排：
#   高音 E R T Y U I O → 上排   /   中音 S D F G H J K → 中排   /   低音 Z X C V B N M → 下排
# 每行 = (标签, 宽度单位)。字母键宽度 1，修饰键按常规宽度，总宽都凑成 13 个单位。
KB_ROWS = [
    [("Tab", 1.5)] + [(c, 1) for c in "QWERTYUIOP"] + [("Back", 1.5)],
    [("Caps", 1.75)] + [(c, 1) for c in "ASDFGHJKL"] + [("Enter", 2.25)],
    [("Shift", 2.25)] + [(c, 1) for c in "ZXCVBNM"] + [(",", 1), (".", 1), ("/", 1),
                         ("Shift", 0.75)],
]
KB_UNITS = 13.0

# ═══ play 风格：原谱跟弹 ═══

def qwerty_layout(x0, y0, w, h):
    """把键盘摊开成 {标签: (x, y, w, h)}（同名的 Shift 会出现两次，各是一块）。

    字母键和修饰键都在里面 —— 高亮当前音时要按**字母**取，`shift` 档还要点亮 Shift。
    """
    u = w / KB_UNITS
    kh = h / len(KB_ROWS)
    out = {}
    for r, row in enumerate(KB_ROWS):
        x = x0
        for label, units in row:
            rect = (x, y0 + r * kh, x + units * u, y0 + (r + 1) * kh)
            out.setdefault(label, []).append(rect)
            x += units * u
    return out


def _row_center(row_y, line):
    y0, y1 = row_y[line]
    return (y0 + y1) / 2.0


def play_offset_at(t, ctx, ease=0.35):
    """当前该把原图纵向滚到哪（**纯函数** —— 给了 t 就能算，和是否顺序渲染无关）。

    为什么不用"逐帧累加平滑"那种做法：那样静止帧（--stills）就取不准 —— 它只渲一帧，
    没有前面的帧可以累加。这里改成解析式：换行后 ease 秒内用 smoothstep 从上一行滑过来。
    """
    notes, row_y, starts = ctx["notes"], ctx["row_y"], ctx["starts"]
    if not notes:
        return 0.0
    idx = _current_idx(starts, t)
    line = notes[idx]["item"].get("line", 1)
    if line not in row_y:
        return 0.0
    tgt = _row_center(row_y, line) - ctx["row_target_y"] / ctx["img_k"]
    if idx > 0:
        prev_line = notes[idx - 1]["item"].get("line", 1)
        if prev_line != line and prev_line in row_y:
            prev = _row_center(row_y, prev_line) - ctx["row_target_y"] / ctx["img_k"]
            u = (t - notes[idx]["start"]) / ease
            if u < 1.0:
                u = max(0.0, u)
                tgt = prev + (tgt - prev) * (u * u * (3 - 2 * u))
    # 夹进图片范围内：图片比上半屏矮时就不滚（显示全部）
    top_h = ctx["split"]
    max_off = max(0.0, ctx["orig_h"] - top_h / ctx["img_k"])
    return min(max(tgt, 0.0), max_off)


def render_frame_play(t, ctx, img, dr):
    """play 风格：上半 = 原谱 + 粉色游标（压在当前音上）；下半 = 虚拟键盘 + 当前键高亮。"""
    W, H, split = ctx["W"], ctx["H"], ctx["split"]
    mx, k = ctx["margin"], ctx["img_k"]
    dr.rectangle([0, 0, W, H], fill=BG)

    # ── 上半：原谱（纵向滚动，让当前那行停在 split 的 55% 处）
    off = play_offset_at(t, ctx)
    dy = ctx["fit_dy"]
    img.paste(ctx["page"], (mx, int(dy - off * k)))
    # ── 游标：粉条，行高上下各留一点；半透明，音数字透出来发红
    notes = ctx["notes"]
    idx = _current_idx(ctx["starts"], t)
    if idx is not None:
        item = notes[idx]["item"]
        box = item.get("box")
        line = item.get("line", 1)
        if box and line in ctx["row_y"]:
            cx = (box[0] + box[2] / 2.0) / ctx["scale"]
            y0, y1 = ctx["row_y"][line]
            bx = mx + cx * k
            bw = max(10.0, 26 * ctx["W"] / 1080.0)
            by0, by1 = dy - off * k + (y0 - 6) * k, dy - off * k + (y1 + 6) * k
            rgba = ImageDraw.Draw(img, "RGBA")
            rgba.rounded_rectangle([bx - bw / 2, by0, bx + bw / 2, by1],
                                   radius=bw / 2,
                                   fill=PLAY_BAR + (PLAY_BAR_A,))

    # ── 下半：盖住溢出的谱面，再画**电脑键盘**
    dr.rectangle([0, split, W, H], fill=BG)
    dr.line([0, split, W, split], fill=(38, 42, 52), width=2)
    kb = ctx["kb"]
    kx0, ky0, kx1, ky1 = kb["A"][0]                 # 拿一个字母键量键宽/行高
    u, row_h = kx1 - kx0, ky1 - ky0
    kb_top = min(r[1] for rects in kb.values() for r in rects)   # 键盘顶边（=第一排）
    f_key = font(max(11, int(u * 0.40)))
    f_mod = font(max(9, int(u * 0.26)))
    cur_label, cur_shift = "", None
    if idx is not None:
        item = notes[idx]["item"]
        cur_label = str(item.get("letter") or "").upper()
        cur_shift = item.get("shift")
    for label, rects in kb.items():
        for (x0, y0, x1, y1) in rects:
            dr.rounded_rectangle([x0 + 2, y0 + 2, x1 - 2, y1 - 4], radius=int(u * 0.10),
                                 fill=KEY_FACE if len(label) == 1 else KEY_MOD,
                                 outline=KEY_EDGE, width=1)
            dr.text(((x0 + x1) / 2, (y0 + y1) / 2 - 2), label,
                    font=f_key if len(label) == 1 else f_mod,
                    fill=KEY_TEXT, anchor="mm")
    # 当前音对应的键：压下去 + 琥珀高亮（±2/±3 那档还要点亮 Shift）
    pressed = []
    if cur_label in kb:
        pressed.append(kb[cur_label][0])
    if cur_shift:
        srects = kb.get("Shift") or []
        if srects:
            pressed.append(srects[0] if str(cur_shift).startswith("L") else srects[-1])
    f_big = font(max(16, int(u * 0.52)))
    for (x0, y0, x1, y1) in pressed:
        dr.rounded_rectangle([x0 + 2, y0 + 6, x1 - 2, y1], radius=int(u * 0.10),
                             fill=KEY_PRESSED, outline=(150, 88, 12), width=2)
        dr.text(((x0 + x1) / 2, (y0 + y1) / 2 + 3), "⇧" if x1 - x0 > u * 1.5 else cur_label,
                font=f_big, fill=(48, 30, 4), anchor="mm")
    # 状态行：拍速 + 当前音
    if idx is not None:
        item = notes[idx]["item"]
        n = item.get("n")
        deg = "" if n is None else ("休止" if int(n) == 0 else "简谱 %s" % n)
        info = "♪=%g　按 %s 键%s" % (ctx["bpm"], cur_label or "—",
                                    ("（%s）" % deg) if deg else "")
        dr.text((ctx["margin"], kb_top - int(H * 0.040)), info,
                font=ctx["f_small"], fill=HIT_SOFT)


def _play_page(score_path, score, want):
    """上半屏用哪张图：`overlay` = 字母谱（原位替换图）/ `source` = 原谱（数字）。

    - overlay 和**原图同尺寸**，所以游标坐标（box/scale）两边通用，换图不用改映射。
    - overlay 只把数字换成字母，**歌词、减时线、连音弧都还在**。
    - overlay 就在 JSON 旁边（同一个 out/），所以用它还顺手去掉了对 `source`
      的依赖 —— 网页上传的那些 source 指向 web_out 临时目录，清掉就找不到了。
    """
    here = os.path.dirname(os.path.abspath(score_path))
    base = os.path.splitext(os.path.basename(score_path))[0]
    if base.endswith("_notes"):
        base = base[:-len("_notes")]
    overlay = os.path.join(here, base + "_overlay.png")
    src = str(score.get("source") or "")
    if want == "overlay":
        # 要字母谱但 overlay 不在（比如只拷了 JSON 出来），退回原谱并说明
        if os.path.isfile(overlay):
            return overlay, "overlay"
        if src and os.path.isfile(src):
            print("  ⚠ 找不到 %s，退回原谱（显示数字，不是字母）" % os.path.basename(overlay))
            return src, "source"
        raise SystemExit(f"既没有字母谱也没有原谱：\n  {overlay}\n  {src!r}")
    if src and os.path.isfile(src):
        return src, "source"
    if os.path.isfile(overlay):
        return overlay, "overlay"
    raise SystemExit(f"既没有原谱也没有字母谱：\n  {src!r}\n  {overlay}")


def play_setup(score, ctx, args, bpm, notes, tonic):
    """play 风格要的装配：上半屏的谱面图、每个音的原图坐标、每行的 y 范围、键盘布局。"""
    path, kind = _play_page(args.score, score, args.page)
    page = Image.open(path).convert("RGB")
    ow, oh = page.size
    mx = ctx["margin"]
    k = (ctx["W"] - 2 * mx) / ow
    page = page.resize((max(1, int(ow * k)), max(1, int(oh * k))), Image.LANCZOS)
    scale = float(score.get("scale") or 1.0)

    # 每行的 y 范围（**原图坐标**）：`box` 长在识别用的缩放空间里，除以 scale 回到原图
    row_y = {}
    for line in score["lines"]:
        ys = [(it["box"][1] / scale, (it["box"][1] + it["box"][3]) / scale)
              for it in line["notes"] if it.get("box")]
        if ys:
            row_y[line["line"]] = (min(a for a, _ in ys), max(b for _, b in ys))

    bottom = ctx["H"] - ctx["split"]
    # 电脑键盘：3 排字母区，高宽比按真键盘（约 0.26）；太扁的话字看不清
    kb_w = int((ctx["W"] - 2 * mx) * 0.96)
    kb_h = max(int(ctx["H"] * 0.10), min(int(bottom * 0.34), int(kb_w * 0.26)))
    kb = qwerty_layout((ctx["W"] - kb_w) // 2,
                       ctx["split"] + max(0, (bottom - kb_h)) // 2, kb_w, kb_h)
    ctx.update({"page": page, "img_k": k, "orig_h": oh, "scale": scale,
                "row_y": row_y, "kb": kb, "tonic": tonic, "bpm": bpm,
                "starts": [n["start"] for n in notes],
                # 谱面整页装得下上半屏时，竖直居中（否则顶着上边、下面一大片空）
                "fit_dy": max(0, (ctx["split"] - page.height)) // 2,
                "row_target_y": ctx["split"] * 0.55})
    print("play：上半 = %s %dx%d → %s 缩放 %.3f | 行 %d | 下半 = QWERTY 键盘"
          % ("字母谱" if kind == "overlay" else "原谱（数字）",
             ow, oh, page.size, k, len(row_y)))
    return ctx

# ═══ roll 风格：蛇形下坡楼梯 ═══

def diatonic(n, o):
    """音高 → **全音阶步数**（1~7 每级一步、每八度 7 步）—— 像五线谱那样按"级"算，
    不是按半音。这样木板的高度差 = 简谱上的级差，一眼能看出旋律的走向。
    """
    oo = 1 if int(o) > 1 else (-1 if int(o) < -1 else int(o))
    return oo * 7 + (int(n) - 1)


def _plank_links(ctx, flags):
    """记下每个位置「前面最近有木板的音」和「后面最近有木板的音」—— 休止要飞过去用。"""
    n = len(flags)
    prev_p, nxt_p = [None] * n, [None] * n
    last = None
    for i in range(n):
        prev_p[i] = last
        if flags[i]:
            last = i
    last = None
    for i in range(n - 1, -1, -1):
        nxt_p[i] = last
        if flags[i]:
            last = i
    ctx["prev_plank"], ctx["next_plank"] = prev_p, nxt_p


def roll_setup(score, ctx, args, bpm, notes):
    """roll 风格：**蛇形下坡楼梯** + 小球一路往下滚。

    两条硬规则（用户定的）：
      * 小球**一直往一个方向滚**，碰到屏幕边缘就换行、方向反过来（像读文章那样来回）；
      * **上一块木板必定不矮于下一块** —— 做法是让下降量 = 旋律**下跌**的幅度，
        上涨记 0（就是"等于上一块"）。整条因此单调下降，而下降的**多少**仍带音乐信息。

    和 tiles 风格的根本区别：那边是"时间轴横向滚动"（当前时刻固定在某个 x），
    这边是**绝对坐标 + 相机竖向跟随** —— 因为楼梯要一路往下延伸，横向反而要来回。
    """
    W, H = ctx["W"], ctx["H"]
    margin = ctx["margin"]
    # ⚠ 每拍像素**固定**（不跟 BPM 走）：否则快歌的木板会被压得很窄（南泥湾
    # BPM 118 时每拍只有 122px，半拍 61px，键位字母都挤不下）。画面快慢由
    # `px_per_beat / 每拍秒数` 自然决定 —— 快歌本来就该走得快。
    px_per_beat = float(args.beat_px)
    drop = float(args.drop_px)
    row_gap = H * float(args.row_gap)
    x, y, direction = margin, H * float(args.stair_top), 1
    planks, rows = [], 1
    prev_d = None
    for note in notes:
        item = note["item"]
        n = int(item.get("n") or 0)
        has = n > 0
        d = diatonic(n, item.get("o", 0)) if has else None
        if prev_d is not None and has and d < prev_d:
            y += (prev_d - d) * drop                 # 只降不升
        if has:
            prev_d = d
        # 最短板宽 40px：十六分音符（q=0.25）按实算只有 35px，细成一根针看不清
        ln = max(40.0, min(note["dur"] * px_per_beat, W - 2 * margin))
        if direction > 0 and x + ln > W - margin:    # 右行到头 → 换行、反向
            direction, y, rows = -1, y + row_gap, rows + 1
            x = W - margin
        elif direction < 0 and x - ln < margin:      # 左行到头 → 换行、反向
            direction, y, rows = 1, y + row_gap, rows + 1
            x = margin
        x2 = x + direction * ln
        planks.append({"x0": min(x, x2), "x1": max(x, x2), "y": y,
                       "dir": direction, "has": has, "note": note, "item": item})
        x = x2
    ctx.update({"planks": planks, "rows": rows,
                # 板做薄一点 + 每块左右各留缝（下面绘制时 inset），否则首尾相接
                # 糊成一整条，"一块块木板"的感觉就没了
                "plank_h": max(22, int(H * 0.033)),
                "plank_gap": max(3, int(W * 0.004)),
                "ball_r": max(18, int(H * 0.028)),
                "f_lyric_float": cjk_font(max(30, int(H * 0.040))),
                "f_key_roll": font(max(16, int(H * 0.024)))})
    ctx["plank"] = [p["has"] for p in planks]
    _plank_links(ctx, ctx["plank"])
    print("roll：%d 块木板 / %d 行 | 楼梯总下降 %dpx | 每级 %.0fpx | 行距 %dpx"
          % (len(planks), rows, int(y - H * float(args.stair_top)), drop, int(row_gap)))
    return ctx


def roll_ball(t, ctx):
    """小球的世界坐标（圆心）：在板上就顺着行进方向滚，板走完抛物线跳到下一块。"""
    notes, starts = ctx["notes"], ctx["starts"]
    pl, ph, r = ctx["planks"], ctx["plank_h"], ctx["ball_r"]
    if not notes:
        return None

    def top_of(i):
        return pl[i]["y"] - ph / 2 - r

    def mid(i, u):                                   # 板上按进度 u(0~1) 的位置
        p = pl[i]
        return (p["x0"] + (p["x1"] - p["x0"]) * (u if p["dir"] > 0 else 1 - u),
                top_of(i))

    i = _current_idx(starts, t)
    cur = notes[i]
    if pl[i]["has"] and t < cur["start"] + cur["dur"]:
        return mid(i, (t - cur["start"]) / max(cur["dur"], 1e-6))
    src = i if pl[i]["has"] else ctx["prev_plank"][i]
    dst = ctx["next_plank"][i]
    if src is None:
        return None
    if dst is None:
        return mid(len(notes) - 1, 1.0)
    t0 = notes[src]["start"] + notes[src]["dur"]
    u = min(max((t - t0) / max(notes[dst]["start"] - t0, 1e-6), 0.0), 1.0)
    (x0, y_s), (x1, y_e) = mid(src, 1.0), mid(dst, 0.0)
    arc = r * 2.6 + max(0.0, y_e - y_s) * 0.30       # 往下跳，落点越低弧越高
    return (x0 + (x1 - x0) * u, y_s + (y_e - y_s) * u - arc * math.sin(math.pi * u))


def render_frame_roll(t, ctx, img, dr):
    """roll 风格画帧：相机竖向跟随小球（小球恒在 0.5H），木板按世界坐标铺。"""
    W, H = ctx["W"], ctx["H"]
    ph, r = ctx["plank_h"], ctx["ball_r"]
    bp = roll_ball(t, ctx)
    y_cam = (bp[1] - H * 0.5) if bp else 0.0         # 让小球停在半屏高

    for y0 in range(0, H, 4):
        k = y0 / H
        dr.rectangle([0, y0, W, y0 + 4], fill=tuple(
            int(BALL_BG_TOP[c] + (BALL_BG_BOT[c] - BALL_BG_TOP[c]) * k) for c in range(3)))
    ImageDraw.Draw(img, "RGBA").ellipse(
        [W * 0.40, -H * 0.12, W * 1.30, H * 0.44], fill=BALL_GLOW + (56,))

    idx_of = None
    ind = ImageDraw.Draw(img, "RGBA")
    f_ly, f_key = ctx["f_lyric_float"], ctx["f_key_roll"]
    for i, p in enumerate(ctx["planks"]):
        sy = p["y"] - y_cam
        if not p["has"] or not (-ph * 3 < sy < H + ph * 3):
            continue                                  # 出画的整行跳过
        top = int(sy - ph / 2)
        g = ctx["plank_gap"]
        xa, xb = p["x0"] + g, p["x1"] - g
        if xb - xa < 8:                              # 很短的音就别缩了
            xa, xb = p["x0"], p["x1"]
        dr.rounded_rectangle([xa, top, xb, top + ph], radius=ph // 2,
                             fill=PLANK_MID, outline=PLANK_EDGE, width=2)
        dr.rounded_rectangle([xa, top, xb, top + int(ph * 0.48)], radius=ph // 3,
                             fill=PLANK_TOP)
        dr.rounded_rectangle([xa, top + int(ph * 0.70), xb, top + ph], radius=ph // 3,
                             fill=PLANK_BOT)
        cx = (xa + xb) / 2
        # 键位字母写在板上（音高不再由高度表达了，字母必须留住音乐信息）
        key = str(p["item"].get("letter") or "")
        if key:
            dr.text((cx, sy + ph * 0.02), key, font=f_key, fill=(48, 30, 10),
                    anchor="mm")
        lyric = str(p["item"].get("lyric") or "")
        if lyric:
            note = ctx["notes"][i]
            d0, d1 = note["start"] - 0.30, note["start"] + note["dur"] + 0.50
            if d0 <= t <= d1:
                a = 1.0
                if t < note["start"]:
                    a = (t - d0) / 0.30
                elif t > note["start"] + note["dur"]:
                    a = (d1 - t) / 0.50
                hs = int(max(0.0, min(1.0, a)) * 240)
                ind.text((cx, sy + ph * 1.9), lyric, font=f_ly,
                         fill=LYRIC_INK + (hs,), anchor="mm",
                         stroke_width=3, stroke_fill=(6, 9, 16, hs))

    if bp:
        bx, by = bp[0], bp[1] - y_cam
        if -80 < bx < W + 80:
            dr.ellipse([bx - r, by - r, bx + r, by + r], fill=BALL_BODY,
                       outline=BALL_EDGE, width=2)
            dr.ellipse([bx - r * 0.48, by - r * 0.62, bx + r * 0.14, by - r * 0.10],
                       fill=(255, 255, 255))
            dr.arc([bx - r * 0.72, by - r * 0.72, bx + r * 0.72, by + r * 0.72],
                   200, 340, fill=BALL_SHADE, width=2)

# ═══ 音频 ═══

def synth(notes, tonic_midi, total, sr=44100):
    """按音高合成主旋律。正弦叠谐波 + 简单包络。"""
    out = np.zeros(int(total * sr) + sr, dtype=np.float32)
    for note in notes:
        midi = midi_of(note["item"], tonic_midi)
        if midi is None:
            continue
        freq = 440.0 * 2 ** ((midi - 69) / 12.0)
        dur = note["dur"] * 0.92                        # 留一点断句
        n = max(int(dur * sr), 1)
        tt = np.arange(n) / sr
        wave_ = sum(a * np.sin(2 * np.pi * freq * h * tt)
                    for h, a in ((1, 1.0), (2, 0.42), (3, 0.18), (4, 0.08)))
        env = np.ones(n, dtype=np.float32)
        att = min(int(0.012 * sr), n)
        env[:att] = np.linspace(0, 1, att)
        dec = np.exp(-tt * 2.6)                          # 缓慢衰减，像敲击后余音
        env *= (0.35 + 0.65 * dec)
        rel = min(int(0.05 * sr), n)
        env[-rel:] *= np.linspace(1, 0, rel)
        s = int(note["start"] * sr)
        seg = wave_ * env * 0.23
        out[s:s + n] += seg[:max(0, len(out) - s)]
    peak = float(np.abs(out).max()) or 1.0
    if peak > 0.95:
        out *= 0.95 / peak
    return out, sr


def write_wav(path, samples, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())

# ═══ 流程 ═══

def build(score_path, args):
    with open(score_path, "r", encoding="utf-8") as fp:
        score = json.load(fp)
    # 拍速优先级：命令行 > JSON 里存的 tempo_qpm > 默认
    bpm = args.bpm or score.get("tempo_qpm") or DEFAULT_TEMPO
    bpm = float(bpm)
    src_note = ("命令行" if args.bpm else
                ("JSON" if score.get("tempo_qpm") else "默认"))
    W, H = (int(v) for v in args.size.lower().split("x"))
    hit_y, top_clip = int(H * args.hit), int(H * 0.02)
    margin = int(W * 0.02)
    # 每秒像素：给了 --second-px 就用它，否则按「线上显示几秒」反算
    px_per_second = args.second_px or ((hit_y - top_clip) / args.lookahead)
    ctx = {
        "W": W, "H": H,
        "hit_y": hit_y,
        "px_per_second": px_per_second,
        "margin": margin,
        "strip_w": (W - 2 * margin) / STRIPS,
        "f_small": cjk_font(max(16, H // 55)),
        # 块上歌词的字号：跟着块宽走（块宽 = 2 条 × 每条宽）
        "f_tile_lyric": cjk_font(max(14, int((W - 2 * margin) / STRIPS * TILE_STRIPS * 0.46))),
        "top_clip": top_clip,
        "split": int(H * args.split),
        # 底部字幕带的高度（整句歌词那条）。放最底部、不透明：和落块完全不重叠
        "band_h": int(H * args.lyric_band),
    }
    notes, song_end, _spb = timeline(score, bpm, args.lead_in)
    ctx["notes"] = notes
    ctx["starts"] = [n["start"] for n in notes]      # 两种风格都要（找"当前音"用）
    # 歌词带要用的东西：每个音自己的歌词；再加"上一个有歌词的音"（休止/无词时歌词带不清空）
    lyrics = [str(n["item"].get("lyric") or "") for n in notes]
    flat, pos_of = [], []
    for s in lyrics:
        pos_of.append((len(flat), len(flat) + len(s)))
        flat.extend(s)                       # 只存字，按顺序
    anchor, last = [], -1
    for i, s in enumerate(lyrics):
        if s:
            last = i
        anchor.append(last)
    f_lyric = cjk_font(max(20, int(H * 0.027)))
    ctx.update({"lyrics": lyrics, "flat": flat, "pos_of": pos_of, "anchor": anchor,
                "f_lyric": f_lyric,
                "lyric_show": max(8, int((W - 2 * margin) / max(f_lyric.size, 1)))})
    total = song_end + args.tail_beats * 60.0 / bpm
    tonic = parse_key(score.get("key"))
    print("曲名 %s | %s %s | BPM %g（来自%s）| 音数 %d | 时长 %.1fs（%.1f 分）"
          % (score.get("title"), score.get("key"), score.get("meter"), bpm, src_note,
             len(notes), total, total / 60))
    if args.style == "play":
        play_setup(score, ctx, args, bpm, notes, tonic)
    elif args.style == "roll":
        roll_setup(score, ctx, args, bpm, notes)
    else:
        print("主音 MIDI %d | 画面 %dx%d | 现在线 y=%d | 每秒 %.0fpx"
              % (tonic, W, H, ctx["hit_y"], ctx["px_per_second"]))
    return score, ctx, notes, total, tonic, bpm


def main(argv=None):
    p = argparse.ArgumentParser(description="把逐音 JSON 渲染成「试演奏」视频。")
    p.add_argument("score", help="out/<曲名>_notes.json")
    p.add_argument("-o", "--out", default=None, help="输出 mp4（默认 <曲名>_试演奏.mp4）")
    p.add_argument("--beat-px", type=float, default=200.0,
                   help="roll 风格：一拍多少像素（固定值，不随 BPM 变；默认 200）")
    p.add_argument("--drop-px", type=float, default=20.0,
                   help="roll 风格：旋律每下跌一级，木板往下走多少像素（默认 20）")
    p.add_argument("--row-gap", type=float, default=0.13,
                   help="roll 风格：换一行时额外下降多少（占画面高的比例，默认 0.13）")
    p.add_argument("--stair-top", type=float, default=0.30,
                   help="roll 风格：楼梯顶端从画面高的哪个位置开始（默认 0.30）")
    p.add_argument("--bpm", type=float, default=None,
                   help="拍速（四分音符/分钟）。不给就用 JSON 里的 tempo_qpm，"
                        "再没有就 100（谱面没印 ♩= 时的默认）")
    p.add_argument("--size", default="1080x1920", help="宽x高，默认竖屏 1080x1920")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--hit", type=float, default=0.72, help="「现在」线在画面高度的比例")
    p.add_argument("--lookahead", type=float, default=2.8,
                   help="「现在」线以上显示几秒（默认 2.8s）。像素比例由它反算 —— "
                        "别直接照抄网页 app 的 --second-px=288：那是在它 650px 高的"
                        "线上区域标定的，换到别的分辨率就会要么太空要么挤爆")
    p.add_argument("--second-px", type=float, default=None,
                   help="显式指定每秒像素（给了就忽略 --lookahead）")
    p.add_argument("--lead-in", type=float, default=2.0, help="开头留几拍")
    p.add_argument("--tail-beats", type=float, default=2.0, help="结尾多留几拍")
    p.add_argument("--style", choices=("tiles", "play", "roll"), default="tiles",
                   help="tiles=落块音游 / play=原谱跟弹（字母谱+电脑键盘）/ "
                        "roll=蛇形下坡楼梯（球一路往下滚）")
    p.add_argument("--split", type=float, default=0.5,
                   help="play 风格里上半屏占的比例（默认 0.5）")
    p.add_argument("--page", choices=("overlay", "source"), default="overlay",
                   help="play 风格上半屏用哪张图：overlay=**字母谱**（默认，"
                        "= 原位替换图，歌词还在）/ source=原谱（数字）")
    p.add_argument("--lyric-band", type=float, default=0.075,
                   help="落块风格里底部字幕带占画面高度的比例（默认 0.075）；"
                        "给 0 = 不画字幕带（只留块上的字）")
    p.add_argument("--stills", default=None,
                   help="只出静止帧：给百分比列表如 2,10,30,60（不编码视频）")
    p.add_argument("--no-audio", action="store_true")
    args = p.parse_args(argv)

    score, ctx, notes, total, tonic, bpm = build(args.score, args)
    draw_frame = {"play": render_frame_play,
                  "roll": render_frame_roll}.get(args.style, render_frame)

    if args.stills is not None:
        base = os.path.splitext(os.path.basename(args.score))[0].replace("_notes", "")
        for pct in [float(x) for x in args.stills.split(",")]:
            t = total * pct / 100.0
            img = Image.new("RGB", (ctx["W"], ctx["H"]), BG)
            draw_frame(t, ctx, img, ImageDraw.Draw(img))
            path = os.path.join(tempfile.gettempdir(),
                                "_still_%s_%s_%g.png" % (base, args.style, pct))
            img.save(path)
            print("  静止帧 t=%6.1fs (%g%%)  →  %s" % (t, pct, path))
        return 0

    # 默认按**曲名**命名（"上海滩_试演奏.mp4"），而不是图号（"1_试演奏.mp4"）
    name = str(score.get("title") or "").strip() or \
        os.path.splitext(os.path.basename(args.score))[0].replace("_notes", "")
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    suffix = {"play": "_跟弹.mp4",
              "roll": "_小球下坡.mp4"}.get(args.style, "_试演奏.mp4")
    out = args.out or os.path.join(VIDEO_DIR, name + suffix)
    # 无论默认路径还是 `-o` 指定的路径，都把父目录建出来 —— 网页那边传的是
    # `视频/xxx.mp4`，ffmpeg 不会自己建目录（否则报 No such file or directory）
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = tempfile.gettempdir()
    silent = os.path.join(tmp, "_jpk_silent.mp4")
    frames = int(total * args.fps)
    print("开始渲染 %d 帧…" % frames)

    writer = subprocess.Popen(
        [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", "%dx%d" % (ctx["W"], ctx["H"]), "-r", str(args.fps), "-i", "-",
         "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
         "-pix_fmt", "yuv420p", silent],
        stdin=subprocess.PIPE)
    img = Image.new("RGB", (ctx["W"], ctx["H"]), BG)
    dr = ImageDraw.Draw(img)
    for i in range(frames):
        draw_frame(i / args.fps, ctx, img, dr)
        writer.stdin.write(img.tobytes())
        if i and i % (args.fps * 15) == 0:
            print("  %d/%d 帧（%.0fs）" % (i, frames, i / args.fps))
    writer.stdin.close()
    writer.wait()

    if args.no_audio:
        os.replace(silent, out)
        print("完成（无音频）：", os.path.abspath(out))
        return 0

    samples, sr = synth(notes, tonic, total)
    wav = os.path.join(tmp, "_jpk_audio.wav")
    write_wav(wav, samples, sr)
    subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
                    "-i", silent, "-i", wav, "-c:v", "copy", "-c:a", "aac",
                    "-b:a", "160k", "-shortest", out], check=True)
    print("完成：", os.path.abspath(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
