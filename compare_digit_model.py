"""Run paired full-pipeline comparisons without enabling or deploying a model."""
import argparse
import contextlib
import csv
import hashlib
import io
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw
from jianpu2letter import ocr_jianpu as oj


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2,
                              default=lambda v: v.tolist() if hasattr(v, "tolist") else str(v)),
                    encoding="utf-8")


def index_notes(measures):
    result = {}
    row, number, previous = 0, 0, object()
    for measure in measures:
        if measure.get("row") != previous:
            row, number, previous = row + 1, 0, measure.get("row")
        for note in measure["notes"]:
            number += 1
            result[f"L{row:02d}N{number:03d}"] = note
    return result


def truth_score(notes, truth):
    by_box = {tuple(n["box"]): n for n in notes.values()}
    matches = [(box, label, by_box.get(box)) for box, label in truth.items()]
    return dict(total=len(matches),
                correct=sum(n is not None and n["n"] == label for _, label, n in matches),
                missing=sum(n is None for _, _, n in matches),
                errors=[dict(box=box, truth=label, prediction=n["n"] if n else None)
                        for box, label, n in matches if n is None or n["n"] != label])


def main(argv=None):
    parser = argparse.ArgumentParser(description="候选数字模型与当前识别流程逐图对比")
    parser.add_argument("--model", required=True)
    parser.add_argument("--dataset", required=True, help="包含 labels.csv 的样本目录")
    parser.add_argument("--images", nargs="+", required=True)
    parser.add_argument("-o", "--output", required=True)
    args = parser.parse_args(argv)
    output = Path(args.output)
    if output.exists():
        parser.error("输出目录已存在，请使用新目录")
    baseline_model = oj._load_digit_model() or False
    previous_env = os.environ.get("JIANPU_DIGIT_MODEL")
    os.environ["JIANPU_DIGIT_MODEL"] = str(Path(args.model).resolve())
    oj._DIGIT_MODEL = None
    candidate_model = oj._load_digit_model()
    if previous_env is None:
        os.environ.pop("JIANPU_DIGIT_MODEL", None)
    else:
        os.environ["JIANPU_DIGIT_MODEL"] = previous_env
    if not candidate_model:
        parser.error("候选模型未能加载")
    truth_by_source = {}
    with (Path(args.dataset)/"labels.csv").open(encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            truth_by_source.setdefault(row["source_sha256"], {})[
                tuple(int(row[k]) for k in ("x", "y", "w", "h"))] = int(row["label"])
    output.mkdir(parents=True)
    for name in ("before", "after", "changes"):
        (output/name).mkdir()
    report = dict(model=str(Path(args.model).resolve()), baseline_has_model=bool(baseline_model),
                  note="只有标注谱有真值分数；训练谱分数不代表泛化准确率。",
                  images=[])
    for position, path in enumerate(args.images, 1):
        path = Path(path)
        source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        truth = truth_by_source.get(source_hash, {})
        runs = []
        for mode, model in (("before", baseline_model), ("after", candidate_model)):
            print(f"[{position}/{len(args.images)}] {path.name} {mode}", flush=True)
            oj._DIGIT_MODEL = model
            log = io.StringIO()
            with contextlib.redirect_stdout(log):
                measures = oj.ocr_to_stream(str(path), header_ocr=False)
            (output/mode/(path.stem+".log")).write_text(log.getvalue(), encoding="utf-8")
            save_json(output/mode/(path.stem+".json"), measures)
            runs.append(measures)
        before, after = map(index_notes, runs)
        changes = []
        for note_id in sorted(before.keys() | after.keys()):
            a, b = before.get(note_id), after.get(note_id)
            fields = ["n", "o", "markup", "box", "lyric", "lyric2", "lyric3",
                      "slur_start", "slur_stop", "paren_before", "paren_after",
                      "accent", "triplet", "house", "house_start", "house_stop"]
            changed = fields if a is None or b is None else [f for f in fields if a.get(f) != b.get(f)]
            if changed:
                changes.append(dict(id=note_id, fields=changed, before=a, after=b))
        summary = dict(image=str(path), source_sha256=source_hash,
                       training_source=bool(truth),
                       before_rows=len({m["row"] for m in runs[0]}),
                       after_rows=len({m["row"] for m in runs[1]}),
                       before_notes=len(before), after_notes=len(after),
                       before_unknown=sum(n["n"] is None for n in before.values()),
                       after_unknown=sum(n["n"] is None for n in after.values()),
                       digit_changes=sum("n" in c["fields"] for c in changes),
                       other_changes=sum(any(f != "n" for f in c["fields"]) for c in changes),
                       measure_structure_changed=(
                           [{k:v for k,v in m.items() if k != "notes"} for m in runs[0]] !=
                           [{k:v for k,v in m.items() if k != "notes"} for m in runs[1]]))
        if truth:
            summary["before_truth"] = truth_score(before, truth)
            summary["after_truth"] = truth_score(after, truth)
        summary["changes"] = changes
        report["images"].append(summary)
        save_json(output/"report.json", report)
        print(json.dumps({k:v for k,v in summary.items() if k != "changes"}, ensure_ascii=False), flush=True)
        # Show actual source ink for every changed digit, never a redrawn prediction.
        digit_changes = [c for c in changes if "n" in c["fields"]]
        for offset in range(0, len(digit_changes), 60):
            batch = digit_changes[offset:offset+60]
            sheet = Image.new("RGB", (1200, ((len(batch)+7)//8)*140), "white")
            draw = ImageDraw.Draw(sheet)
            for i, change in enumerate(batch):
                note = change["after"] or change["before"]
                x, y, w, h = map(int, note["box"])
                height, width = oj._LAST_COLOR.shape[:2]
                crop = oj._LAST_COLOR[max(0,y-4):min(height,y+h+4),
                                      max(0,x-4):min(width,x+w+4), ::-1]
                image = Image.fromarray(crop)
                image.thumbnail((134, 88))
                left, top = i%8*150, i//8*140
                sheet.paste(image, (left+(150-image.width)//2,top+22))
                draw.text((left+5,top+3), change["id"], fill="black")
                a, b = change["before"], change["after"]
                draw.text((left+5,top+116), f"{a['n'] if a else '?'} -> {b['n'] if b else '?'}",fill="black")
            sheet.save(output/"changes"/f"{path.stem}_{offset//60+1:02d}.png")
    oj._DIGIT_MODEL = baseline_model
    print("[完成]", output/"report.json", flush=True)


if __name__ == "__main__":
    main()
