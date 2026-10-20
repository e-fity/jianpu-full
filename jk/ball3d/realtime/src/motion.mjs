/**
 * Exact JavaScript mirror of the analytic motion in ``ball3d/score.py``.
 *
 * Every function below repeats the *same expression in the same order* as the
 * Python original, so sampling the same ``plan.json`` at the same ``t`` yields
 * bit-identical IEEE-754 doubles on both sides.  ``tests/test_trajectory_
 * equivalence.py`` asserts that equality at every landing, rest, segment
 * boundary, representative midpoint and frame time.
 *
 * Deliberately dependency-free (no three.js): the pure functions are the ones
 * the unit tests exercise.
 */

/** ``score.hop_height``: ``max(MIN, min(MAX, 0.55 * flight))``. */
export const MIN_HOP_HEIGHT = 0.25;
export const MAX_HOP_HEIGHT = 0.9;
export const HOP_RISE = 0.55;

export function hopHeight(flight) {
  return Math.max(MIN_HOP_HEIGHT, Math.min(MAX_HOP_HEIGHT, HOP_RISE * flight));
}

/**
 * ``score._segment_at``: the first segment covering ``t``; segments are
 * contiguous (``score.check_segments``), so this only clamps outside
 * ``[0, duration]``.  The "first match wins" order matters at a boundary,
 * where two segments share a ``t``: the hold wins over the following hop and
 * the hop wins over the following hold -- exactly as in Python.
 */
export function segmentAt(plan, t) {
  const segs = plan.segments;
  if (t <= segs[0].t0) return segs[0];
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg.t0 <= t && t <= seg.t1) return seg;
  }
  return segs[segs.length - 1];
}

/** ``score._lerp3``. */
export function lerp3(a, b, u) {
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ];
}

/** ``score.sample_ball``: ball centre at absolute time ``t``. */
export function sampleBall(plan, t) {
  const seg = segmentAt(plan, t);
  if (seg.kind === "hold") return seg.p0.slice();
  const span = seg.t1 - seg.t0;
  const u = span <= 0 ? 0 : (t - seg.t0) / span;
  const p = lerp3(seg.p0, seg.p1, u);
  p[1] += seg.h * 4 * u * (1 - u); // 0 at both ends -> exact landing
  return p;
}

/** ``score.sample_track``: the hop's vertical arc removed (camera target). */
export function sampleTrack(plan, t) {
  const seg = segmentAt(plan, t);
  if (seg.kind === "hold") return seg.p0.slice();
  const span = seg.t1 - seg.t0;
  const u = span <= 0 ? 0 : (t - seg.t0) / span;
  return lerp3(seg.p0, seg.p1, u);
}

/** ``score.onset_seconds``. */
export function onsetSeconds(onsetQ, tempoQpm, lead) {
  return lead + (onsetQ * 60) / tempoQpm;
}

/** ``make_ball_video.expected_frames`` / ``render_scene.frame_count``. */
export function frameCount(duration, fps) {
  return Math.ceil(duration * fps - 1e-9);
}

/** ``render_scene.frame_time``: 1-based Blender frame -> absolute seconds. */
export function frameTime(frame, fps) {
  return (frame - 1) / fps;
}

/** ``score.frame_times``: frame ``i`` is sampled at exactly ``i / fps``. */
export function frameTimes(fps, duration) {
  const n = frameCount(duration, fps);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = i / fps;
  return out;
}

/**
 * ``render_scene.to_blender`` inverted: plan is Y-up, Blender is Z-up, so the
 * same physical point is ``(x, y, z)`` in the plan and ``(x, z, y)`` in Blender.
 * Reading it backwards turns Blender offsets (camera, lights) into plan axes.
 */
export function blenderToPlan(v) {
  return [v[0], v[2], v[1]];
}

/**
 * ``render_scene.camera_placement`` in plan axes: the camera tracks
 * ``sample_track()`` (the smooth line under the hops) for both its position and
 * its aim point, so the view never pitches with a hop.
 */
export function cameraPlacement(plan, t, camOffsetBlender, lookaheadBlender) {
  const track = sampleTrack(plan, t);
  const off = blenderToPlan(camOffsetBlender);
  const ahead = blenderToPlan(lookaheadBlender);
  return {
    location: [track[0] + off[0], track[1] + off[1], track[2] + off[2]],
    target: [track[0] + ahead[0], track[1] + ahead[1], track[2] + ahead[2]],
  };
}

/**
 * ``render_scene.ground_bounds`` in plan axes: floor rectangle (x0, x1, z0, z1)
 * derived from the plan's own boards plus the margin, so any song length is
 * covered instead of being rejected by a fixed extent.
 */
export function groundBounds(plan, margin) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  const specs = plan.boards.concat([plan.pad]);
  for (let i = 0; i < specs.length; i += 1) {
    const [x, , z] = specs[i].pos;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0: x0 - margin, x1: x1 + margin, z0: z0 - margin, z1: z1 + margin };
}

/**
 * Orthographic frustum for a portrait frame: the vertical extent is
 * ``ORTHO_SCALE`` metres (Blender's ortho_scale with AUTO sensor fit on the
 * larger -- here vertical -- dimension) and the horizontal one follows the
 * aspect ratio.  ``camera_placement`` in render_scene.py asserts the same
 * window for 360x640.
 */
export function orthoFrustum(width, height, orthoScale) {
  const halfH = orthoScale / 2;
  const halfW = (halfH * width) / height;
  return { left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}
