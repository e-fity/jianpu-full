/**
 * Hand-built plan fixtures for the JavaScript unit tests.
 *
 * A plan.json produced by ``score.build_plan`` carries many more keys; these
 * fixtures carry exactly the ones the realtime modules read, so the tests never
 * need the fixture score file (or a browser).  The two numbers a fixture must
 * not get wrong -- the constants and the ball height above a board top -- are
 * checked against ``score.py`` by ``tests/test_realtime_video.py``.
 */

import { hopHeight } from "../src/motion.mjs";

/** The subset of ``score.CONSTANTS`` the realtime renderer reads. */
export const CONSTANTS = {
  spacing: 1.05,
  board_w: 0.90,
  board_h: 0.10,
  board_d: 0.62,
  support_r: 0.030,
  support_segs: 10,
  ball_r: 0.16,
  hop_life: 0.55,
  glow_life: 1.10,
  base_top: 1.55,
  height_per_semitone: 0.055,
};

const BALL_R = CONSTANTS.ball_r;

/** A short but complete plan: pad -> board 0 -> board 1, with two hops.
 *
 * The last segment is a hold ending the duration, exactly as
 * ``score.build_plan`` always leaves the ball resting on the last board.
 */
export function smallPlan({ fps = 30, duration = 1.4 } = {}) {
  const padBall = [-1.05, CONSTANTS.base_top + BALL_R, 0.02];
  const ball0 = [0.0, CONSTANTS.base_top + BALL_R, 0.0];
  const ball1 = [1.05, CONSTANTS.base_top + 0.055 + BALL_R, -0.06];

  const hold = (t0, t1, p) => ({
    kind: "hold", t0, t1, p0: p.slice(), p1: p.slice(), h: 0.0,
  });
  const hop = (t0, t1, a, b) => ({
    kind: "hop", t0, t1, p0: a.slice(), p1: b.slice(), h: hopHeight(t1 - t0),
  });

  const landings = [
    {
      i: 0, t: 0.5, midi: 60, n: 1, o: 0, q: 0.3, dur: 0.3, line: 1, index: 1,
      where: "l1/1", onset_q: 0, board_pos: [0.0, 0.0, 0.0],
      ball_pos: ball0.slice(), top_y: CONSTANTS.base_top,
    },
    {
      i: 1, t: 1.0, midi: 61, n: 2, o: 0, q: 0.3, dur: 0.3, line: 1, index: 2,
      where: "l1/2", onset_q: 0.5, board_pos: [1.05, 0.0, -0.06],
      ball_pos: ball1.slice(), top_y: CONSTANTS.base_top + 0.055,
    },
  ];

  return {
    format: "ball3d-plan-v1",
    input: "fixture",
    title: "fixture",
    key: "1=C",
    tonic_pc: 0,
    tempo_qpm: 65.0,
    fps,
    width: 720,
    height: 1280,
    lead: 1.2,
    tail: 1.1,
    duration,
    ref_midi: 60,
    constants: { ...CONSTANTS },
    landings,
    boards: landings.map((landing, index) => ({
      index,
      pos: landing.board_pos,
      top_y: landing.top_y,
      ball_pos: landing.ball_pos,
      midi: landing.midi,
      n: landing.n,
      o: landing.o,
      pitch_class: landing.midi % 12,
      where: landing.where,
    })),
    pad: {
      index: -1, pos: [-1.05, 0.0, 0.02],
      top_y: CONSTANTS.base_top, ball_pos: padBall.slice(),
    },
    segments: [
      hold(0.0, 0.2, padBall),
      hop(0.2, 0.5, padBall, ball0),
      hold(0.5, 0.7, ball0),
      hop(0.7, 1.0, ball0, ball1),
      hold(1.0, duration, ball1),
    ],
    rests: [],
    counts: { lines: 1, events: 2, sounding: 2, rests: 0 },
  };
}

/**
 * Deterministic, slightly irregular landing times (no ``Math.random``): a
 * linear congruential step decides each gap, so every run sees the same score.
 * ``48271 * 2**31`` stays inside the exact-integer range, so the sequence is a
 * genuine LCG rather than a rounded one.
 */
export function irregularTimes(count, { start = 1.2, seed = 12345 } = {}) {
  const times = [];
  let t = start;
  let state = seed;
  for (let i = 0; i < count; i += 1) {
    times.push(t);
    state = (state * 48271) % 2147483647;
    t += 0.18 + 0.04 * (state % 7) + 0.02 * (state % 3);
  }
  return times;
}

/**
 * A dense time sweep over ``times``: every landing, points inside every gap,
 * and both sides of every landing at ``1e-9`` -- the tolerance the landing
 * bisect uses -- plus the lead-in, the tail and well past the glow window.
 */
export function sweep(times, perGap = 7, tail = 5.0) {
  const points = [times[0] - 1.0, times[0], times[0] - 1e-9, times[0] + 1e-9];
  for (let i = 0; i + 1 < times.length; i += 1) {
    for (let k = 0; k <= perGap; k += 1) {
      const t = times[i] + ((times[i + 1] - times[i]) * k) / perGap;
      points.push(t, t - 1e-9, t + 1e-9);
    }
  }
  const last = times[times.length - 1];
  points.push(last, last - 1e-9, last + 1e-9, last + 1.0, last + tail);
  return points;
}
