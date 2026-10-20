"""Score loading, validation, timing and deterministic motion planning.

Pure standard library on purpose: this module is imported both by CPython
(D:/python/python11/python.exe) for the tests and by Blender's bundled Python
(3.11 in Blender 4.5 LTS) when rendering.  It must therefore not import numpy,
bpy or anything else that is not available in both.

Pitch model (also documented in README.md):

  * middle 1 = C = MIDI 60 -- the written degree "1" in the middle octave (o=0)
    sounds as C4 when the score key is ``1=C``.
  * ``n`` in 1..7 is a diatonic scale degree, ``n`` == 0 is a rest.
  * ``o`` is the signed octave shift in octaves (12 semitones each).
  * key ``1=B`` transposes every degree by the pitch class of B (+11 semitones),
    so degree 1 / o=0 sounds as MIDI 71 (B4) and degree 7 as MIDI 82 (A#5).
  * ``letter`` is a keyboard mapping, NOT a pitch; it is never used for audio.
"""

from __future__ import annotations

import json
import math
import os

# --- pitch -------------------------------------------------------------------

MIDDLE_C_MIDI = 60
# semitone offset of degrees 1..7 inside one octave (index 0 == degree 1)
DEGREE_SEMITONES = (0, 2, 4, 5, 7, 9, 11)
NOTE_PITCH_CLASS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# --- geometry constants (metres) --------------------------------------------
# They live in the plan JSON so a renderer never re-invents them.

SPACING = 1.05          # centre-to-centre board step along +X
BOARD_W = 0.90          # board size along X
BOARD_H = 0.10          # visible thickness
BOARD_D = 0.62          # board size along Z
SUPPORT_R = 0.030       # support post radius
SUPPORT_SEGS = 10
BALL_R = 0.16           # pearl ball radius
# Reference board top height.  Must stay above
# pitch_clamp_semitones * height_per_semitone (24 * 0.055 = 1.32 m) so that the
# lowest boards never sink through the ground and support posts stay positive.
BASE_TOP = 1.55         # board top surface height for the reference pitch
HEIGHT_PER_SEMITONE = 0.055
PITCH_CLAMP_SEMITONES = 24.0    # bound on vertical pitch offset -> no extreme leaps
LANE_AMP = 0.10         # gentle Z weave so the track is not a flat plane
LANE_FREQ = 0.9
MAX_HOP_HEIGHT = 0.90
MIN_HOP_HEIGHT = 0.25
MAX_DWELL = 0.80        # seconds the ball may stay on a board before hopping
START_HOP_MAX = 0.60    # arriving hop into the first board, during the lead-in

HOP_LIFE = 0.55         # star-particle life after a landing (seconds)
GLOW_LIFE = 1.10        # board/ball glow decay constant (seconds)

CONSTANTS = {
    "spacing": SPACING, "board_w": BOARD_W, "board_h": BOARD_H, "board_d": BOARD_D,
    "support_r": SUPPORT_R, "support_segs": SUPPORT_SEGS, "ball_r": BALL_R,
    "base_top": BASE_TOP, "height_per_semitone": HEIGHT_PER_SEMITONE,
    "pitch_clamp_semitones": PITCH_CLAMP_SEMITONES, "lane_amp": LANE_AMP,
    "lane_freq": LANE_FREQ, "max_hop_height": MAX_HOP_HEIGHT,
    "min_hop_height": MIN_HOP_HEIGHT, "max_dwell": MAX_DWELL,
    "start_hop_max": START_HOP_MAX,
    "hop_life": HOP_LIFE, "glow_life": GLOW_LIFE, "middle_c_midi": MIDDLE_C_MIDI,
}


class ScoreError(ValueError):
    """Invalid input score, with the offending line/index in the message."""


def _fail(where, msg):
    raise ScoreError("%s: %s" % (where, msg))


# --- parsing -----------------------------------------------------------------

def parse_key(text):
    """``"1=B"`` -> pitch class 11 (B).  ``1=C`` is documented as MIDI 60."""
    if not isinstance(text, str) or "=" not in text:
        raise ScoreError("key %r is not of the form 1=B" % (text,))
    left, _, right = text.partition("=")
    if left.strip() != "1":
        raise ScoreError("key %r: only the tonic (1=X) form is supported" % (text,))
    body = right.strip()
    if not body:
        raise ScoreError("key %r has no note name" % (text,))
    letter = body[0].upper()
    if letter not in NOTE_PITCH_CLASS:
        raise ScoreError("key %r: unknown note name %r" % (text, body))
    pc = NOTE_PITCH_CLASS[letter]
    shift = 0
    for ch in body[1:].strip():
        if ch == "#":
            shift += 1
        elif ch in "bB":
            shift -= 1
        else:
            raise ScoreError("key %r: unsupported suffix %r" % (text, ch))
    return (pc + shift) % 12


def midi_for(n, o, tonic_pc):
    """Diatonic degree ``n`` (1..7) at octave ``o`` -> MIDI note number."""
    return MIDDLE_C_MIDI + tonic_pc + DEGREE_SEMITONES[n - 1] + 12 * o


def _finite(value, where, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(where, "%s is not a number (%r)" % (what, value))
    value = float(value)
    if not math.isfinite(value):
        _fail(where, "%s is not finite (%r)" % (what, value))
    return value


def load_score(path):
    """Read and validate a ``jianpu2letter-notes-v1`` file.

    Returns a dict with: title, key/tempo, tonic_pc, lines, events (stored order),
    sounding, rests, sum_q, score_duration, counts.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise ScoreError("%s: cannot read (%s)" % (path, exc))
    except ValueError as exc:
        raise ScoreError("%s: not valid JSON (%s)" % (path, exc))
    if not isinstance(data, dict):
        raise ScoreError("%s: top level is not a JSON object" % path)
    fmt = data.get("format")
    if fmt != "jianpu2letter-notes-v1":
        raise ScoreError("%s: unsupported format %r (expected jianpu2letter-notes-v1)"
                         % (path, fmt))

    where0 = os.path.basename(path)
    tempo = _finite(data.get("tempo_qpm"), where0, "tempo_qpm")
    if tempo <= 0.0:
        _fail(where0, "tempo_qpm must be > 0 (got %r)" % (tempo,))
    tonic_pc = parse_key(data.get("key"))

    lines = data.get("lines")
    if not isinstance(lines, list) or not lines:
        _fail(where0, "lines must be a non-empty list")

    events = []
    sounding = []
    rests = []
    sum_q = 0.0
    for li, line in enumerate(lines):
        if not isinstance(line, dict):
            _fail("%s line[%d]" % (where0, li), "entry is not an object")
        line_no = line.get("line", li + 1)
        notes = line.get("notes")
        if not isinstance(notes, list):
            _fail("%s L%s" % (where0, line_no), "notes must be a list")
        for ni, note in enumerate(notes):
            if not isinstance(note, dict):
                _fail("%s L%s (note[%d])" % (where0, line_no, ni), "note is not an object")
            idx = note.get("index", ni + 1)
            where = "%s L%s N%s" % (where0, line_no, idx)
            n = note.get("n")
            unknown = n is None and note.get("unknown") is True
            if unknown:
                n = 0  # Keep the OCR item's duration as silence; never remove its time.
            if isinstance(n, bool) or not isinstance(n, int):
                _fail(where, "n is missing or not an integer (got %r)" % (n,))
            if not 0 <= n <= 7:
                _fail(where, "unknown note n=%r (expected 0..7, 0 == rest)" % (n,))
            o = note.get("o", 0)
            if isinstance(o, bool) or not isinstance(o, int):
                _fail(where, "o is not an integer (got %r)" % (o,))
            q = _finite(note.get("q"), where, "q (duration in quarter notes)")
            if q <= 0.0:
                _fail(where, "q must be > 0 (got %r)" % (q,))
            letter = note.get("letter")
            if letter is not None and not isinstance(letter, str):
                _fail(where, "letter is not a string (got %r)" % (letter,))
            articulation = note.get("articulation")
            if articulation not in (None, "normal", "sustain", "glissando"):
                _fail(where, "articulation must be normal, sustain or glissando")
            if n == 0 and articulation not in (None, "normal"):
                _fail(where, "a rest cannot have sustain/glissando articulation")
            target_midi = None
            if articulation == "glissando":
                target = note.get("glissando_to")
                if not isinstance(target, dict):
                    _fail(where, "glissando requires glissando_to: {n, o}")
                tn, to = target.get("n"), target.get("o", 0)
                if isinstance(tn, bool) or not isinstance(tn, int) or not 1 <= tn <= 7:
                    _fail(where, "glissando_to.n must be an integer from 1 to 7")
                if isinstance(to, bool) or not isinstance(to, int):
                    _fail(where, "glissando_to.o must be an integer")
                target_midi = midi_for(tn, to, tonic_pc)
            elif "glissando_to" in note:
                _fail(where, "glissando_to requires articulation: glissando")
            duration = q * 60.0 / tempo
            if "duration_sec" in note:
                if n == 0:
                    _fail(where, "a rest cannot have duration_sec")
                duration = _finite(note["duration_sec"], where, "duration_sec")
                if duration <= 0:
                    _fail(where, "duration_sec must be > 0")
            bend = note.get("pitch_bend")
            if "pitch_bend" in note:
                if n == 0 or not isinstance(bend, list) or not bend:
                    _fail(where, "pitch_bend requires a sounding note and a non-empty point list")
                if target_midi is not None:
                    _fail(where, "use either pitch_bend or glissando_to, not both")
                previous = -1.0
                for point in bend:
                    if not isinstance(point, dict) or set(point) != {"time_sec", "semitones"}:
                        _fail(where, "pitch_bend points must contain time_sec and semitones")
                    time = _finite(point["time_sec"], where, "pitch_bend.time_sec")
                    offset = _finite(point["semitones"], where, "pitch_bend.semitones")
                    if not previous < time <= duration or time < 0:
                        _fail(where, "pitch_bend times must increase within 0..duration_sec")
                    if not 0 <= midi_for(n, o, tonic_pc) + offset <= 127:
                        _fail(where, "pitch_bend pitch must be within MIDI 0..127")
                    previous = time
            ev = {
                "where": where,
                "line": line_no,
                "index": idx,
                "n": n,
                "o": o,
                "q": q,
                "letter": letter,
                "lyric": note.get("lyric"),
                "onset_q": sum_q,
                "rest": n == 0,
                "midi": None if n == 0 else midi_for(n, o, tonic_pc),
                "duration_sec": duration,
                "duration_source": "note_off" if "duration_sec" in note else "score_q",
            }
            if unknown:
                ev["unknown"] = True
            if bend is not None:
                ev["pitch_bend"] = bend
            if articulation in ("sustain", "glissando"):
                ev["articulation"] = articulation
            if target_midi is not None:
                ev["glissando_to_midi"] = target_midi
            events.append(ev)
            (rests if ev["rest"] else sounding).append(ev)
            sum_q += q

    if not events:
        _fail(where0, "score has no notes")
    if not sounding:
        _fail(where0, "score has no sounding notes (only rests)")

    return {
        "path": os.path.abspath(path),
        "title": data.get("title") or "",
        "key": data.get("key"),
        "tonic_pc": tonic_pc,
        "tempo_qpm": tempo,
        "meter": data.get("meter"),
        "tempo_source": data.get("tempo_source"),
        "line_count": len(lines),
        "events": events,
        "sounding": sounding,
        "rests": rests,
        "sum_q": sum_q,
        "score_duration": sum_q * 60.0 / tempo,
    }


# --- timing ------------------------------------------------------------------

def onset_seconds(onset_q, tempo_qpm, lead=0.0):
    """Absolute onset in seconds.  No per-note rounding -- one exact formula."""
    return lead + onset_q * 60.0 / tempo_qpm


# --- geometry / motion -------------------------------------------------------

def board_position(i, midi, ref_midi):
    """Board box centre and ball rest centre for landing ``i``."""
    delta = max(-PITCH_CLAMP_SEMITONES, min(PITCH_CLAMP_SEMITONES, midi - ref_midi))
    top_y = BASE_TOP + delta * HEIGHT_PER_SEMITONE
    x = i * SPACING
    z = LANE_AMP * math.sin(i * LANE_FREQ)
    return ([x, top_y - BOARD_H * 0.5, z], top_y, [x, top_y + BALL_R, z])


def _lerp3(a, b, u):
    return [a[0] + (b[0] - a[0]) * u,
            a[1] + (b[1] - a[1]) * u,
            a[2] + (b[2] - a[2]) * u]


def hop_height(flight):
    """Arc height for a flight of ``flight`` seconds (clamped)."""
    return max(MIN_HOP_HEIGHT, min(MAX_HOP_HEIGHT, 0.55 * flight))


def _segment_at(plan, t):
    """The one segment covering ``t``.  Segments are contiguous (see
    check_segments), so this only clamps outside [0, duration] instead of
    silently falling through to the last board."""
    segs = plan["segments"]
    if t <= segs[0]["t0"]:
        return segs[0]
    for seg in segs:
        if seg["t0"] <= t <= seg["t1"]:
            return seg
    return segs[-1]


def check_segments(plan, eps=1e-9):
    """Fail loudly on gaps/overlaps or incomplete coverage of the duration."""
    segs = plan["segments"]
    if not segs:
        raise ScoreError("plan has no motion segments")
    if segs[0]["t0"] > eps:
        raise ScoreError("motion segments start at %r, not 0" % segs[0]["t0"])
    for a, b in zip(segs, segs[1:]):
        if abs(b["t0"] - a["t1"]) > eps:
            raise ScoreError("motion segment gap/overlap: %s ends at %r but %s "
                             "starts at %r" % (a["kind"], a["t1"], b["kind"], b["t0"]))
        if b["t1"] < b["t0"] - eps:
            raise ScoreError("motion segment ends before it starts")
    if segs[-1]["t1"] < plan["duration"] - eps:
        raise ScoreError("motion segments end at %r, before duration %r"
                         % (segs[-1]["t1"], plan["duration"]))
    return True


def sample_ball(plan, t):
    """Ball centre position at absolute time ``t`` (analytic, any real t)."""
    seg = _segment_at(plan, t)
    if seg["kind"] == "hold":
        return list(seg["p0"])
    span = seg["t1"] - seg["t0"]
    u = 0.0 if span <= 0.0 else (t - seg["t0"]) / span
    p = _lerp3(seg["p0"], seg["p1"], u)
    p[1] += seg["h"] * 4.0 * u * (1.0 - u)   # 0 at both ends -> exact collision
    return p


def sample_track(plan, t):
    """Ball position with the hop's vertical arc removed (smooth camera target)."""
    seg = _segment_at(plan, t)
    if seg["kind"] == "hold":
        return list(seg["p0"])
    span = seg["t1"] - seg["t0"]
    u = 0.0 if span <= 0.0 else (t - seg["t0"]) / span
    return _lerp3(seg["p0"], seg["p1"], u)


def build_plan(score, lead=1.2, tail=1.1, fps=30, width=360, height=640, seconds=None,
               max_rest=0.0):
    """Absolute-time event list + deterministic board layout + motion segments."""
    tempo = score["tempo_qpm"]
    ref_midi = score["sounding"][0]["midi"]

    events = []
    for ev in score["events"]:
        events.append({
            "kind": "rest" if ev["rest"] else "note",
            "where": ev["where"], "line": ev["line"], "index": ev["index"],
            "n": ev["n"], "o": ev["o"], "letter": ev["letter"], "q": ev["q"],
            "lyric": ev.get("lyric"), "midi": ev["midi"],
            "onset_q": ev["onset_q"],
            "onset_sec": onset_seconds(ev["onset_q"], tempo, lead),
            "dur_sec": ev["duration_sec"],
            "score_dur_sec": ev["q"] * 60.0 / tempo,
            **{k: ev[k] for k in ("articulation", "glissando_to_midi", "pitch_bend", "duration_sec", "duration_source", "unknown") if k in ev},
        })

    landings = []
    boards = []
    for i, ev in enumerate(score["sounding"]):
        box, top_y, ball = board_position(i, ev["midi"], ref_midi)
        t = onset_seconds(ev["onset_q"], tempo, lead)
        dur = ev["duration_sec"]
        landing = {
            "i": i, "t": t, "midi": ev["midi"], "n": ev["n"], "o": ev["o"],
            "q": ev["q"], "dur": dur, "line": ev["line"], "index": ev["index"],
            "where": ev["where"], "onset_q": ev["onset_q"], "lyric": ev.get("lyric"),
            "board_pos": box, "ball_pos": ball, "top_y": top_y,
            **{k: ev[k] for k in ("articulation", "glissando_to_midi", "pitch_bend", "duration_sec", "duration_source") if k in ev},
        }
        landings.append(landing)
        boards.append({
            "index": i, "pos": box, "top_y": top_y, "ball_pos": ball,
            "midi": ev["midi"], "n": ev["n"], "o": ev["o"],
            "pitch_class": ev["midi"] % 12, "where": ev["where"],
        })

    # start pad: one board step behind the first landing, so the lead-in shows a
    # real arriving hop instead of the ball sitting on board 0 and flashing
    pad_box, pad_top, pad_ball = board_position(-1, ref_midi, ref_midi)

    # A long instrumental rest is one hop in the video, so the ball nearly
    # hovers for its whole duration.  Compressing each rest run to ``max_rest``
    # seconds keeps picture and synthesized audio on the same shortened clock.
    score_end_override = None
    if max_rest and max_rest > 0:
        runs, i = [], 0
        while i < len(events):
            if events[i]["kind"] != "rest":
                i += 1
                continue
            j = i
            while j < len(events) and events[j]["kind"] == "rest":
                j += 1
            start = events[i]["onset_sec"]
            end = events[j - 1]["onset_sec"] + events[j - 1]["dur_sec"]
            if end - start > max_rest + 1e-9:
                runs.append((start, end, float(max_rest)))
            i = j

        def warp_time(t):
            shift = 0.0
            for start, end, new_len in runs:
                if t >= end:
                    shift += new_len - (end - start)
                elif t > start:
                    return start + (t - start) * (new_len / (end - start)) + shift
                else:
                    break
            return t + shift

        for ev in events:
            t0 = ev["onset_sec"]
            ev["onset_sec"] = warp_time(t0)
            ev["dur_sec"] = max(0.0, warp_time(t0 + ev["dur_sec"]) - ev["onset_sec"])
        for landing in landings:
            landing["t"] = warp_time(landing["t"])
        score_end_override = warp_time(lead + score["score_duration"])

    def hold(t0, t1, ball):
        return {"kind": "hold", "t0": t0, "t1": t1,
                "p0": list(ball), "p1": list(ball), "h": 0.0}

    def hop(t0, t1, ball_a, ball_b):
        return {"kind": "hop", "t0": t0, "t1": t1,
                "p0": list(ball_a), "p1": list(ball_b),
                "h": hop_height(t1 - t0)}

    # every segment is contiguous: hold(t0..t1) followed by hop(t1..t2), and a
    # hold covers every dwell interval -- no time is left uncovered
    segments = []
    t_first = landings[0]["t"]
    flight_in = min(START_HOP_MAX, max(0.0, t_first))
    t_launch = t_first - flight_in
    if t_launch > 0.0:
        segments.append(hold(0.0, t_launch, pad_ball))
    if flight_in > 0.0:
        segments.append(hop(t_launch, t_first, pad_ball, landings[0]["ball_pos"]))
    for k in range(len(landings) - 1):
        a, b = landings[k], landings[k + 1]
        gap = b["t"] - a["t"]
        dwell = min(a["dur"], gap * 0.5, MAX_DWELL)
        if dwell > 0.0:
            segments.append(hold(a["t"], a["t"] + dwell, a["ball_pos"]))
        if gap - dwell > 0.0:
            segments.append(hop(a["t"] + dwell, b["t"], a["ball_pos"], b["ball_pos"]))
        else:                                   # defensive: keep the timeline covered
            segments.append(hold(a["t"] + dwell, b["t"], a["ball_pos"]))
    last_t = landings[-1]["t"]
    score_end = score_end_override if score_end_override is not None else lead + score["score_duration"]
    tail_end = max(score_end, max(n["t"] + n["dur"] for n in landings)) + tail
    segments.append(hold(last_t, max(tail_end, last_t), landings[-1]["ball_pos"]))

    duration = tail_end
    if seconds is not None:
        duration = float(seconds)
        segments[-1]["t1"] = max(segments[-1]["t1"], duration)
    if not segments:
        raise ScoreError("no motion segments could be built")

    plan = {
        "format": "ball3d-plan-v1",
        "input": score["path"],
        "title": score["title"],
        "key": score["key"],
        "tonic_pc": score["tonic_pc"],
        "tempo_qpm": tempo,
        "tempo_source": score["tempo_source"], "meter": score.get("meter", "4/4"),
        "fps": int(fps), "width": int(width), "height": int(height),
        "lead": float(lead), "tail": float(tail),
        "score_duration": score["score_duration"],
        "max_rest": float(max_rest),
        "duration": duration,
        "sum_q": score["sum_q"],
        "ref_midi": ref_midi,
        "constants": dict(CONSTANTS),
        "events": events,
        "landings": landings,
        "rests": [e for e in events if e["kind"] == "rest"],
        "boards": boards,
        "pad": {"index": -1, "pos": pad_box, "top_y": pad_top, "ball_pos": pad_ball},
        "segments": segments,
        "counts": {
            "lines": score["line_count"],
            "events": len(events),
            "sounding": len(landings),
            "rests": len(events) - len(landings),
        },
    }
    check_segments(plan)
    return plan


def load_plan(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            plan = json.load(fh)
    except OSError as exc:
        raise ScoreError("%s: cannot read (%s)" % (path, exc))
    except ValueError as exc:
        raise ScoreError("%s: not valid JSON (%s)" % (path, exc))
    if plan.get("format") != "ball3d-plan-v1":
        raise ScoreError("%s: not a ball3d-plan-v1 file" % path)
    return plan


def frame_times(fps, duration):
    """Frame i is sampled at exactly i / fps (no accumulated rounding)."""
    return [i / float(fps) for i in range(int(math.ceil(duration * fps - 1e-9)))]
