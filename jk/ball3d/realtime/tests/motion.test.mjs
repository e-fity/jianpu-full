/**
 * Motion/geometry unit tests: the pure functions ``scene.mjs`` is built on.
 *
 *     node --test realtime/tests
 *
 * The *exact* Python equivalence (bit-identical doubles at landings, rests,
 * segment boundaries, midpoints and frame times) is asserted by
 * ``ball3d/tests/test_realtime_video.py``, which runs the dump script in this
 * directory; these tests pin the behaviour those comparisons rely on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  blenderToPlan,
  cameraPlacement,
  frameCount,
  frameTime,
  frameTimes,
  groundBounds,
  hopHeight,
  lerp3,
  onsetSeconds,
  orthoFrustum,
  sampleBall,
  sampleTrack,
  segmentAt,
} from "../src/motion.mjs";
import { CAM_LOOKAHEAD_BLENDER, CAM_OFFSET_BLENDER } from "../src/style.mjs";
import { smallPlan } from "./fixture.mjs";

const NEAR = 1e-12;
const plan = smallPlan();

describe("hopHeight", () => {
  it("clamps to the documented floor and ceiling", () => {
    assert.equal(hopHeight(0.0), 0.25);
    assert.equal(hopHeight(0.3), 0.25); // 0.55 * 0.3 = 0.165 -> floor
    assert.equal(hopHeight(1.0), 0.55); // 0.55 * 1.0, inside the range
    assert.equal(hopHeight(2.0), 0.9); // 1.1 -> ceiling
  });

  it("is the same expression as score.hop_height", () => {
    assert.equal(hopHeight(0.7), Math.max(0.25, Math.min(0.9, 0.55 * 0.7)));
  });
});

describe("segmentAt", () => {
  it("picks the hold during a dwell", () => {
    assert.equal(segmentAt(plan, 0.1).kind, "hold");
    assert.equal(segmentAt(plan, 0.6).kind, "hold");
  });

  it("picks the hop in the middle of a flight", () => {
    assert.equal(segmentAt(plan, 0.35).kind, "hop");
    assert.equal(segmentAt(plan, 0.85).kind, "hop");
  });

  it("gives the boundary to the earlier segment, as Python does", () => {
    // contiguous segments share their endpoints; "first match wins" means the
    // segment that *ends* at t owns it -- so the hold wins at 0.2 and the hop
    // wins at 0.5 and 0.7.
    assert.equal(segmentAt(plan, 0.2), plan.segments[0]);
    assert.equal(segmentAt(plan, 0.5), plan.segments[1]);
    assert.equal(segmentAt(plan, 0.7), plan.segments[2]);
  });

  it("clamps outside [0, duration]", () => {
    assert.equal(segmentAt(plan, -3.0), plan.segments[0]);
    assert.equal(segmentAt(plan, 99.0), plan.segments[plan.segments.length - 1]);
  });
});

describe("sampleBall", () => {
  it("sits exactly on the board at a landing", () => {
    for (const landing of plan.landings) {
      assert.deepEqual(sampleBall(plan, landing.t), landing.ball_pos);
    }
  });

  it("moves the ball along the segment and adds the arc", () => {
    const seg = plan.segments[1]; // hop 0.2 -> 0.5, h = 0.25
    const u = (0.35 - seg.t0) / (seg.t1 - seg.t0);
    const base = lerp3(seg.p0, seg.p1, u);
    const point = sampleBall(plan, 0.35);
    assert.equal(point[0], base[0]);
    assert.equal(point[2], base[2]);
    assert.equal(point[1], base[1] + seg.h * 4 * u * (1 - u));
    assert.ok(point[1] > base[1]);
  });

  it("reaches the full hop height at the apex", () => {
    const seg = plan.segments[1];
    const apex = (seg.t0 + seg.t1) / 2;
    // 4u(1-u) is 1 at the midpoint, so the apex adds the whole hop height
    const apexY = sampleBall(plan, apex)[1];
    assert.ok(Math.abs(apexY - (seg.p0[1] + seg.h)) < 1e-12, `apex y=${apexY}`);
  });

  it("never dips below either end of a hop", () => {
    const seg = plan.segments[3];
    for (let k = 0; k <= 32; k += 1) {
      const t = seg.t0 + ((seg.t1 - seg.t0) * k) / 32;
      const y = sampleBall(plan, t)[1];
      assert.ok(y >= Math.min(seg.p0[1], seg.p1[1]) - NEAR, `y=${y} at t=${t}`);
      assert.ok(y <= Math.max(seg.p0[1], seg.p1[1]) + seg.h + NEAR, `y=${y}`);
    }
  });

  it("holds the last landing after the score ends", () => {
    const last = plan.landings[plan.landings.length - 1];
    assert.deepEqual(sampleBall(plan, plan.duration + 5), last.ball_pos);
    assert.deepEqual(sampleBall(plan, 0), plan.pad.ball_pos);
  });
});

describe("sampleTrack", () => {
  it("follows the same line with the hop's arc removed", () => {
    for (let k = 0; k <= 20; k += 1) {
      const t = (plan.duration * k) / 20;
      const track = sampleTrack(plan, t);
      const ball = sampleBall(plan, t);
      assert.equal(track[0], ball[0]);
      assert.equal(track[2], ball[2]);
      assert.ok(track[1] <= ball[1] + NEAR, `track above ball at t=${t}`);
    }
  });

  it("is the pure lerp inside a hop", () => {
    const seg = plan.segments[1];
    const u = 0.4;
    const t = seg.t0 + (seg.t1 - seg.t0) * u;
    assert.deepEqual(sampleTrack(plan, t), lerp3(seg.p0, seg.p1, u));
  });

  it("stays level during a hop (no vertical bounce in the camera target)", () => {
    const seg = plan.segments[1];
    const a = sampleTrack(plan, seg.t0 + 0.01)[1];
    const b = sampleTrack(plan, seg.t1 - 0.01)[1];
    assert.equal(a, b);
  });
});

describe("cameraPlacement", () => {
  it("maps Blender's (-3, -6, 5.5) to the plan's (-3, 5.5, -6)", () => {
    assert.deepEqual(blenderToPlan([-3.0, -6.0, 5.5]), [-3.0, 5.5, -6.0]);
    assert.deepEqual(blenderToPlan([0.6, 0.0, 0.0]), [0.6, 0.0, 0.0]);
    assert.deepEqual(blenderToPlan(blenderToPlan([1, 2, 3])), [1, 2, 3]);
  });

  it("follows the track, above and behind, aiming 0.6 m ahead", () => {
    const t = 0.35;
    const track = sampleTrack(plan, t);
    const view = cameraPlacement(plan, t, CAM_OFFSET_BLENDER, CAM_LOOKAHEAD_BLENDER);
    assert.deepEqual(view.location, [track[0] - 3.0, track[1] + 5.5, track[2] - 6.0]);
    assert.deepEqual(view.target, [track[0] + 0.6, track[1], track[2]]);
    assert.ok(view.location[1] > view.target[1]);
  });

  it("does not pitch with a hop", () => {
    const seg = plan.segments[1];
    const low = cameraPlacement(plan, seg.t0 + 0.01, CAM_OFFSET_BLENDER, CAM_LOOKAHEAD_BLENDER);
    const high = cameraPlacement(plan, (seg.t0 + seg.t1) / 2, CAM_OFFSET_BLENDER, CAM_LOOKAHEAD_BLENDER);
    // the aim height is the track's, which is flat across this hop
    assert.equal(low.target[1], high.target[1]);
  });
});

describe("orthoFrustum", () => {
  it("keeps the vertical extent at ortho_scale and follows the aspect", () => {
    const frustum = orthoFrustum(720, 1280, 8.0);
    assert.deepEqual(frustum, { left: -2.25, right: 2.25, top: 4.0, bottom: -4.0 });
    assert.equal(
      (frustum.right - frustum.left) / (frustum.top - frustum.bottom), 720 / 1280,
    );
  });

  it("agrees with render_scene.py's asserted 360x640 window", () => {
    const frustum = orthoFrustum(360, 640, 8.0);
    assert.equal(frustum.top, 4.0);
    assert.equal(frustum.right, 2.25);
  });
});

describe("groundBounds", () => {
  it("covers every board and the pad, plus the margin", () => {
    const bounds = groundBounds(plan, 40.0);
    for (const spec of plan.boards.concat([plan.pad])) {
      assert.ok(bounds.x0 <= spec.pos[0] - 40.0 + NEAR);
      assert.ok(bounds.x1 >= spec.pos[0] + 40.0 - NEAR);
      assert.ok(bounds.z0 <= spec.pos[2] - 40.0 + NEAR);
      assert.ok(bounds.z1 >= spec.pos[2] + 40.0 - NEAR);
    }
    assert.equal(bounds.x0, -41.05);
    assert.equal(bounds.x1, 41.05);
  });
});

describe("frame timing", () => {
  it("counts ceil(duration * fps) frames", () => {
    assert.equal(frameCount(10.0, 30), 300);
    assert.equal(frameCount(0.5, 30), 15);
    assert.equal(frameCount(0.03, 30), 1);
    assert.ok(frameCount(0.0, 30) === 0);
  });

  it("keeps the last frame inside the duration (the encoder's guard)", () => {
    // Recorder.step() stops when frame >= duration * frameRate, so the last
    // index we drive must stay below that float product.
    for (const duration of [0.5, 1 / 3, 9.9, 10.0, 12.3, 27.5]) {
      for (const fps of [24, 30, 60]) {
        const frames = frameCount(duration, fps);
        assert.ok(frames - 1 < duration * fps, `${duration}s @ ${fps}fps`);
      }
    }
  });

  it("samples frame i at exactly i / fps, never an accumulated step", () => {
    const times = frameTimes(30, 1.0);
    assert.equal(times.length, 30);
    assert.equal(times[0], 0);
    for (let i = 0; i < times.length; i += 1) assert.equal(times[i], i / 30);
  });

  it("agrees with render_scene.frame_time's 1-based frames", () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(frameTime(i + 1, 30), frameTimes(30, 1.0)[i]);
    }
  });

  it("matches score.onset_seconds", () => {
    assert.equal(onsetSeconds(4, 65.0, 1.2), 1.2 + (4 * 60) / 65.0);
    assert.equal(onsetSeconds(0, 65.0, 1.2), 1.2);
  });
});
