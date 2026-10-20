"""ball3d CLI: JSON score -> a self-contained **2D layout preview** HTML.

    D:/python/python11/python.exe ball3d/make_layout_preview.py --help
    D:/python/python11/python.exe ball3d/make_layout_preview.py \
        --input D:/Downloads/10_notes.json \
        --output D:/Letter piano jk/ball3d/out/孤勇者_编排2d.html

The preview draws the **same** ``realtime/src/layout.mjs`` data the 3D scene
renders -- boards, hops, troughs, rows, rests and every channel's trigger
reason -- so the 2D schematic and the 3D device can never disagree about the
arrangement.  The page is bundled and the plan inlined by
``realtime/tools/preview_build.mjs`` (local esbuild), so the output opens
directly from disk with no server.

This CLI does not render video and does not touch the Blender path: it only
reuses ``score.build_plan`` for timing and geometry.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import make_ball_video as mbv  # noqa: E402
import score  # noqa: E402
from make_realtime_video import NodeMissing, find_node  # noqa: E402

REALTIME_DIR = os.path.join(HERE, "realtime")
PREVIEW_BUILD = os.path.join(REALTIME_DIR, "tools", "preview_build.mjs")
DEFAULT_OUT_DIR = os.path.join(HERE, "out")

EXIT_OK, EXIT_INPUT, EXIT_NO_TOOL = 0, 2, 3


def output_for(out_dir, input_path):
    base = os.path.splitext(os.path.basename(input_path))[0].replace("_notes", "")
    return os.path.join(out_dir, "%s_layout2d.html" % base)


def run(args):
    if not os.path.isfile(args.input):
        raise mbv.CliError("input not found: %r" % args.input)
    out = os.path.abspath(args.output)
    if mbv.same_path(args.input, out) or not out.lower().endswith(".html"):
        raise mbv.CliError("preview output must be a distinct .html file")

    sc = score.load_score(args.input)
    seconds = mbv.cap_seconds(args.seconds, mbv.natural_duration(sc, args.lead, args.tail))
    plan = score.build_plan(sc, lead=args.lead, tail=args.tail, fps=args.fps,
                            width=args.width, height=args.height, seconds=seconds)
    plan["visual_style"] = "music-machine"
    plan["layout_seed"] = int(args.seed)

    stem = os.path.splitext(os.path.basename(out))[0]
    work = mbv.make_work_dir(out, stem)
    plan_path = os.path.join(work, "plan.json")
    with open(plan_path, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)

    print("input      : %s" % args.input)
    print("title/key  : %s / %s" % (plan["title"] or "(untitled)", plan["key"]))
    print("score      : %d sounding + %d rests, %.3fs, %d lines"
          % (plan["counts"]["sounding"], plan["counts"]["rests"],
             plan["score_duration"], plan["counts"]["lines"]))
    print("plan       : %s" % plan_path)

    node = find_node(args.node)
    cmd = [node, PREVIEW_BUILD, "--plan", plan_path, "--out", out,
           "--seed", str(int(args.seed))]
    if args.minify:
        cmd.append("--minify")
    print("browser    : %s" % " ".join('"%s"' % c if " " in c else c for c in cmd))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        raise NodeMissing("cannot execute Node at %r" % node)
    except subprocess.CalledProcessError as exc:
        raise mbv.CliError("the 2D preview build failed (node exit code %s)"
                           % exc.returncode)

    if not args.keep_work:
        import shutil
        shutil.rmtree(work, ignore_errors=True)
    print("output     : %s" % out)
    return EXIT_OK


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="make_layout_preview.py",
        description="Build a self-contained 2D preview of the music-machine layout "
                    "for one score (same layout.mjs data as the 3D scene).")
    ap.add_argument("--input", "-i", required=True, help="input *_notes.json")
    ap.add_argument("--output", "-o",
                    help="output .html (default: ball3d/out/<name>_layout2d.html)")
    ap.add_argument("--out-dir", help="directory for the default output")
    ap.add_argument("--seconds", type=float, help="limit to the first N seconds")
    ap.add_argument("--seed", type=int, default=0,
                    help="extra layout seed (same input+seed -> same layout)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--width", type=int, default=720)
    ap.add_argument("--height", type=int, default=1280)
    ap.add_argument("--lead", type=float, default=1.2)
    ap.add_argument("--tail", type=float, default=1.1)
    ap.add_argument("--node", help="explicit node executable")
    ap.add_argument("--minify", action="store_true", help="minify the preview bundle")
    ap.add_argument("--keep-work", action="store_true",
                    help="keep the plan.json work directory")
    args = ap.parse_args(argv)

    out_dir = os.path.abspath(args.out_dir or DEFAULT_OUT_DIR)
    if not args.output:
        args.output = output_for(out_dir, args.input)
    try:
        return run(args)
    except NodeMissing as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_NO_TOOL
    except (mbv.CliError, score.ScoreError) as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_INPUT


if __name__ == "__main__":
    raise SystemExit(main())
