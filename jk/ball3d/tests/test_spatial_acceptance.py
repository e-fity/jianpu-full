import copy
import unittest
from ball3d.spatial_acceptance import summarize


class SpatialAcceptanceTests(unittest.TestCase):
    def report(self):
        return {"expected": 1, "frames": 1,
                "stats": {"spatial": {"height_range": [-.3, .4], "delta_y": {"p50": .1, "p95": .2, "max": .29},
                                      "min_spacing": .51, "diameter": .2, "board_width": .25, "rails": []},
                          "tracks": {"delta0": .25}},
                "audit": {"forced": 0, "clearance_fails": 0, "plank_overlaps": 0},
                "repeat_frames": [{"frame": 0, "identical": True}],
                "visual_frames": [{"ball_width_fraction": .08, "future_complete": 7, "upcoming": list(range(10)),
                                   "plank_screen_overlaps": [], "ball_occluded_by": [], "label_overlaps": [],
                                   "ball_inside": True, "ball_screen": [.5, .35]}]}

    def test_measured_good_report_passes(self):
        self.assertTrue(summarize(self.report())["passed"])

    def layered_report(self):
        report = self.report()
        report["stats"]["tracks"] = {"total_notes": 24}
        report["stats"]["spatial"].update(
            mode="wall-phrase-layers", height_range=[-20, 0],
            delta_y={"p50": 1, "p95": 1, "max": 1},
            phrasing={"descending_steps": 20, "level_steps": 3, "phrase_groups": [
                {"start": 0, "end": 5, "level": False, "top_y_start": 0, "top_y_end": -5},
                {"start": 6, "end": 11, "level": False, "top_y_start": -6, "top_y_end": -11},
                {"start": 12, "end": 15, "level": True, "top_y_start": -12, "top_y_end": -12},
                {"start": 16, "end": 23, "level": False, "top_y_start": -13, "top_y_end": -20},
            ], "level_groups": [
                {"start": 12, "end": 15, "y": -12, "direction": 1, "shape": "line", "up": False, "top_y_range": [-12, -12]},
            ]})
        report["visual_frames"][0].update(t=1, visible=[], board_lights=[])
        return report

    def test_layered_report_uses_measured_layers_instead_of_old_pitch_bounds(self):
        summary = summarize(self.layered_report())
        self.assertTrue(summary["passed"])
        self.assertNotIn("height_bound", summary["checks"])
        self.assertNotIn("adjacent_height_bound", summary["checks"])
        self.assertNotIn("strictly_descending", summary["checks"])
        self.assertEqual(summary["height_range_m"], [-20, 0])
        self.assertEqual(summary["rail_count"], 0)
        self.assertEqual(len(summary["layer_groups"]), 1)
        self.assertEqual(summary["descending_steps"], 20)
        self.assertEqual(summary["level_step_fraction"], 3 / 23)

    def test_level_groups_require_four_to_six_boards_and_phrases_cover_every_note(self):
        for count in (3, 7):
            with self.subTest(count=count):
                report = self.layered_report()
                group = report["stats"]["spatial"]["phrasing"]["level_groups"][0]
                group["end"] = group["start"] + count - 1
                summary = summarize(report)
                self.assertFalse(summary["checks"]["level_groups_4_to_6"])
                self.assertFalse(summary["checks"]["level_groups_match_phrases"])
                self.assertFalse(summary["passed"])
        report = self.layered_report()
        report["stats"]["tracks"]["total_notes"] = 25
        self.assertFalse(summarize(report)["checks"]["phrase_groups_cover_notes"])

    def test_layered_top_centres_must_be_measured_equal_and_next_layer_lower(self):
        report = self.layered_report()
        groups = report["stats"]["spatial"]["phrasing"]["level_groups"]
        groups[0]["top_y_range"][1] += .05
        self.assertFalse(summarize(report)["checks"]["layer_top_centres_equal"])
        groups[0].pop("top_y_range")
        self.assertFalse(summarize(report)["checks"]["layer_top_centres_equal"])
        for y in (-5, -4):
            with self.subTest(y=y):
                report = self.layered_report()
                group = report["stats"]["spatial"]["phrasing"]["phrase_groups"][1]
                group["top_y_start"] = y
                summary = summarize(report)
                self.assertTrue(summary["checks"]["layer_top_centres_equal"])
                self.assertFalse(summary["checks"]["phrases_descend"])
                self.assertFalse(summary["passed"])

    def test_short_descending_scores_do_not_need_a_level_group(self):
        for count in (1, 3, 8):
            with self.subTest(count=count):
                report = self.layered_report()
                report["stats"]["tracks"]["total_notes"] = count
                report["stats"]["spatial"]["phrasing"] = {
                    "descending_steps": count - 1, "level_steps": 0, "level_groups": [],
                    "phrase_groups": [{"start": 0, "end": count - 1, "level": False,
                                       "top_y_start": 0, "top_y_end": 1 - count}]}
                self.assertTrue(summarize(report)["passed"])

    def test_level_steps_are_rare_and_match_all_actual_steps(self):
        report = self.layered_report()
        phrasing = report["stats"]["spatial"]["phrasing"]
        # The old all-flat layers satisfy equal-height checks but fail the new
        # requirement that at least 80% of adjacent jumps descend.
        report["stats"]["tracks"]["total_notes"] = 8
        phrasing.update(descending_steps=1, level_steps=6,
                        phrase_groups=[{"start": start, "end": start + 3, "level": True,
                                        "top_y_start": -start, "top_y_end": -start} for start in (0, 4)],
                        level_groups=[{"start": start, "end": start + 3, "y": -start,
                                       "top_y_range": [-start, -start]} for start in (0, 4)])
        summary = summarize(report)
        self.assertTrue(summary["checks"]["layer_top_centres_equal"])
        self.assertTrue(summary["checks"]["all_steps_descend_or_level"])
        self.assertFalse(summary["checks"]["level_steps_at_most_20_percent"])
        self.assertFalse(summary["passed"])
        for values, failed_check in [({"descending_steps": 19}, "all_steps_descend_or_level"),
                                     ({"descending_steps": 19, "level_steps": 4}, "level_steps_match_groups")]:
            with self.subTest(values=values):
                report = self.layered_report()
                report["stats"]["spatial"]["phrasing"].update(values)
                self.assertFalse(summarize(report)["checks"][failed_check])

    def test_twenty_percent_level_steps_is_the_inclusive_limit(self):
        report = self.layered_report()
        report["stats"]["tracks"]["total_notes"] = 16
        phrasing = report["stats"]["spatial"]["phrasing"]
        phrasing.update(descending_steps=12, level_steps=3,
                        phrase_groups=[
                            {"start": 0, "end": 5, "level": False, "top_y_start": 0, "top_y_end": -5},
                            {"start": 6, "end": 9, "level": True, "top_y_start": -6, "top_y_end": -6},
                            {"start": 10, "end": 15, "level": False, "top_y_start": -7, "top_y_end": -12}],
                        level_groups=[{"start": 6, "end": 9, "y": -6, "top_y_range": [-6, -6]}])
        self.assertTrue(summarize(report)["passed"])
        report["stats"]["tracks"]["total_notes"] = 15
        phrasing["phrase_groups"][-1]["end"] = 14
        phrasing["descending_steps"] = 11
        summary = summarize(report)
        self.assertTrue(summary["checks"]["all_steps_descend_or_level"])
        self.assertFalse(summary["checks"]["level_steps_at_most_20_percent"])
        self.assertFalse(summary["passed"])

    def test_missing_measurements_and_real_frame_failures_cannot_pass(self):
        report = self.report()
        for key, value in [("ball_width_fraction", .069), ("future_complete", 5),
                           ("plank_screen_overlaps", [[1, 2]]), ("ball_occluded_by", [1]),
                           ("label_overlaps", [[1, 2]]), ("ball_inside", False)]:
            with self.subTest(key=key):
                invalid = copy.deepcopy(report)
                invalid["visual_frames"][0][key] = value
                self.assertFalse(summarize(invalid)["passed"])
        report["visual_frames"] = []
        self.assertFalse(summarize(report)["passed"])

    def test_rail_statistics_support_multiple_rails_in_both_layout_modes(self):
        for wall in (False, True):
            for count in range(4):
                with self.subTest(wall=wall, count=count):
                    report = self.report()
                    spatial = report["stats"]["spatial"]
                    if wall:
                        spatial.update(mode="wall-downward", max_pitch_offset=.02,
                                       max_height_residual=.03, strictly_descending=True)
                    spatial["rails"] = [
                        dict({"t": start + gap / 4, "flight_in": gap / 4} if wall
                             else {"t0": start + gap / 4},
                             gap=gap, length_widths=2.6)
                        for start, gap in [(0, 4), (8, 2), (16, 3)][:count]
                    ]
                    self.assertTrue(summarize(report)["checks"]["rail_spacing"])

    def test_rail_spacing_uses_departure_time_and_rejects_close_rails(self):
        for wall in (False, True):
            with self.subTest(wall=wall):
                report = self.report()
                spatial = report["stats"]["spatial"]
                if wall:
                    spatial.update(mode="wall-downward", max_pitch_offset=.02,
                                   max_height_residual=.03, strictly_descending=True)
                spatial["rails"] = [
                    dict({"t": start + gap / 4, "flight_in": gap / 4} if wall
                         else {"t0": start + gap / 4},
                         gap=gap, length_widths=2.6)
                    for start, gap in [(0, 2), (7.9, 4)]
                ]
                self.assertFalse(summarize(report)["checks"]["rail_spacing"])
                self.assertFalse(summarize(report)["passed"])

    def test_wall_mode_requires_descent_and_correct_unlit_note_states(self):
        report = self.report()
        report["stats"]["spatial"].update(mode="wall-downward", height_range=[-147, 0],
                                           max_pitch_offset=.02, max_height_residual=.03,
                                           baseline_drop=.44, strictly_descending=True)
        frame = report["visual_frames"][0]
        frame.update(t=1, visible=[{"index": 0, "time": 1.5}],
                     board_lights=[{"index": 0, "n": 4, "color": "#39e651", "pulse": 0, "base": "#08090b"}])
        self.assertTrue(summarize(report)["passed"])
        frame["board_lights"][0]["pulse"] = .1
        self.assertFalse(summarize(report)["checks"]["black_before_hit"])
        frame["board_lights"][0]["pulse"] = 0
        frame["board_lights"][0]["color"] = "#2465ff"
        self.assertFalse(summarize(report)["checks"]["note_colors"])
        del frame["board_lights"]
        self.assertFalse(summarize(report)["checks"]["board_lights_measured"])
