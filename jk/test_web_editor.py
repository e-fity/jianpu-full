"""3D 编辑页的接口回归：参数、并发、冻结、失败不糊弄。

这一层管的是「服务端有没有把关」：非法设置必须 400、畸形 JSON 不能变成
500、一次只跑一个导出、任务目录唯一且输入被复制冻结、失败绝不回退到旧视频、
设置文件能存能下能导入。真实浏览器行为在 realtime/tools/editor_check.mjs。
"""

import json
import os
import tempfile
import unittest
from unittest.mock import Mock, patch

import webapp  # noqa: F401  （它会把 ball3d 加进 sys.path）
import editor_settings


class EditorSettingsUnitTests(unittest.TestCase):
    """Python 侧的校验和 JS 侧同源：schema 一漂移，这里就红。"""

    def test_schema_file_matches_js(self):
        import subprocess
        node = webapp._node_exe()
        root = os.path.join(webapp.BALL3D, "realtime", "tools", "dump_schema.mjs")
        proc = subprocess.run([node, root, "--check"], capture_output=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stdout.decode("utf-8", "replace"))

    def test_defaults_and_strict_errors(self):
        self.assertEqual(editor_settings.normalize_settings(None),
                         editor_settings.normalize_settings({}))
        base = editor_settings.normalize_settings(
            {"geometry": {"board_w": 0.36}, "visuals": {"exposure": 1.2}})
        self.assertEqual(base["geometry"]["board_w"], 0.36)
        # 只收用户能调的旋钮；联动出来的接触点由 JS 从板宽算（board_w/2）
        self.assertEqual(sorted(base["geometry"]),
                         ["ball_r", "board_d", "board_w", "bounce", "spacing"])
        self.assertEqual(base["visuals"]["exposure"], 1.2)
        for bad in ([], "hello", 3,
                    {"geometry": {"nope": 1}},
                    {"extra": 1},
                    {"schema": "web-editor-99"},
                    {"visuals": {"shadows": "yes"}},
                    {"visuals": {"wall_color": "blue"}},
                    {"visuals": {"exposure": "亮"}},
                    {"geometry": {"board_w": 0.99}}):
            with self.assertRaises(editor_settings.SettingsError, msg=repr(bad)):
                editor_settings.normalize_settings(bad)
        # 传进来的对象被改过，也不影响已经校验出来的那份
        payload = {"geometry": {"board_w": 0.36}}
        out = editor_settings.normalize_settings(payload)
        payload["geometry"]["board_w"] = 0.24
        self.assertEqual(out["geometry"]["board_w"], 0.36)

    def test_null_means_default_like_the_js_side(self):
        out = editor_settings.normalize_settings({"geometry": {"board_w": None}})
        self.assertEqual(out["geometry"]["board_w"],
                         editor_settings.defaults()["geometry"]["board_w"])

    def test_frames_use_the_encoder_contract(self):
        # 和 realtime/src/settings.mjs / make_ball_video.expected_frames 同一把尺子
        self.assertEqual(editor_settings.expected_frames(0.501, 30), 16)
        self.assertEqual(editor_settings.expected_frames(175.8384615, 30), 5276)
        self.assertEqual(editor_settings.expected_frames(0.1 * 3, 30), 9)
        self.assertEqual(editor_settings.normalize_video(
            {"seconds": 175.8385276, "fps": 30})["frames"], 5276)
        self.assertEqual(editor_settings.normalize_video(
            {"seconds": 10, "fps": 60})["frames"], 600)

    def test_render_timeout_scales_with_pixels_and_frames(self):
        ten_720p30 = editor_settings.normalize_video({"seconds": 10, "fps": 30})
        ten_1080p60 = editor_settings.normalize_video(
            {"size": "1080x1920", "seconds": 10, "fps": 60})
        full_720p30 = editor_settings.normalize_video({"seconds": 175.8385276})
        short = webapp._render_timeout(ten_720p30)
        big = webapp._render_timeout(ten_1080p60)
        full = webapp._render_timeout(full_720p30)
        # 默认那档不小于 CLI 的老默认 300s，也不至于短到插一段 10 秒的片子
        self.assertGreaterEqual(short, 300.0)
        self.assertGreater(big, short * 3)          # 4.5 倍工作量不能还是 300s
        self.assertGreater(full, big)
        self.assertLessEqual(full, webapp._RENDER_MAX_TIMEOUT)

    def test_video_and_bitrate(self):
        video = editor_settings.normalize_video(
            {"size": "1080x1920", "fps": 30, "seconds": 10, "start": 1.5})
        self.assertEqual((video["width"], video["height"], video["frames"]),
                         (1080, 1920, 300))
        self.assertEqual(video["bitrate"], editor_settings.matched_bitrate(1080, 1920, 30))
        for bad in ([720, 1280], "720x1280",
                    {"size": "__proto__"}, {"size": "720x1281"},
                    {"fps": 25}, {"seconds": 0.2}, {"bitrate": 5},
                    {"start": -1}, {"start": float("nan")}):
            with self.assertRaises(editor_settings.SettingsError, msg=repr(bad)):
                editor_settings.normalize_video(bad)


class EditorApiTests(unittest.TestCase):
    def test_layout_worker_resource(self):
        with tempfile.TemporaryDirectory() as work:
            worker = os.path.join(work, "layout-worker.js")
            with patch.object(webapp, "EDITOR_LAYOUT_WORKER", worker):
                with webapp.app.test_client() as client:
                    self.assertEqual(client.get("/editor/layout-worker.js").status_code, 503)
                    with open(worker, "w", encoding="utf-8") as fp:
                        fp.write("self.onmessage = () => {};")
                    with client.get("/editor/layout-worker.js") as response:
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.mimetype, "text/javascript")
                        self.assertIn(b"self.onmessage", response.data)
                        self.assertIn("no-cache", response.headers["Cache-Control"])

    def setUp(self):
        self.client = webapp.app.test_client()
        self.song = {"title": "测试歌", "tempo_qpm": 100,
                     "counts": {"letters": 8, "rests": 1, "total": 9}}
        # 放在工程目录下面：接口返回的是相对 HERE 的路径，跨盘符会算不出来
        self.work = tempfile.TemporaryDirectory(dir=webapp.HERE, prefix="_editor_test_")
        self.addCleanup(self.work.cleanup)
        self.runs = os.path.join(self.work.name, "runs")
        os.makedirs(self.runs, exist_ok=True)
        self.patch = patch.multiple(
            webapp,
            LIB=os.path.join(self.work.name, "lib"),
            EDITOR_RUNS=self.runs,
            EDITOR_SAVED=os.path.join(self.work.name, "settings"),
            EDITOR_IMPORTS=os.path.join(self.work.name, "imports"),
            EDITOR_OUT=self.work.name,
            _song_index=Mock(return_value={"song": self.song}),
        )
        self.patch.start()
        self.addCleanup(self.patch.stop)
        os.makedirs(webapp.LIB, exist_ok=True)
        self.score = os.path.join(webapp.LIB, "song_notes.json")
        with open(self.score, "w", encoding="utf-8") as fp:
            json.dump({"title": "测试歌", "format": "jianpu2letter-notes-v1"}, fp)
        self._finish_export()
        webapp._RENDER.update({"proc": None, "rid": None, "base": None, "title": "",
                               "log": None, "out": None, "started": 0.0})

    def tearDown(self):
        # 一个测试里挂着的替身进程不许漏给下一个测试
        self._finish_export()
        webapp._RENDER["proc"] = None

    # ── 非法输入 ─────────────────────────────────────────────────────────
    def test_malformed_json_is_400_not_500(self):
        for body in ([1], "hello", 3):
            for url in ("/api/editor/solve", "/api/editor/export",
                        "/api/editor/settings/名字"):
                with self.subTest(body=body, url=url):
                    resp = self.client.post(url, json=body)
                    self.assertEqual(resp.status_code, 400, resp.data[:200])
        for payload in ({"base": ["song"]}, {"base": 5},
                        {"base": "song", "video": [1]},
                        {"base": "song", "settings": [1]},
                        {"base": "song", "label": ["x"]},
                        {"base": "song", "import": {"a": 1}}):
            with self.subTest(payload=payload):
                resp = self.client.post("/api/editor/export", json=payload)
                self.assertEqual(resp.status_code, 400, resp.data[:200])

    def test_bad_settings_are_rejected_with_reasons(self):
        for url in ("/api/editor/solve", "/api/editor/export"):
            resp = self.client.post(url, json={
                "base": "song", "settings": {"geometry": {"board_w": 9}}})
            self.assertEqual(resp.status_code, 400)
            body = resp.get_json()
            self.assertFalse(body["ok"])
            self.assertTrue(body["errors"])
            self.assertIn("board_w", " ".join(body["errors"]))
        resp = self.client.post("/api/editor/settings/名字",
                                json={"settings": {"visuals": {"wood": 9}}})
        self.assertEqual(resp.status_code, 400)

    def test_plan_keeps_ocr_unknown_as_silent_time(self):
        payload = {"format": "jianpu2letter-notes-v1", "title": "unknown test",
                   "key": "1=C", "tempo_qpm": 60,
                   "lines": [{"line": 1, "notes": [
                       {"n": 1, "q": 1},
                       {"n": None, "unknown": True, "q": .5},
                       {"n": 3, "q": 1}]}]}
        with open(self.score, "w", encoding="utf-8") as fp:
            json.dump(payload, fp)
        resp = self.client.get("/api/editor/plan?base=song")
        self.assertEqual(resp.status_code, 200, resp.data[:300])
        plan = resp.get_json()["plan"]
        self.assertEqual(plan["counts"]["sounding"], 2)
        self.assertEqual(plan["counts"]["rests"], 1)
        self.assertAlmostEqual(plan["landings"][1]["t"], 2.7)
        self.assertTrue(plan["rests"][0]["unknown"])
        self.assertEqual(plan["rests"][0]["dur_sec"], .5)
        with open(self.score, encoding="utf-8") as fp:
            self.assertEqual(json.load(fp), payload)

    def test_unknown_song_and_import_are_404(self):
        self.assertEqual(self.client.post(
            "/api/editor/solve", json={"base": "nope"}).status_code, 404)
        self.assertEqual(self.client.get(
            "/api/editor/plan?import=zzzz").status_code, 404)
        self.assertEqual(self.client.post(
            "/api/editor/solve", json={}).status_code, 404)
        self.assertEqual(self.client.get(
            "/api/editor/plan?base=../../etc/passwd").status_code, 404)

    # ── 一次一个导出，目录唯一，输入被冻结 ──────────────────────────────
    def _finish_export(self):
        """把上一次任务的占用清掉，好让下一次请求真的走到校验分支。"""
        webapp._EXPORT.update({"proc": None, "state": "idle", "rid": None,
                               "dir": None, "log": None, "out": None, "label": ""})

    def _start_export(self, **extra):
        body = {"base": "song", "settings": {"geometry": {"board_w": 0.36}},
                "video": {"size": "720x1280", "fps": 30, "seconds": 4, "start": 0},
                "label": "sample"}
        body.update(extra)
        proc = Mock()
        proc.poll.return_value = None
        with patch.object(webapp, "_editor_plan", return_value={"duration": 100.0}), \
             patch.object(webapp, "_run_logged", return_value=proc) as spawn, \
             patch.object(webapp.os.path, "isfile", return_value=True):
            resp = self.client.post("/api/editor/export", json=body)
        return resp, (spawn.call_args.args[0] if spawn.called else None)

    def test_export_freezes_song_and_settings_into_the_job_dir(self):
        resp, cmd = self._start_export()
        self.assertEqual(resp.status_code, 200, resp.data[:300])
        self.assertIsNotNone(cmd)
        rid = resp.get_json()["rid"]
        run_dir = os.path.join(self.runs, rid)
        frozen = cmd[cmd.index("--input") + 1]
        self.assertTrue(frozen.startswith(run_dir),
                        "曲谱必须先复制进任务目录再渲染：%s" % frozen)
        self.assertNotEqual(os.path.abspath(frozen), os.path.abspath(self.score))
        with open(frozen, "r", encoding="utf-8") as fp:
            self.assertEqual(json.load(fp)["title"], "测试歌")
        with open(os.path.join(run_dir, "settings.json"), "r", encoding="utf-8") as fp:
            frozen_settings = json.load(fp)
        self.assertEqual(frozen_settings["geometry"]["board_w"], 0.36)
        # 冻结的是「选中的那套」，不是默认值：别的键仍是默认
        self.assertEqual(frozen_settings["geometry"]["ball_r"],
                         editor_settings.defaults()["geometry"]["ball_r"])
        with open(os.path.join(run_dir, "song.json"), "r", encoding="utf-8") as fp:
            record = json.load(fp)
        self.assertEqual(record["source"], "song_notes.json")
        self.assertEqual(record["video"]["seconds"], 4.0)
        # 之后改曲库文件，也不影响这次任务
        with open(self.score, "w", encoding="utf-8") as fp:
            json.dump({"title": "改了"}, fp)
        with open(frozen, "r", encoding="utf-8") as fp:
            self.assertEqual(json.load(fp)["title"], "测试歌")

    def test_second_export_is_409_and_failure_never_returns_an_old_video(self):
        resp, _ = self._start_export()
        self.assertEqual(resp.status_code, 200)
        rid = resp.get_json()["rid"]
        with patch.object(webapp, "_editor_plan", return_value={"duration": 100.0}):
            second = self.client.post("/api/editor/export", json={
                "base": "song", "video": {"seconds": 3}})
        self.assertEqual(second.status_code, 409, second.data[:200])
        # 还在跑：文件接口不给东西
        self.assertEqual(self.client.get(
            "/api/editor/export/%s/file" % rid).status_code, 409)
        # 失败：也不许把上一次的视频端出来
        out = os.path.join(self.runs, rid, "clip.mp4")
        with open(out, "wb") as fp:
            fp.write(b"stale-video")
        webapp._EXPORT["proc"].poll = Mock(return_value=1)
        status = self.client.get("/api/editor/export/%s" % rid).get_json()
        self.assertEqual(status["state"], "failed")
        self.assertNotIn("file", status)
        self.assertEqual(self.client.get(
            "/api/editor/export/%s/file" % rid).status_code, 409)
        # 失败是「钉死」的：就算进程后来退了 0，也不许翻案把文件端出来
        webapp._EXPORT["proc"].poll = Mock(return_value=0)
        status = self.client.get("/api/editor/export/%s" % rid).get_json()
        self.assertEqual(status["state"], "failed")
        self.assertEqual(self.client.get(
            "/api/editor/export/%s/file" % rid).status_code, 409)
        # 新起一个真跑成功的任务才给文件
        self._finish_export()
        resp, _ = self._start_export(label="again")
        rid2 = resp.get_json()["rid"]
        out2 = os.path.join(self.runs, rid2, "clip.mp4")
        with open(out2, "wb") as fp:
            fp.write(b"good-video")
        webapp._EXPORT["proc"].poll = Mock(return_value=0)
        status = self.client.get("/api/editor/export/%s" % rid2).get_json()
        self.assertEqual(status["state"], "done")
        with self.client.get(status["file"]) as video:
            self.assertEqual(video.data, b"good-video")

    def test_export_progress_tracks_real_frames_and_waits_for_success(self):
        response, _ = self._start_export()
        rid = response.get_json()["rid"]
        route = "/api/editor/export/%s" % rid
        log = webapp._EXPORT["log"]
        total = webapp._EXPORT["video"]["frames"]
        self.assertEqual(total, 120)
        status = self.client.get(route).get_json()
        self.assertEqual(status["progress"]["percent"], 0)
        with open(log, "w", encoding="utf-8") as fp:
            fp.write("[realtime] frame 30/120\n[realtime] frame 999/1000\n")
        progress = self.client.get(route).get_json()["progress"]
        self.assertEqual((progress["completed"], progress["percent"]), (30, 25))
        with open(log, "a", encoding="utf-8") as fp:
            fp.write("other output\n" * 70)
        self.assertEqual(self.client.get(route).get_json()["progress"]["percent"], 25)
        with open(log, "a", encoding="utf-8") as fp:
            fp.write("[realtime] frame 120/120\n")
        progress = self.client.get(route).get_json()["progress"]
        self.assertEqual(progress["percent"], 99)
        self.assertEqual(progress["stage"], "合成与校验")
        webapp._EXPORT["proc"].poll.return_value = 1
        failed = self.client.get(route).get_json()
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(failed["progress"]["percent"], 99)
        self.assertEqual(failed["progress"]["stage"], "渲染失败")
        self._finish_export()
        response, _ = self._start_export()
        rid = response.get_json()["rid"]
        status = self.client.get("/api/editor/export/%s" % rid).get_json()
        self.assertEqual(status["progress"]["percent"], 0, "新任务不能沿用旧任务的进度")
        with open(webapp._EXPORT["out"], "wb") as fp:
            fp.write(b"complete")
        webapp._EXPORT["proc"].poll.return_value = 0
        done = self.client.get("/api/editor/export/%s" % rid).get_json()
        self.assertEqual(done["progress"]["percent"], 100)
        self.assertEqual(done["progress"]["stage"], "渲染完成")

    def test_sample_is_capped_at_what_is_left(self):
        with patch.object(webapp, "_editor_plan", return_value={"duration": 6.0}), \
             patch.object(webapp, "_run_logged", return_value=Mock(poll=lambda: None)):
            resp = self.client.post("/api/editor/export", json={
                "base": "song", "video": {"seconds": 10, "start": 4.0}})
        body = resp.get_json()
        self.assertEqual((body["start"], body["seconds"]), (4.0, 2.0))
        self.assertTrue(body["trimmed"])
        # 起点不往后挪（4.0 没被改成 0），只把长度缩到剩下的
        self._finish_export()
        # 后面没内容了就明说
        with patch.object(webapp, "_editor_plan", return_value={"duration": 6.0}):
            resp = self.client.post("/api/editor/export", json={
                "base": "song", "video": {"seconds": 10, "start": 5.8}})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("没有内容", resp.get_json()["error"])
        # 整曲：长度由曲长决定，不看请求里写了几秒
        with patch.object(webapp, "_editor_plan", return_value={"duration": 6.0}), \
             patch.object(webapp, "_run_logged", return_value=Mock(poll=lambda: None)):
            resp = self.client.post("/api/editor/export", json={
                "base": "song", "label": "song", "video": {"seconds": 1}})
        body = resp.get_json()
        self.assertEqual((body["start"], body["seconds"]), (0.0, 6.0))

    def test_solve_uses_a_fresh_directory_each_time(self):
        seen = []

        class Done:
            returncode = 0
            stderr = b""
            stdout = b""

        def fake_run(cmd, **kwargs):
            plan_path = cmd[cmd.index("--plan") + 1]
            seen.append(plan_path)
            out = cmd[cmd.index("--json") + 1]
            with open(out, "w", encoding="utf-8") as fp:
                json.dump({"ok": True, "audit": {"forced": 0}}, fp)
            with open(plan_path, "r", encoding="utf-8") as fp:
                json.load(fp)                      # 每次都能读到自己的 plan
            return Done()

        with patch.object(webapp, "_editor_plan", return_value={"duration": 1.0}), \
             patch.object(webapp.subprocess, "run", side_effect=fake_run):
            for _ in range(2):
                resp = self.client.post("/api/editor/solve", json={"base": "song"})
                self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0], seen[1])
        for path in seen:                          # finally 里清掉了临时目录
            self.assertFalse(os.path.exists(os.path.dirname(path)),
                             "求解的临时目录应当用完就删: %s" % path)

    def test_bad_window_numbers_are_rejected_not_silently_replaced(self):
        # "abc"/true/NaN 以前会被悄悄当成 0 和 10，导出来的是另一段
        for bad in ({"start": "abc"}, {"start": True}, {"start": []},
                    {"seconds": "十秒"}, {"seconds": True},
                    {"seconds": float("nan")}, {"start": float("inf")}):
            with self.subTest(bad=bad):
                with patch.object(webapp, "_editor_plan", return_value={"duration": 100.0}):
                    resp = self.client.post("/api/editor/export",
                                            json={"base": "song", "video": bad})
                self.assertEqual(resp.status_code, 400, resp.data[:200])
        # None 是「没给」，用默认值，不算非法
        with patch.object(webapp, "_editor_plan", return_value={"duration": 100.0}), \
             patch.object(webapp, "_run_logged", return_value=Mock(poll=lambda: None)):
            resp = self.client.post("/api/editor/export", json={
                "base": "song", "video": {"start": None, "seconds": None}})
        self.assertEqual(resp.status_code, 200, resp.data[:200])
        self.assertEqual((resp.get_json()["start"], resp.get_json()["seconds"]),
                         (0.0, 10.0))

    def test_exactly_the_minimum_seconds_is_accepted(self):
        with patch.object(webapp, "_editor_plan", return_value={"duration": 100.0}), \
             patch.object(webapp, "_run_logged", return_value=Mock(poll=lambda: None)):
            resp = self.client.post("/api/editor/export", json={
                "base": "song", "video": {"seconds": 0.5}})
        self.assertEqual(resp.status_code, 200, resp.data[:200])
        self.assertEqual(resp.get_json()["seconds"], 0.5)
        self._finish_export()
        # 剩下正好 0.5s：也能导，且长度就是 0.5
        with patch.object(webapp, "_editor_plan", return_value={"duration": 10.5}), \
             patch.object(webapp, "_run_logged", return_value=Mock(poll=lambda: None)):
            resp = self.client.post("/api/editor/export", json={
                "base": "song", "video": {"seconds": 10, "start": 10.0}})
        self.assertEqual(resp.status_code, 200, resp.data[:200])
        self.assertEqual((resp.get_json()["start"], resp.get_json()["seconds"]),
                         (10.0, 0.5))

    def test_one_gpu_job_across_both_entry_points(self):
        """旧版「生成视频」和编辑页导出不能同时开两个浏览器。"""
        forever = Mock(poll=lambda: None)
        # 1) 编辑页先跑：旧版按钮要被拦
        self._start_export()
        resp = self.client.post("/api/video", json={"base": "song",
                                                    "style": "music-machine"})
        self.assertEqual(resp.status_code, 409, resp.data[:200])
        self.assertIn("编辑页导出", resp.get_json()["error"])
        self._finish_export()
        # 2) 旧版先生成：编辑页导出要被拦（这里不真开浏览器，进程用替身）
        with patch.object(webapp, "_video_path",
                          return_value=os.path.join(self.work.name, "x.mp4")), \
             patch.object(webapp.subprocess, "Popen", return_value=forever):
            legacy = self.client.post("/api/video", json={"base": "song",
                                                          "style": "music-machine"})
        self.assertEqual(legacy.status_code, 200, legacy.data[:200])
        self.assertIs(webapp._RENDER["proc"], forever)
        with patch.object(webapp, "_editor_plan", return_value={"duration": 100.0}):
            resp = self.client.post("/api/editor/export", json={
                "base": "song", "video": {"seconds": 3}})
        self.assertEqual(resp.status_code, 409, resp.data[:200])
        self.assertIn("已经有渲染在跑", resp.get_json()["error"])
        webapp._RENDER["proc"] = None

    def test_read_errors_are_400(self):
        class Bad(Exception):
            pass

        with patch.object(webapp, "_editor_plan", side_effect=Bad("n is missing")):
            resp = self.client.post("/api/editor/solve", json={"base": "song"})
            self.assertEqual(resp.status_code, 400)
            self.assertIn("读谱失败", resp.get_json()["error"])
            resp = self.client.post("/api/editor/export",
                                    json={"base": "song", "video": {"seconds": 3}})
            self.assertEqual(resp.status_code, 400)

    # ── 设置文件：中文名、下载、导入 ────────────────────────────────────
    def test_settings_save_load_download_import(self):
        payload = {"geometry": {"board_w": 0.36}, "visuals": {"exposure": 1.35}}
        resp = self.client.post("/api/editor/settings/暖色傍晚",
                                json={"settings": payload})
        self.assertEqual(resp.status_code, 200, resp.data[:200])
        self.assertIn("暖色傍晚", self.client.get("/api/editor/settings").get_json()["names"])
        got = self.client.get("/api/editor/settings/暖色傍晚").get_json()
        self.assertEqual(got["settings"]["geometry"]["board_w"], 0.36)
        with self.client.get("/api/editor/settings/暖色傍晚/file") as raw:
            self.assertEqual(raw.status_code, 200)
            self.assertEqual(json.loads(raw.data)["name"], "暖色傍晚")
        # 导入：整份设置本体也能直接存
        resp = self.client.post("/api/editor/settings/导入的",
                                json={"visuals": {"wood": 0.0}})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self.client.get(
            "/api/editor/settings/导入的").get_json()["settings"]["visuals"]["wood"], 0.0)
        # 名字不能变成路径
        for bad in ("..", "a/b", "a\\b", "x" * 60):
            with self.subTest(bad=bad):
                self.assertGreaterEqual(
                    self.client.post("/api/editor/settings/" + bad,
                                     json={"settings": {}}).status_code, 400)
        self.assertEqual(self.client.get(
            "/api/editor/settings/不存在").status_code, 404)

    def test_frame_endpoint_validates(self):
        self.assertEqual(self.client.post(
            "/api/editor/frame?name=../escape", data=b"\x89PNG").status_code, 400)
        self.assertEqual(self.client.post(
            "/api/editor/frame?name=ok", data=b"nope").status_code, 400)
        resp = self.client.post("/api/editor/frame?name=unit_frame",
                                data=b"\x89PNG\r\n\x1a\nrest")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(os.path.isfile(os.path.join(self.work.name, "unit_frame.png")))


if __name__ == "__main__":
    unittest.main()

