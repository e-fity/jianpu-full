"""从 piano11 现成结果同步歌词；不重跑识别或修改音符。"""
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import uuid


def sync_lyrics(table, review, preview=False):
    table, review = Path(table), Path(review)
    if not review.is_file():
        raise ValueError("找不到 piano11 的同名 _review.json，请先在 piano11 生成这首曲目的最新结果。")
    original = table.read_bytes()
    payload = json.loads(original)
    donor = json.loads(review.read_bytes())
    if donor.get("format") != "jianpu2letter-review-v1":
        raise ValueError("piano11 文件格式不正确，未同步。")
    paths = [Path(payload.get("source") or ""),
             Path(donor.get("metadata", {}).get("source_image") or "")]
    if not all(p.is_file() for p in paths):
        raise ValueError("两边的原图必须存在，才能核实是否同一张谱。")
    if hashlib.sha256(paths[0].read_bytes()).digest() != hashlib.sha256(paths[1].read_bytes()).digest():
        raise ValueError("两边原图内容不同，未同步；请先确认 piano11 对应的是同一张图片。")
    source_lines = donor.get("lines", [])
    if [l["line"] for l in source_lines] != [l["line"] for l in payload["lines"]]:
        raise ValueError("两边谱行划分不同，不能安全同步，未修改歌词。")
    changes = []
    matched = changed = 0
    skipped = []
    for line_pos, (line, source_line) in enumerate(zip(payload["lines"], source_lines)):
        notes, refs = line["notes"], source_line["notes"]
        # source_x 和 box 均使用 OCR 缩放图坐标。只接受接近且唯一的对应。
        positions = [r.get("source_x") for r in refs]
        if any(type(x) not in (int, float) or not math.isfinite(x) for x in positions):
            skipped.extend(f"第 {line['line']} 行第 {n['index']} 个" for n in notes)
            continue
        gaps = [b-a for a,b in zip(sorted(positions), sorted(positions)[1:]) if b>a]
        gap = statistics.median(gaps) if gaps else 20
        candidates = []
        for note in notes:
            box = note.get("box")
            if not box or len(box) != 4:
                candidates.append([])
                continue
            x = box[0] + box[2] / 2
            tolerance = max(2, min(box[2] * .35, gap * .25))
            candidates.append([i for i, sx in enumerate(positions) if abs(sx-x) <= tolerance])
        uses = {}
        for indices in candidates:
            for i in indices:
                uses[i] = uses.get(i, 0) + 1
        pairs = [(n, refs[c[0]]) for n,c in zip(notes,candidates) if len(c)==1 and uses[c[0]]==1]
        # 多个音高一致的坐标锚点确认本行匹配，避免尺度变化时误同步。
        anchors = sum(n.get("n")==r.get("n") and n.get("o",0)==r.get("o",0) for n,r in pairs)
        safe = bool(pairs) and anchors >= min(3,len(notes),len(refs)) and len(pairs) >= .6 * len(notes)
        paired = {id(n):r for n,r in pairs} if safe else {}
        for note_pos, note in enumerate(notes):
            ref = paired.get(id(note))
            if ref is None or not isinstance(ref.get("lyric"), str):
                skipped.append(f"第 {line['line']} 行第 {note['index']} 个")
                continue
            matched += 1
            updated = False
            for field in ("lyric", "lyric2", "lyric3"):
                if not isinstance(ref.get(field), str):
                    continue
                value = ref[field].strip()
                if str(note.get(field) or "") != value:
                    changes.append({"id": len(changes), "line_pos": line_pos, "note_pos": note_pos,
                                    "line": line["line"], "index": note["index"],
                                    "letter": note.get("letter", ""), "box": note.get("box"),
                                    "field": field, "before": str(note.get(field) or ""), "after": value})
                    updated = True
                    if value:
                        note[field] = value
                    else:
                        note.pop(field, None)
            changed += int(updated)
    if not matched:
        raise ValueError("没有找到足够可靠的位置匹配，未修改歌词。")
    result = {"matched": matched, "changed": changed, "skipped": skipped, "source": review.name}
    if preview:
        result.update(changes=changes, scale=payload.get("scale") or 1,
                      revision=hashlib.sha256(original).hexdigest(), table=str(table.resolve()))
    else:
        result["backup"] = _save_lyrics(table, original, payload) if changed else None
    return result


def _save_lyrics(table, original, payload):
    backup = Path(str(table) + ".before-lyrics-" + uuid.uuid4().hex[:12] + ".bak")
    backup.write_bytes(original)
    temporary = Path(str(table) + ".lyrics-tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, table)
    finally:
        temporary.unlink(missing_ok=True)
    return backup.name


def apply_lyrics(table, workdir, token, selected):
    if not isinstance(token, str) or len(token) != 12 or any(c not in "0123456789abcdef" for c in token):
        raise ValueError("歌词预览无效，请重新识别。")
    plan_file = Path(workdir) / ("lyrics_" + token) / "preview.json"
    if not plan_file.is_file():
        raise ValueError("歌词预览已失效，请重新识别。")
    plan = json.loads(plan_file.read_bytes())
    table = Path(table)
    original = table.read_bytes()
    if plan["table"] != str(table.resolve()) or plan["revision"] != hashlib.sha256(original).hexdigest():
        raise ValueError("曲谱数据已改变，请重新识别后再应用，未修改歌词。")
    valid = {c["id"] for c in plan["changes"]}
    if (not isinstance(selected, list) or not selected
            or any(type(i) is not int or i not in valid for i in selected)
            or len(set(selected)) != len(selected)):
        raise ValueError("请选择有效的歌词修改。")
    payload = json.loads(original)
    for change in plan["changes"]:
        if change["id"] not in selected:
            continue
        note = payload["lines"][change["line_pos"]]["notes"][change["note_pos"]]
        if change["after"]:
            note[change["field"]] = change["after"]
        else:
            note.pop(change["field"], None)
    backup = _save_lyrics(table, original, payload)
    return {"changed": len(selected), "backup": backup}


def reread_lyrics(table, workdir):
    """读取原图运行本地 OCR，生成匹配可靠的歌词差异预览，不写入现有 JSON。"""
    import contextlib
    import io
    import jianpu_api
    from jianpu2letter import review_io

    table = Path(table)
    payload = json.loads(table.read_bytes())
    source = Path(payload.get("source") or "")
    if not source.is_file():
        raise ValueError("原谱图片不存在，请恢复 JSON 的 source 指向的图片。")
    # OCR 同时定位音符以对齐歌词；这些重新识别的音符不会覆盖人工编辑结果。
    with contextlib.redirect_stdout(io.StringIO()):
        measures = jianpu_api.ocr_jianpu.ocr_to_stream(
            str(source), debug_dir=None, measure_mode="vline", header_ocr=False)
    scale = float(jianpu_api.ocr_jianpu._LAST_SCALE or 1)
    work = Path(workdir) / ("lyrics_" + uuid.uuid4().hex[:12])
    work.mkdir(parents=True)
    review = work / "reread_review.json"
    review_io.save_review(str(review), measures, payload.get("title", ""),
                          payload.get("key", "1=C"), payload.get("meter", "4/4"),
                          source_image=str(source))
    donor = json.loads(review.read_bytes())
    # 识别尺度变化时，将新坐标换算到当前 JSON 的 box 坐标系。
    factor = float(payload.get("scale") or 1) / scale
    for line in donor["lines"]:
        for note in line["notes"]:
            note["source_x"] *= factor
    review.write_text(json.dumps(donor, ensure_ascii=False, indent=2), encoding="utf-8")
    result = sync_lyrics(table, review, preview=True)
    (work / "preview.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    result["token"] = work.name.removeprefix("lyrics_")
    return result
