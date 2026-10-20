"""ball3d CLI: JSON score -> the same plan and audio, rendered *without Blender*.

    D:/python/python11/python.exe ball3d/make_realtime_video.py --help
    D:/python/python11/python.exe ball3d/make_realtime_video.py \
        --input D:/Downloads/10_notes.json --seconds 10

``make_ball_video.py`` renders every frame in Blender/EEVEE.  This CLI renders
the identical plan in a browser instead: the same ``score.build_plan()``, the
same ``audio.render_to_wav()``, the same ``t = i / fps`` sampling, but the frames
come from a three.js scene encoded by WebCodecs (see ``realtime/README.md``).
The two renderers do **not** produce the same pixels -- the realtime look is a
faithful re-creation of the established style, not a copy of the Blender render
-- and no speed claim is made here: the timings this CLI prints (and writes to
``timing.json``) are the measurement.

Nothing in the Blender path is touched: ``score.py``, ``audio.py``,
``render_scene.py`` and ``make_ball_video.py`` are imported for their plans,
audio and validation only.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import audio  # noqa: E402
import score  # noqa: E402
import editor_settings  # noqa: E402
import make_ball_video as mbv  # noqa: E402
import spatial_acceptance  # noqa: E402

REALTIME_DIR = os.path.join(HERE, "realtime")
SESSION_SCRIPT = os.path.join(REALTIME_DIR, "export_session.mjs")
BUILD_SCRIPT = os.path.join(REALTIME_DIR, "build.mjs")
BUILD_DIR = os.path.join(REALTIME_DIR, "build")
DEFAULT_OUT_DIR = os.path.join(HERE, "out")

# 720x1280 is the realtime default (the Blender CLI defaults to 360x640).
DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_FPS = 720, 1280, 30
DEFAULT_BITRATE = 8_000_000        # H.264 ~8 Mbps, as asked for in the task
DEFAULT_TIMEOUT = 300.0            # seconds for the browser part of one job

EXIT_OK, EXIT_INPUT, EXIT_NO_TOOL, EXIT_SUBPROCESS = 0, 2, 3, 4


class NodeMissing(mbv.CliError):
    """Node or Edge could not be launched (exit code 3)."""


# --- tool discovery ----------------------------------------------------------

def node_candidates():
    out = []
    env = os.environ.get("JPK_NODE")
    if env:
        out.append(env)
    found = shutil.which("node")
    if found:
        out.append(found)
    for pattern in (r"C:\Program Files\nodejs\node.exe",
                    r"C:\Program Files (x86)\nodejs\node.exe",
                    r"D:\Program Files\nodejs\node.exe",
                    r"D:\node\node.exe",
                    r"D:\apps\node*\node.exe",
                    os.path.expanduser(r"~\AppData\Roaming\npm\node.exe"),
                    os.path.expanduser(r"~\scoop\apps\nodejs\*\node.exe")):
        out.append(pattern)
    for pattern in list(out):
        if "*" in pattern:
            out.extend(sorted(glob.glob(pattern), reverse=True))
    seen, uniq = set(), []
    for path in out:
        key = mbv.resolve(path)
        if key not in seen:
            seen.add(key)
            uniq.append(path)
    return uniq


def find_node(explicit):
    if explicit:
        if os.path.isfile(explicit):
            return explicit
        raise NodeMissing("--node %r does not exist" % explicit)
    for cand in node_candidates():
        if os.path.isfile(cand):
            return cand
    tried = "\n".join("    " + c for c in node_candidates()) or "    (nothing found)"
    raise NodeMissing("Node was not found.  Tried:\n%s\n"
                      "Pass --node \"C:\\path\\to\\node.exe\" or set JPK_NODE." % tried)


def check_realtime_install():
    """The browser bundle and its node_modules must be in place."""
    for path in (SESSION_SCRIPT, BUILD_SCRIPT):
        if not os.path.isfile(path):
            raise mbv.CliError("missing %r (is ball3d/realtime/ complete?)" % path)
    if not os.path.isdir(os.path.join(REALTIME_DIR, "node_modules")):
        raise mbv.CliError("ball3d/realtime/node_modules is missing: "
                           "run `npm install` in ball3d/realtime first")


# --- validation --------------------------------------------------------------

def validate_job(input_path, out_path, fps, width, height, seconds, lead, tail):
    """The same pre-flight checks as ``make_ball_video.validate_job``.

    Re-stated rather than reused because that one also validates EEVEE's
    ``--samples``, which the realtime renderer has no equivalent of; every other
    rule (input exists, output is a distinct .mp4, even dimensions for yuv420p,
    fps/duration positive) is identical.
    """
    if not input_path or not os.path.isfile(input_path):
        raise mbv.CliError("input not found: %r" % input_path)
    if not out_path:
        raise mbv.CliError("output path is empty")
    if os.path.splitext(out_path)[1].lower() != ".mp4":
        raise mbv.CliError("output must end in .mp4 (got %r)" % out_path)
    if mbv.same_path(input_path, out_path):
        raise mbv.CliError("refusing to overwrite the input file %r" % input_path)
    if os.path.isdir(out_path):
        raise mbv.CliError("output path %r is a directory" % out_path)

    fps = mbv._finite(fps, "--fps")
    if fps <= 0:
        raise mbv.CliError("--fps must be > 0 (got %r)" % fps)
    for name, value in (("--width", width), ("--height", height)):
        value = mbv._finite(value, name)
        if value <= 0:
            raise mbv.CliError("%s must be > 0 (got %r)" % (name, value))
        if int(value) % 2:
            raise mbv.CliError("%s must be even for yuv420p (got %d)" % (name, int(value)))
    if mbv._finite(lead, "--lead") < 0:
        raise mbv.CliError("--lead must be >= 0 (got %r)" % lead)
    if mbv._finite(tail, "--tail") < 0:
        raise mbv.CliError("--tail must be >= 0 (got %r)" % tail)
    if seconds is not None:
        seconds = mbv._finite(seconds, "--seconds")
        if seconds <= 0:
            raise mbv.CliError("--seconds must be > 0 (got %r)" % seconds)
    return True


def parse_qa_frames(text, frames_n):
    """``--qa-frames 0,150`` -> [0, 150]; never a frame sequence."""
    if not text:
        return []
    out = []
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            continue
        if not re.fullmatch(r"\d+", part):
            raise mbv.CliError("--qa-frames wants frame numbers, got %r" % part)
        index = int(part)
        if index >= frames_n:
            raise mbv.CliError("--qa-frames %d is past the last frame (%d)"
                               % (index, frames_n - 1))
        if index not in out:
            out.append(index)
    return out


# --- post-render verification ------------------------------------------------

def count_video_frames(ffmpeg, path):
    """Decode a video stream to nowhere and read ffmpeg's own frame counter.

    Returns ``None`` when the build of ffmpeg does not print a counter, so a
    logging difference can never fail a render that is otherwise complete.
    """
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "info", "-i", path,
           "-map", "0:v:0", "-f", "null", "-"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise mbv.CliError("ffmpeg could not decode %r" % path)
    text = proc.stderr.decode("utf-8", "replace")
    counts = [int(m) for m in re.findall(r"frame=\s*(\d+)", text)]
    return max(counts) if counts else None


def mux(ffmpeg, video, wav_path, out_path):
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
           "-i", video, "-i", wav_path, "-c:v", "copy", "-c:a", "aac",
           "-b:a", "160k", "-movflags", "+faststart", out_path]
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        raise mbv.CliError("cannot execute ffmpeg at %r" % ffmpeg)
    except subprocess.CalledProcessError as exc:
        raise mbv.CliError("ffmpeg failed with exit code %s" % exc.returncode)


# --- one video ---------------------------------------------------------------

def render_window_to_wav(plan, path, start, seconds):
    """The synthesised melody of ``[start, start+seconds)``.

    The window is cut by *sample index*, not by an ffmpeg seek, so the first
    exported frame and the first audio sample describe the same instant.
    """
    samples = audio.render(plan)
    rate = audio.SAMPLE_RATE
    first = int(round(start * rate))
    count = int(round(seconds * rate))
    window = samples[first:first + count]
    if window.size < count:                       # short tail: pad with silence
        pad = max(0, count - window.size)
        window = list(window) + [0.0] * pad
    audio.write_wav(path, window, rate)
    return path


def solve_gate(node, plan_path, settings_path, work, config_path=None):
    """Refuse to render a geometry whose trajectory does not solve.

    The same solver the page runs (realtime/src/layout.mjs, instantiated for the
    requested geometry) is executed here first: a failing config stops the job
    with its measured numbers instead of producing a video, or silently falling
    back to the default geometry.
    """
    tool = os.path.join(REALTIME_DIR, "tools", "solve_layout.mjs")
    solve_json = os.path.join(work, "solve.json")
    cmd = [node, tool, "--plan", plan_path, "--json", solve_json, "--quiet"]
    if settings_path:
        cmd += ["--settings", settings_path]
    if config_path:
        cmd += ["--config", os.path.abspath(config_path)]
    print("solve      : %s" % " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, cwd=HERE)
    text = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        detail = ""
        if os.path.isfile(solve_json):
            with open(solve_json, "r", encoding="utf-8") as fh:
                detail = json.dumps(json.load(fh).get("audit", {}), ensure_ascii=False)
        raise mbv.CliError(
            "this geometry does not solve for this song (exit %s): %s %s"
            % (proc.returncode, detail.strip(), text.strip()[-400:]))
    return solve_json


def run_job(args, input_path, out_path):
    started = time.time()
    if args.seconds is not None:
        mbv._finite(args.seconds, "--seconds")
        if args.seconds <= 0:
            raise mbv.CliError("--seconds must be > 0 (got %r)" % args.seconds)
    if not os.path.isfile(input_path):
        raise mbv.CliError("input not found: %r" % input_path)

    sc = score.load_score(input_path)

    # --- the editor snapshot: settings, window start, clip length ------------
    settings = None
    settings_path_in = os.path.abspath(args.settings) if args.settings else None
    if settings_path_in:
        try:
            with open(settings_path_in, "r", encoding="utf-8") as fh:
                settings = json.load(fh)
        except (OSError, ValueError) as exc:
            raise mbv.CliError("--settings %s: %s" % (settings_path_in, exc))
    try:
        settings = editor_settings.normalize_settings(settings)
    except editor_settings.SettingsError as exc:
        raise mbv.CliError("--settings rejected: %s" % exc)
    raw_start = getattr(args, "start", None)
    start = 0.0 if raw_start is None else float(raw_start)
    if not math.isfinite(start) or start < 0:
        raise mbv.CliError("--start must be a finite number >= 0 (got %r)" % raw_start)
    # A windowed job renders a slice of the *whole* plan, so the preview the
    # editor showed and the exported clip share one layout.
    windowed = raw_start is not None or settings_path_in is not None

    seconds = mbv.cap_seconds(args.seconds, mbv.natural_duration(sc, args.lead, args.tail))
    if args.seconds is not None and seconds < args.seconds:
        print("note       : --seconds %.3f capped to the score length %.3fs"
              % (args.seconds, seconds))

    validate_job(input_path, out_path, args.fps, args.width, args.height,
                 seconds, args.lead, args.tail)

    plan = score.build_plan(sc, lead=args.lead, tail=args.tail, fps=args.fps,
                            width=args.width, height=args.height,
                            seconds=None if windowed else seconds,
                            max_rest=args.max_rest)
    plan["visual_style"] = args.style
    fps = plan["fps"]
    clip_seconds = seconds if windowed else plan["duration"]
    if windowed and start + clip_seconds > plan["duration"] + 1e-6:
        raise mbv.CliError(
            "the window %.3f..%.3fs runs past the video length %.3fs"
            % (start, start + clip_seconds, plan["duration"]))
    frames_n = mbv.expected_frames(clip_seconds, fps)
    qa_frames = parse_qa_frames(args.qa_frames, frames_n)

    stem = os.path.splitext(os.path.basename(out_path))[0]
    work = mbv.make_work_dir(out_path, stem)
    plan_path = os.path.join(work, "plan.json")
    settings_path = os.path.join(work, "settings.json")
    wav_path = os.path.join(work, "audio.wav")
    browser_mp4 = os.path.join(work, "browser.mp4")
    node_json = os.path.join(work, "node.json")
    report_json = os.path.join(work, "report.json")
    timing_path = os.path.abspath(args.timing) if args.timing \
        else os.path.join(work, "timing.json")

    print("input      : %s" % input_path)
    print("renderer   : realtime (three.js + WebCodecs, no Blender)")
    print("title/key  : %s / %s (middle 1 = C = MIDI 60; this key puts 1 at MIDI %d)"
          % (plan["title"] or "(untitled)", plan["key"], 60 + plan["tonic_pc"]))
    print("score      : %d lines, %d events = %d sounding + %d rests, sum q=%g, "
          "tempo=%g qpm" % (plan["counts"]["lines"], plan["counts"]["events"],
                            plan["counts"]["sounding"], plan["counts"]["rests"],
                            plan["sum_q"], plan["tempo_qpm"]))
    print("timing     : score %.3fs, lead %.2fs, video %.3fs, window %.3f..%.3fs, "
          "%d frames @ %dfps %dx%d"
          % (plan["score_duration"], plan["lead"], plan["duration"], start,
             start + clip_seconds, frames_n, fps, plan["width"], plan["height"]))
    print("geometry   : board %.3fx%.3fx%.3f m, ball r %.3f, dx_min %.3f, bounce %.2f"
          % (settings["geometry"]["board_w"], settings["geometry"]["board_w"] * 0.2,
             settings["geometry"]["board_d"], settings["geometry"]["ball_r"],
             settings["geometry"]["spacing"], settings["geometry"]["bounce"]))
    print("work dir   : %s" % work)

    with open(plan_path, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)
    with open(settings_path, "w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False, indent=1)
    if windowed:
        render_window_to_wav(plan, wav_path, start, clip_seconds)
    else:
        audio.render_to_wav(plan, wav_path)
    print("plan/audio : %s\n             %s" % (plan_path, wav_path))
    print("settings   : %s" % settings_path)

    if args.plan_only:
        print("--plan-only: skipping the browser and ffmpeg")
        return EXIT_OK

    check_realtime_install()
    node = find_node(args.node)
    presentation_path = None
    if args.style == "music-machine":
        # The gate and browser must use the same g even if config is saved mid-export.
        source_config = getattr(args, "config", None) or os.path.join(REALTIME_DIR, "config.json")
        with open(source_config, encoding="utf-8") as fh:
            presentation = json.load(fh)
        presentation_path = os.path.join(work, "presentation.json")
        with open(presentation_path, "w", encoding="utf-8") as fh:
            json.dump(presentation, fh, ensure_ascii=False, indent=2)
        solved_path = solve_gate(node, plan_path, settings_path, work, presentation_path)
        with open(solved_path, encoding="utf-8") as fh:
            tracks = json.load(fh).get("audit", {}).get("tracks")
        if tracks and "gap_threshold" in tracks:
            print("tracks     : gap=%d, threshold=%.6fs, longest=%.6f board widths, unsafe candidates rejected=%s"
                  % (tracks["gap"], tracks["gap_threshold"], tracks["longest_widths"], tracks["rejected_unsafe"]))
        elif tracks:
            print("tracks     : long=%d, glissando=%d, carried=%d/%d (%.2f%%), longest=%.6f board widths, shortened=%d"
                  % (tracks["long"], tracks["glissando"], tracks["carried_notes"], tracks["total_notes"],
                     tracks["ratio"] * 100, tracks["longest_widths"], tracks["shortened"]))
    cmd = [node, SESSION_SCRIPT,
           "--plan", plan_path, "--out", browser_mp4,
           # repr() round-trips the double exactly, so Python and the page agree
           # on ceil(duration * fps) and therefore on the frame count.
           "--seconds", repr(float(clip_seconds)),
           "--start", repr(float(start)),
           "--settings", settings_path,
           "--width", str(int(plan["width"])), "--height", str(int(plan["height"])),
           "--fps", str(int(fps)),
           "--bitrate", str(int(args.bitrate)),
           "--timeout", repr(float(args.timeout)),
           "--json", node_json, "--report", report_json,
           "--dir", os.path.abspath(args.build_dir),
           "--channel", args.channel]
    if presentation_path or getattr(args, "config", None):
        cmd += ["--config", os.path.abspath(presentation_path or args.config)]
    if args.glb:
        cmd += ["--glb", os.path.abspath(args.glb)]
    if args.no_bloom:
        cmd.append("--no-bloom")
    if args.no_build:
        cmd.append("--no-build")
    if args.no_sandbox:
        cmd.append("--no-sandbox")
    if args.headful:
        cmd.append("--headful")
    if qa_frames:
        cmd += ["--qa-frames", ",".join(str(i) for i in qa_frames)]

    print("browser    : %s" % " ".join('"%s"' % c if " " in c else c for c in cmd))
    node_started = time.time()
    try:
        subprocess.run(cmd, check=True, timeout=args.timeout + 600.0)
    except FileNotFoundError:
        raise NodeMissing("cannot execute Node at %r" % node)
    except subprocess.TimeoutExpired:
        raise mbv.CliError("the browser session did not finish in %.0fs"
                           % (args.timeout + 600.0))
    except subprocess.CalledProcessError as exc:
        raise mbv.CliError(
            "the realtime render failed (node exit code %s); see the messages "
            "above (a missing Microsoft Edge shows up here too)" % exc.returncode)
    node_ms = (time.time() - node_started) * 1000.0

    if not os.path.isfile(node_json):
        raise mbv.CliError("the browser session wrote no %r" % node_json)
    with open(node_json, "r", encoding="utf-8") as fh:
        node_result = json.load(fh)
    if not node_result.get("ok"):
        raise mbv.CliError("the browser session reported: %s"
                           % node_result.get("error", "unknown failure"))

    # The page counted its frames and the orchestrator checked that count and
    # the uploaded byte count; here the file on disk is checked once more.
    size = os.path.getsize(browser_mp4)
    if size != node_result.get("bytes"):
        raise mbv.CliError("browser.mp4 is %d bytes, the page reported %s"
                           % (size, node_result.get("bytes")))
    if int(node_result.get("frames", -1)) != frames_n:
        raise mbv.CliError("the page encoded %s of %d frames"
                           % (node_result.get("frames"), frames_n))

    ffmpeg = mbv.ffmpeg_exe()
    decoded = count_video_frames(ffmpeg, browser_mp4)
    if decoded is None:
        print("note       : ffmpeg printed no frame counter; "
              "the encoder-side count %d is used" % frames_n)
    elif decoded != frames_n:
        raise mbv.CliError("browser.mp4 decodes to %d frames, expected %d"
                           % (decoded, frames_n))

    mux(ffmpeg, browser_mp4, wav_path, out_path)
    total_ms = (time.time() - started) * 1000.0

    timing = {
        "renderer": "realtime",
        "start": round(start, 6),
        "clip_seconds": round(clip_seconds, 6),
        "settings": settings,
        "solve_gate": "passed" if args.style == "music-machine" else "n/a",
        "input": os.path.abspath(input_path),
        "output": os.path.abspath(out_path),
        "width": plan["width"], "height": plan["height"], "fps": fps,
        "seconds": plan["duration"],
        "frames": frames_n,
        "decoded_frames": decoded,
        "bitrate": int(args.bitrate),
        "bloom": not args.no_bloom,
        "qa_frames": qa_frames,
        "bytes": size,
        "webgl": node_result.get("webgl"),
        "scene": node_result.get("scene"),
        "cli_ms": {
            "total": round(total_ms, 3),
            "node": round(node_ms, 3),
            "plan_audio_verify_mux": round(total_ms - node_ms, 3),
        },
        "node_ms": node_result.get("timings"),
    }
    with open(timing_path, "w", encoding="utf-8") as fh:
        json.dump(timing, fh, ensure_ascii=False, indent=1)

    gl = node_result.get("webgl") or {}
    timings = node_result.get("timings") or {}
    print("webgl      : vendor=%s renderer=%s%s"
          % (gl.get("vendor"), gl.get("unmaskedRenderer") or gl.get("renderer"),
             " (SOFTWARE)" if gl.get("software") else ""))
    print("frames     : %d encoded, %s decoded%s"
          % (frames_n, decoded if decoded is not None else "not counted",
             "" if qa_frames else " (no QA stills)"))
    print("timing     : CLI %.1fs = browser session %.1fs + plan/audio/mux %.1fs"
          % (total_ms / 1000.0, node_ms / 1000.0, (total_ms - node_ms) / 1000.0))
    print("             node: build %sms, launch %sms, export %sms"
          % (timings.get("build_ms"), timings.get("launch_ms"), timings.get("export_ms")))
    print("             page: setup %.0fms, update %.0fms, encode %.0fms"
          % ((timings.get("browser") or {}).get("setup", 0.0),
             (timings.get("browser") or {}).get("update", 0.0),
             (timings.get("browser") or {}).get("encode", 0.0)))
    print("timing.json: %s" % timing_path)
    if node_result.get("scene", {}).get("spatial"):
        acceptance_path = os.path.splitext(out_path)[0] + ".acceptance.json"
        acceptance = spatial_acceptance.write_acceptance(node_result["report"], acceptance_path)
        print("acceptance : %s (%s)" % (acceptance_path, "PASS" if acceptance["passed"] else "FAIL"))
    if args.clean:
        shutil.rmtree(work, ignore_errors=True)
        print("cleaned    : %s" % work)
    print("output     : %s" % os.path.abspath(out_path))
    print("             H.264 / yuv420p + AAC, %dx%d, %dfps, %.3fs (score %.3f..%.3f), %d frames"
          % (plan["width"], plan["height"], fps, clip_seconds, start, start + clip_seconds, frames_n))
    return EXIT_OK


def output_for(out_dir, input_path):
    """Batch naming, mirroring make_ball_video.output_for with a distinct suffix
    so a realtime run can never overwrite a Blender run's output."""
    base = os.path.splitext(os.path.basename(input_path))[0].replace("_notes", "")
    return os.path.join(out_dir, "%s_ball3d_realtime.mp4" % base)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="make_realtime_video.py",
        description="Render a ball3d video without Blender: the same plan and audio "
                    "as make_ball_video.py, drawn by three.js and encoded by WebCodecs "
                    "through Microsoft Edge.  The visual result differs from the "
                    "Blender renderer (see realtime/README.md).")
    ap.add_argument("--input", "-i", help="input *_notes.json")
    ap.add_argument("--output", "-o",
                    help="output .mp4 (default: ball3d/out/<name>_ball3d_realtime.mp4)")
    ap.add_argument("--out-dir", help="directory for default/batch outputs")
    ap.add_argument("--seconds", type=float,
                    help="render only the first N seconds (preview); capped to the score length")
    ap.add_argument("--start", type=float,
                    help="start the clip at this absolute score time (seconds); with "
                         "--settings the whole song is solved and only the window "
                         "[start, start+--seconds) is rendered and sounded")
    ap.add_argument("--config", help="config.json for physics, layout, camera and materials; preserves note JSON")
    ap.add_argument("--settings",
                    help="editor settings JSON (geometry + look); validated against "
                         "editor_schema.json, snapshotted into the work dir and used "
                         "for the solve gate, the scene and the report")
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS)
    ap.add_argument("--style", choices=("classic", "wood-drop", "music-machine"),
                    default="music-machine",
                    help="scene style: the music-driven device (default, loads "
                         "assets/reference_music_machine.glb) or the classic boards; "
                         "'wood-drop' preserves the previous wood course")
    ap.add_argument("--width", type=int, default=DEFAULT_WIDTH, help="must be even (yuv420p)")
    ap.add_argument("--height", type=int, default=DEFAULT_HEIGHT, help="must be even (yuv420p)")
    ap.add_argument("--lead", type=float, default=1.2, help="fixed lead-in seconds")
    ap.add_argument("--tail", type=float, default=1.1, help="tail seconds")
    ap.add_argument("--bitrate", type=int, default=DEFAULT_BITRATE, help="H.264 bits/s")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                    help="seconds allowed for the browser render")
    ap.add_argument("--node", help="explicit node executable")
    ap.add_argument("--channel", default="msedge",
                    help="playwright browser channel (default: the installed msedge)")
    ap.add_argument("--build-dir", default=BUILD_DIR, help="where the browser bundle is built")
    ap.add_argument("--no-build", action="store_true", help="reuse the existing bundle")
    ap.add_argument("--no-bloom", action="store_true", help="skip the bloom pass")
    ap.add_argument("--no-sandbox", action="store_true", help="pass --no-sandbox to Edge")
    ap.add_argument("--headful", action="store_true", help="show the browser window")
    ap.add_argument("--qa-frames", help="comma-separated frame numbers to save as PNG stills")
    ap.add_argument("--glb", help="music-machine GLB to load (default "
                    "assets/reference_music_machine.glb, the 0.30 m build that matches "
                    "realtime/src/layout.mjs; the 0.60 m classic asset is still there "
                    "for comparison but the renderer refuses a plank that does not "
                    "match the audited collision box)")
    ap.add_argument("--timing", help="write timing.json here (default: the work dir)")
    ap.add_argument("--plan-only", action="store_true",
                    help="write plan.json + audio.wav, skip the browser and ffmpeg")
    ap.add_argument("--max-rest", type=float, default=0.0,
                    help="compress each rest run longer than this many seconds (0 = keep)")
    ap.add_argument("--clean", action="store_true", help="delete this run's work dir")
    ap.add_argument("--batch", help="a file listing inputs (one path per line) or a directory")
    ap.add_argument("--limit", type=int, default=3, help="max inputs in batch mode")
    args = ap.parse_args(argv)

    try:
        if args.limit < 1:
            raise mbv.CliError("--limit must be >= 1 (got %r)" % args.limit)
        if args.bitrate < 1:
            raise mbv.CliError("--bitrate must be >= 1 (got %r)" % args.bitrate)
        if args.timeout <= 0:
            raise mbv.CliError("--timeout must be > 0 (got %r)" % args.timeout)
        out_dir = os.path.abspath(args.out_dir or DEFAULT_OUT_DIR)
        if args.batch:
            inputs = mbv.batch_inputs(args.batch, args.limit)
            mbv.check_batch_collisions(inputs, lambda p: output_for(out_dir, p))
            print("batch      : %d input(s), limit %d" % (len(inputs), args.limit))
            for path in inputs:
                rc = run_job(args, path, output_for(out_dir, path))
                if rc != EXIT_OK:
                    print("batch stopped at %s" % path, file=sys.stderr)
                    return rc
            return EXIT_OK

        if not args.input:
            ap.error("--input is required (or use --batch)")
        if args.output:
            out = os.path.abspath(args.output)
        else:
            out = output_for(out_dir, args.input)
        if not os.path.isfile(args.input):
            raise mbv.CliError("input not found: %r" % args.input)
        return run_job(args, args.input, out)
    except NodeMissing as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_NO_TOOL
    except mbv.CliError as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_INPUT
    except score.ScoreError as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_INPUT


if __name__ == "__main__":
    raise SystemExit(main())
