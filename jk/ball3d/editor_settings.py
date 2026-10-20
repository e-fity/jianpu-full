"""Validation of the 3D-editor settings, mirrored from realtime/src/settings.mjs.

The JavaScript module is the single source of truth: ``editor_schema.json`` is
generated from it by ``node realtime/tools/dump_schema.mjs`` and a test fails
when the two drift apart.  This module validates a request payload with the same
rules (finite numbers, ranges, ``#rrggbb`` colours, strict booleans, the
ball/plank cross-check) and always returns a *fresh* normalised dict, so a task
can never be affected by a later edit of the caller's own data.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA_PATH = HERE / "editor_schema.json"
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

# Mirrors TIME_MIN_SECONDS / TIME_MAX_SECONDS in realtime/src/settings.mjs.
TIME_MIN_SECONDS = 0.5
TIME_MAX_SECONDS = 600.0


def expected_frames(seconds, fps):
    """ceil(seconds * fps), the one frame contract shared with the encoder.

    ``make_ball_video.expected_frames``, ``render_scene.frame_count`` and
    ``realtime/src/settings.mjs`` all use ``ceil(x * fps - 1e-9)``: the epsilon
    keeps a binary near-integer from gaining a phantom frame, and a genuinely
    fractional second still rounds up (0.501 s @ 30 fps -> 16 frames).
    """
    return int(math.ceil(float(seconds) * int(fps) - 1e-9))


class SettingsError(ValueError):
    """One or more settings were rejected; ``errors`` lists every reason."""

    def __init__(self, errors):
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


def schema():
    """The shared schema (read once from the generated JSON file)."""
    if not SCHEMA_PATH.exists():
        raise SettingsError(["缺少 editor_schema.json：先运行 node realtime/tools/dump_schema.mjs"])
    return json.loads(SCHEMA_PATH.read_text(encoding="utf8"))


def defaults():
    sch = schema()
    return {
        "geometry": {k: v["def"] for k, v in sch["geometry"].items()},
        "visuals": {k: v["def"] for k, v in sch["visuals"].items()},
    }


def _number(spec, key, value, errors, where):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        errors.append("%s.%s 必须是有限数字（收到 %r）" % (where, key, value))
        return None
    value = float(value)
    if not math.isfinite(value):
        errors.append("%s.%s 必须是有限数字（收到 %r）" % (where, key, value))
        return None
    if value < spec["min"] - 1e-12 or value > spec["max"] + 1e-12:
        errors.append("%s.%s 超出范围 [%s, %s]（收到 %s）"
                      % (where, key, spec["min"], spec["max"], value))
        return None
    return value


def normalize_settings(payload):
    """Validate a settings payload; raises :class:`SettingsError` with all reasons.

    Structurally invalid payloads are rejected instead of being read as "use the
    defaults": a list, a string or an unknown key is a client bug that must be
    visible, not silently converted into a default render.
    """
    sch = schema()
    errors = []
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise SettingsError(["设置必须是一个对象（收到 %r）" % (payload,)])
    geometry = defaults()["geometry"]
    visuals = defaults()["visuals"]
    for key in payload:
        if key not in ("schema", "geometry", "visuals"):
            errors.append("未知的设置段 %r" % (key,))
    if "schema" in payload and payload["schema"] != sch["version"]:
        errors.append("不支持的设置版本 %r（本机为 %s）" % (payload["schema"], sch["version"]))
    geom_in = payload.get("geometry")
    if geom_in is not None and not isinstance(geom_in, dict):
        errors.append("geometry 必须是一个对象")
        geom_in = {}
    geom_in = geom_in or {}
    for key in geom_in:
        if key not in sch["geometry"]:
            errors.append("未知的几何参数 geometry.%s" % key)
    for key, spec in sch["geometry"].items():
        if key in geom_in and geom_in[key] is not None:
            value = _number(spec, key, geom_in[key], errors, "geometry")
            if value is not None:
                geometry[key] = value
    vis_in = payload.get("visuals")
    if vis_in is not None and not isinstance(vis_in, dict):
        errors.append("visuals 必须是一个对象")
        vis_in = {}
    vis_in = vis_in or {}
    for key in vis_in:
        if key not in sch["visuals"]:
            errors.append("未知的视觉参数 visuals.%s" % key)
    for key, spec in sch["visuals"].items():
        if key not in vis_in or vis_in[key] is None:
            continue
        raw = vis_in[key]
        if spec["kind"] == "number":
            value = _number(spec, key, raw, errors, "visuals")
            if value is not None:
                visuals[key] = value
        elif spec["kind"] == "boolean":
            if not isinstance(raw, bool):
                errors.append("visuals.%s 必须是 true/false" % key)
            else:
                visuals[key] = raw
        else:
            if not isinstance(raw, str) or not HEX.match(raw):
                errors.append("visuals.%s 必须是 #rrggbb 颜色（收到 %r）" % (key, raw))
            else:
                visuals[key] = raw.lower()
    if geometry["ball_r"] > geometry["board_w"] * 0.6:
        errors.append("小球半径 %s 对板宽 %s 太大（须 <= 0.6 x 板宽）"
                      % (geometry["ball_r"], geometry["board_w"]))
    if errors:
        raise SettingsError(errors)
    return {"schema": sch["version"], "geometry": geometry, "visuals": visuals}


def matched_bitrate(width, height, fps):
    """The "匹配码率" for a size/fps: the 720x1280@30 reference scaled by pixels."""
    sch = schema()["video"]
    raw = sch["bitrate_ref"] * (width * height * fps) / sch["bitrate_ref_pixels"]
    return int(round(raw / 100000.0) * 100000)


def normalize_video(payload):
    """Validate the video part of an export task."""
    sch = schema()["video"]
    if payload is not None and not isinstance(payload, dict):
        raise SettingsError(["视频参数必须是一个对象（收到 %r）" % (payload,)])
    src = payload or {}
    errors = []
    size = str(src.get("size", "720x1280"))
    fps = src.get("fps", 30)
    start = src.get("start", 0)
    seconds = src.get("seconds", 10)
    bitrate = src.get("bitrate", 0)
    if size not in sch["sizes"]:
        errors.append("size 必须是 %s" % " 或 ".join(sch["sizes"]))
        width, height = 0, 0
    else:
        width, height = sch["sizes"][size]
    if fps not in sch["fps"]:
        errors.append("fps 必须是 %s" % " 或 ".join(str(v) for v in sch["fps"]))
    if isinstance(start, bool) or not isinstance(start, (int, float)) \
            or not math.isfinite(start) or start < 0:
        errors.append("start 必须 >= 0（收到 %r）" % (start,))
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) \
            or not math.isfinite(seconds) \
            or seconds < sch["seconds_min"] - 1e-9 or seconds > sch["seconds_max"]:
        errors.append("seconds 必须在 [%s, %s]（收到 %r）"
                      % (sch["seconds_min"], sch["seconds_max"], seconds))
    if bitrate not in (0, None) and (
            isinstance(bitrate, bool) or not isinstance(bitrate, (int, float))
            or not math.isfinite(bitrate)
            or bitrate < sch["bitrate_min"] or bitrate > sch["bitrate_max"]):
        errors.append("码率必须在 [%d, %d]（收到 %r）"
                      % (sch["bitrate_min"], sch["bitrate_max"], bitrate))
    if errors:
        raise SettingsError(errors)
    chosen = int(bitrate) if bitrate else matched_bitrate(width, height, int(fps))
    return {
        "size": size, "width": width, "height": height, "fps": int(fps),
        "start": float(start), "seconds": float(seconds),
        "frames": max(1, expected_frames(seconds, fps)),
        "bitrate": chosen, "bitrate_mode": "custom" if bitrate else "matched",
    }

