"""Geometry regressions for the Blender renderer (no Blender needed).

render_scene.py imports bpy defensively, so its pure helpers can be checked by
CPython: the plan is Y-up while Blender is Z-up, and mixing the two put the
floor, the support posts and the shadows in the wrong place.
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BALL3D = os.path.dirname(HERE)
sys.path.insert(0, BALL3D)

import render_scene as rs  # noqa: E402
import score  # noqa: E402


def plan_from(notes, lead=1.2, tail=1.0, fps=30, **kw):
    data = {"format": "jianpu2letter-notes-v1", "title": "t", "key": "1=B",
            "tempo_qpm": 65.0,
            "lines": [{"line": 1, "notes": [
                {"line": 1, "index": i + 1, "n": n, "o": o, "q": q, "letter": "D"}
                for i, (n, o, q) in enumerate(notes)]}]}
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "s.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        sc = score.load_score(path)
    return score.build_plan(sc, lead=lead, tail=tail, fps=fps, **kw)


def small_plan(lead=1.2, tail=1.0):
    notes = [(1, 0, 0.5), (7, 1, 0.25), (2, -1, 2.0), (0, 0, 0.5), (3, 0, 0.25)]
    return plan_from(notes, lead=lead, tail=tail)


# --- camera framing maths (Blender ortho: scale spans the larger dimension) ---

def _frame_half_extents(plan):
    scale = rs.ORTHO_SCALE
    aspect = float(plan["width"]) / float(plan["height"])
    if aspect >= 1.0:
        return scale * 0.5, scale * 0.5 / aspect
    return scale * aspect * 0.5, scale * 0.5


def _normalize(v):
    n = math.sqrt(sum(c * c for c in v))
    return tuple(c / n for c in v)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def frame_uv(plan, t, point):
    """Point -> (u, v) in camera half-extents; |u|, |v| <= 1 means on screen."""
    loc, target = rs.camera_placement(plan, t)
    forward = _normalize(tuple(a - b for a, b in zip(target, loc)))
    right = _normalize(_cross(forward, (0.0, 0.0, 1.0)))
    up = _cross(right, forward)
    d = tuple(a - b for a, b in zip(point, target))
    half_w, half_h = _frame_half_extents(plan)
    return _dot(d, right) / half_w, _dot(d, up) / half_h


class TestAxisConversion(unittest.TestCase):
    def test_plan_y_becomes_blender_z(self):
        self.assertEqual(rs.to_blender([1.0, 2.0, 3.0]), (1.0, 3.0, 2.0))

    def test_board_thickness_is_vertical_in_blender(self):
        plan = small_plan()
        c = plan["constants"]
        for b in plan["boards"]:
            center, size = rs.board_box(b, c)
            self.assertEqual(center, rs.to_blender(b["pos"]))
            self.assertEqual(size, (c["board_w"], c["board_d"], c["board_h"]))
            verts, faces = [], []
            rs._add_box(verts, faces, center, size)
            zs = [v[2] for v in verts]
            ys = [v[1] for v in verts]
            self.assertAlmostEqual(max(zs) - min(zs), c["board_h"], places=9)
            self.assertAlmostEqual(max(ys) - min(ys), c["board_d"], places=9)
            # the board's upper face must sit at the plan's top_y (its height)
            self.assertAlmostEqual(max(zs), b["top_y"], places=9)

    def test_ball_is_placed_at_its_height(self):
        plan = small_plan()
        landing = plan["landings"][0]
        self.assertEqual(rs.to_blender(landing["ball_pos"])[2],
                         landing["ball_pos"][1])

    def test_posts_grow_from_the_ground_to_the_board(self):
        plan = small_plan()
        c = plan["constants"]
        for b in plan["boards"]:
            center, radius, height = rs.post_params(b, c)
            self.assertGreater(height, 0.05)
            self.assertAlmostEqual(center[2] - height * 0.5, 0.0, places=9)
            self.assertAlmostEqual(center[2] + height * 0.5,
                                   b["top_y"] - c["board_h"], places=9)
            self.assertAlmostEqual(radius, c["support_r"], places=9)
            verts, faces = [], []
            rs._add_cylinder(verts, faces, center, radius, height, c["support_segs"])
            zs = [v[2] for v in verts]
            self.assertAlmostEqual(min(zs), 0.0, places=9)

    def test_ground_is_derived_from_the_boards_with_a_margin(self):
        plan = small_plan()
        x0, x1, y0, y1 = rs.ground_bounds(plan)
        xs = [b["pos"][0] for b in plan["boards"]] + [plan["pad"]["pos"][0]]
        lanes = [b["pos"][2] for b in plan["boards"]] + [plan["pad"]["pos"][2]]
        self.assertAlmostEqual(x0, min(xs) - rs.GROUND_MARGIN, places=9)
        self.assertAlmostEqual(x1, max(xs) + rs.GROUND_MARGIN, places=9)
        self.assertAlmostEqual(y0, min(lanes) - rs.GROUND_MARGIN, places=9)
        self.assertAlmostEqual(y1, max(lanes) + rs.GROUND_MARGIN, places=9)
        # no fixed half-extent constant is left in the renderer
        self.assertFalse(hasattr(rs, "GROUND_HALF"))
        self.assertTrue(rs.ground_covers_track(plan))

    def test_long_song_ground_grows_with_the_track(self):
        """>600 notes: the old fixed 500 unit floor used to reject this."""
        notes = [(1 + (i % 7), (i % 3) - 1, 0.25) for i in range(700)]
        plan = plan_from(notes)
        self.assertEqual(len(plan["boards"]), 700)
        last_x = max(b["pos"][0] for b in plan["boards"])
        self.assertGreater(last_x, 500.0)           # longer than the old floor
        x0, x1, y0, y1 = rs.ground_bounds(plan)
        self.assertGreaterEqual(x1, last_x + rs.GROUND_MARGIN)
        self.assertLessEqual(x0, plan["pad"]["pos"][0] - rs.GROUND_MARGIN)
        self.assertGreater(x1 - x0, last_x)          # it really scaled up
        self.assertTrue(rs.ground_covers_track(plan))
        score.check_segments(plan)


class TestCameraAndParticles(unittest.TestCase):
    def test_camera_and_target_follow_sample_track(self):
        plan = small_plan()
        for t in [0.0, 0.5, 1.0, 1.5, 2.0]:
            loc, target = rs.camera_placement(plan, t)
            track = rs.to_blender(score.sample_track(plan, t))
            self.assertEqual(loc, (track[0] + rs.CAM_OFFSET[0],
                                   track[1] + rs.CAM_OFFSET[1],
                                   track[2] + rs.CAM_OFFSET[2]))
            self.assertEqual(target, (track[0] + rs.CAM_LOOKAHEAD[0],
                                      track[1] + rs.CAM_LOOKAHEAD[1],
                                      track[2] + rs.CAM_LOOKAHEAD[2]))

    def test_target_ignores_the_hop_arc(self):
        plan = small_plan()
        hops = [s for s in plan["segments"] if s["kind"] == "hop"]
        self.assertTrue(hops)
        for hop in hops:
            mid = 0.5 * (hop["t0"] + hop["t1"])
            ball = rs.to_blender(score.sample_ball(plan, mid))
            _, target = rs.camera_placement(plan, mid)
            # the ball is above the line the camera aims at: no pitching per hop
            self.assertLess(target[2], ball[2])
            self.assertGreater(ball[2] - target[2], 0.1)

    def test_particle_geometry_is_a_sparse_burst(self):
        plan = small_plan()
        landing = plan["landings"][0]
        verts, faces = rs.particle_geometry(landing, plan["constants"])
        self.assertEqual(len(verts), rs.STARS_PER_LANDING * 6)
        self.assertEqual(len(faces), rs.STARS_PER_LANDING * 8)
        self.assertLessEqual(rs.STARS_PER_LANDING, 8)       # sparse, not a cloud


class TestCameraFraming(unittest.TestCase):
    """The reviewed frames were too close, with the ball down in one corner."""

    def test_ortho_frame_shows_four_to_six_boards(self):
        plan = small_plan()
        half_w, _half_h = _frame_half_extents(plan)
        visible = 2.0 * half_w / plan["constants"]["spacing"]
        self.assertGreaterEqual(visible, 4.0)
        self.assertLessEqual(visible, 6.0)
        self.assertTrue(7.8 <= rs.ORTHO_SCALE <= 8.4)
        self.assertEqual(rs.CAM_OFFSET, (-3.0, -6.0, 5.5))
        self.assertEqual(rs.CAM_LOOKAHEAD, (0.6, 0.0, 0.0))

    def test_ball_is_small_and_near_the_centre_at_every_landing(self):
        plan = small_plan()
        half_w, half_h = _frame_half_extents(plan)
        r = plan["constants"]["ball_r"]
        self.assertLess(2.0 * r / rs.ORTHO_SCALE, 0.10)     # a small pearl
        for landing in plan["landings"]:
            u, v = frame_uv(plan, landing["t"] + 1e-6,
                            rs.to_blender(landing["ball_pos"]))
            self.assertLess(abs(u), 0.45, landing["i"])
            self.assertLess(abs(v), 0.50, landing["i"])

    def test_whole_ball_stays_inside_the_frame_through_the_hop(self):
        plan = small_plan()
        c = plan["constants"]
        half_w, half_h = _frame_half_extents(plan)
        r_u, r_v = c["ball_r"] / half_w, c["ball_r"] / half_h
        t, step = 0.0, 1.0 / 60.0
        while t <= plan["duration"]:
            ball = rs.to_blender(score.sample_ball(plan, t))
            u, v = frame_uv(plan, t, ball)
            self.assertLessEqual(abs(u) + r_u, 1.0, t)
            self.assertLessEqual(abs(v) + r_v, 1.0, t)
            t += step


class TestPalette(unittest.TestCase):
    """Saturated hues instead of the near-white wash the reviewer saw."""

    def test_contact_light_palette_is_saturated(self):
        hues = {rs.palette_hue(pc) for pc in range(12)}
        self.assertGreaterEqual(len(hues), 5)
        for pc in range(12):
            r, g, b, _a = rs.glow_color(pc)
            self.assertAlmostEqual(max(r, g, b), 1.0, places=6)   # bright
            self.assertLessEqual(min(r, g, b), 0.20)              # but not white


class TestAnimationFrames(unittest.TestCase):
    """One animation render must land on exactly the times the plan samples."""

    def test_frame_time_matches_the_plan_sampling(self):
        for fps in (24, 30, 60):
            plan = plan_from([(1, 0, 0.5), (5, 0, 1.0), (0, 0, 0.5), (3, 1, 0.25)],
                             fps=fps)
            times = score.frame_times(plan["fps"], plan["duration"])
            self.assertEqual(len(times), rs.frame_count(plan))
            for i, expected in enumerate(times):
                self.assertEqual(rs.frame_time(i + 1, plan["fps"]), expected)

    def test_frame_range_covers_the_duration_without_an_extra_frame(self):
        plan = small_plan()
        fps = plan["fps"]
        total = rs.frame_count(plan)
        self.assertGreaterEqual(rs.frame_time(1, fps), 0.0)
        self.assertLess(rs.frame_time(total, fps), plan["duration"])
        self.assertGreaterEqual(rs.frame_time(total + 1, fps), plan["duration"])

    def test_frame_names_match_the_cli_contract(self):
        import make_ball_video as cli                        # same names, one place

        self.assertEqual(rs.frame_filename(1), "frame_000001.png")
        self.assertEqual(rs.frame_filename(300), "frame_000300.png")
        self.assertEqual([rs.frame_filename(i) for i in range(1, 13)],
                         cli.frame_names(12))
        names = [rs.frame_filename(i) for i in range(1, 13)]
        self.assertEqual(names, sorted(names))              # the CLI sorts these
        # the '#' padding handed to Blender pads to the same width as those names
        pattern = rs.frame_pattern("frames")
        self.assertTrue(pattern.endswith("frame_" + "#" * 6))
        self.assertEqual(len(rs.frame_filename(1)) - len(".png"),
                         len(rs.FRAME_PREFIX) + pattern.count("#"))


class TestMaterialReuse(unittest.TestCase):
    """Shared star materials must stay visually identical and independent."""

    def test_star_bursts_share_one_material_per_palette_hue(self):
        plan = plan_from([(1 + (i % 7), (i % 3) - 1, 0.25) for i in range(700)])
        landings = plan["landings"]
        groups = rs.star_materials_by_palette(landings)
        self.assertLess(len(groups), len(landings))          # a real reduction
        self.assertLessEqual(len(groups), len(rs.PALETTE_HUES))
        covered = sorted(i for idxs in groups.values() for i in idxs)
        self.assertEqual(covered, [l["i"] for l in landings])   # each burst once
        by_index = {l["i"]: l for l in landings}
        for key, idxs in groups.items():
            hues = {rs.palette_hue(by_index[i]["midi"]) for i in idxs}
            self.assertEqual(hues, {rs.PALETTE_HUES[key]})   # one hue per material

    def test_board_materials_are_never_shared(self):
        plan = small_plan()
        keys = [rs.board_material_key(b["index"]) for b in plan["boards"]]
        self.assertEqual(len(set(keys)), len(keys))
        self.assertGreater(len(keys), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
