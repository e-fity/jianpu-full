"""CLI regressions: validation, per-run temp dirs, frame bounds, batch collisions.

No Blender is needed: --plan-only exercises load -> plan -> WAV end to end.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
BALL3D = os.path.dirname(HERE)
sys.path.insert(0, BALL3D)

import make_ball_video as cli  # noqa: E402
import score  # noqa: E402

NOTES = [(1, 0, 0.5), (2, 0, 0.5), (0, 0, 1.0), (5, 1, 1.0), (3, -1, 0.5)]


def write_score(tmp, name="score_notes.json", tempo=65.0):
    data = {"format": "jianpu2letter-notes-v1", "title": "t", "key": "1=B",
            "tempo_qpm": tempo,
            "lines": [{"line": 1, "notes": [
                {"line": 1, "index": i + 1, "n": n, "o": o, "q": q, "letter": "D"}
                for i, (n, o, q) in enumerate(NOTES)]}]}
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    return path


class TestValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.input = write_score(self.tmp)
        self.out = os.path.join(self.tmp, "v.mp4")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def check(self, **kw):
        args = dict(fps=30, width=360, height=640, seconds=None, lead=1.2,
                    tail=1.1, samples=32)
        args.update(kw)
        out = args.pop("out", self.out)
        inp = args.pop("inp", self.input)
        return cli.validate_job(inp, out, **args)

    def test_accepts_a_normal_job(self):
        self.assertTrue(self.check())

    def test_output_must_be_mp4(self):
        with self.assertRaises(cli.CliError):
            self.check(out=os.path.join(self.tmp, "v.avi"))

    def test_input_output_alias_is_rejected(self):
        # same file through a different spelling must not be overwritten
        alias = os.path.join(self.tmp, ".", os.path.basename(self.input))
        with self.assertRaises(cli.CliError):
            self.check(out=alias)
        self.assertTrue(cli.same_path(self.input, alias))

    def test_output_directory_is_rejected(self):
        with self.assertRaises(cli.CliError):
            self.check(out=self.tmp)

    def test_odd_dimensions_are_rejected_for_yuv420p(self):
        for w, h in ((361, 640), (360, 639)):
            with self.assertRaises(cli.CliError):
                self.check(width=w, height=h)

    def test_bad_numbers_are_rejected(self):
        for kw in (dict(fps=0), dict(fps=-30), dict(width=0), dict(samples=0),
                   dict(samples=-1), dict(lead=-0.1), dict(tail=-1.0),
                   dict(lead=float("nan")), dict(tail=float("inf")),
                   dict(seconds=0.0), dict(seconds=-2.0), dict(seconds=float("nan")),
                   dict(seconds=float("inf"))):
            with self.assertRaises(cli.CliError, msg=kw):
                self.check(**kw)

    def test_missing_input_is_rejected(self):
        with self.assertRaises(cli.CliError):
            self.check(inp=os.path.join(self.tmp, "nope.json"))


class TestFramesAndSeconds(unittest.TestCase):
    def test_expected_frames_matches_score_frame_times(self):
        for duration in (0.5, 3.0, 12.0, 173.53846153846155):
            for fps in (24, 30, 60):
                self.assertEqual(cli.expected_frames(duration, fps),
                                 len(score.frame_times(fps, duration)))

    def test_seconds_is_capped_to_the_score_length(self):
        self.assertIsNone(cli.cap_seconds(None, 100.0))
        self.assertEqual(cli.cap_seconds(12.0, 100.0), 12.0)
        self.assertEqual(cli.cap_seconds(500.0, 10.0), 10.0)
        self.assertEqual(cli.cap_seconds(10.0, 10.0), 10.0)

    def test_natural_duration_matches_the_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_score(tmp)
            sc = score.load_score(path)
        natural = cli.natural_duration(sc, 1.2, 1.1)
        plan = score.build_plan(sc, lead=1.2, tail=1.1)
        self.assertAlmostEqual(natural, plan["duration"], places=9)


class TestWorkDirAndBatch(unittest.TestCase):
    def test_work_dir_is_unique_and_verified_inside_the_output_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "v.mp4")
            first = cli.make_work_dir(out, "v")
            second = cli.make_work_dir(out, "v")
            self.assertNotEqual(first, second)          # no stale reuse
            for work in (first, second):
                self.assertEqual(os.path.dirname(work), os.path.realpath(tmp))
                self.assertTrue(os.path.isdir(work))
                self.assertTrue(os.path.basename(work).startswith("v.ball3d."))
            shutil.rmtree(first)
            self.assertFalse(os.path.exists(first))
            self.assertTrue(os.path.isdir(second))

    def test_batch_collisions_are_rejected_before_rendering(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = os.path.join(tmp, "a")
            b = os.path.join(tmp, "b")
            os.makedirs(a)
            os.makedirs(b)
            one = write_score(a)
            two = write_score(b)                        # same basename
            out_dir = os.path.join(tmp, "out")
            fn = lambda p: cli.output_for(out_dir, p)   # noqa: E731
            with self.assertRaises(cli.CliError):
                cli.check_batch_collisions([one, two], fn)
            cli.check_batch_collisions([one], fn)       # a single input is fine

    def test_batch_list_skips_comments_and_caps_the_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = [write_score(tmp, "s%d_notes.json" % i) for i in range(4)]
            listing = os.path.join(tmp, "list.txt")
            with open(listing, "w", encoding="utf-8") as fh:
                fh.write("# inputs\n\n" + "\n".join(paths) + "\n")
            self.assertEqual(cli.batch_inputs(listing, 3), paths[:3])
            with self.assertRaises(cli.CliError):
                cli.batch_inputs(os.path.join(tmp, "missing.txt"), 3)

    def test_blender_discovery_lists_the_installed_build(self):
        cands = cli.blender_candidates()
        self.assertTrue(any("blender-4.5.3" in c for c in cands), cands)


class TestPlanOnlyRun(unittest.TestCase):
    def test_plan_only_writes_a_consistent_plan_and_wav(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_score(tmp)
            out = os.path.join(tmp, "v.mp4")
            rc = cli.main(["--input", path, "--output", out, "--plan-only",
                           "--seconds", "1"])
            self.assertEqual(rc, cli.EXIT_OK)
            works = [d for d in os.listdir(tmp) if d.startswith("v.ball3d.")]
            self.assertEqual(len(works), 1)
            work = os.path.join(tmp, works[0])
            plan_path = os.path.join(work, "plan.json")
            wav_path = os.path.join(work, "audio.wav")
            self.assertTrue(os.path.isfile(plan_path))
            self.assertTrue(os.path.isfile(wav_path))

            plan = score.load_plan(plan_path)
            self.assertTrue(score.check_segments(plan))
            self.assertEqual(plan["duration"], 1.0)
            self.assertEqual(plan["counts"]["sounding"], 4)
            self.assertEqual(plan["counts"]["rests"], 1)
            with wave.open(wav_path, "rb") as fh:
                self.assertEqual(fh.getframerate(), 44100)
                self.assertEqual(fh.getnframes(), int(round(1.0 * 44100)))
                self.assertEqual(fh.getnchannels(), 1)
            self.assertFalse(os.path.exists(out))       # nothing was rendered

    def test_missing_blender_reports_clearly(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_score(tmp)
            out = os.path.join(tmp, "v.mp4")
            rc = cli.main(["--input", path, "--output", out, "--seconds", "1",
                           "--blender", os.path.join(tmp, "no-such-blender.exe")])
            self.assertEqual(rc, cli.EXIT_NO_BLENDER)
            self.assertFalse(os.path.exists(out))

    def test_plan_only_never_overwrites_the_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_score(tmp)
            rc = cli.main(["--input", path, "--output", path, "--plan-only"])
            self.assertEqual(rc, cli.EXIT_INPUT)
            with open(path, "r", encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["format"], "jianpu2letter-notes-v1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
