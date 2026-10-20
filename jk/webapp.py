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
from functools import wraps
from urllib.parse import quote
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_file, send_from_directory

import jianpu_api
import note_review
import lyric_sync

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
WORK = os.path.join(HERE, "web_out")
LIB = os.path.join(HERE, "out")          # 已识别转换好的曲库（选择页从这里读）
NOTES_SUFFIX = "_notes.json"
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp")
ID_RE = re.compile(r"[0-9a-f]{12}")

app = Flask(__name__)
# 参数表的键序是给人看的（板宽、板长、小球…），别让 jsonify 按字母重排
app.json.sort_keys = False

# jianpu_api 用的是 ocr_jianpu 的模块全局（底图、缩放倍数），**不是线程安全的**，
# 所以并发的识别请求必须排队。Flask 仍然 threaded=True —— 那样识别跑着的时候，
# 页面照样能取图和下载，不会整站卡住。
_RUN_LOCK = threading.Lock()
_EDIT_LOCK = threading.Lock()


def _serialize_edits(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        with _EDIT_LOCK:
            return func(*args, **kwargs)
    return wrapped


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
@_serialize_edits
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
@_serialize_edits
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


@app.get("/review/<base>")
def review_page(base):
    if base not in _song_index():
        return "曲库里没有这一首。", 404
    return send_from_directory(WEB, "review.html")


@app.route("/api/review/<base>", methods=["GET", "POST"])
@_serialize_edits
def api_review(base):
    if base not in _song_index():
        return _fail("曲库里没有这一首。", 404)
    table = os.path.join(LIB, base + NOTES_SUFFIX)
    overlay = os.path.join(LIB, base + "_overlay.png")
    try:
        if request.method == "POST":
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                return _fail("请求必须是 JSON 对象。")
            result = note_review.edit_note(table, overlay, data)
        else:
            result = note_review.read_review(table, overlay)
    except ValueError as exc:
        return _fail(str(exc))
    except OSError as exc:
        return _fail(f"读写曲谱失败：{exc}", 500)
    resp = jsonify({"ok": True, **result})
    resp.headers["Cache-Control"] = "no-store"
    return resp


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


@app.post("/api/lyrics/sync/<base>")
@_serialize_edits
def api_sync_lyrics(base):
    if base not in _song_index():
        return _fail("曲库里没有这一首。", 404)
    try:
        result = lyric_sync.sync_lyrics(
            os.path.join(LIB, base + NOTES_SUFFIX),
            os.path.join(jianpu_api.PIANO11, "out", base + "_review.json"))
    except ValueError as exc:
        return _fail(str(exc))
    except OSError as exc:
        return _fail(f"歌词同步读写失败：{exc}", 500)
    return jsonify({"ok": True, **result})


@app.post("/api/lyrics/apply/<base>")
@_serialize_edits
def api_apply_lyrics(base):
    if base not in _song_index():
        return _fail("曲目不存在。", 404)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _fail("请求格式不正确。", 400)
    try:
        result = lyric_sync.apply_lyrics(os.path.join(LIB, base + NOTES_SUFFIX), WORK,
                                         data.get("token"), data.get("selected"))
    except ValueError as exc:
        return _fail(str(exc), 400)
    except OSError as exc:
        return _fail(str(exc), 500)
    return jsonify(ok=True, **result)


@app.post("/api/lyrics/reread/<base>")
@_serialize_edits
def api_reread_lyrics(base):
    if base not in _song_index():
        return _fail("曲库里没有这一首。", 404)
    started = time.time()
    try:
        with _RUN_LOCK:
            result = lyric_sync.reread_lyrics(os.path.join(LIB, base + NOTES_SUFFIX), WORK)
    except ValueError as exc:
        return _fail(str(exc))
    except Exception as exc:
        return _fail(f"原谱歌词识别失败：{type(exc).__name__}: {exc}", 500)
    return jsonify({"ok": True, "seconds": round(time.time() - started, 1), **result})


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
VIDEO_SUFFIX = {"tiles": "_试演奏.mp4", "play": "_跟弹.mp4",
                "music-machine": "_小球弹跳.mp4"}
_RENDER = {"proc": None, "rid": None, "base": None, "title": "", "log": None,
           "out": None, "style": "tiles", "started": 0.0}
_RENDER_LOCK = threading.Lock()

# 这台机器上一次只跑一个渲染任务：曲库那个「生成视频」按钮和编辑页的导出
# 都开浏览器、都吃 GPU，同时跑会互相拖慢甚至把显存顶爆。两边的按钮各拿一个
# 自己的状态锁，这里再加一把**共用的**闸门，谁先来谁占，另一方拿到 409。
_GPU_LOCK = threading.Lock()


def _busy_render():
    """谁正占着渲染（编辑页导出 / 旧版生成视频）；空着返回 None。"""
    proc = _EXPORT["proc"]
    if proc is not None and proc.poll() is None:
        return "编辑页导出（%s）" % (_EXPORT["label"] or _EXPORT["rid"])
    proc = _RENDER["proc"]
    if proc is not None and proc.poll() is None:
        return "《%s》的生成视频" % (_RENDER["title"] or _RENDER["base"])
    return None


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

    with _GPU_LOCK, _RENDER_LOCK:
        proc = _RENDER["proc"]
        if proc is not None and proc.poll() is None:
            return _fail(f"已经在渲《{_RENDER['title'] or _RENDER['base']}》了，"
                         f"等它跑完再点。", 409)
        busy = _busy_render()
        if busy:
            return _fail(f"这台机器上已经有渲染在跑：{busy}，等它跑完再点。", 409)
        rid = uuid.uuid4().hex[:12]
        os.makedirs(WORK, exist_ok=True)
        log_path = os.path.join(WORK, "render_" + rid + ".log")
        out_path = _video_path(song["title"], style)
        if style == "music-machine":
            cmd = [sys.executable, "-u",
                   os.path.join(HERE, "ball3d", "make_realtime_video.py"),
                   "--input", os.path.join(LIB, base + NOTES_SUFFIX),
                   "--output", out_path, "--style", style, "--clean"]
        else:
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


# ── 3D 编辑页（小球视频：几何/视觉可调，同场景导出） ───────────────────
# 网页只负责「选歌 + 调参 + 预览 + 发起导出」，真正的帧还是 ball3d 里那套
# three.js + WebCodecs 渲染（同一 layout、同一 GLB、同一相机与绝对时间采样）。
BALL3D = os.path.join(HERE, "ball3d")
if BALL3D not in sys.path:
    sys.path.insert(0, BALL3D)
import editor_settings  # noqa: E402  （ball3d 里的设置校验，和 JS schema 同源）
import score as ball_score  # noqa: E402

EDITOR_OUT = os.path.join(BALL3D, "out", "web_editor")
EDITOR_RUNS = os.path.join(EDITOR_OUT, "runs")
EDITOR_IMPORTS = os.path.join(EDITOR_OUT, "imports")
EDITOR_SAVED = os.path.join(EDITOR_OUT, "settings")
EDITOR_AUDIO = os.path.join(EDITOR_OUT, "audio")
EDITOR_GLB = os.path.join(BALL3D, "assets", "reference_music_machine.glb")
EDITOR_LAYOUT_SRC = os.path.join(BALL3D, "realtime", "src", "layout.mjs")
EDITOR_BUNDLE = os.path.join(BALL3D, "realtime", "build", "editor.bundle.js")
EDITOR_LAYOUT_WORKER = os.path.join(BALL3D, "realtime", "build", "layout-worker.js")
EDITOR_CLI = os.path.join(BALL3D, "make_realtime_video.py")

# 一次只跑一个导出：进程、日志、目录都挂在 rid 上
_EXPORT = {"proc": None, "rid": None, "dir": None, "log": None, "out": None,
           "label": "", "started": 0.0, "settings": None, "video": None,
           "song": "", "state": "idle", "error": None, "timing": None}
_EXPORT_LOCK = threading.Lock()
NAME_RE = re.compile(r"[A-Za-z0-9_.-]{1,64}")
IMPORT_RE = re.compile(r"[0-9a-f]{16}")


def _node_exe():
    for cand in (os.environ.get("JPK_NODE"), "D:/node/node.exe", "node"):
        if not cand:
            continue
        if os.path.isabs(cand):
            if os.path.isfile(cand):
                return cand
            continue
        found = shutil.which(cand)
        if found:
            return found
    return "node"


def _run_logged(cmd, log_path, cwd=HERE):
    """起一个**隐藏窗口**的后台进程，stdout/stderr 进日志文件。"""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    with open(log_path, "wb") as log:
        log.write(("$ " + " ".join(cmd) + "\n").encode("utf-8"))
        log.flush()
        return subprocess.Popen(cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                                creationflags=flags)


def _json_object():
    """请求体必须是一个 JSON 对象；否则给 400 而不是 500。

    客户端发来 ``[1]``、``"hello"``、``{"base": ["10"]}`` 这类东西时，
    后面的 ``data.get(...)`` / ``dict(...)`` / 字典查找会直接抛异常并变成
    500「服务器错误」——那是客户端的错，应该说清楚。
    """
    data = request.get_json(silent=True)
    if data is None:
        return None, _fail("请求体必须是 JSON。")
    if not isinstance(data, dict):
        return None, _fail("请求体必须是一个 JSON 对象（收到 %s）。" % type(data).__name__)
    return data, None


# 浏览器那段渲染的预算：720x1280@30 的 10 秒片子在实测里约 60~100 秒，CLI 默认
# 只给 300 秒。1080x1920@60 的同样长度是它的 4.5 倍（像素 2.25x x 帧 2x），默认
# 值会把一个本来能跑完的任务掐死在中途。按 像素 x 帧数 线性放大，再留一倍余量。
_RENDER_BASELINE_FRAMES = 300.0                 # 720p30 x 10s
_RENDER_BASELINE_PIXELS = 720.0 * 1280.0
_RENDER_MIN_TIMEOUT = 300.0
_RENDER_MAX_TIMEOUT = 5400.0


def _render_timeout(video):
    """按请求的像素和帧数给浏览器渲染留时间（秒）。"""
    frames = video["frames"]
    pixels = float(video["width"]) * float(video["height"])
    scale = (pixels * frames) / (_RENDER_BASELINE_PIXELS * _RENDER_BASELINE_FRAMES)
    budget = _RENDER_MIN_TIMEOUT * 2.0 * scale           # x2 = 余量，不是估算值
    return float(min(_RENDER_MAX_TIMEOUT, max(_RENDER_MIN_TIMEOUT, budget)))


def _request_number(data, key, default):
    """请求里的数字：**给了就必须是有限数**，没给才用默认值。

    以前 export 会把 ``"abc"`` / ``null`` / ``NaN`` 悄悄折成默认值继续渲染，
    结果「点的是这一段、导的是另一段」。布尔（``true`` 在 Python 里就是 1）也
    不算数字，免得 ``seconds: true`` 变成 1 秒的片子。
    """
    if key not in data or data[key] is None:
        return default, None
    value = data[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)) \
            or not math.isfinite(value):
        return None, _fail("%s 必须是有限数字（收到 %r）。" % (key, value))
    return float(value), None


def _text_id(value, what):
    """可选的名字/编号参数：不是字符串就当它没给，绝不去哈希一个列表。"""
    if value is None:
        return None, None
    if not isinstance(value, str):
        return None, _fail("%s 必须是字符串。" % what)
    value = value.strip()
    return (value or None), None


def _song_notes_path(base=None, import_id=None):
    """曲库歌或导入 JSON 的实际路径（都先核对存在/格式，再拼路径）。"""
    if import_id:
        if not IMPORT_RE.fullmatch(str(import_id)):
            return None, "导入编号不合法。"
        path = os.path.join(EDITOR_IMPORTS, str(import_id) + ".json")
        return (path, None) if os.path.isfile(path) else (None, "这份导入已不在。")
    if base:
        if not isinstance(base, str) or base not in _song_index():
            return None, "曲库里没有这一首。"
        return os.path.join(LIB, base + NOTES_SUFFIX), None
    return None, "请先选一首歌，或导入一份 JSON。"


def _editor_plan(path, max_rest=0.0):
    """编辑页用的完整 plan：不截断（窗口由 start/seconds 单独描述）。"""
    sc = ball_score.load_score(path)
    return ball_score.build_plan(sc, max_rest=max_rest)


def _rest_limit(value):
    """0 .. 20 秒；0 / 非法值 = 不压缩长休止。"""
    try:
        limit = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(limit):
        return 0.0
    return max(0.0, min(20.0, limit))


@app.get("/editor")
def editor_page():
    return send_from_directory(WEB, "editor.html")


@app.get("/editor/bundle.js")
def editor_bundle():
    if not os.path.isfile(EDITOR_BUNDLE):
        return "编辑页前端还没构建：node realtime/build.mjs", 503
    resp = send_file(EDITOR_BUNDLE, mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/editor/layout-worker.js")
def editor_layout_worker():
    if not os.path.isfile(EDITOR_LAYOUT_WORKER):
        return "编辑页后台排版还没构建：node realtime/build.mjs", 503
    return send_file(EDITOR_LAYOUT_WORKER, mimetype="text/javascript")


@app.get("/editor/glb")
def editor_glb():
    if not os.path.isfile(EDITOR_GLB):
        return "缺少 assets/reference_music_machine.glb", 404
    return send_file(EDITOR_GLB, mimetype="model/gltf-binary", conditional=True)


EDITOR_PRESENTATION = os.path.join(BALL3D, "realtime", "config.json")


def _presentation_config(raw=None):
    with open(EDITOR_PRESENTATION, encoding="utf-8") as fp:
        current = json.load(fp)
    if raw is None:
        return current
    if not isinstance(raw, dict) or raw.keys() != current.keys():
        raise ValueError("视觉配置字段不完整")
    with open(os.path.join(BALL3D, "realtime", "presentation_limits.json"), encoding="utf-8") as fp:
        limits = json.load(fp)
    for group, fields in current.items():
        if not isinstance(raw[group], dict) or raw[group].keys() != fields.keys():
            raise ValueError("视觉配置字段不完整：" + group)
        for key, value in fields.items():
            given = raw[group][key]
            if isinstance(value, bool):
                valid = isinstance(given, bool)
            elif isinstance(value, (int, float)):
                valid = isinstance(given, (int, float)) and not isinstance(given, bool) and limits[key][0] <= given <= limits[key][1]
                if key in ("seed", "maxRails", "levelPhraseGap", "levelMaxNotes", "maxBoardsAcross", "samples", "glissMinNotes", "glissMaxSemitones", "integrationSteps", "solveIterations"):
                    valid = valid and int(given) == given
            elif key.endswith("Color"):
                valid = isinstance(given, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", given) is not None
            else:
                valid = given == value
            if not valid:
                raise ValueError("无效视觉参数：" + group + "." + key)
    return raw


@app.route("/api/editor/presentation", methods=["GET", "POST"])
def api_editor_presentation():
    try:
        value = _presentation_config(request.get_json() if request.method == "POST" else None)
        if request.method == "POST":
            with open(EDITOR_PRESENTATION, "w", encoding="utf-8") as fp:
                json.dump(value, fp, ensure_ascii=False, indent=2)
        return jsonify({"ok": True, "config": value})
    except (ValueError, TypeError) as exc:
        return _fail(str(exc))


@app.get("/editor/environment")
def editor_environment():
    name = _presentation_config()["environment"]["file"]
    return send_file(os.path.join(BALL3D, "assets", os.path.basename(name)), mimetype="application/octet-stream")


@app.get("/editor/layout.mjs")
def editor_layout_source():
    if not os.path.isfile(EDITOR_LAYOUT_SRC):
        return "缺少 realtime/src/layout.mjs", 404
    resp = send_file(EDITOR_LAYOUT_SRC, mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/editor/schema")
def api_editor_schema():
    try:
        return jsonify({"ok": True, "schema": editor_settings.schema(),
                        "defaults": editor_settings.defaults()})
    except editor_settings.SettingsError as exc:
        return _fail("；".join(exc.errors), 500)


@app.get("/api/editor/songs")
def api_editor_songs():
    songs = _song_index()
    out = []
    for base, song in sorted(songs.items(), key=lambda kv: kv[1].get("title") or kv[0]):
        counts = song.get("counts") or {}
        out.append({"base": base, "title": song.get("title") or base,
                    "tempo_qpm": song.get("tempo_qpm"),
                    # 曲库索引里音数在 letters（sounding 是 plan 那边的叫法）
                    "notes": counts.get("letters")})
    return jsonify({"ok": True, "songs": out})


@app.get("/api/editor/plan")
def api_editor_plan():
    path, err = _song_notes_path(request.args.get("base"),
                                 request.args.get("import"))
    if path is None:
        return _fail(err, 404)
    try:
        plan = _editor_plan(path, _rest_limit(request.args.get("max_rest")))
    except Exception as exc:                     # noqa: BLE001 - 曲谱本身有问题就直说
        return _fail("读谱失败：%s" % exc, 400)
    with open(path, "r", encoding="utf-8") as fp:
        head = json.load(fp)
    title = str(head.get("title") or "").strip() or os.path.splitext(
        os.path.basename(path))[0]
    return jsonify({"ok": True, "plan": plan, "title": title,
                    "duration": plan["duration"], "fps": plan["fps"],
                    "source": os.path.basename(path)})


@app.post("/api/editor/import")
def api_editor_import():
    raw = request.get_data(cache=False)
    if not raw:
        return _fail("没有收到文件内容。")
    if len(raw) > 4 * 1024 * 1024:
        return _fail("JSON 太大了（上限 4 MB）。", 413)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        return _fail("不是合法的 JSON：%s" % exc)
    if not isinstance(data, dict) or data.get("format") != "jianpu2letter-notes-v1":
        return _fail("格式不对：需要 jianpu2letter-notes-v1。")
    digest = hashlib.sha1(raw).hexdigest()[:16]
    os.makedirs(EDITOR_IMPORTS, exist_ok=True)
    dest = os.path.join(EDITOR_IMPORTS, digest + ".json")   # 内容定名，天然去重
    if not os.path.isfile(dest):
        with open(dest, "wb") as fp:
            fp.write(raw)
    try:
        sc = ball_score.load_score(dest)
    except Exception as exc:                     # noqa: BLE001
        if os.path.isfile(dest):
            os.remove(dest)
        return _fail("这份简谱读不了：%s" % exc, 400)
    return jsonify({"ok": True, "import": digest,
                    "title": (sc.get("title") or "").strip() or "导入的谱子",
                    "notes": len(sc["sounding"]),
                    "duration": sc["score_duration"]})


@app.post("/api/editor/solve")
def api_editor_solve():
    data, bad = _json_object()
    if bad:
        return bad
    base, bad = _text_id(data.get("base"), "base")
    if bad:
        return bad
    imp, bad = _text_id(data.get("import"), "import")
    if bad:
        return bad
    path, err = _song_notes_path(base, imp)
    if path is None:
        return _fail(err, 404)
    try:
        settings = editor_settings.normalize_settings(data.get("settings"))
    except editor_settings.SettingsError as exc:
        return jsonify({"ok": False, "error": "；".join(exc.errors),
                        "errors": exc.errors}), 400
    max_rest = _rest_limit(data.get("max_rest"))
    # 每个请求一个目录：两个求解撞在一起时谁也不会读到对方的 solve.json
    try:
        plan = _editor_plan(path, max_rest)
    except Exception as exc:                     # noqa: BLE001 - 曲谱本身有问题就直说
        return _fail("读谱失败：%s" % exc, 400)
    tmp = tempfile.mkdtemp(prefix="solve_", dir=EDITOR_RUNS)
    try:
        plan_path = os.path.join(tmp, "plan.json")
        settings_path = os.path.join(tmp, "settings.json")
        with open(plan_path, "w", encoding="utf-8") as fp:
            json.dump(plan, fp, ensure_ascii=False)
        with open(settings_path, "w", encoding="utf-8") as fp:
            json.dump(settings, fp, ensure_ascii=False)
        out_json = os.path.join(tmp, "solve.json")
        cmd = [_node_exe(), os.path.join(BALL3D, "realtime", "tools", "solve_layout.mjs"),
               "--plan", plan_path, "--settings", settings_path,
               "--json", out_json, "--quiet", "--config", EDITOR_PRESENTATION]
        try:
            proc = subprocess.run(cmd, capture_output=True, cwd=HERE, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return _fail("求解失败：%s" % exc, 500)
        if not os.path.isfile(out_json):
            return _fail("求解失败：%s" % proc.stderr.decode("utf-8", "replace")[-400:], 500)
        with open(out_json, "r", encoding="utf-8") as fp:
            result = json.load(fp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    result["ok"] = bool(proc.returncode == 0 and result.get("ok"))
    result["settings"] = settings
    return jsonify(result)


@app.post("/api/editor/export")
def api_editor_export():
    data, bad = _json_object()
    if bad:
        return bad
    base, bad = _text_id(data.get("base"), "base")
    if bad:
        return bad
    imp, bad = _text_id(data.get("import"), "import")
    if bad:
        return bad
    path, err = _song_notes_path(base, imp)
    if path is None:
        return _fail(err, 404)
    try:
        settings = editor_settings.normalize_settings(data.get("settings"))
    except editor_settings.SettingsError as exc:
        return jsonify({"ok": False, "error": "；".join(exc.errors),
                        "errors": exc.errors}), 400
    video_in = data.get("video")
    if video_in is None:
        video_in = {}
    if not isinstance(video_in, dict):
        return _fail("video 必须是一个 JSON 对象。")
    else:
        video_in = dict(video_in)
    label, bad = _text_id(data.get("label"), "label")
    if bad:
        return bad
    label = label or "sample"
    raw_presentation = data.get("presentation")
    max_rest = 0.0
    if isinstance(raw_presentation, dict) and isinstance(raw_presentation.get("spatial"), dict):
        max_rest = _rest_limit(raw_presentation["spatial"].get("maxRestSeconds"))
    try:
        plan = _editor_plan(path, max_rest)  # 曲长：整曲与样片都用它夹住窗口
    except Exception as exc:                 # noqa: BLE001
        return _fail("读谱失败：%s" % exc, 400)
    duration = float(plan["duration"])
    trimmed = False
    # 窗口的数字先说清楚：给了就必须是有限数。以前这里把 "abc"/null/NaN 悄悄
    # 当成 0 和 10 去渲染 —— 那是「导了另一段却说是你点的那段」，宁可报错。
    start, bad = _request_number(video_in, "start", 0.0)
    if bad:
        return bad
    asked, bad = _request_number(video_in, "seconds", 10.0)
    if bad:
        return bad
    if label == "song":                      # 整曲：从头到尾，长度由曲长决定
        video_in.update({"start": 0.0, "seconds": duration})
    else:
        # 短歌：样片不许超出曲子；起点不许被悄悄往前挪（点了哪就是哪）
        video_in["start"] = start
        left = duration - start
        # 剩下正好 0.5s 也算数（和 normalize_video 的下限同一把尺子）
        if left < editor_settings.TIME_MIN_SECONDS - 1e-9:
            return _fail("这首歌在 %.2fs 之后没有内容了，往后拖一点再导出。" % start)
        video_in["seconds"] = min(asked, left)
        trimmed = bool(video_in["seconds"] < asked)
    try:
        video = editor_settings.normalize_video(video_in)
    except editor_settings.SettingsError as exc:
        return jsonify({"ok": False, "error": "；".join(exc.errors),
                        "errors": exc.errors}), 400

    with _GPU_LOCK, _EXPORT_LOCK:
        proc = _EXPORT["proc"]
        if proc is not None and proc.poll() is None:
            return _fail("已经有一个导出在跑（%s），等它结束或失败后再试。"
                         % (_EXPORT["label"] or _EXPORT["rid"]), 409)
        busy = _busy_render()
        if busy:
            return _fail("这台机器上已经有渲染在跑：%s，等它跑完再试。" % busy, 409)
        if not os.path.isfile(EDITOR_BUNDLE):
            return _fail("编辑页前端还没构建：node realtime/build.mjs", 503)
        rid = uuid.uuid4().hex[:12]
        run_dir = os.path.join(EDITOR_RUNS, rid)      # 每个任务一个唯一目录
        os.makedirs(run_dir, exist_ok=True)
        # 冻结这首歌：把曲谱复制进任务目录，之后曲库/导入文件怎么变都与它无关
        frozen_path = os.path.join(run_dir, os.path.basename(path))
        shutil.copyfile(path, frozen_path)
        with open(os.path.join(run_dir, "song.json"), "w", encoding="utf-8") as fp:
            json.dump({"source": os.path.basename(path), "frozen": frozen_path,
                       "base": base, "import": imp, "duration": duration,
                       "settings": settings, "video": video},
                      fp, ensure_ascii=False, indent=1)
        presentation_path = os.path.join(run_dir, "config.json")
        try:
            presentation = _presentation_config(data.get("presentation"))
        except (ValueError, TypeError) as exc:
            return _fail(str(exc))
        with open(presentation_path, "w", encoding="utf-8") as fp:
            json.dump(presentation, fp, ensure_ascii=False, indent=2)
        settings_path = os.path.join(run_dir, "settings.json")
        out_path = os.path.join(run_dir, "clip.mp4")
        log_path = os.path.join(run_dir, "render.log")
        with open(settings_path, "w", encoding="utf-8") as fp:
            json.dump(settings, fp, ensure_ascii=False, indent=1)
        cmd = [sys.executable, "-u", EDITOR_CLI,
               "--input", frozen_path, "--output", out_path, "--style", "music-machine",
               "--settings", settings_path, "--config", presentation_path,
               "--start", repr(float(video["start"])),
               "--seconds", repr(float(video["seconds"])),
               "--width", str(video["width"]), "--height", str(video["height"]),
               "--fps", str(video["fps"]), "--bitrate", str(video["bitrate"]),
               "--max-rest", repr(max_rest),
               "--timeout", repr(_render_timeout(video)),
               "--node", _node_exe(),
               "--timing", os.path.join(run_dir, "timing.json")]
        qa = data.get("qa_frames")
        if isinstance(qa, list):
            frames = [int(v) for v in qa
                      if isinstance(v, int) and not isinstance(v, bool)
                      and 0 <= v < video["frames"]]
            if frames:
                cmd += ["--qa-frames", ",".join(str(v) for v in frames)]
        _EXPORT.update({"proc": _run_logged(cmd, log_path), "rid": rid,
                        "dir": run_dir, "log": log_path, "out": out_path,
                        "label": label, "started": time.time(),
                        "settings": settings, "video": video,
                        "song": os.path.basename(path),
                        "state": "running", "error": None, "timing": None, "rendered_frames": 0})
    return jsonify({"ok": True, "rid": rid, "video": video,
                    "start": video["start"], "seconds": video["seconds"],
                    "trimmed": trimmed,
                    "out": os.path.relpath(out_path, HERE).replace("\\", "/")})


def _editor_export_progress(state, video, lines, previous=0):
    total = video["frames"]
    frames = previous
    for line in lines:
        match = re.search(r"\[realtime\] frame (\d+)/(\d+)", line)
        if match and int(match[2]) == total:
            frames = max(frames, min(total, int(match[1])))
    stage = "准备渲染" if not frames else "逐帧渲染"
    if frames == total:
        stage = "合成与校验"
    percent = min(99, round(100 * frames / total, 1))
    if state == "done":
        frames, percent, stage = total, 100, "渲染完成"
    elif state == "failed":
        stage = "渲染失败"
    return {"percent": percent, "stage": stage, "completed": frames, "total": total}


@app.get("/api/editor/export/<rid>")
def api_editor_export_status(rid):
    if not ID_RE.fullmatch(rid):
        return _fail("编号不合法。", 404)
    with _EXPORT_LOCK:
        if _EXPORT["rid"] != rid:
            return _fail("没有这个导出任务。", 404)
        proc = _EXPORT["proc"]
        if proc is not None and _EXPORT["state"] == "running":
            code = proc.poll()
            if code is None:
                _EXPORT["state"] = "running"
            elif code == 0 and os.path.isfile(_EXPORT["out"]):
                _EXPORT["state"] = "done"
            else:
                _EXPORT["state"] = "failed"
                _EXPORT["error"] = "渲染进程退出码 %s，见日志。" % code
        if _EXPORT["state"] == "done" and _EXPORT["timing"] is None:
            timing = os.path.join(_EXPORT["dir"], "timing.json")
            if os.path.isfile(timing):
                with open(timing, "r", encoding="utf-8") as fp:
                    _EXPORT["timing"] = json.load(fp)
        lines = _log_tail(_EXPORT["log"], 64)
        progress = _editor_export_progress(_EXPORT["state"], _EXPORT["video"], lines,
                                           _EXPORT.get("rendered_frames", 0))
        _EXPORT["rendered_frames"] = progress["completed"]
        info = {
            "ok": True, "rid": rid, "state": _EXPORT["state"], "error": _EXPORT["error"],
            "label": _EXPORT["label"], "song": _EXPORT["song"],
            "video": _EXPORT["video"], "settings": _EXPORT["settings"],
            "elapsed": round(time.time() - _EXPORT["started"], 1),
            "log_tail": lines[-8:], "progress": progress,
        }
        out = _EXPORT["out"]
        if _EXPORT["state"] == "done" and out and os.path.isfile(out):
            info["bytes"] = os.path.getsize(out)
            info["file"] = "/api/editor/export/%s/file" % rid
            timing = _EXPORT["timing"] or {}
            info["frames"] = timing.get("frames")
            info["decoded_frames"] = timing.get("decoded_frames")
            info["seconds"] = timing.get("clip_seconds") or timing.get("seconds")
            info["start"] = timing.get("start")
            info["timing_ms"] = (timing.get("cli_ms") or {}).get("total")
    return jsonify(info)


@app.get("/api/editor/export/<rid>/file")
def api_editor_export_file(rid):
    """完成才给文件；失败/进行中绝不回退到旧视频。"""
    if not ID_RE.fullmatch(rid):
        return _fail("编号不合法。", 404)
    with _EXPORT_LOCK:
        if _EXPORT["rid"] != rid:
            return _fail("没有这个导出任务。", 404)
        state, path = _EXPORT["state"], _EXPORT["out"]
        if state != "done" or not path or not os.path.isfile(path):
            return _fail("这次导出还没有完成。", 409)
        name = "%s_%s_%s.mp4" % (_EXPORT["song"].replace("_notes.json", ""),
                                 _EXPORT["label"], rid)
    return send_file(path, download_name=name, conditional=True)


# ── 设置（外观/几何）的保存、下载、导入 ────────────────────────────────
# 名字给人看（中文也行），文件名是它的 sha1：这样「视角 1」这样的名字既能显示
# 又不会变成路径。JSON 既能整份下载带走，也能再导入回来。
SAVE_NAME_MAX = 40


def _save_name(raw):
    """Return (display_name, error)."""
    if not isinstance(raw, str):
        return None, "设置名字必须是字符串。"
    name = " ".join(raw.split())
    if not name:
        return None, "请给这份设置起个名字。"
    if len(name) > SAVE_NAME_MAX:
        return None, "设置名字太长了（上限 %d 个字）。" % SAVE_NAME_MAX
    if name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
        return None, "设置名字里不能有斜杠。"
    return name, None


def _save_path(name):
    return os.path.join(EDITOR_SAVED, hashlib.sha1(name.encode("utf-8")).hexdigest()[:16] + ".json")


def _saved_names():
    os.makedirs(EDITOR_SAVED, exist_ok=True)
    out = []
    for entry in glob.glob(os.path.join(EDITOR_SAVED, "*.json")):
        try:
            with open(entry, "r", encoding="utf-8") as fp:
                head = json.load(fp)
        except (OSError, ValueError):
            continue
        name = head.get("name") if isinstance(head, dict) else None
        if isinstance(name, str) and name:
            out.append(name)
    return out


@app.post("/api/editor/frame")
def api_editor_frame():
    """浏览器预览页送来的 PNG（同设置/同绝对时间/同分辨率的对比图）。"""
    name = request.args.get("name") or "preview_frame"
    if not NAME_RE.fullmatch(name):
        return _fail("图片名不合法。")
    blob = request.get_data(cache=False)
    if not blob or not blob.startswith(b"\x89PNG"):
        return _fail("不是 PNG 数据。")
    if len(blob) > 24 * 1024 * 1024:
        return _fail("PNG 太大。", 413)
    os.makedirs(EDITOR_OUT, exist_ok=True)
    dest = os.path.join(EDITOR_OUT, name + ".png")
    with open(dest, "wb") as fp:
        fp.write(blob)
    return jsonify({"ok": True, "path": dest, "bytes": len(blob)})


@app.get("/api/editor/settings")
def api_editor_settings_list():
    return jsonify({"ok": True, "names": sorted(_saved_names())})


@app.get("/api/editor/settings/<path:name>/file")
def api_editor_settings_download(name):
    """整份 JSON 下载：带走一份能再导入回来的设置。"""
    name, err = _save_name(name)
    if err:
        return _fail(err, 404)
    path = _save_path(name)
    if not os.path.isfile(path):
        return _fail("没有这份设置。", 404)
    return send_file(path, mimetype="application/json",
                     download_name=name + ".json", as_attachment=True)


@app.get("/api/editor/settings/<path:name>")
def api_editor_settings_get(name):
    name, err = _save_name(name)
    if err:
        return _fail(err, 404)
    path = _save_path(name)
    if not os.path.isfile(path):
        return _fail("没有这份设置。", 404)
    with open(path, "r", encoding="utf-8") as fp:
        head = json.load(fp)
    return jsonify({"ok": True, "name": name, "settings": head.get("settings")})


@app.post("/api/editor/settings/<path:name>")
def api_editor_settings_put(name):
    """保存/导入：body 可以是 {"settings": {...}}，也可以是一份设置本体。"""
    name, err = _save_name(name)
    if err:
        return _fail(err)
    data, bad = _json_object()
    if bad:
        return bad
    payload = data.get("settings")
    if payload is None:
        payload = data                 # 导入：整份 JSON 就是设置本身
    try:
        settings = editor_settings.normalize_settings(payload)
    except editor_settings.SettingsError as exc:
        return jsonify({"ok": False, "error": "；".join(exc.errors),
                        "errors": exc.errors}), 400
    os.makedirs(EDITOR_SAVED, exist_ok=True)
    path = _save_path(name)
    with open(path, "w", encoding="utf-8") as fp:
        json.dump({"name": name, "settings": settings}, fp,
                  ensure_ascii=False, indent=1)
    return jsonify({"ok": True, "name": name, "path": path,
                    "file": "/api/editor/settings/%s/file" % quote(name)})


@app.get("/api/editor/audio")
def api_editor_audio():
    """试听用的合成旋律 WAV（和导出用的是同一个 audio.render）。"""
    path, err = _song_notes_path(request.args.get("base"), request.args.get("import"))
    if path is None:
        return _fail(err, 404)
    max_rest = _rest_limit(request.args.get("max_rest"))
    key = hashlib.sha1((os.path.abspath(path) + "|"
                        + str(os.path.getmtime(path)) + "|" + repr(max_rest)).encode("utf-8")).hexdigest()[:16]
    os.makedirs(EDITOR_AUDIO, exist_ok=True)
    dest = os.path.join(EDITOR_AUDIO, key + ".wav")
    if not os.path.isfile(dest):
        import audio as ball_audio
        try:
            plan = _editor_plan(path, max_rest)
        except Exception as exc:                     # noqa: BLE001
            return _fail("读谱失败：%s" % exc, 400)
        tmp = dest + ".part"
        ball_audio.render_to_wav(plan, tmp)
        os.replace(tmp, dest)
    return send_file(dest, mimetype="audio/wav", conditional=True)


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
