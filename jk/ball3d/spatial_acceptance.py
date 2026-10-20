"""Summarize the measured frames, without substituting layout estimates."""
import json
import statistics
from pathlib import Path


def summarize(report):
    spatial = report["stats"]["spatial"]
    frames = report.get("visual_frames", [])
    widths = [f["ball_width_fraction"] for f in frames]
    future = [f["future_complete"] for f in frames if len(f["upcoming"]) >= 6]
    overlaps = sum(len(f["plank_screen_overlaps"]) for f in frames)
    ball_occlusions = sum(len(f["ball_occluded_by"]) for f in frames)
    label_overlaps = sum(len(f["label_overlaps"]) for f in frames)
    rails = spatial["rails"]
    diameter, width = spatial["diameter"], spatial["board_width"]
    layered = spatial.get("mode") == "wall-phrase-layers"
    wall = spatial.get("mode") in ("wall-downward", "wall-phrase-layers")
    # Measure separation from the board departure, before the inbound flight.
    rail_starts = [s["t"] - s["flight_in"] if wall
                   else s["t0"] - max(.25, s["gap"] * .25) for s in rails]
    checks = {
        "all_frames_measured": bool(frames) and len(frames) == report["expected"] == report["frames"],
        "spacing": spatial["min_spacing"] >= 2 * width,
        "no_board_overlap": overlaps == 0,
        "no_ball_occlusion": ball_occlusions == 0,
        "no_label_overlap": label_overlaps == 0,
        "ball_inside": all(f["ball_inside"] for f in frames),
        "ball_width_7_to_9_percent": bool(widths) and min(widths) >= .07 and max(widths) <= .09,
        "future_6_to_10": bool(future) and min(future) >= 6 and max(future) <= 10,
        "rail_count": len(rails) <= 3,
        "rail_gap": all(s["gap"] >= max(1, 3.5 * report["stats"]["tracks"]["delta0"]) for s in rails),
        "rail_spacing": all(b - a >= 8 for a, b in zip(rail_starts, rail_starts[1:])),
        "rail_length": all(s["length_widths"] <= 4 for s in rails),
        "geometry": all(report["audit"][key] == 0 for key in ("forced", "clearance_fails", "plank_overlaps")),
        "repeat_frames": bool(report.get("repeat_frames")) and all(f["identical"] for f in report["repeat_frames"]),
    }
    if layered:
        phrasing = spatial["phrasing"]
        groups, phrases = phrasing["level_groups"], phrasing.get("phrase_groups", [])
        notes = report["stats"]["tracks"]["total_notes"]
        steps = max(0, notes - 1)
        descending, level = phrasing.get("descending_steps", -1), phrasing.get("level_steps", -1)
        checks["phrase_groups_4_to_8"] = bool(phrases) and all(
            4 <= g["end"] - g["start"] + 1 <= 8 or notes < 4 and len(phrases) == 1 for g in phrases)
        checks["phrase_groups_cover_notes"] = [i for g in phrases for i in range(g["start"], g["end"] + 1)] == list(range(notes))
        checks["level_groups_4_to_6"] = all(4 <= g["end"] - g["start"] + 1 <= 6 for g in groups)
        checks["level_groups_match_phrases"] = [(g["start"], g["end"]) for g in groups] == [
            (g["start"], g["end"]) for g in phrases if g["level"]]
        checks["layer_top_centres_equal"] = all(
            len(g.get("top_y_range", [])) == 2 and all(abs(y - g["y"]) <= 1e-8 for y in g["top_y_range"])
            for g in groups)
        checks["phrase_heights_follow_mode"] = all(
            abs(g["top_y_end"] - g["top_y_start"]) <= 1e-8 if g["level"] or g["start"] == g["end"]
            else g["top_y_end"] < g["top_y_start"] for g in phrases)
        checks["phrases_descend"] = all(b["top_y_start"] < a["top_y_end"] for a, b in zip(phrases, phrases[1:]))
        checks["all_steps_descend_or_level"] = descending >= 0 and level >= 0 and descending + level == steps
        checks["level_steps_match_groups"] = level == sum(g["end"] - g["start"] for g in groups)
        checks["level_steps_at_most_20_percent"] = level >= 0 and 5 * level <= steps
    else:
        checks["height_bound"] = spatial["max_pitch_offset"] <= 4 * diameter if wall else all(abs(y) <= 4 * diameter for y in spatial["height_range"])
        checks["adjacent_height_bound"] = (spatial["max_height_residual"] if wall else spatial["delta_y"]["max"]) <= 1.5 * diameter + 1e-8
    if wall and not layered:
        checks["strictly_descending"] = spatial["strictly_descending"]
    if wall:
        checks["board_lights_measured"] = bool(frames) and all("board_lights" in frame for frame in frames)
        checks["black_before_hit"] = all(light["pulse"] == 0 and light["base"] == "#08090b"
                                          for frame in frames for light in frame.get("board_lights", [])
                                          if next(b["time"] for b in frame["visible"] if b["index"] == light["index"]) > frame["t"])
        palette = ["#ff2028", "#ff810d", "#ffdf18", "#39e651", "#16e5dd", "#2465ff", "#aa38ff"]
        checks["note_colors"] = all(light["color"] == palette[light["n"] - 1] for frame in frames for light in frame.get("board_lights", []))
    return {
        "passed": all(checks.values()), "checks": checks, "mode": spatial.get("mode", "spatial"),
        "baseline_drop_m": spatial.get("baseline_drop", 0),
        "frames": len(frames), "height_range_m": spatial["height_range"],
        "delta_y_m": spatial["delta_y"], "min_3d_spacing_m": spatial["min_spacing"],
        "board_overlap_pair_frames": overlaps,
        "board_overlap_frames": sum(bool(f["plank_screen_overlaps"]) for f in frames),
        "ball_occlusion_frames": sum(bool(f["ball_occluded_by"]) for f in frames),
        "label_overlap_pair_frames": label_overlaps,
        "rails": rails, "rail_count": len(rails),
        **({"layer_groups": groups, "phrase_groups": phrases,
            "descending_steps": descending, "level_steps": level,
            "level_step_fraction": level / steps if steps else 0} if layered else {}),
        "ball_width_fraction": {"min": min(widths, default=0), "p50": statistics.median(widths) if widths else 0, "max": max(widths, default=0)},
        "ball_screen_y_p50": statistics.median(f["ball_screen"][1] for f in frames) if frames else None,
        "future_complete_range": [min(future, default=0), max(future, default=0)],
        "repeat_frames": report.get("repeat_frames", []),
        "measurement_scope": "board overlap: clipped projected oriented slab silhouettes; ball occlusion: 7x7 silhouette rays against actual meshes; labels: screen rectangles; static collision: 128 samples per segment",
    }


def write_acceptance(report, output):
    summary = summarize(report)
    Path(output).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("spatial QA : " + json.dumps({k: v for k, v in summary.items() if k not in ("checks", "repeat_frames", "measurement_scope")}, ensure_ascii=True))
    return summary


if __name__ == "__main__":
    import sys
    report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    result = write_acceptance(report, sys.argv[2])
    sys.exit(0 if result["passed"] else 1)
