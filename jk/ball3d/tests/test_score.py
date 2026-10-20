"""Tests for the ball3d input/timing/motion/audio layer.

    D:/python/python11/python.exe -m unittest discover -s "D:/Letter piano jk/ball3d/tests" -v

These tests use only CPython + numpy; they never need Blender.
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import unittest
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
BALL3D = os.path.dirname(HERE)
sys.path.insert(0, BALL3D)

import audio  # noqa: E402
import score  # noqa: E402

FIXTURE = os.environ.get("JPK_FIXTURE", r"D:\Downloads\10_notes.json")


def strikes_inside_rest(landing, rest, tol=1e-9):
    """True when a landing is strictly inside the rest, beyond a 1e-9 tolerance.

    Comparing endpoints with a bare `<` hides a genuine interior strike whenever
    floating error makes the landing land a rounding step outside the interval,
    so the interval is checked in quarter-note positions with an absolute
    tolerance as well.
    """
    t = landing["t"]
    start, end = rest["onset_sec"], rest["onset_sec"] + rest["dur_sec"]
    if not (start + tol < t < end - tol):
        return False
    q = landing.get("onset_q")
    q_start = rest.get("onset_q")
    if q is not None and q_start is not None:
        return q_start + tol < q < q_start + rest["q"] - tol
    return True


def make_score(notes, tempo=65.0, key="1=C", title="t", tmp=None):
    """notes: list of (n, o, q) for a single line, or list of lists per line."""
    lines = []
    if notes and isinstance(notes[0], tuple):
        notes = [notes]
    for li, line in enumerate(notes, start=1):
        entries = []
        for ni, (n, o, q) in enumerate(line, start=1):
            entries.append({"line": li, "index": ni, "n": n, "o": o, "q": q,
                            "letter": "0" if n == 0 else "D"})
        lines.append({"line": li, "notes": entries})
    data = {"format": "jianpu2letter-notes-v1", "title": title, "key": key,
            "meter": "4/4", "tempo_qpm": tempo, "lines": lines}
    path = os.path.join(tmp, "score.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    return score.load_score(path), path


class TestPitchModel(unittest.TestCase):
    def test_key_parsing_and_middle_c(self):
        self.assertEqual(score.parse_key("1=C"), 0)
        self.assertEqual(score.parse_key("1=B"), 11)
        self.assertEqual(score.parse_key("1=G"), 7)
        self.assertEqual(score.parse_key(" 1 = c "), 0)
        # documented rule: middle 1 == C == MIDI 60
        self.assertEqual(score.midi_for(1, 0, score.parse_key("1=C")), 60)

    def test_key_transposes_diatonic_degrees(self):
        pc = score.parse_key("1=B")
        self.assertEqual(score.midi_for(1, 0, pc), 71)   # B4
        self.assertEqual(score.midi_for(2, 0, pc), 73)   # C#5
        self.assertEqual(score.midi_for(7, 0, pc), 82)   # A#5 (major 7th above B4)

    def test_octave_shifts_by_twelve(self):
        pc = score.parse_key("1=C")
        self.assertEqual(score.midi_for(1, -1, pc), 48)
        self.assertEqual(score.midi_for(1, 0, pc), 60)
        self.assertEqual(score.midi_for(1, 1, pc), 72)
        self.assertEqual(score.midi_for(5, 1, pc) - score.midi_for(5, 0, pc), 12)

    def test_letter_is_not_pitch(self):
        # two events, same letter, different octave -> different pitch
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 1.0), (1, 1, 1.0)], key="1=C", tmp=tmp)
        self.assertEqual([e["midi"] for e in sc["sounding"]], [60, 72])


class TestValidation(unittest.TestCase):
    def _bad(self, notes, **kw):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(score.ScoreError) as ctx:
                make_score(notes, tmp=tmp, **kw)
        return str(ctx.exception)

    def test_missing_q(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = {"format": "jianpu2letter-notes-v1", "key": "1=C",
                    "tempo_qpm": 65.0,
                    "lines": [{"line": 3, "notes": [{"index": 7, "n": 1, "o": 0}]}]}
            path = os.path.join(tmp, "s.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            with self.assertRaises(score.ScoreError) as ctx:
                score.load_score(path)
        msg = str(ctx.exception)
        self.assertIn("L3 N7", msg)
        self.assertIn("q", msg)

    def test_zero_and_negative_q(self):
        self.assertIn("q must be > 0", self._bad([(1, 0, 0.0)]))
        self.assertIn("q must be > 0", self._bad([(1, 0, -0.5)]))

    def test_bad_tempo(self):
        for tempo in (0.0, -60.0, float("nan"), float("inf")):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(score.ScoreError) as ctx:
                    make_score([(1, 0, 1.0)], tempo=tempo, tmp=tmp)
            self.assertIn("tempo_qpm", str(ctx.exception))

    def test_unknown_note(self):
        self.assertIn("unknown note", self._bad([(1, 0, 1.0), (8, 0, 1.0)], ))
        self.assertIn("L1 N1", self._bad([(None, 0, 1.0)]))

    def test_ocr_unknown_keeps_its_time_as_silence(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, path = make_score([(1, 0, 1), (2, 0, .5), (3, 0, 1)], tempo=60, tmp=tmp)
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            data["lines"][0]["notes"][1].update(n=None, letter=None, unknown=True)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            with open(path, "rb") as fh:
                before = fh.read()
            sc = score.load_score(path)
            plan = score.build_plan(sc, lead=0, tail=0)
            with open(path, "rb") as fh:
                self.assertEqual(fh.read(), before)
            data["lines"][0]["notes"][1].update(n=0, unknown=False)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            rest_plan = score.build_plan(score.load_score(path), lead=0, tail=0)
        self.assertEqual(sc["sum_q"], 2.5)
        self.assertEqual([n["t"] for n in plan["landings"]], [0, 1.5])
        self.assertEqual(plan["duration"], 2.5)
        self.assertEqual(len(plan["boards"]), 2)
        self.assertEqual(plan["rests"][0]["onset_sec"], 1)
        self.assertEqual(plan["rests"][0]["dur_sec"], .5)
        self.assertTrue(plan["rests"][0]["unknown"])
        samples = audio.render(plan)
        # Existing notes may decay across a rest; the placeholder adds no voice.
        self.assertTrue((samples == audio.render(rest_plan)).all())

    def test_unknown_marker_does_not_hide_other_errors_or_valid_pitches(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, path = make_score([(1, 0, 1)], tmp=tmp)
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            note = data["lines"][0]["notes"][0]
            for n, marker in [(None, False), (True, True), ("3", True), (8, True)]:
                note.update(n=n, unknown=marker)
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump(data, fh)
                with self.assertRaises(score.ScoreError):
                    score.load_score(path)
            note.update(n=None, unknown=True, q=0)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            with self.assertRaisesRegex(score.ScoreError, "q must be > 0"):
                score.load_score(path)
            note.update(n=3, unknown=True, q=1)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            self.assertEqual(score.load_score(path)["sounding"][0]["n"], 3)

    def test_bad_key_and_format(self):
        self.assertIn("key", self._bad([(1, 0, 1.0)], key="1=H"))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"format": "other", "lines": []}, fh)
            with self.assertRaises(score.ScoreError) as ctx:
                score.load_score(path)
        self.assertIn("format", str(ctx.exception))


class TestTiming(unittest.TestCase):
    def test_onset_accumulates_absolute_not_rounded(self):
        # 0.25 q at 65 qpm = 0.230769... s; three of them must be exact
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 0.25)] * 3, tempo=65.0, tmp=tmp)
            plan = score.build_plan(sc, lead=1.0, tail=1.0, fps=30)
        step = 0.25 * 60.0 / 65.0
        for i, landing in enumerate(plan["landings"]):
            self.assertAlmostEqual(landing["t"], 1.0 + i * step, places=12)
        # landing[i] starts at i*step; the *end* of the third note is 3*step
        self.assertAlmostEqual(plan["landings"][2]["t"], 1.0 + 2 * step, places=12)
        self.assertAlmostEqual(plan["landings"][2]["t"] + plan["landings"][2]["dur"],
                               1.0 + 3 * step, places=12)
        # an onset lies between frames (never snapped): 1.0+step = 1.2307..., frame 36 = 1.2
        self.assertNotAlmostEqual(plan["landings"][1]["t"] * 30.0,
                                  round(plan["landings"][1]["t"] * 30.0), places=3)

    def test_frame_times_are_index_over_fps(self):
        times = score.frame_times(30, 1.0)
        self.assertEqual(len(times), 30)
        self.assertEqual(times[7], 7 / 30.0)
        self.assertEqual(times[-1], 29 / 30.0)

    def test_seconds_preview_truncates_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 4.0)] * 20, tempo=65.0, tmp=tmp)
            plan = score.build_plan(sc, seconds=12.0, fps=30)
        self.assertEqual(plan["duration"], 12.0)
        self.assertEqual(len(score.frame_times(plan["fps"], plan["duration"])), 360)

    def test_audio_onset_error_at_most_one_sample(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 0.25), (3, 1, 0.75), (0, 0, 1.0), (5, -1, 2.0)],
                               tempo=65.0, tmp=tmp)
            plan = score.build_plan(sc, lead=1.2, tail=1.0)
        for landing in plan["landings"]:
            idx = audio.onset_sample(landing["t"])
            err_samples = abs(idx / audio.SAMPLE_RATE - landing["t"]) * audio.SAMPLE_RATE
            self.assertLessEqual(err_samples, 1.0)

    def test_video_covers_last_landing(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 2.0)] * 5, tempo=65.0, tmp=tmp)
            plan = score.build_plan(sc, lead=1.2, tail=1.1, fps=30)
        n_frames = len(score.frame_times(plan["fps"], plan["duration"]))
        last = plan["landings"][-1]["t"] + plan["landings"][-1]["dur"]
        self.assertGreaterEqual(n_frames / plan["fps"], last)


class TestRestsAndRepeats(unittest.TestCase):
    def test_long_rest_can_be_compressed(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 1.0), (0, 0, 8.0), (3, 0, 1.0)], tempo=60.0, tmp=tmp)
            base = score.build_plan(sc, lead=0.0, tail=0.0)
            capped = score.build_plan(sc, lead=0.0, tail=0.0, max_rest=2.0)
        gap = lambda plan: plan["landings"][1]["t"] - plan["landings"][0]["t"]
        self.assertAlmostEqual(gap(base), 9.0, places=12)
        # The note itself still lasts 1 s; only the 8 s rest is capped to 2 s.
        self.assertAlmostEqual(gap(capped), 3.0, places=12)
        self.assertAlmostEqual(base["duration"] - capped["duration"], 6.0, places=12)
        self.assertAlmostEqual(len(audio.render(capped)) / audio.SAMPLE_RATE,
                               capped["duration"], places=6)

    def test_rest_consumes_time_without_landing(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 1.0), (0, 0, 2.0), (3, 0, 1.0)], tempo=60.0, tmp=tmp)
            plan = score.build_plan(sc, lead=0.0, tail=0.5)
        self.assertEqual(len(plan["landings"]), 2)
        self.assertEqual(len(plan["rests"]), 1)
        self.assertAlmostEqual(plan["landings"][1]["t"], 3.0, places=12)  # 1 + 2 quarters
        rest = plan["rests"][0]
        for landing in plan["landings"]:
            self.assertFalse(strikes_inside_rest(landing, rest),
                             "a landing happened during a rest")
        # the helper must actually catch an interior strike, not just near-misses
        ghost = dict(plan["landings"][0], t=2.0, onset_q=2.0)
        self.assertTrue(strikes_inside_rest(ghost, rest))

    def test_rests_never_emit_audio_onsets(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 1.0), (0, 0, 1.0), (0, 0, 1.0), (2, 0, 1.0)],
                               tempo=60.0, tmp=tmp)
            plan = score.build_plan(sc, lead=0.0, tail=0.2)
        onsets = sorted(audio.onset_sample(l["t"]) for l in plan["landings"])
        self.assertEqual(len(onsets), 2)
        self.assertEqual(onsets, [0, audio.onset_sample(3.0)])
        buf = audio.render(plan)
        # through the two rests (1..3 s) the sound only decays: no new attack
        sr = audio.SAMPLE_RATE
        step = int(0.01 * sr)
        lo, hi = int(1.05 * sr), int(2.95 * sr)
        windows = [float(abs(buf[i:i + step]).max()) for i in range(lo, hi, step)]
        for prev, nxt in zip(windows, windows[1:]):
            self.assertLessEqual(nxt, prev * 1.08 + 1e-4)

    def test_repeated_pitch_stays_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(5, 0, 0.5), (5, 0, 0.5), (5, 0, 0.5)], tempo=65.0, tmp=tmp)
            plan = score.build_plan(sc, lead=0.0, tail=0.2)
        self.assertEqual(len(plan["landings"]), 3)
        xs = [b["pos"][0] for b in plan["boards"]]
        self.assertEqual(len(set(xs)), 3)
        ts = [l["t"] for l in plan["landings"]]
        self.assertEqual(len(set(ts)), 3)
        samples = [audio.onset_sample(t) for t in ts]
        self.assertEqual(len(set(samples)), 3)
        self.assertEqual(len({l["midi"] for l in plan["landings"]}), 1)

    def test_lead_in_silence(self):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score([(1, 0, 1.0)] * 4, tempo=60.0, tmp=tmp)
            plan = score.build_plan(sc, lead=1.2, tail=0.5)
        buf = audio.render(plan)
        self.assertEqual(float(abs(buf[: int(1.0 * audio.SAMPLE_RATE)]).max()), 0.0)
        self.assertGreater(float(abs(buf).max()), 0.1)


class TestMotion(unittest.TestCase):
    def _plan(self, notes, **kw):
        with tempfile.TemporaryDirectory() as tmp:
            sc, _ = make_score(notes, tmp=tmp, **kw)
            return score.build_plan(sc, lead=1.2, tail=1.0, fps=30)

    def test_landing_is_exactly_on_the_board(self):
        plan = self._plan([(1, 0, 1.0), (3, 1, 0.5), (0, 0, 1.0), (7, -1, 2.0)])
        for landing in plan["landings"]:
            got = score.sample_ball(plan, landing["t"])
            for a, b in zip(got, landing["ball_pos"]):
                self.assertAlmostEqual(a, b, places=9)
            self.assertAlmostEqual(landing["ball_pos"][1] - landing["top_y"],
                                   plan["constants"]["ball_r"], places=12)

    def test_ball_is_above_boards_between_landings(self):
        plan = self._plan([(1, 0, 0.5), (2, 0, 0.5), (3, 0, 0.5), (4, 0, 0.5)])
        for t in [i / 60.0 for i in range(1, 480)]:
            p = score.sample_ball(plan, t)
            lo = min(l["ball_pos"][1] for l in plan["landings"]) - 1e-9
            self.assertGreaterEqual(p[1], lo)

    def test_hop_endpoints_are_continuous(self):
        plan = self._plan([(1, 0, 0.5), (5, 1, 1.0), (2, -1, 0.25)])
        for seg in plan["segments"]:
            if seg["kind"] != "hop":
                continue
            self.assertAlmostEqual(score.sample_ball(plan, seg["t0"])[1], seg["p0"][1],
                                   places=9)
            self.assertAlmostEqual(score.sample_ball(plan, seg["t1"])[1], seg["p1"][1],
                                   places=9)

    def test_no_teleport_between_frames(self):
        plan = self._plan([(1, 0, 0.25), (7, 1, 0.25), (2, -1, 2.0), (0, 0, 0.5),
                           (3, 0, 0.25)], tempo=65.0)
        fps = plan["fps"]
        times = score.frame_times(fps, plan["duration"])
        max_step = 0.0
        for t in times:
            a, b = score.sample_ball(plan, t), score.sample_ball(plan, t + 1.0 / fps)
            max_step = max(max_step, math.dist(a, b))
        # analytic speed bound: horizontal travel plus the steepest arc slope
        # (|dy/dt| <= |dy_line|/span + 4h/span), all over the flight span
        worst = 0.0
        for s in plan["segments"]:
            if s["kind"] != "hop":
                continue
            span = max(1e-6, s["t1"] - s["t0"])
            dx, dz = abs(s["p1"][0] - s["p0"][0]), abs(s["p1"][2] - s["p0"][2])
            dy = abs(s["p1"][1] - s["p0"][1])
            worst = max(worst, (math.hypot(dx, dz) + dy + 4.0 * s["h"]) / span)
        self.assertLessEqual(max_step, worst / fps * 1.05 + 1e-9)

    def test_long_notes_do_not_leap(self):
        plan = self._plan([(1, -1, 8.0), (1, 1, 0.25), (7, 0, 4.0)])
        step_h = plan["constants"]["height_per_semitone"]
        clamp = plan["constants"]["pitch_clamp_semitones"]
        for a, b in zip(plan["boards"], plan["boards"][1:]):
            self.assertLessEqual(abs(b["top_y"] - a["top_y"]), clamp * step_h + 1e-9)
            self.assertAlmostEqual(b["pos"][0] - a["pos"][0],
                                   plan["constants"]["spacing"], places=9)
        for seg in plan["segments"]:
            if seg["kind"] == "hop":
                self.assertLessEqual(seg["h"], plan["constants"]["max_hop_height"] + 1e-9)

    def test_segments_are_contiguous_and_start_at_zero(self):
        for notes in ([(1, 0, 1.0), (2, 0, 0.5), (0, 0, 1.0), (5, 1, 0.25)],
                      [(3, 0, 0.25)],
                      [(1, 0, 4.0), (0, 0, 4.0)]):
            plan = self._plan(notes)
            segs = plan["segments"]
            self.assertTrue(score.check_segments(plan))
            self.assertEqual(segs[0]["t0"], 0.0)
            for a, b in zip(segs, segs[1:]):
                self.assertAlmostEqual(b["t0"], a["t1"], places=12)
            self.assertGreaterEqual(segs[-1]["t1"], plan["duration"] - 1e-9)

    def test_no_time_falls_through_to_the_last_board(self):
        plan = self._plan([(1, 0, 0.5), (2, 0, 0.5), (3, 0, 2.0), (0, 0, 1.0), (4, 0, 0.25)],
                          tempo=65.0)
        for i in range(int(plan["duration"] * 120)):
            t = i / 120.0
            seg = score._segment_at(plan, t)
            self.assertLessEqual(seg["t0"], t + 1e-12)
            self.assertGreaterEqual(seg["t1"], t - 1e-12)

    def test_ball_travels_monotonically_between_landings(self):
        plan = self._plan([(1, 0, 0.5), (7, 1, 0.25), (2, -1, 2.0), (0, 0, 0.5),
                           (3, 0, 0.25)], tempo=65.0)
        landings = plan["landings"]
        # (x0, t0, x1, t1) for the lead-in run-up and for every landing-to-landing gap
        spans = [(plan["pad"]["ball_pos"][0], 0.0,
                  landings[0]["ball_pos"][0], landings[0]["t"])]
        spans += [(a["ball_pos"][0], a["t"], b["ball_pos"][0], b["t"])
                  for a, b in zip(landings, landings[1:])]
        for x0, t0, x1, t1 in spans:
            for u in [k / 20.0 for k in range(21)]:
                x = score.sample_ball(plan, t0 + u * (t1 - t0))[0]
                self.assertGreaterEqual(x, min(x0, x1) - 1e-9)
                self.assertLessEqual(x, max(x0, x1) + 1e-9)

    def test_first_note_has_a_visible_arriving_hop(self):
        plan = self._plan([(1, 0, 1.0), (2, 0, 1.0)])
        pad = plan["pad"]
        first = plan["landings"][0]
        self.assertLess(pad["ball_pos"][0], first["ball_pos"][0])
        start = score.sample_ball(plan, 0.0)
        for x, y in zip(start, pad["ball_pos"]):
            self.assertAlmostEqual(x, y, places=9)
        # airborne halfway through the arriving hop (parabola peak, not a flash)
        mid = first["t"] - score.START_HOP_MAX * 0.5
        self.assertGreater(score.sample_ball(plan, mid)[1],
                           max(pad["ball_pos"][1], first["ball_pos"][1]) + 0.1)
        # and it lands exactly on board 0 at the first onset
        for x, y in zip(score.sample_ball(plan, first["t"]), first["ball_pos"]):
            self.assertAlmostEqual(x, y, places=9)

    def test_boards_stay_above_the_ground(self):
        # extremes of the clamp: the lowest board must still leave room for a post
        plan = self._plan([(1, -1, 1.0), (7, 1, 1.0), (1, 1, 1.0), (7, -3, 1.0)])
        for b in plan["boards"]:
            self.assertGreater(b["top_y"] - plan["constants"]["board_h"], 0.05)

    def test_nearest_frame_within_one_frame_of_every_landing(self):
        plan = self._plan([(1, 0, 0.25), (2, 0, 0.75), (3, 0, 1.0), (4, 0, 0.5)],
                          tempo=65.0)
        fps = plan["fps"]
        n = len(score.frame_times(fps, plan["duration"]))
        for landing in plan["landings"]:
            idx = min(range(n), key=lambda i: abs(i / fps - landing["t"]))
            self.assertLessEqual(abs(idx / fps - landing["t"]), 0.5 / fps + 1e-9)
            self.assertLess(idx / fps, plan["duration"])


class TestFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.isfile(FIXTURE):
            raise unittest.SkipTest("fixture %s not present" % FIXTURE)
        cls.score = score.load_score(FIXTURE)
        cls.plan = score.build_plan(cls.score, lead=1.2, tail=1.1, fps=30)

    def test_documented_counts(self):
        s = self.score
        self.assertEqual(s["line_count"], 13)
        self.assertEqual(len(s["events"]), 377)
        self.assertEqual(len(s["sounding"]), 335)
        self.assertEqual(len(s["rests"]), 42)
        self.assertEqual(s["sum_q"], 188.0)
        self.assertEqual(s["tempo_qpm"], 65.0)
        self.assertAlmostEqual(s["score_duration"], 188.0 * 60.0 / 65.0, places=9)
        p = self.plan
        self.assertEqual(p["counts"], {"lines": 13, "events": 377,
                                       "sounding": 335, "rests": 42})
        self.assertEqual(len(p["landings"]), 335)
        self.assertEqual(len(p["boards"]), 335)

    def test_first_landing_and_event_accumulation(self):
        p = self.plan
        self.assertEqual(p["events"][0]["kind"], "note")
        self.assertAlmostEqual(p["landings"][0]["t"], 1.2, places=9)
        cum = 0.0
        for ev in p["events"][:20]:
            self.assertAlmostEqual(ev["onset_sec"], 1.2 + cum * 60.0 / 65.0, places=9)
            cum += ev["q"]

    def test_lyrics_are_carried_but_not_needed_for_rendering(self):
        # the fixture has lyric text; we keep it in the plan but the renderer
        # draws no text (Blender's bundled font has no CJK glyphs)
        self.assertTrue(any(ev.get("lyric") for ev in self.plan["events"]))

    def test_no_landing_inside_a_rest(self):
        p = self.plan
        for r in p["rests"]:
            for landing in p["landings"]:
                self.assertFalse(strikes_inside_rest(landing, r),
                                 "landing at t=%r is a ghost strike inside rest %s"
                                 % (landing["t"], r["where"]))

    def test_reviewer_repro_is_on_board_zero(self):
        # repro from REVIEW_1: this returned x=350.7 (the last board) because the
        # dwell interval had no segment and sample_ball fell through
        t = 1.3153846153846154
        p = score.sample_ball(self.plan, t)
        self.assertAlmostEqual(p[0], 0.0, places=9)
        self.assertAlmostEqual(p[1], self.plan["landings"][0]["ball_pos"][1], places=9)
        self.assertAlmostEqual(p[2], self.plan["landings"][0]["ball_pos"][2], places=9)

    def test_segments_cover_every_dwell_and_the_whole_duration(self):
        p = self.plan
        self.assertTrue(score.check_segments(p))
        landings = p["landings"]
        for a in landings[:-1]:
            gap = landings[a["i"] + 1]["t"] - a["t"]
            dwell = min(a["dur"], gap * 0.5, score.MAX_DWELL)
            holds = [s for s in p["segments"] if s["kind"] == "hold"
                     and abs(s["t0"] - a["t"]) < 1e-9
                     and abs(s["t1"] - (a["t"] + dwell)) < 1e-9]
            self.assertEqual(len(holds), 1,
                             "no hold segment covering the dwell after landing %d" % a["i"])
            for u in (0.0, 0.5, 1.0):
                got = score.sample_ball(p, a["t"] + u * dwell)
                for x, y in zip(got, a["ball_pos"]):
                    self.assertAlmostEqual(x, y, places=9)

    def test_audio_render_matches_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = score.build_plan(self.score, lead=0.2, tail=0.2, seconds=3.0)
            path = os.path.join(tmp, "a.wav")
            audio.render_to_wav(plan, path)
            with wave.open(path, "rb") as fh:
                self.assertEqual(fh.getnchannels(), 1)
                self.assertEqual(fh.getsampwidth(), 2)
                self.assertEqual(fh.getframerate(), audio.SAMPLE_RATE)
                self.assertEqual(fh.getnframes(), int(round(3.0 * audio.SAMPLE_RATE)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
