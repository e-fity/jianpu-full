"""Do not accept animation frames after Blender swallows a handler error."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render_scene as renderer


class TestAnimationFailure(unittest.TestCase):
    def fake_blender(self, scene, fire_handlers=True):
        handlers = []

        def render(**kwargs):
            for frame in range(scene.frame_start, scene.frame_end + 1):
                scene.frame_current = frame
                if fire_handlers:
                    for handler in list(handlers):
                        try:
                            handler(scene)
                        except Exception:
                            pass  # Blender may report handler errors without failing render.

        fake = SimpleNamespace(
            app=SimpleNamespace(handlers=SimpleNamespace(frame_change_pre=handlers)),
            ops=SimpleNamespace(render=SimpleNamespace(render=render)),
        )
        return fake, handlers

    def test_state_update_failure_rejects_render_and_cleans_handler(self):
        scene = SimpleNamespace(render=SimpleNamespace())
        fake, handlers = self.fake_blender(scene)

        def update(ctx, plan, t):
            if t > 0:
                raise ValueError("injected update failure")

        with patch.object(renderer, "bpy", fake), patch.object(renderer, "apply_frame", update):
            with self.assertRaisesRegex(RuntimeError, "state update failed at frame 2"):
                renderer.render_frames({"scene": scene}, {"fps": 30}, "unused", 3)
        self.assertEqual(handlers, [])

    def test_missing_handler_calls_reject_render(self):
        scene = SimpleNamespace(render=SimpleNamespace())
        fake, handlers = self.fake_blender(scene, fire_handlers=False)
        with patch.object(renderer, "bpy", fake):
            with self.assertRaisesRegex(RuntimeError, "handler never ran"):
                renderer.render_frames({"scene": scene}, {"fps": 30}, "unused", 3)
        self.assertEqual(handlers, [])


if __name__ == "__main__":
    unittest.main()
