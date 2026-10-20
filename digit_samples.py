"""Prepare numbered digit crops and export only human-labelled training samples."""
import argparse
import csv
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")


def png_bytes(array):
    ok, encoded = cv2.imencode(".png", array)
    if not ok:
        raise ValueError("无法编码数字图片")
    return encoded.tobytes()


def write_bundle(image_path, output, measures, color, binary, scale):
    """Freeze OCR coordinates and crops; labels deliberately start unconfirmed."""
    image_path, output = Path(image_path).resolve(), Path(output)
    if output.exists():
        raise ValueError(f"标注目录已存在，不覆盖人工标注：{output}")
    source_hash = digest(image_path.read_bytes())
    records, crops = [], {}
    line, index, previous = 0, 0, object()
    height, width = binary.shape
    for measure in measures:
        if measure.get("row") != previous:
            line, index, previous = line + 1, 0, measure.get("row")
        for note in measure.get("notes", []):
            index += 1
            note_id = f"L{line:02d}N{index:03d}"
            box = note.get("box")
            if box is None or len(box) != 4:
                raise ValueError(f"{note_id} 缺少数字框，须从原图生成标注包")
            x, y, w, h = map(int, box)
            if min(x, y) < 0 or min(w, h) <= 0 or x+w > width or y+h > height:
                raise ValueError(f"{note_id} 数字框越界：{box}")
            crop = png_bytes(color[y:y+h, x:x+w])
            mask = png_bytes(binary[y:y+h, x:x+w])
            records.append(dict(id=note_id, prediction=(None if note.get("n") is None else int(note["n"])),
                                confidence=(None if note.get("conf") is None else float(note["conf"])),
                                box=[x, y, w, h], crop_sha256=digest(crop),
                                binary_sha256=digest(mask)))
            crops[note_id] = (crop, mask)
    if not records:
        raise ValueError("没有可标注的数字")
    output.mkdir(parents=True)
    for folder in ("digits", "binary", "sheets"):
        (output / folder).mkdir()
    for note_id, (crop, mask) in crops.items():
        (output / "digits" / f"{note_id}.png").write_bytes(crop)
        (output / "binary" / f"{note_id}.png").write_bytes(mask)
    manifest = dict(format="jianpu-digit-crops-v1",
                    source=dict(image=str(image_path), sha256=source_hash,
                                scale=float(scale), scaled_size=[width, height]),
                    notes=records)
    write_json(output / "manifest.json", manifest)
    write_json(output / "labels.json",
               dict(format="jianpu-digit-labels-v1", source_sha256=source_hash,
                    labels={r["id"]: None for r in records}))
    for start in range(0, len(records), 80):
        page = records[start:start+80]
        sheet = Image.new("RGB", (1200, ((len(page)+9)//10)*132), "white")
        draw = ImageDraw.Draw(sheet)
        for pos, record in enumerate(page):
            left, top = (pos % 10)*120, (pos // 10)*132
            conf = record["confidence"]
            suspect = record["prediction"] is None or conf is None or conf < .7
            draw.rectangle((left, top, left+119, top+131),
                           fill="#fff3bf" if suspect else "white", outline="#cccccc")
            with Image.open(output / "digits" / (record["id"]+".png")) as original:
                crop = original.convert("RGB")
            factor = min(100/crop.width, 78/crop.height, 2)
            crop = crop.resize((max(1, round(crop.width*factor)),
                                max(1, round(crop.height*factor))), Image.Resampling.NEAREST)
            sheet.paste(crop, (left+(120-crop.width)//2, top+22+(78-crop.height)//2))
            draw.text((left+7, top+5), record["id"], fill="black")
            guess = "?" if record["prediction"] is None else str(record["prediction"])
            draw.text((left+7, top+108), "OCR: "+guess, fill="black")
        sheet.save(output / "sheets" / f"{start//80+1:03d}.png")
    return manifest


def prepare(image_path, output):
    from jianpu2letter import ocr_jianpu
    if Path(output).exists():
        raise ValueError(f"标注目录已存在，不覆盖人工标注：{output}")
    measures = ocr_jianpu.ocr_to_stream(str(image_path), header_ocr=False)
    return write_bundle(image_path, output, measures, ocr_jianpu._LAST_COLOR,
                        ocr_jianpu._LAST_BINARY, ocr_jianpu._LAST_SCALE)


def collect_samples(label_paths):
    """Validate all inputs before writing; a null/skip label is never a target."""
    from jianpu2letter.ocr_jianpu import _shape_feature
    samples = {}
    for label_path in label_paths:
        label_path = Path(label_path)
        root = label_path.parent
        labels = json.loads(label_path.read_text(encoding="utf-8-sig"))
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8-sig"))
        if labels.get("format") != "jianpu-digit-labels-v1" or manifest.get("format") != "jianpu-digit-crops-v1":
            raise ValueError(f"不是数字标注包：{label_path}")
        source = manifest["source"]
        if labels.get("source_sha256") != source["sha256"]:
            raise ValueError(f"标签与原图不匹配：{label_path}")
        records = {r["id"]: r for r in manifest["notes"]}
        if len(records) != len(manifest["notes"]):
            raise ValueError("标注包有重复音符编号")
        for note_id, label in labels["labels"].items():
            if note_id not in records:
                raise ValueError(f"未知音符编号：{note_id}")
            if label is None or label == "skip":
                continue
            if type(label) is not int or not 0 <= label <= 7:
                raise ValueError(f"{note_id} 标签必须为整数 0～7、null 或 \"skip\"")
            record = records[note_id]
            if not (note_id.startswith("L") and all(c.isascii() and c.isalnum() for c in note_id)):
                raise ValueError(f"非法音符编号：{note_id}")
            crop = (root / "digits" / f"{note_id}.png").read_bytes()
            mask_bytes = (root / "binary" / f"{note_id}.png").read_bytes()
            if digest(crop) != record["crop_sha256"] or digest(mask_bytes) != record["binary_sha256"]:
                raise ValueError(f"{note_id} 小图已改变，请勿替换裁剪图片")
            mask = cv2.imdecode(np.frombuffer(mask_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)
            x, y, w, h = record["box"]
            if mask is None or mask.shape != (h, w):
                raise ValueError(f"{note_id} 图片尺寸与数字框不匹配")
            key = (source["sha256"], tuple(record["box"]))
            if key in samples:
                if samples[key]["label"] != label:
                    raise ValueError(f"{note_id} 同一数字图片存在冲突标签")
                continue
            sample_id = digest(json.dumps(key).encode("utf-8"))[:24]
            samples[key] = dict(
                id=sample_id, label=label, crop=crop, note_id=note_id,
                prediction=record["prediction"], source_image=source["image"],
                source_sha256=source["sha256"], scale=source["scale"],
                box=record["box"],
                feature=_shape_feature(dict(x=0, y=0, w=w, h=h), mask))
    if not samples:
        raise ValueError("没有已确认的标签；请先把 labels.json 中的 null 改为正确数字")
    return list(samples.values())


def export(label_paths, output):
    output = Path(output)
    if output.exists():
        raise ValueError(f"样本目录已存在，请使用新的输出目录：{output}")
    samples = collect_samples(label_paths)
    output.mkdir(parents=True)
    (output / "digits").mkdir()
    rows = []
    for sample in samples:
        relative = f"digits/{sample['id']}.png"
        (output / relative).write_bytes(sample["crop"])
        rows.append(dict(image=relative, label=sample["label"],
                         note_id=sample["note_id"], prediction=sample["prediction"],
                         source_image=sample["source_image"],
                         source_sha256=sample["source_sha256"], scale=sample["scale"],
                         **dict(zip(("x", "y", "w", "h"), sample["box"]))))
    with (output / "labels.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    np.savez_compressed(output / "samples.npz",
                        feats=np.stack([s["feature"] for s in samples]).astype(np.float32),
                        labels=np.array([s["label"] for s in samples], dtype=np.int16),
                        groups=np.array([s["source_sha256"] for s in samples]),
                        ids=np.array([s["id"] for s in samples]))
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description="数字纠错标注与训练样本提取")
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare", help="原图 → 数字小图、对照表和空白标签")
    prep.add_argument("image")
    prep.add_argument("-o", "--output", required=True)
    exp = commands.add_parser("export", help="只导出人工填写的数字标签")
    exp.add_argument("labels", nargs="+")
    exp.add_argument("-o", "--output", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare(args.image, args.output)
            print(f"[ok] {len(result['notes'])} 个数字待标注：{Path(args.output)/'labels.json'}")
            print(f"[查看小图] {Path(args.output)/'sheets'}")
        else:
            rows = export(args.labels, args.output)
            counts = {d: sum(r["label"] == d for r in rows) for d in range(8)}
            print(f"[ok] 已导出 {len(rows)} 个已确认样本：{args.output}")
            print(f"[数字分布] {counts}")
            print("samples.npz 是训练数据；尚未训练或替换识别模型。")
    except (ValueError, OSError, KeyError, TypeError) as exc:
        parser.exit(1, f"[错误] {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
