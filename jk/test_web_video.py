import os
import tempfile
import unittest
from unittest.mock import Mock, patch

import webapp


class WebVideoTests(unittest.TestCase):
    def test_styles_dispatch_and_video_delivery(self):
        with tempfile.TemporaryDirectory() as work:
            song = {"title": "测试歌", "tempo_qpm": 100}
            client = webapp.app.test_client()
            for style in ("tiles", "play", "music-machine"):
                with self.subTest(style=style):
                    proc = Mock()
                    proc.poll.return_value = None
                    output = os.path.join(work, style + ".mp4")
                    with patch.dict(webapp._RENDER, {"proc": None}), \
                         patch.object(webapp, "WORK", work), \
                         patch.object(webapp, "_song_index", return_value={"song": song}), \
                         patch.object(webapp, "_video_path", return_value=output), \
                         patch.object(webapp.subprocess, "Popen", return_value=proc) as spawn:
                        response = client.post("/api/video", json={"base": "song", "style": style})
                        self.assertEqual(response.status_code, 200)
                        rid = response.json["rid"]
                        cmd = spawn.call_args.args[0]
                        self.assertIn(os.path.join(webapp.LIB, "song_notes.json"), cmd)
                        if style == "music-machine":
                            self.assertIn(os.path.join(webapp.HERE, "ball3d", "make_realtime_video.py"), cmd)
                            self.assertIn("--input", cmd)
                            self.assertIn("--clean", cmd)
                        else:
                            self.assertIn(os.path.join(webapp.HERE, "make_video.py"), cmd)
                        self.assertEqual(client.get("/api/video/" + rid).json["state"], "running")
                        self.assertEqual(client.post("/api/video", json={"base": "song", "style": style}).status_code, 409)
                        with open(output, "wb") as fp:
                            fp.write(b"video-result")
                        proc.poll.return_value = 0
                        result = client.get("/api/video/" + rid).json
                        self.assertEqual(result["state"], "done")
                        with client.get(result["url"]) as video:
                            self.assertEqual(video.data, b"video-result")
                        proc.poll.return_value = 1
                        self.assertEqual(client.get("/api/video/" + rid).json["state"], "failed")


if __name__ == "__main__":
    unittest.main()
