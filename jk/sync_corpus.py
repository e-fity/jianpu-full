# -*- coding: utf-8 -*-
"""把 out/ 里的曲目重跑一遍，同步到 `D:\\Letter piano11` **当前**的识别代码。

## 为什么需要它

识别代码在 piano11 里，产物在本工程的 `out/` 里 —— 两边没有版本绑定。
你改了 piano11 的 `ocr_jianpu.py` / `overlay_letters.py` 之后，`out/` 里**已有的产物不会跟着变**，
还是旧代码的结果（2026-09-29 就是这么发现的：48 处红框其实是旧判据的假警报）。
重跑一遍才能对上。OCR 本身是确定性的，所以重跑不会引入随机差异。

## 为什么不"只挑旧的出来跑"

试过按"缺 `box`/`q`/`scale` 字段"判新旧，但那只在**改数据格式**时有效；
你下次改判据（字段不变、结果变）它就完全看不出来。所以默认**全量重跑** ——
判别成本不可靠，重跑成本才是确定的。想省时间就传曲名只跑几首。

## 用法

    python sync_corpus.py              # 重跑 out/ 里全部曲目
    python sync_corpus.py 42 43        # 只重跑这两首
    python sync_corpus.py --dry-run    # 只核对依赖签名 + 列出会重跑什么，不动任何文件

会**覆盖** `out/<曲名>_overlay.png` 和 `_notes.json`（原图不动）。
"""

import argparse
import glob
import inspect
import json
import os
import shutil
import sys
import tempfile
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import jianpu_api  # noqa: E402

# 防御：如果别处（比如临时目录）有个同名的空目录抢先被解析成"命名空间包"，
# import 会**成功**但模块里什么都没有，报错信息很费解（踩过：module 'jianpu_api'
# has no attribute 'convert'）。这里直接说清楚。
if not getattr(jianpu_api, "convert", None):
    raise SystemExit(f"jianpu_api 解析到了错误的位置：{jianpu_api.__file__}\n"
                     f"（要的是 {os.path.join(HERE, 'jianpu_api.py')}）")

from jianpu2letter import mapping, ocr_jianpu, overlay_letters  # noqa: E402

LIB = os.path.join(HERE, "out")
NOTES_SUFFIX = "_notes.json"

# 本工程依赖 piano11 的那些调用。签名/存在性一变，这里立刻报警 ——
# 否则问题会以"字母画错位置""没认出数不对"这类现象在外面才暴露。
DEPS = [
    ("overlay_letters.render", lambda: str(inspect.signature(overlay_letters.render))),
    ("ocr_jianpu.ocr_to_stream", lambda: str(inspect.signature(ocr_jianpu.ocr_to_stream))),
    ("mapping.key_for", lambda: str(inspect.signature(mapping.key_for))),
    ("ocr_jianpu._LAST_SCALE", lambda: "在" if hasattr(ocr_jianpu, "_LAST_SCALE") else "没了"),
    ("ocr_jianpu._LAST_COLOR", lambda: "在" if hasattr(ocr_jianpu, "_LAST_COLOR") else "没了"),
    ("ocr_jianpu._LAST_BINARY", lambda: "在" if hasattr(ocr_jianpu, "_LAST_BINARY") else "没了"),
    ("ocr_jianpu._imread_unicode", lambda: "在" if hasattr(ocr_jianpu, "_imread_unicode") else "没了"),
]


def red_box_count(overlay_path):
    """数 overlay 上的红框个数（红框画的是纯红，数连通域就行）。

    这是**最省事的"结果有没有变"指标**：不用跑 OCR，只看图。
    但它数不到"表格里标红的没认出音"以外的信息，只是给个量级。
    """
    img = cv2.imread(overlay_path)
    if img is None:
        return None
    b, g, r = (img[:, :, i].astype(int) for i in range(3))
    red = ((b < 60) & (g < 60) & (r > 170)).astype(np.uint8)
    return cv2.connectedComponents(red)[0] - 1


def corpus():
    """扫 out/ 下所有产物，返回 [{base, source, notes_path, overlay_path}]。"""
    items = []
    for notes_path in sorted(glob.glob(os.path.join(LIB, "*" + NOTES_SUFFIX))):
        base = os.path.basename(notes_path)[:-len(NOTES_SUFFIX)]
        try:
            with open(notes_path, "r", encoding="utf-8") as fp:
                source = str(json.load(fp).get("source") or "")
        except (OSError, ValueError):
            print(f"  ! {base}: 读不了 {notes_path}，跳过")
            continue
        items.append({"base": base, "source": source,
                      "notes_path": notes_path,
                      "overlay_path": os.path.join(LIB, base + "_overlay.png")})
    return items


def check_deps():
    print("=== 依赖 piano11 的调用 ===")
    bad = 0
    for name, probe in DEPS:
        try:
            value = probe()
        except Exception as exc:  # noqa: BLE001
            value = f"★取不到：{type(exc).__name__}: {exc}"
            bad += 1
        if value == "没了":
            bad += 1
        print(f"  {name:<28} {value}")
    return bad


def convert_into(src, base, keep):
    """调 `convert()`，再把产物**按 `base` 命名**放进曲库。

    ⚠ **不能**直接 `convert(src, outdir=LIB)` —— 产物名取的是**源文件名**
    （`convert` 的约定），而网页上传的歌 `source` 指向 `web_out/<id>/upload.*`，
    名字会变成 `upload`：于是**写错文件**（覆盖 `out/upload_*`，自己那首反而不更新，
    mtime 都不动）。2026-09-29 踩到：17 首里有 3 首（source 指向 web_out 的）
    歌词一直是 0，查了半天是这里。

    先写到临时目录再按 base 复制过去 —— 和网页 `/api/convert` 那边的做法一致。
    """
    tmp = tempfile.mkdtemp(prefix="jksync_")
    try:
        overlay, table, payload = jianpu_api.convert(src, outdir=tmp, **keep)
        shutil.copyfile(overlay, os.path.join(LIB, base + "_overlay.png"))
        shutil.copyfile(table, os.path.join(LIB, base + NOTES_SUFFIX))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description="把 out/ 里的曲目重跑一遍，同步到当前识别代码。")
    parser.add_argument("names", nargs="*", help="只重跑这几首（不传=全部）")
    parser.add_argument("--dry-run", action="store_true", help="只看会做什么，不动文件")
    args = parser.parse_args(argv)

    if not os.path.isdir(LIB):
        raise SystemExit(f"没有曲库目录：{LIB}")

    check_deps()
    print()

    items = corpus()
    if args.names:
        wanted = set(args.names)
        missing = wanted - {it["base"] for it in items}
        if missing:
            print("曲库里没有：", "、".join(sorted(missing)))
        items = [it for it in items if it["base"] in wanted]

    runnable = [it for it in items if os.path.isfile(it["source"])]
    skipped = [it for it in items if not os.path.isfile(it["source"])]
    print(f"=== 曲库 {len(items)} 首：能重跑 {len(runnable)}，原图找不到 {len(skipped)} ===")
    for it in skipped:
        print(f"  ! {it['base']}: 原图不在 {it['source']}（跳过，产物保持原样）")
    if args.dry_run:
        for it in runnable:
            print(f"  会重跑 {it['base']}  <- {it['source']}")
        print("\n（--dry-run：没有动任何文件）")
        return 0

    print()
    started = time.time()
    changed = 0
    for it in runnable:
        before = red_box_count(it["overlay_path"])
        # 先把**手填的 4 项**读出来，重跑时传回去 —— 否则识别只产「页眉读到的曲名/调号」
        # 和「默认 4/4、100」，你填的 J 就被盖成 100 了（静默丢数据）。
        # 规则和网页上传那边一致：已存的优先于自动/默认；tempo 只在原来源是 manual
        # 时才沿用，免得把「默认 100」误标成「人工填的」。
        old = {}
        try:
            with open(it["notes_path"], "r", encoding="utf-8") as fp:
                old = json.load(fp)
        except (OSError, ValueError):
            old = {}
        keep = {k: old.get(k) for k in ("title", "key", "meter")}
        if old.get("tempo_source") == "manual":
            keep["tempo"] = old.get("tempo_qpm")
        try:
            convert_into(it["source"], it["base"], keep)
        except Exception as exc:  # noqa: BLE001 —— 一张失败不该中断整批
            print(f"  {it['base']:<6} ★失败: {type(exc).__name__}: {exc}")
            continue
        with open(it["notes_path"], "r", encoding="utf-8") as fp:
            counts = json.load(fp)["counts"]
        after = red_box_count(it["overlay_path"])
        mark = ""
        if before is not None and after is not None and before != after:
            mark = "  ← 变了"
            changed += 1
        print(f"  {it['base']:<6} %5.1fs  音数{counts['total']:>4}  "
              f"没认出{counts['unknown']:>3}  红框 {before} -> {after}{mark}"
              % (time.time() - started))

    print(f"\n完成：重跑 {len(runnable)} 首，其中红框数变化 {changed} 首，"
          f"总耗时 {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
