# -*- coding: utf-8 -*-
"""简谱图片 → 原位替换图 + 「第几行 / 原始数字 / 转换后字母」对照表。

识别本身一行没改，全部复用 `D:\\Letter piano11` 的 jianpu2letter 包：
`ocr_jianpu` 认谱、`overlay_letters` 把数字原位盖成字母、`mapping` 查键位。
本文件只做三件事 —— 把包喂进去、把产物落盘、把结果整理成逐音对照。

用法：

    import jianpu_api
    overlay, table, payload = jianpu_api.convert(r"D:\\Letter piano11\\piano\\7.png",
                                                 outdir="out")
    for line in payload["lines"]:
        for note in line["notes"]:
            print(note["line"], note["n"], note["letter"])

piano11 不在默认位置时用环境变量指定（也可以拿它把解释器钉死）：

    set JIANPU_PIANO11=D:\\Letter piano11
"""

import contextlib
import io
import json
import os
import sys

# 识别包（jianpu2letter）在哪里 —— 按顺序找**第一个真的有它**的目录：
#   ① 环境变量 JIANPU_PIANO11（显式指定，优先）
#   ② **本文件的上级目录** —— 本工程作为 piano11 的子目录（如 `D:\Letter piano11\jk`）时，
#      识别包就在上一级；这样搬过去不用配任何环境变量，clone 到哪都能跑 ✓
#   ③ `D:\Letter piano11`（本工程独立放在别处时的兜底）
_HERE = os.path.dirname(os.path.abspath(__file__))
PIANO11 = next((p for p in (os.environ.get("JIANPU_PIANO11"),
                            os.path.dirname(_HERE),
                            r"D:\Letter piano11")
                if p and os.path.isdir(os.path.join(p, "jianpu2letter"))), None)
if PIANO11 is None:
    raise ImportError(
        "找不到 jianpu2letter 工程目录（那套识别代码）。按顺序找过：\n"
        "  ① 环境变量 JIANPU_PIANO11\n"
        "  ② 本文件的上级目录 %s\n"
        "  ③ D:\\Letter piano11\n"
        "设 JIANPU_PIANO11 指到含 jianpu2letter 的目录即可。" % os.path.dirname(_HERE))
if PIANO11 not in sys.path:
    sys.path.insert(0, PIANO11)

from jianpu2letter import mapping, ocr_jianpu, overlay_letters  # noqa: E402

FORMAT = "jianpu2letter-notes-v1"

# 谱面没印拍速时的默认值。100 的依据：piano11 自己的 site_json 格式里写的就是
# `"tempo_qpm": 100`；实测你参考视频的音轨是 95.7 BPM；另有一张谱印的是 ♩=103。
# 三个锚点都落在 96~103，取整数 100。
DEFAULT_TEMPO = 100.0

_INSTRUCTIONS = [
    "line / index —— 第几行、该行第几个音（与 overlay 图上和 _review.json 里的 "
    "L03N029 这种 id 对应）。",
    "n —— 原谱上的数字：0=休止，1..7=唱名，null=没认出来。",
    "o —— 音区：-1=低音点，0=中音，1=高音点（±2/±3 见 shift）。",
    "letter —— 转换后的字母谱键位；休止是 \"0\"，认不出来是 null。",
    "shift —— null / \"LSHIFT\" / \"RSHIFT\"：映射2 里 ±2、±3 音区要按 Shift，"
    "所以 letter 相同时靠它区分音区。",
    "q —— 时值，**四分音符 = 1.0**（减时线每多一条减半、附点×1.5、延时线每条+1）。"
    "做视频/试听要算秒数就按它来。",
    "box —— [x, y, w, h]：该音在**识别用缩放图**上的像素框；顶层 `scale` 是那个倍数。"
    "overlay.png 是**原图尺寸**，要换算过去就除以 scale。画高亮框靠它。",
    "unknown —— 只出现在 n 为 null 的音上。⚠ overlay 上的红框**不止这一种来源**："
    "判成休止的音若形状复核不像 0、也会画红框，而那些音的 n 仍然是 0、不带 unknown。",
    "tempo_qpm —— 拍速，**四分音符/分钟**。做视频/试听的时间轴按它算。"
    "`tempo_source` 说明来源：`manual`=人填的 / `default`=没人填、用的默认 100。"
    "⚠ 谱面印的 ♩= 目前**没读**（piano11 会把它当表头噪音丢掉），所以别把 "
    "default 当成「谱上就是这么写的」。",
    "lyric —— 这个音对应的歌词（可能多个字，即一字多音/拖腔）；没有就不出现这个键。"
    "⚠ **只有第一段**：一行底下叠着多段歌词时，piano11 只留最上面那一段、其余丢弃。",
]


def _key_mark(raw):
    """调号统一成 `1=X`。`F` 和 `1=F` 都收；没给就用页眉读到的，再没有才退回 1=C。"""
    raw = raw or ocr_jianpu._LAST_KEY_MARK
    if not raw:
        return "1=C"
    return raw if str(raw).startswith("1=") else f"1={raw}"


def _letter(n, o):
    """原始数字 + 音区 → 字母谱键位，返回 (letter, shift)。

    休止 `0` 在字母谱里仍然是 `"0"`；(None, None) 表示没有音高 —— 认不出的块
    （n 为 None），或者音区超出映射2 的范围（只覆盖 -3..3）。
    """
    if n is None:
        return None, None
    if int(n) == 0:
        return "0", None
    try:
        return mapping.key_for(int(n), int(o or 0))
    except ValueError:
        return None, None


def _beats(note):
    """这个音的时值，**四分音符 = 1.0**（跟着 review_io 的口径，别自己发明单位）。

    公式与 `review_io.load_review` 里那行完全一致：减时线每多一条减半、附点乘 1.5、
    延时线每条加一拍。放在这里是因为 OCR 现场才有 `markup`，而下游（做视频）只吃 JSON。
    """
    markup = note.get("markup") or {}
    beams = int(markup.get("beams", 0))
    dotted = bool(markup.get("dotted", False))
    extend = int(markup.get("extend", 0))
    return round((1.0 / (2 ** beams)) * (1.5 if dotted else 1.0) + extend, 4)


def _notes_table(measures):
    """逐音整理成 `lines[].notes[]`。返回 (lines, counts)。

    分行规则**必须与 `review_io.save_review` 逐字一致**（`row` 变了才换行），
    否则同一张图这里、`_review.json`、网页三处的行号会对不上。
    """
    groups, current, current_row = [], [], object()
    for measure in measures:
        row = measure.get("row", 0)
        if current and row != current_row:
            groups.append(current)
            current = []
        current_row = row
        current.append(measure)
    if current:
        groups.append(current)

    lines = []
    counts = {"total": 0, "letters": 0, "rests": 0, "unknown": 0}
    for line_no, group in enumerate(groups, 1):
        notes_out = []
        for measure in group:
            for note in measure.get("notes", []):
                n = note.get("n")
                o = int(note.get("o", 0) or 0)
                letter, shift = _letter(n, o)
                item = {"line": line_no, "index": len(notes_out) + 1,
                        "n": n, "o": o, "letter": letter,
                        "q": _beats(note)}
                # 像素框（在**识别用的缩放图**空间里，见顶层 scale）。
                # 做视频要在图上画"当前音"的高亮框，这个框只有 OCR 现场有 ——
                # `_review.json` 只存了 source_x，没有 y 和宽高，所以必须落在这里。
                box = note.get("box")
                if box is not None:
                    item["box"] = [int(v) for v in box]
                # 歌词（可能多个字对应一个音，即一字多音/拖腔）。
                # ⚠ 只有**第一段**：piano11 的 OCR 在"一行底下叠着多段歌词"时
                # 只留最上面那一段（见 ocr_jianpu.py 里那段注释），其余几段被丢弃，
                # 所以这里也拿不到。要补多段得改 piano11。
                lyric = str(note.get("lyric") or "").strip()
                if lyric:
                    item["lyric"] = lyric
                if shift:
                    item["shift"] = shift
                if n is None:
                    item["unknown"] = True
                notes_out.append(item)

                counts["total"] += 1
                if n is None:
                    counts["unknown"] += 1
                elif letter == "0":
                    counts["rests"] += 1
                else:
                    counts["letters"] += 1
        lines.append({"line": line_no, "notes": notes_out})
    return lines, counts


def convert(image_path, outdir="out", *, title=None, key=None, meter=None,
            tempo=None, measure_mode="vline"):
    """把一张简谱图片转成两样产物，返回 (overlay_path, table_path, payload)。

    - `overlay_path` = `<outdir>/<图片名>_overlay.png`
      在原谱上**原位**把数字盖成字母：版式、歌词、减时线、连音弧、小节线全部保持
      像素原样，没认出来的数字保留并画红框。这是核对识别结果最直接的一张图。
    - `table_path` = `<outdir>/<图片名>_notes.json`
      逐音对照表，每个音有 line / index / n / o / letter（+ shift / unknown）。

    `title` / `key` / `meter` 不给就从页眉自动读，读不到退回文件名 / `1=C` / `4/4`。
    `key` 可以写 `F` 或 `1=F`。给了 `title` 和 `key` 会跳过页眉 OCR（省几秒）。

    注意：OCR 用的底图和缩放倍数是 `ocr_jianpu` 的**模块全局**，所以这个函数
    不是线程安全的 —— 多张图请串行跑。
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"找不到图片：{image_path}")
    base = os.path.splitext(os.path.basename(image_path))[0]
    os.makedirs(outdir, exist_ok=True)

    # OCR 会往 stdout 打很多逐行诊断；收进缓冲区（顺带避开 Windows 控制台 GBK
    # 编不出 `³` 就整个崩掉的老问题）。想看日志就把这个 StringIO 留下来打印。
    with contextlib.redirect_stdout(io.StringIO()):
        measures = ocr_jianpu.ocr_to_stream(
            image_path, debug_dir=None, measure_mode=measure_mode,
            header_ocr=not (title and key))

    # 必须**紧挨着**上面那次 OCR：overlay 要的底图（`_LAST_COLOR`）和缩放倍数
    #（`_LAST_SCALE`）就存在模块全局里，中间隔一次别的识别就会盖到别人的谱上。
    overlay_path = os.path.join(outdir, base + "_overlay.png")
    _drawn, _rests, _unknown, ok = overlay_letters.render(measures, overlay_path)
    if not ok:
        raise IOError(f"原位替换图写入失败：{overlay_path}")

    lines, counts = _notes_table(measures)
    payload = {
        "format": FORMAT,
        "title": title or ocr_jianpu._LAST_TITLE or base,
        "key": _key_mark(key),
        "meter": meter or "4/4",
        "source": os.path.abspath(image_path),
        # 拍速（四分音符/分钟）。piano11 **不读**页眉的 ♩=，所以这里只有两种来源：
        # 调用方给的（"manual"）和默认值（"default"）。存来源是为了以后分得清
        # "这个 100 是谱上写的" 还是 "没人填、系统猜的" —— 猜错会让视频速度错，
        # 且不报错，属于静默错误。
        "tempo_qpm": float(tempo) if tempo else DEFAULT_TEMPO,
        "tempo_source": "manual" if tempo else "default",
        # 识别时把原图放大的倍数。每个音的 `box` 就长在这个缩放空间里：
        # 想换算到 `_overlay.png`（它是**原图尺寸**）就除以它。
        "scale": round(float(ocr_jianpu._LAST_SCALE or 1.0), 6),
        "counts": counts,
        "_instructions": _INSTRUCTIONS,
        "lines": lines,
    }
    table_path = os.path.join(outdir, base + "_notes.json")
    with open(table_path, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)
        fp.write("\n")
    return overlay_path, table_path, payload
