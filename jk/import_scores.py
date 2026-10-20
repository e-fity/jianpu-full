# -*- coding: utf-8 -*-
"""把目标网站的 57 首主歌单谱面 + 两件采样音源搬到本地。

    python import_scores.py --dry-run     # 只列清单，不写文件
    python import_scores.py               # 真下载（已存在且校验通过就跳过）
    python import_scores.py --force       # 全部重下

产物：
    scores/<id>.json         57 首简谱（jianpu-score-json，原样保存）
    scores/manifest.json     导入清单（sha256 / 来源 URL / 时间）
    web/audio/*.wav          古筝、竹笛两件真实采样

设计要点：
- 歌单从 game.js 的 SONGS 段解析，**保留 site id** —— 播放器 routeFor() 靠 id 认
  反复规则，改 id 会让《早安隆回》这类曲子只播一遍。
- 只取主音乐馆前 57 首；后面 26 首是小学生馆，本期不搬。
- 全部幂等：重复跑不会产生重复文件。
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# Windows 控制台默认 GBK：中文会乱码、♩ 这类符号直接抛 UnicodeEncodeError。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                  # noqa: BLE001 —— 老版本/重定向忽略
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
SCORES = os.path.join(HERE, "scores")
AUDIO = os.path.join(HERE, "web", "audio")

DEFAULT_BASE = "https://letterpianoygx260910.z7.web.core.windows.net/"
MAIN_COUNT = 57
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LetterPiano-import/1.0"


def fetch(url, binary=False, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    return data if binary else data.decode("utf-8")


def parse_songs(source):
    """按出现顺序解析 game.js 里的 SONGS 条目。"""
    entries = []
    pattern = re.compile(r'^  (\w+): \{\n(.*?)^  \},?$', re.S | re.M)
    for match in pattern.finditer(source):
        body = match.group(2)

        def text(name):
            found = re.search(r'%s:\s*"([^"]*)"' % name, body)
            return found.group(1) if found else None

        def number(name):
            found = re.search(r'%s:\s*(\d+)' % name, body)
            return int(found.group(1)) if found else None

        title, filename = text("title"), text("file")
        if not (title and filename):
            continue                      # 不是歌曲条目（别的对象），跳过
        entries.append({
            "id": match.group(1),
            "title": title,
            "file": filename,
            "tonic_midi": number("tonicMidi"),
            "tempo_qpm": number("tempoQpm"),
        })
    return entries


def parse_audio(source):
    """game.js 里的采样音源（古筝 / 竹笛）。"""
    found = re.findall(r'url:\s*"(audio/[^"?]+)', source)
    return sorted(set(found))


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fp:
        fp.write(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description="导入 57 首谱面与采样音源")
    parser.add_argument("--base-url", default=DEFAULT_BASE)
    parser.add_argument("--dry-run", action="store_true", help="只列清单")
    parser.add_argument("--force", action="store_true", help="已有文件也重下")
    parser.add_argument("--limit", type=int, default=MAIN_COUNT,
                        help="只导前 N 首（调试用）")
    args = parser.parse_args(argv)

    print("读取歌单：%sgame.js" % args.base_url)
    source = fetch(args.base_url + "game.js")
    songs = parse_songs(source)
    audio = parse_audio(source)
    if not songs:
        print("没解析出歌单，game.js 结构可能变了。", file=sys.stderr)
        return 1

    # 主歌单到 haiyuni 为止；找不到就用前 N 首
    ids = [song["id"] for song in songs]
    main = songs[:ids.index("haiyuni") + 1] if "haiyuni" in ids else songs[:MAIN_COUNT]
    main = main[:args.limit]
    print("解析到 %d 首，主歌单 %d 首；采样 %d 件" % (len(songs), len(main), len(audio)))

    if args.dry_run:
        for index, song in enumerate(main, 1):
            print("%02d  %-14s %-12s 1=%s  BPM=%s" % (
                index, song["id"], song["title"],
                song["tonic_midi"], song["tempo_qpm"]))
        for name in audio:
            print("audio  %s" % name)
        print("\n（--dry-run：没有写任何文件）")
        return 0

    os.makedirs(SCORES, exist_ok=True)
    manifest_path = os.path.join(SCORES, "manifest.json")
    manifest = {"base_url": args.base_url, "imported_at": None, "songs": [], "audio": []}
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as fp:
                manifest = json.load(fp)
        except (OSError, ValueError):
            pass
    known = {item["id"]: item for item in manifest.get("songs", [])}
    errors = []

    for index, song in enumerate(main, 1):
        target = os.path.join(SCORES, song["id"] + ".json")
        url = args.base_url + urllib.parse.quote(song["file"])
        if os.path.isfile(target) and not args.force:
            record = known.get(song["id"])
            digest = sha256_of(target)
            if record and record.get("sha256") == digest:
                print("[%02d/%d] 跳过 %s（已是最新）" % (index, len(main), song["id"]))
                song.update(record)
                song["path"] = os.path.relpath(target, HERE)
                continue
        try:
            raw = fetch(url, binary=True)
            payload = json.loads(raw.decode("utf-8"))
            # 两种写法都见过：schema 是对象（jianpu-score-json）或字符串
            # （numberd-score/v1，6 首老谱面用这个）。播放器只读 measures/lyrics，
            # 所以这里只要求"有 schema、有非空 measures"。
            schema = payload.get("schema")
            schema_name = schema.get("name") if isinstance(schema, dict) else schema
            if not schema_name or not payload.get("measures"):
                raise ValueError("不是合法谱面（schema=%r, measures=%d）" % (
                    schema_name, len(payload.get("measures") or [])))
        except Exception as exc:                       # noqa: BLE001 —— 单首失败不拖垮整批
            message = "%s（%s）：%s" % (song["id"], song["file"], exc)
            print("[%02d/%d] 失败 %s" % (index, len(main), message))
            errors.append(message)
            continue
        if not args.force and os.path.isfile(target) and sha256_of(target) == hashlib.sha256(raw).hexdigest():
            print("[%02d/%d] 跳过 %s（内容相同）" % (index, len(main), song["id"]))
        else:
            save(target, raw)
            print("[%02d/%d] 下载 %s ← %s（%d KB）" % (
                index, len(main), song["id"], song["file"], len(raw) // 1024))
        song.update({
            "path": os.path.relpath(target, HERE),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "url": url,
        })
        manifest["songs"].append(song)

    os.makedirs(AUDIO, exist_ok=True)
    audio_records = []
    for name in audio:
        target = os.path.join(AUDIO, os.path.basename(name))
        if os.path.isfile(target) and not args.force:
            print("音频 跳过 %s（已存在）" % os.path.basename(name))
        else:
            raw = fetch(args.base_url + urllib.parse.quote(name), binary=True)
            save(target, raw)
            print("音频 下载 %s（%d KB）" % (os.path.basename(name), len(raw) // 1024))
        audio_records.append({
            "path": os.path.relpath(target, HERE),
            "bytes": os.path.getsize(target),
            "sha256": sha256_of(target),
            "url": args.base_url + urllib.parse.quote(name),
        })

    # 保序去重（重跑时同一个 id 不要出现两次）
    deduped, seen = [], set()
    for record in manifest["songs"]:
        if record["id"] in seen:
            continue
        seen.add(record["id"])
        deduped.append(record)
    manifest.update({
        "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "count": len(deduped),
        "songs": deduped,
        "audio": audio_records,
    })
    with open(manifest_path, "w", encoding="utf-8") as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=2)

    print("\n完成：%d 首入库，%d 件采样；清单 %s" % (
        len(deduped), len(audio_records), os.path.relpath(manifest_path, HERE)))
    if errors:
        print("失败 %d 首：" % len(errors), file=sys.stderr)
        for message in errors:
            print("  - %s" % message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
