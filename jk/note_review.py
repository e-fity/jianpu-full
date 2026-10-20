# -*- coding: utf-8 -*-
"""人工核对现有 JSON 和替换图，不重跑 OCR。"""
import base64
import hashlib
import json
import math
import os
from pathlib import Path

import cv2
import numpy as np

from jianpu_api import _letter, overlay_letters


def _image(raw):
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("图片无法读取。")
    return image


def _red(image):
    b, g, r = cv2.split(image)
    return (r > 200) & (g < 80) & (b < 80)


def _rect(note, scale, shape):
    x, y, w, h = [float(v) / scale for v in note["box"]]
    pad = max(2, round(.12 * h)) + 2
    return (max(0, int(x) - pad), max(0, int(y) - pad),
            min(shape[1], int(x + w) + pad + 1),
            min(shape[0], int(y + h) + pad + 1))


def _border(note, scale, shape):
    x0, y0, x1, y1 = _rect(note, scale, shape)
    mask = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
    x, y, w, h = [float(v) / scale for v in note["box"]]
    pad = max(2, round(.12 * h))
    cv2.rectangle(mask, (int(x) - pad - x0, int(y) - pad - y0),
                  (int(x + w) + pad - x0, int(y + h) + pad - y0), 1, 2)
    return mask.astype(bool)


def read_review(table, overlay):
    raw_table, raw_image = Path(table).read_bytes(), Path(overlay).read_bytes()
    payload = json.loads(raw_table)
    image = _image(raw_image)
    scale = float(payload.get("scale") or 1)
    red = _red(image)
    notes = []
    for line in payload["lines"]:
        for note in line["notes"]:
            if not note.get("box"):
                continue
            x0, y0, x1, y1 = _rect(note, scale, image.shape)
            border = _border(note, scale, image.shape)
            matched = np.count_nonzero(red[y0:y1, x0:x1] & border)
            has_red = matched > .6 * np.count_nonzero(border)
            notes.append({**note, "red": bool(has_red),
                          "rect": [x0, y0, x1 - x0, y1 - y0],
                          "edit_rect": [v / scale for v in note["box"]]})
    choices = [{"n": 0, "o": 0, "label": "0 · 休止"}]
    for o in range(-3, 4):
        for n in range(1, 8):
            letter, shift = _letter(n, o)
            choices.append({"n": n, "o": o,
                            "label": f"{letter} · 音区 {o} · 简谱 {n}" +
                            (f" · {shift}" if shift else "")})
    return {"title": payload.get("title", ""), "notes": notes,
            "counts": payload["counts"], "choices": choices,
            "line_numbers": [line["line"] for line in payload["lines"]],
            "width": image.shape[1], "height": image.shape[0],
            "can_edit": Path(payload.get("source") or "").is_file(),
            "revision": hashlib.sha256(raw_table + raw_image).hexdigest()}


def _paint_note(image, note, scale):
    """在选框内绘字，防止宽字母和 Shift 标记污染旁边的音符。"""
    x, y, w, h = [v / scale for v in note["box"]]
    x0, y0 = int(x), int(y)
    x1, y1 = min(image.shape[1], math.ceil(x + w)), min(image.shape[0], math.ceil(y + h))
    tile = image[y0:y1, x0:x1]
    tile[:] = overlay_letters._bg_color(image, x0, y0, x1 - x0, y1 - y0, 2)
    th, tw = tile.shape[:2]
    # 字母和修饰键都落在这块裁片中，不向选框外绘制。
    shift = note.get("shift")
    letter_height = th * (.72 if shift else .9)
    overlay_letters._put_letter(tile, tw / 2, th / 2 + (th * .12 if shift else 0),
                               letter_height, max(1, tw - 2), note["letter"], None, .85)
    if shift:
        cv2.putText(tile, "^" if shift == "LSHIFT" else "v", (max(0, tw - 7), max(3, int(th * .3))),
                    cv2.FONT_HERSHEY_SIMPLEX, .25, (0, 0, 0), 1, cv2.LINE_AA)
    note["review_box"] = [x0, y0, x1 - x0, y1 - y0]


def _full_border_mask(image, red, x, y):
    mask = np.zeros(image.shape[:2], dtype=np.uint8)
    mask[y:y + red.shape[0], x:x + red.shape[1]] = red.astype(np.uint8) * 255
    return mask


def edit_note(table, overlay, data):
    """消框、删除、改音、修改框或补录；坐标从原图换算到识别空间。"""
    current = read_review(table, overlay)
    if data.get("revision") != current["revision"]:
        raise ValueError("曲谱已被修改，请刷新后重新选择，避免覆盖新结果。")
    action = data.get("action")
    if action not in ("hide", "delete", "assign", "add", "box"):
        raise ValueError("不支持的编辑操作。")
    table, overlay = Path(table), Path(overlay)
    raw_table, raw_image = table.read_bytes(), overlay.read_bytes()
    payload = json.loads(raw_table)
    adding = action == "add"
    if adding:
        matches = [line for line in payload["lines"] if line["line"] == data.get("line")]
        if len(matches) != 1:
            raise ValueError("请选择新增音符所属的谱行。")
        line = matches[0]
        note = {"line": line["line"], "n": None, "o": 0, "letter": None, "q": 1}
    else:
        selected = [(line, note) for line in payload["lines"] for note in line["notes"]
                    if note["line"] == data.get("line") and note["index"] == data.get("index")]
        if len(selected) != 1 or not selected[0][1].get("box"):
            raise ValueError("找不到所选音符或位置，请刷新后重试。")
        line, note = selected[0]
    if action in ("assign", "add"):
        n, o = data.get("n"), data.get("o")
        if type(n) is not int or type(o) is not int or not 0 <= n <= 7 or not -3 <= o <= 3:
            raise ValueError("字母对应的数字或音区无效。")
        if n == 0 and o != 0:
            raise ValueError("休止符音区应为 0。")
        try:
            q = float(data.get("q"))
        except (TypeError, ValueError):
            raise ValueError("时值必须是正数，四分音符为 1 拍。") from None
        if not math.isfinite(q) or q <= 0:
            raise ValueError("时值必须是有限正数。")
    source_path = Path(payload.get("source") or "")
    if not source_path.is_file():
        raise ValueError("原图已丢失，无法准确消除红框；请先恢复 JSON 中 source 指向的原图。")
    image, source = _image(raw_image), _image(source_path.read_bytes())
    if source.shape != image.shape:
        raise ValueError("原图和替换图尺寸不一致，未保存修改。")
    scale = float(payload.get("scale") or 1)
    new_box = None
    if action in ("add", "box") or (action == "assign" and "image_box" in data):
        raw_box = data.get("image_box")
        if (not isinstance(raw_box, list) or len(raw_box) != 4 or
                any(type(v) not in (int, float) or not math.isfinite(v) for v in raw_box)):
            raise ValueError("框的位置必须是四个有限数字。")
        x, y, w, h = raw_box
        if x < 0 or y < 0 or w < 2 or h < 2 or x + w > image.shape[1] or y + h > image.shape[0]:
            raise ValueError("框必须在图片内，宽高至少为 2 像素。")
        new_box = [round(v * scale, 4) for v in raw_box]
        if adding:
            for item in current["notes"]:
                ax, ay, aw, ah = item["edit_rect"]
                overlap = max(0, min(x + w, ax + aw) - max(x, ax)) * max(0, min(y + h, ay + ah) - max(y, ay))
                if overlap > .6 * min(w * h, aw * ah):
                    raise ValueError(f"此处已有第 {item['line']} 行第 {item['index']} 个音符，请选择该条目修改，避免重复新增。")
    flagged = False
    if not adding:
        x0, y0, x1, y1 = _rect(note, scale, image.shape)
        patch = image[y0:y1, x0:x1]
        red = _red(patch) & _border(note, scale, image.shape)
        flagged = next(item["red"] for item in current["notes"]
                       if item["line"] == note["line"] and item["index"] == note["index"])
        if action == "hide" and not flagged:
            raise ValueError("这个位置没有红框。")
        if flagged and red.any():
            border = _border(note, scale, image.shape)
            saved = note.pop("review_border_pixels", None) if action != "hide" else note.get("review_border_pixels")
            if saved:
                pixels = np.frombuffer(base64.b64decode(saved), dtype=np.uint8).reshape(-1, 3)
                restored = patch.copy()
                restored[border] = pixels
                patch[red] = restored[red]
            else:
                # 旧图的红框没有底图记录：仅修补红色像素，绝不粘回原谱数字。
                repaired = cv2.inpaint(image, _full_border_mask(image, red, x0, y0), 3, cv2.INPAINT_TELEA)
                patch[red] = repaired[y0:y1, x0:x1][red]
        if action not in ("hide", "delete"):

            # 移动或改字才恢复旧绘制区域；删除条目保留谱面字符。
            if note.get("review_box"):
                ax, ay, aw, ah = note["review_box"]
                image[ay:ay + ah, ax:ax + aw] = source[ay:ay + ah, ax:ax + aw]
            elif note.get("n") not in (None, 0):
                x, y, w, h = [int(round(v / scale)) for v in note["box"]]
                margin = max(1, round(.1 * h))
                area = (slice(max(0, y - margin), y + h + margin),
                        slice(max(0, x - margin), x + w + margin))
                image[area] = source[area]
    if action == "delete":
        line["notes"].remove(note)
    elif action in ("assign", "add", "box"):
        if new_box is not None:
            note["box"] = new_box
        if action in ("assign", "add"):
            letter, shift = _letter(n, o)
            note.update(n=n, o=o, letter=letter, q=q)
            note.pop("unknown", None)
            note.pop("shift", None)
            if shift:
                note["shift"] = shift
        if adding or new_box is not None:
            if not adding:
                line["notes"].remove(note)
            cx = note["box"][0] + note["box"][2] / 2
            pos = next((i for i, item in enumerate(line["notes"])
                        if item.get("box") and item["box"][0] + item["box"][2] / 2 > cx), len(line["notes"]))
            line["notes"].insert(pos, note)
        if note.get("n") is not None:
            _paint_note(image, note, scale)
        else:
            note.pop("review_box", None)
        if action == "box" and flagged:
            x, y, w, h = [v / scale for v in note["box"]]
            pad = max(2, round(.12 * h))
            bx0, by0, bx1, by1 = _rect(note, scale, image.shape)
            border = _border(note, scale, image.shape)
            note["review_border_pixels"] = base64.b64encode(
                image[by0:by1, bx0:bx1][border].tobytes()).decode("ascii")
            cv2.rectangle(image, (int(x) - pad, int(y) - pad),
                          (int(x + w) + pad, int(y + h) + pad), (0, 0, 255), 2)
    if action != "hide":
        for index, item in enumerate(line["notes"], 1):
            item["index"] = index
    if action != "hide":
        counts = dict(total=0, letters=0, rests=0, unknown=0)
        for row in payload["lines"]:
            for item in row["notes"]:
                counts["total"] += 1
                counts["unknown" if item.get("n") is None else
                       "rests" if item["n"] == 0 else "letters"] += 1
        payload["counts"] = counts
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise OSError("替换图编码失败，未保存修改。")
    new_table = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    # 首次编辑前的备份不覆盖，不参与曲库索引。
    for path, raw in ((table, raw_table), (overlay, raw_image)):
        backup = Path(str(path) + ".before-review.bak")
        if not backup.exists():
            backup.write_bytes(raw)
    staged = Path(str(overlay) + ".review-tmp")
    staged_table = Path(str(table) + ".review-tmp")
    try:
        staged.write_bytes(encoded.tobytes())
        if action != "hide":
            staged_table.write_bytes(new_table)
        os.replace(staged, overlay)
        if action != "hide":
            os.replace(staged_table, table)
    except OSError:
        overlay.write_bytes(raw_image)
        if action != "hide":
            table.write_bytes(raw_table)
        raise
    finally:
        staged.unlink(missing_ok=True)
        staged_table.unlink(missing_ok=True)
    result = read_review(table, overlay)
    if action != "delete":
        result["selected"] = {"line": note["line"], "index": note["index"]}
    return result
