"""The export CLI accepts each layout's real track statistics before encoding."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ball3d import make_realtime_video as cli


class BrowserReached(Exception):
    pass


class RealtimeExportTests(unittest.TestCase):
    def setUp(self):
        work = Path(self.enterContext(tempfile.TemporaryDirectory()))
        score = work / "notes.json"
        score.write_text(json.dumps({
            "format": "jianpu2letter-notes-v1", "key": "1=C", "tempo_qpm": 60,
            "lines": [{"notes": [{"n": 1, "q": 1}, {"n": 2, "q": 1}]}],
        }), encoding="utf-8")
        self.argv = ["--input", str(score), "--output", str(work / "clip.mp4"),
                     "--seconds", "0.1"]
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))
        self.enterContext(patch.object(cli.audio, "render_to_wav"))
        self.enterContext(patch.object(cli, "check_realtime_install"))
        self.enterContext(patch.object(cli, "find_node", return_value="node"))
        self.tracks = dict(long=0, glissando=0, carried_notes=0, total_notes=2,
                           ratio=0, longest_widths=0, shortened=0)

    def assert_reaches_browser(self, tracks):
        def run(cmd, **kwargs):
            if cmd[1] == cli.SESSION_SCRIPT:
                raise BrowserReached()
            self.assertTrue(cmd[1].endswith("solve_layout.mjs"))
            Path(cmd[cmd.index("--json") + 1]).write_text(
                json.dumps({"audit": {"tracks": tracks}}), encoding="utf-8")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

        with patch.object(cli.subprocess, "run", side_effect=run) as spawn:
            with self.assertRaises(BrowserReached):
                cli.main(self.argv)
        self.assertEqual(spawn.call_count, 2)
        self.assertEqual(spawn.call_args.args[0][1], cli.SESSION_SCRIPT)

    def test_layered_tracks_with_gap_but_no_threshold_reach_browser(self):
        self.assert_reaches_browser(dict(self.tracks, gap=0, rejected_unsafe=[]))

    def test_wall_tracks_with_gap_threshold_reach_browser(self):
        self.assert_reaches_browser(dict(self.tracks, gap=2, gap_threshold=.875,
                                        delta0=.25, rejected_unsafe=[]))

    def test_free_tracks_without_gap_reach_browser(self):
        self.assert_reaches_browser(self.tracks)

    def test_failed_solve_gate_prevents_browser_encoding(self):
        failed = subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"unsafe layout")
        with patch.object(cli.subprocess, "run", return_value=failed) as spawn:
            self.assertEqual(cli.main(self.argv), cli.EXIT_INPUT)
        self.assertEqual(spawn.call_count, 1)
        self.assertTrue(spawn.call_args.args[0][1].endswith("solve_layout.mjs"))


if __name__ == "__main__":
    unittest.main()
