# -*- coding: utf-8 -*-
"""一张网页：传简谱图片进来，看识别结果（原位替换图 + 逐音对照表）。

    python webapp.py                # 默认 http://127.0.0.1:8010/
    python webapp.py --port 9000
    python webapp.py --debug        # 改前端代码自动生效

识别本身还是 `jianpu_api.convert()`，这里只做三件事：收图、落盘、把产物端出去。
产物按请求各自一个小目录（`web_out/<id>/`），互不覆盖，想留着就自己去那个目录拿。
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_file, send_from_directory

import jianpu_api

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
WORK = os.path.join(HERE, "web_out")
LIB = os.path.join(HERE, "out")          # 已识别转换好的曲库（选择页从这里读）
NOTES_SUFFIX = "_notes.json"
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp")
ID_RE = re.compile(r"[0-9a-f]{12}")

app = Flask(__name__)

# jianpu_api 用的是 ocr_jianpu 的模块全局（底图、缩放倍数），**不是线程安全的**，
# 所以并发的识别请求必须排队。Flask 仍然 threaded=True —— 那样识别跑着的时候，
# 页面照样能取图和下载，不会整站卡住。
_RUN_LOCK = threading.Lock()


def _fail(message, status=400):
    return jsonify({"ok": False, "error": message}), status


@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.after_request
def _no_cache_pages(resp):
    """页面本身**不许缓存**（HTML/JS/CSS）。

    为什么必须有这条：`send_from_directory` 只给 `Last-Modified`，浏览器会用**启发式**
    规则自己决定缓存多久（大约"距上次修改时间的 10%"），期间**连 revalidate 都不做**。
    于是你改了页面 JS、刷新、看起来"加载了"，但浏览器跑的还是旧逻辑。

    2026-09-29 踩到：视频的防缓存（URL 挂时间戳）是**页面 JS 里**加的，
    而页面被缓存 → 新 JS 没生效 → 重渲完播放器还是**旧视频**，表现成
    "我重跑了但《孤勇者》试演奏还是没歌词"（文件其实是新的，抽帧验过）。

    `no-cache` = "用之前必须回来问一次"，便宜（304），不会每次都重传。
    """
    if resp.mimetype in ("text/html", "text/javascript", "application/javascript",
                         "text/css"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


def _form_meta(form):
    """从表单里取那 4 个可手填的字段（空字符串 = 没填，用自动/默认值）。"""
    def num(name):
        try:
            return float(form.get(name)) if form.get(name) else None
        except (TypeError, ValueError):
            return None

    return {
        "title": (form.get("title") or "").strip() or None,
        "key": (form.get("key") or "").strip() or None,
        "meter": (form.get("meter") or "").strip() or None,
        "tempo": num("tempo"),
    }


def _safe_stem(filename):
    """上传的文件名 → 曲库用的名字。只去路径危险字符，保留中文。"""
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    stem = re.sub(r'[\\/:*?"<>|]', "_", stem).strip()
    return stem or "upload"


@app.post("/api/convert")
def convert():
    upload = request.files.get("image")
    if upload is None or not upload.filename:
        return _fail("没有收到图片文件。")
    ext = os.path.splitext(upload.filename)[1].lower()
    if ext not in IMAGE_EXTS:
        return _fail(f"不认识 {ext or '（无扩展名）'} 这种文件，"
                     f"请传 {'、'.join(IMAGE_EXTS)}。")

    rid = uuid.uuid4().hex[:12]
    workdir = os.path.join(WORK, rid)
    os.makedirs(workdir, exist_ok=True)
    # 按**原文件名**存（只去掉路径危险字符），不要一律存成 `upload.<ext>`。
    # 为什么：`convert()` 读不到页眉标题时拿**文件名**兜底 —— 一律存成 upload 的话，
    # 曲名就变成 "upload"，而曲名又是**视频文件名** → 所有"页眉没标题"的歌都会
    # 叫 `upload_试演奏.mp4` 互相覆盖。`_safe_stem` 去掉路径危险字符，workdir 又是
    # 随机 uuid，所以这样存没有路径风险。
    stem = _safe_stem(upload.filename)
    src = os.path.join(workdir, stem + ext)
    upload.save(src)

    meta = _form_meta(request.form)

    # 曲库里已有这首 → 表单没填的字段**沿用已存的**。
    # 为什么：重传同一张图会重新识别，而识别只产 title/key（页眉）+ 默认 meter/tempo，
    # 于是你手填的曲名/调号/拍号/J 会被默认值盖掉 —— 属于静默丢数据。
    # 优先级：表单 > 已存的 > 自动/默认。tempo 只在原来是 manual 时才沿用，
    # 免得把"默认 100"误标成"人工填的"。
    old = {}
    old_path = os.path.join(LIB, stem + NOTES_SUFFIX)
    if os.path.isfile(old_path):
        try:
            with open(old_path, "r", encoding="utf-8") as fp:
                old = json.load(fp)
        except (OSError, ValueError):
            old = {}
    kept = []
    for field in ("title", "key", "meter"):
        if not meta[field] and old.get(field):
            meta[field] = old[field]
            kept.append(field)
    if meta["tempo"] is None and old.get("tempo_source") == "manual":
        meta["tempo"] = old.get("tempo_qpm")
        if meta["tempo"]:
            kept.append("tempo")

    started = time.time()
    try:
        with _RUN_LOCK:
            overlay, table, payload = jianpu_api.convert(
                src, outdir=workdir, title=meta["title"], key=meta["key"],
                meter=meta["meter"], tempo=meta["tempo"])
    except Exception as exc:  # noqa: BLE001 —— 读不成的图什么样都有，如实回报给页面
        shutil.rmtree(workdir, ignore_errors=True)
        return _fail(f"这张图没读成。{type(exc).__name__}: {exc}", 500)

    # 同时**存进曲库** `out/`：不然页面上改的 4 个字段只活在这个临时目录里，
    # 选择页和做视频都看不到（那"编辑"就没意义了）。名字取上传文件名的词干，
    # 所以再传一次同名文件是覆盖、不会堆重复。
    os.makedirs(LIB, exist_ok=True)
    shutil.copyfile(overlay, os.path.join(LIB, stem + "_overlay.png"))
    shutil.copyfile(table, os.path.join(LIB, stem + NOTES_SUFFIX))
    with open(os.path.join(LIB, stem + NOTES_SUFFIX), "r", encoding="utf-8") as fp:
        payload = json.load(fp)                     # 以落盘那份为准

    # 三个链接都指向**曲库那份**（`out/`），不指 web_out 的临时副本。
    # 踩过的坑：原先指 web_out，于是"在页面上改完 J 再点下载 JSON"拿到的是
    # 没改过的旧文件 —— 因为 /api/meta 改的是 out/ 那份。现在只有一份真相。
    return jsonify({
        "ok": True,
        "id": rid,
        "base": stem,
        "original_name": os.path.basename(upload.filename),
        "seconds": round(time.time() - started, 1),
        "title": payload["title"],
        "key": payload["key"],
        "meter": payload["meter"],
        "tempo_qpm": payload.get("tempo_qpm"),
        "tempo_source": payload.get("tempo_source"),
        "counts": payload["counts"],
        "lines": payload["lines"],
        "overlay_url": f"/library/img/{stem}/overlay",
        "source_url": f"/library/img/{stem}/original",
        "table_url": f"/library/notes/{stem}",
    })


@app.post("/api/meta")
def api_meta():
    """改曲名 / 调号 / 拍号 / 拍速 —— **只改这 4 个字段，不重跑 OCR**。

    为什么不用重跑：这 4 个都是顶层元数据，不参与识别。尤其**调号不影响字母** ——
    字母走的是 `mapping.key_for(n, o)`，那是「度数 → 键盘键」，和 1=C 还是 1=D 无关；
    调号只决定做视频时算出来的频率。所以改完立刻生效，不用等 40 秒。
    """
    data = request.get_json(silent=True) or {}
    base = str(data.get("base") or "")
    if base not in _song_index():                   # 核对过才拼路径 → 挡路径穿越
        return _fail("曲库里没有这一首。", 404)
    path = os.path.join(LIB, base + NOTES_SUFFIX)
    try:
        with open(path, "r", encoding="utf-8") as fp:
            payload = json.load(fp)
    except (OSError, ValueError) as exc:
        return _fail(f"读不了这份 JSON：{type(exc).__name__}: {exc}", 500)

    for field in ("title", "key", "meter"):
        value = str(data.get(field) or "").strip()
        if value:
            payload[field] = value
    raw = data.get("tempo_qpm")
    if raw not in (None, ""):
        try:
            tempo = float(raw)
        except (TypeError, ValueError):
            return _fail(f"拍速得是数字，收到 {raw!r}。")
        if not 20 <= tempo <= 400:
            return _fail(f"拍速 {tempo:g} 不合理（应在 20~400 之间）。")
        payload["tempo_qpm"] = tempo
        payload["tempo_source"] = "manual"

    with open(path, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)
        fp.write("\n")
    return jsonify({"ok": True, "song": _song_index()[base]})


@app.get("/files/<rid>/<name>")
def files(rid, name):
    if not ID_RE.fullmatch(rid):
        return "没有这个结果。", 404
    # send_from_directory 自己会挡住 `..` 之类的路径穿越，这里不用再拼字符串。
    return send_from_directory(os.path.join(WORK, rid), name)


# ── 选择页：列出已经识别转换好的曲目，选一首看结果 ──────────────────────────

def _song_index():
    """扫 `LIB` 下所有 `<名字>_notes.json`，返回 {名字: 曲目信息}。

    曲名、调号、拍号、音数都从那份 JSON 里读；原图路径取 JSON 的 `source`
    （那是识别时记下的绝对路径，可能已经不在了，所以要 isfile 检查）。
    """
    songs = {}
    for path in sorted(glob.glob(os.path.join(LIB, "*" + NOTES_SUFFIX))):
        base = os.path.basename(path)[:-len(NOTES_SUFFIX)]
        try:
            with open(path, "r", encoding="utf-8") as fp:
                payload = json.load(fp)
        except (OSError, ValueError):
            continue
        src = str(payload.get("source") or "")
        songs[base] = {
            "base": base,
            "title": payload.get("title") or base,
            "key": payload.get("key") or "",
            "meter": payload.get("meter") or "",
            "tempo_qpm": payload.get("tempo_qpm"),
            "tempo_source": payload.get("tempo_source") or "missing",
            "counts": payload.get("counts") or {},
            "has_original": bool(src) and os.path.isfile(src)
                            and os.path.splitext(src)[1].lower() in IMAGE_EXTS,
            "overlay_url": f"/library/img/{base}/overlay",
            "original_url": f"/library/img/{base}/original",
            "notes_url": f"/library/notes/{base}",
        }
    return songs


@app.get("/library")
def library():
    return send_from_directory(WEB, "library.html")


@app.get("/api/library")
def api_library():
    songs = _song_index()
    return jsonify({"ok": True, "songs": [songs[k] for k in sorted(songs)]})


@app.get("/library/img/<base>/<what>")
def library_img(base, what):
    # 先拿 base 去曲目表里**核对**，核不上就 404 —— 于是 base 永远拼不出路径穿越。
    song = _song_index().get(base)
    if song is None:
        return "曲库里没有这一首。", 404
    if what == "overlay":
        return send_file(os.path.join(LIB, base + "_overlay.png"))
    if what == "original":
        with open(os.path.join(LIB, base + NOTES_SUFFIX), "r", encoding="utf-8") as fp:
            src = str(json.load(fp).get("source") or "")
        if not (src and os.path.isfile(src)):
            return "原图不在原来的位置了（JSON 的 source 指向的路径已经不存在）。", 404
        return send_file(src)
    return "不认识的类型。", 404


@app.get("/library/notes/<base>")
def library_notes(base):
    if _song_index().get(base) is None:
        return "曲库里没有这一首。", 404
    return send_file(os.path.join(LIB, base + NOTES_SUFFIX), as_attachment=True,
                     download_name=base + NOTES_SUFFIX)


# ── 生成「试演奏」视频 ───────────────────────────────────────────────
# 一次要渲几百到几千帧、约 1~3 分钟，所以**不在请求里等**：起一个后台子进程，
# 页面轮询进度。这样失败了能看到日志尾巴，页面也不会干等到超时。
VIDEO_SUFFIX = {"tiles": "_试演奏.mp4", "play": "_跟弹.mp4"}
_RENDER = {"proc": None, "rid": None, "base": None, "title": "", "log": None,
           "out": None, "style": "tiles", "started": 0.0}
_RENDER_LOCK = threading.Lock()


def _video_path(title, style):
    """视频落在**工程根目录下的 `视频/`**（和命令行 `make_video.py` 的默认一致）。

    名字由这里算（不是让 make_video 自己取），且写/读两边都用这一个函数 ——
    否则两边各自 sanitize，规则一漂就找不到文件。
    ⚠ 子目录名必须和 `make_video.py` 里的 `VIDEO_DIR` 一致：那边写、这边读。
    """
    name = re.sub(r'[\\/:*?"<>|]', "_", str(title or "").strip()) or "未命名"
    return os.path.join(HERE, "视频", name + VIDEO_SUFFIX[style])


def _log_tail(path, lines=3):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fp:
            return [ln.rstrip() for ln in fp.readlines()[-lines:]]
    except OSError:
        return []


@app.post("/api/video")
def api_video_start():
    data = request.get_json(silent=True) or {}
    base = str(data.get("base") or "")
    style = str(data.get("style") or "tiles")
    if style not in VIDEO_SUFFIX:
        return _fail(f"不认识的风格 {style!r}。")
    song = _song_index().get(base)
    if song is None:
        return _fail("曲库里没有这一首。", 404)

    with _RENDER_LOCK:
        proc = _RENDER["proc"]
        if proc is not None and proc.poll() is None:
            return _fail(f"已经在渲《{_RENDER['title'] or _RENDER['base']}》了，"
                         f"等它跑完再点。", 409)
        rid = uuid.uuid4().hex[:12]
        os.makedirs(WORK, exist_ok=True)
        log_path = os.path.join(WORK, "render_" + rid + ".log")
        out_path = _video_path(song["title"], style)
        cmd = [sys.executable, os.path.join(HERE, "make_video.py"),
               os.path.join(LIB, base + NOTES_SUFFIX), "-o", out_path,
               "--style", style]
        with open(log_path, "wb") as log:
            log.write(("$ " + " ".join(cmd) + "\n").encode("utf-8"))
            log.flush()
            proc = subprocess.Popen(cmd, cwd=HERE, stdout=log,
                                    stderr=subprocess.STDOUT,
                                    env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        _RENDER.update({"proc": proc, "rid": rid, "base": base, "style": style,
                        "title": song["title"], "log": log_path,
                        "out": out_path, "started": time.time()})
    return jsonify({"ok": True, "rid": rid, "title": song["title"], "style": style,
                    "tempo_qpm": song.get("tempo_qpm")})


@app.get("/api/video/<rid>")
def api_video_status(rid):
    if not ID_RE.fullmatch(rid):
        return _fail("没有这个渲染任务。", 404)
    with _RENDER_LOCK:
        if _RENDER["rid"] != rid:
            return _fail("没有这个渲染任务了（服务重启过？重新点一次生成视频）。", 404)
        proc, log, out = _RENDER["proc"], _RENDER["log"], _RENDER["out"]
        base, title = _RENDER["base"], _RENDER["title"]
        style, started = _RENDER["style"], _RENDER["started"]
        code = proc.poll() if proc else None
    state = "running" if code is None else ("done" if code == 0 else "failed")
    payload = {
        "ok": True, "state": state, "title": title, "base": base, "style": style,
        "seconds": round(time.time() - started, 1),
        "log": _log_tail(log),
    }
    if state == "done" and os.path.isfile(out):
        payload["url"] = f"/video/{base}/{style}"
        payload["name"] = os.path.basename(out)
        payload["bytes"] = os.path.getsize(out)
    return jsonify(payload)


@app.get("/video/<base>/<style>")
def video_file(base, style):
    if style not in VIDEO_SUFFIX:
        return "不认识的风格。", 404
    song = _song_index().get(base)
    if song is None:
        return "曲库里没有这一首。", 404
    path = _video_path(song["title"], style)
    if not os.path.isfile(path):
        return "这首歌还没渲过这种视频（或文件被删了）。", 404
    # conditional=True 支持 Range 请求 —— <video> 拖动进度条要靠它
    return send_file(path, conditional=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="传简谱图片进来，看识别结果。")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--debug", action="store_true", help="改代码自动生效（调试用）")
    args = parser.parse_args(argv)

    os.makedirs(WORK, exist_ok=True)
    print(f"简谱认谱： http://{args.host}:{args.port}/    （结果落在 {WORK}）")
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
