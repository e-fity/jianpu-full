"""从 piano11 现成结果同步歌词；不重跑识别或修改音符。"""
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import uuid


def sync_lyrics(table, review):
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
    matched = changed = 0
    skipped = []
    for line, source_line in zip(payload["lines"], source_lines):
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
        for note in notes:
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
                    updated = True
                    if value:
                        note[field] = value
                    else:
                        note.pop(field, None)
            changed += int(updated)
    if not matched:
        raise ValueError("没有找到足够可靠的位置匹配，未修改歌词。")
    backup_name = None
    if changed:
        backup = Path(str(table) + ".before-lyrics-" + uuid.uuid4().hex[:12] + ".bak")
        backup.write_bytes(original)
        backup_name = backup.name
        temporary = Path(str(table) + ".lyrics-tmp")
        try:
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temporary, table)
        finally:
            temporary.unlink(missing_ok=True)
    return {"matched": matched, "changed": changed, "skipped": skipped,
            "backup": backup_name, "source": review.name}
