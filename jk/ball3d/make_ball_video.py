"""ball3d CLI: JSON score -> synthesized audio + a true-3D EEVEE ball video.

    D:/python/python11/python.exe ball3d/make_ball_video.py --help
    D:/python/python11/python.exe ball3d/make_ball_video.py \
        --input D:/Downloads/10_notes.json --seconds 12 \
        --blender "D:/apps/Blender/blender-4.5.3-windows-x64/blender.exe"

Runs with CPython (numpy needed for audio).  Blender is only used for rendering;
it is called through an argument array, so paths with spaces or Chinese work.
Every run gets its own temp directory under the output parent, the encoded frame
count is bounded explicitly, and nothing under the input path is overwritten.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import audio  # noqa: E402
import score  # noqa: E402

DEFAULT_OUT_DIR = os.path.join(HERE, "out")
RENDER_SCRIPT = os.path.join(HERE, "render_scene.py")
PYTHON_EXIT_CODE = "1"          # make Blender return non-zero on a Python error

EXIT_OK, EXIT_INPUT, EXIT_NO_BLENDER, EXIT_SUBPROCESS = 0, 2, 3, 4


class CliError(Exception):
    """Bad arguments or bad input; reported as a clean message, not a traceback."""


class BlenderMissing(CliError):
    """Blender could not be found or launched (exit code 3)."""


def resolve(path):
    """Normalized, resolved path (case-insensitive comparison on Windows)."""
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def same_path(a, b):
    return resolve(a) == resolve(b)


def expected_frames(duration, fps):
    """ceil(duration * fps) -- one formula shared with render_scene.frame_count."""
    return int(math.ceil(float(duration) * int(fps) - 1e-9))


def frame_names(frames_n):
    """The exact PNG names the renderer must have written, in order.

    Six digits, matching render_scene.frame_filename() ('#' padding in the
    output path), so a rename on either side is caught before muxing.
    """
    return ["frame_%06d.png" % (i + 1) for i in range(int(frames_n))]


def natural_duration(sc, lead, tail):
    """Duration when no --seconds cap is given (must match score.build_plan)."""
    return lead + sc["score_duration"] + tail


def cap_seconds(seconds, natural):
    """--seconds never extends the video beyond the score's own length."""
    if seconds is None:
        return None
    if seconds >= natural:
        return natural
    return seconds


def _finite(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CliError("%s must be a number (got %r)" % (what, value))
    if not math.isfinite(float(value)):
        raise CliError("%s must be finite (got %r)" % (what, value))
    return float(value)


def validate_job(input_path, out_path, fps, width, height, seconds, lead, tail, samples):
    """Everything that must be true before a single file is written."""
    if not input_path or not os.path.isfile(input_path):
        raise CliError("input not found: %r" % input_path)
    if not out_path:
        raise CliError("output path is empty")
    if os.path.splitext(out_path)[1].lower() != ".mp4":
        raise CliError("output must end in .mp4 (got %r)" % out_path)
    if same_path(input_path, out_path):
        raise CliError("refusing to overwrite the input file %r" % input_path)
    if os.path.isdir(out_path):
        raise CliError("output path %r is a directory" % out_path)

    fps = _finite(fps, "--fps")
    if fps <= 0:
        raise CliError("--fps must be > 0 (got %r)" % fps)
    for name, value in (("--width", width), ("--height", height)):
        value = _finite(value, name)
        if value <= 0:
            raise CliError("%s must be > 0 (got %r)" % (name, value))
        if int(value) % 2:
            raise CliError("%s must be even for yuv420p (got %d)" % (name, int(value)))
    if _finite(samples, "--samples") < 1:
        raise CliError("--samples must be >= 1 (got %r)" % samples)
    if _finite(lead, "--lead") < 0:
        raise CliError("--lead must be >= 0 (got %r)" % lead)
    if _finite(tail, "--tail") < 0:
        raise CliError("--tail must be >= 0 (got %r)" % tail)
    if seconds is not None:
        seconds = _finite(seconds, "--seconds")
        if seconds <= 0:
            raise CliError("--seconds must be > 0 (got %r)" % seconds)
    return True


def check_batch_collisions(inputs, output_for):
    """Reject two inputs that would write the same output file."""
    seen = {}
    for path in inputs:
        key = resolve(output_for(path))
        if key in seen:
            raise CliError("batch outputs collide: %r and %r both map to %r"
                           % (seen[key], path, output_for(path)))
        seen[key] = path
    return True


# --- tool discovery ----------------------------------------------------------

def blender_candidates():
    out = []
    env = os.environ.get("JPK_BLENDER")
    if env:
        out.append(env)
    found = shutil.which("blender")
    if found:
        out.append(found)
    out.append(r"D:\apps\Blender\blender-4.5.3-windows-x64\blender.exe")
    for pattern in (r"D:\apps\Blender\*\blender.exe",
                    r"C:\Program Files\Blender Foundation\*\blender.exe",
                    r"C:\Program Files\Blender Foundation\Blender\blender.exe",
                    r"C:\Program Files (x86)\Blender Foundation\*\blender.exe",
                    r"D:\Program Files\Blender Foundation\*\blender.exe",
                    os.path.expanduser(r"~\scoop\apps\blender\*\blender.exe")):
        out.extend(sorted(glob.glob(pattern), reverse=True))
    seen, uniq = set(), []
    for p in out:
        key = resolve(p)
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def find_blender(explicit):
    if explicit:
        if os.path.isfile(explicit):
            return explicit
        raise BlenderMissing("--blender %r does not exist" % explicit)
    for cand in blender_candidates():
        if os.path.isfile(cand):
            return cand
    tried = "\n".join("    " + c for c in blender_candidates()) or "    (nothing found)"
    raise BlenderMissing("Blender was not found.  Tried:\n%s\n"
                         "Pass --blender \"C:\\path\\to\\blender.exe\" or set JPK_BLENDER "
                         "(Blender 4.5 LTS is the tested version)." % tried)


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        found = shutil.which("ffmpeg")
        if not found:
            raise CliError("no ffmpeg: install imageio-ffmpeg or put ffmpeg on PATH")
        return found


def make_work_dir(out_path, stem):
    """A fresh, unique per-run directory under the output parent.

    Its resolved path is verified to be exactly the directory we just created
    inside the intended parent, so --clean can never delete anything else.
    """
    parent = os.path.dirname(os.path.abspath(out_path)) or os.getcwd()
    os.makedirs(parent, exist_ok=True)
    prefix = "%s.ball3d." % stem
    work = tempfile.mkdtemp(prefix=prefix, dir=parent)
    resolved = os.path.realpath(work)
    if os.path.realpath(os.path.dirname(resolved)) != os.path.realpath(parent) \
            or not os.path.basename(resolved).startswith(prefix) \
            or not os.path.isdir(resolved):
        raise CliError("refusing to use work dir %r outside %r" % (resolved, parent))
    return resolved


# --- one video ---------------------------------------------------------------

def run_job(args, input_path, out_path):
    if args.seconds is not None:
        _finite(args.seconds, "--seconds")
        if args.seconds <= 0:
            raise CliError("--seconds must be > 0 (got %r)" % args.seconds)
    if not os.path.isfile(input_path):
        raise CliError("input not found: %r" % input_path)
    sc = score.load_score(input_path)

    seconds = cap_seconds(args.seconds, natural_duration(sc, args.lead, args.tail))
    if args.seconds is not None and seconds < args.seconds:
        print("note       : --seconds %.3f capped to the score length %.3fs"
              % (args.seconds, seconds))

    validate_job(input_path, out_path, args.fps, args.width, args.height,
                 seconds, args.lead, args.tail, args.samples)

    plan = score.build_plan(sc, lead=args.lead, tail=args.tail, fps=args.fps,
                            width=args.width, height=args.height, seconds=seconds)

    fps = plan["fps"]
    frames_n = expected_frames(plan["duration"], fps)
    stem = os.path.splitext(os.path.basename(out_path))[0]
    work = make_work_dir(out_path, stem)
    frames_dir = os.path.join(work, "frames")
    plan_path = os.path.join(work, "plan.json")
    wav_path = os.path.join(work, "audio.wav")

    print("input      : %s" % input_path)
    print("title/key  : %s / %s (middle 1 = C = MIDI 60; this key puts 1 at MIDI %d)"
          % (plan["title"] or "(untitled)", plan["key"], 60 + plan["tonic_pc"]))
    print("score      : %d lines, %d events = %d sounding + %d rests, sum q=%g, "
          "tempo=%g qpm" % (plan["counts"]["lines"], plan["counts"]["events"],
                            plan["counts"]["sounding"], plan["counts"]["rests"],
                            plan["sum_q"], plan["tempo_qpm"]))
    print("timing     : score %.3fs, lead %.2fs, video %.3fs, %d frames @ %dfps %dx%d"
          % (plan["score_duration"], plan["lead"], plan["duration"], frames_n,
             fps, plan["width"], plan["height"]))
    print("work dir   : %s" % work)

    os.makedirs(frames_dir, exist_ok=True)
    with open(plan_path, "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)
    audio.render_to_wav(plan, wav_path)
    print("plan/audio : %s\n             %s" % (plan_path, wav_path))

    if args.plan_only:
        print("--plan-only: skipping Blender and ffmpeg")
        return EXIT_OK

    blender = find_blender(args.blender)
    cmd = [blender, "-b", "--factory-startup", "--python-exit-code", PYTHON_EXIT_CODE,
           "-noaudio", "-P", RENDER_SCRIPT,
           "--", "--plan", plan_path, "--frames-dir", frames_dir,
           "--samples", str(args.samples)]
    print("render     : %s" % " ".join('"%s"' % c if " " in c else c for c in cmd))
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        raise BlenderMissing("cannot execute Blender at %r" % blender)
    except subprocess.CalledProcessError as exc:
        raise CliError("Blender failed with exit code %s" % exc.returncode)

    # never mux a half-rendered sequence
    written = sorted(n for n in os.listdir(frames_dir)
                     if n.startswith("frame_") and n.endswith(".png"))
    if len(written) != frames_n:
        raise CliError("expected %d rendered frames, found %d in %s"
                       % (frames_n, len(written), frames_dir))
    expected_names = frame_names(frames_n)
    if written != expected_names:
        raise CliError("rendered frame names are not contiguous in %s" % frames_dir)

    ffmpeg = ffmpeg_exe()
    silent = os.path.join(work, "silent.mp4")
    steps = [
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-framerate", str(fps), "-start_number", "1",
         "-i", os.path.join(frames_dir, "frame_%06d.png"),
         "-frames:v", str(frames_n),
         "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
         "-pix_fmt", "yuv420p", silent],
        [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-i", silent, "-i", wav_path, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
         "-movflags", "+faststart", out_path],
    ]
    for step in steps:
        try:
            subprocess.run(step, check=True)
        except FileNotFoundError:
            raise CliError("cannot execute ffmpeg at %r" % ffmpeg)
        except subprocess.CalledProcessError as exc:
            raise CliError("ffmpeg failed with exit code %s" % exc.returncode)

    if args.clean:
        shutil.rmtree(work, ignore_errors=True)
        print("cleaned    : %s" % work)
    print("output     : %s" % os.path.abspath(out_path))
    print("             H.264 / yuv420p + AAC, %dx%d, %dfps, %.3fs, %d frames"
          % (plan["width"], plan["height"], fps, plan["duration"], frames_n))
    return EXIT_OK


# --- batch -------------------------------------------------------------------

def batch_inputs(batch, limit):
    paths = []
    if os.path.isdir(batch):
        paths = sorted(glob.glob(os.path.join(batch, "*.json")))
    else:
        if not os.path.isfile(batch):
            raise CliError("--batch %r is neither a file nor a directory" % batch)
        with open(batch, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if os.path.isdir(line):
                    paths.extend(sorted(glob.glob(os.path.join(line, "*.json"))))
                else:
                    paths.append(line)
    if not paths:
        raise CliError("batch %r produced no inputs" % batch)
    return paths[:limit]


def output_for(out_dir, input_path):
    base = os.path.splitext(os.path.basename(input_path))[0].replace("_notes", "")
    return os.path.join(out_dir, "%s_ball3d.mp4" % base)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="make_ball_video.py",
        description="Render a true-3D ball video (Blender/EEVEE) with a synthesized "
                    "melody from a jianpu2letter-notes-v1 JSON score.")
    ap.add_argument("--input", "-i", help="input *_notes.json")
    ap.add_argument("--output", "-o", help="output .mp4 (default: ball3d/out/<name>_ball3d.mp4)")
    ap.add_argument("--out-dir", help="directory for default/batch outputs")
    ap.add_argument("--seconds", type=float,
                    help="render only the first N seconds (preview); capped to the score length")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--width", type=int, default=360, help="must be even (yuv420p)")
    ap.add_argument("--height", type=int, default=640, help="must be even (yuv420p)")
    ap.add_argument("--lead", type=float, default=1.2, help="fixed lead-in seconds")
    ap.add_argument("--tail", type=float, default=1.1, help="tail seconds")
    ap.add_argument("--samples", type=int, default=32, help="EEVEE TAA samples")
    ap.add_argument("--blender", help="explicit blender executable")
    ap.add_argument("--plan-only", action="store_true",
                    help="write plan.json + audio.wav, skip Blender/ffmpeg")
    ap.add_argument("--clean", action="store_true", help="delete this run's work dir")
    ap.add_argument("--batch", help="a file listing inputs (one path per line) or a directory")
    ap.add_argument("--limit", type=int, default=3, help="max inputs in batch mode")
    args = ap.parse_args(argv)

    try:
        if args.limit < 1:
            raise CliError("--limit must be >= 1 (got %r)" % args.limit)
        out_dir = os.path.abspath(args.out_dir or DEFAULT_OUT_DIR)
        if args.batch:
            inputs = batch_inputs(args.batch, args.limit)
            check_batch_collisions(inputs, lambda p: output_for(out_dir, p))
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
            stem = os.path.splitext(os.path.basename(args.input))[0].replace("_notes", "")
            out = os.path.join(out_dir, "%s_ball3d.mp4" % stem)
        if not args.input or not os.path.isfile(args.input):
            raise CliError("input not found: %r" % args.input)
        return run_job(args, args.input, out)
    except BlenderMissing as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_NO_BLENDER
    except CliError as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_INPUT
    except score.ScoreError as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return EXIT_INPUT


if __name__ == "__main__":
    raise SystemExit(main())
