/**
 * Pool coverage tests: the claim that the fixed ``InstancedMesh`` slot counts
 * are enough for the whole song, at any time, without pop-in.
 *
 * A dense sweep over two very different timelines (200 fast notes, 60 slow
 * ones) checks, for every sampled time, that the pool contains
 *
 *   * the board the ball is on and the board it is hopping to,
 *   * every board that can still be glowing (the same window
 *     ``render_scene.apply_frame`` uses), so no board ever stops glowing
 *     mid-shot, and
 *   * every board inside the sun's shadow frustum,
 *
 * and that the pool never needs more slots than ``boardPoolSize`` gives it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as P from "../src/pool.mjs";
import { GLOW_WINDOW_FACTOR, SHADOW_EXTENT, glowStrength } from "../src/style.mjs";
import { CONSTANTS, irregularTimes, sweep } from "./fixture.mjs";

const GLOW_LIFE = CONSTANTS.glow_life;
const HOP_LIFE = CONSTANTS.hop_life;
const SPACING = CONSTANTS.spacing;
const GLOW_WINDOW = GLOW_LIFE * GLOW_WINDOW_FACTOR;
const STARS = 6;
/** Boards the sun's shadow frustum can reach on either side of the ball. */
const SHADOW_REACH = Math.floor(SHADOW_EXTENT / SPACING);
/** ``boardPool`` options as the scene passes them (scene.mjs). */
const OPTIONS = { glowWindow: GLOW_WINDOW };

const TIMELINES = {
  // a fast song: an irregular landing every ~0.3 s, so many boards are inside
  // the glow window at once
  dense: { times: irregularTimes(200), perGap: 3 },
  // a slow one: a regular landing every 1.4 s, so the glow window holds few
  sparse: { times: Array.from({ length: 60 }, (_, i) => 1.2 + i * 1.4), perGap: 5 },
};

function activeLandingReference(times, t) {
  let active = -1;
  for (let i = 0; i < times.length; i += 1) {
    if (times[i] <= t + 1e-9) active = i;
  }
  return active;
}

describe("activeLanding", () => {
  it("matches the linear scan at every swept time", () => {
    for (const { times, perGap } of Object.values(TIMELINES)) {
      for (const t of sweep(times, perGap)) {
        assert.equal(P.activeLanding(times, t), activeLandingReference(times, t));
      }
    }
  });

  it("is -1 before the first landing and the last index afterwards", () => {
    const { times } = TIMELINES.dense;
    assert.equal(P.activeLanding(times, times[0] - 1.0), -1);
    assert.equal(P.activeLanding(times, 0), -1);
    assert.equal(P.activeLanding(times, times[times.length - 1]), times.length - 1);
    assert.equal(P.activeLanding(times, times[times.length - 1] + 600), times.length - 1);
  });

  it("is an empty (non-throwing) edge for an empty timeline", () => {
    assert.equal(P.activeLanding([], 1.0), -1);
  });
});

describe("maxLandingsWithin", () => {
  it("matches an exhaustive count", () => {
    for (const { times } of Object.values(TIMELINES)) {
      for (const window of [0.0, 0.5, GLOW_LIFE, GLOW_WINDOW, 10.0]) {
        let best = 0;
        for (let i = 0; i < times.length; i += 1) {
          let count = 0;
          for (let j = i; j < times.length; j += 1) {
            if (times[j] - times[i] <= window) count += 1;
          }
          best = Math.max(best, count);
        }
        assert.equal(P.maxLandingsWithin(times, window), best, `window ${window}`);
      }
    }
  });
});

describe("boardPool", () => {
  for (const [name, { times, perGap }] of Object.entries(TIMELINES)) {
    it(`contains every board that can be visible (${name})`, () => {
      const total = times.length;
      for (const t of sweep(times, perGap)) {
        const pool = P.boardPool(times, t, OPTIONS);
        const active = activeLandingReference(times, t);
        assert.equal(pool.active, active);
        const inside = (index) => index >= pool.lo && index <= pool.hi;

        // the ball's board and the board it is heading to
        assert.ok(inside(active), `active ${active} missing at t=${t}`);
        if (active + 1 <= total - 1) {
          assert.ok(inside(active + 1), `target ${active + 1} missing at t=${t}`);
        }
        // the pad, while the ball is on it or on its way off it
        if (active <= 0) assert.ok(inside(-1), `pad missing at t=${t}`);

        for (let i = 0; i < total; i += 1) {
          const age = t - times[i];
          if (age >= 0 && age < GLOW_WINDOW) {
            assert.ok(inside(i), `glowing board ${i} (age ${age}) missing at t=${t}`);
          }
          if (Math.abs(i - active) <= SHADOW_REACH) {
            assert.ok(inside(i), `shadow caster ${i} missing at t=${t}`);
          }
        }
      }
    });

    it(`never needs more slots than boardPoolSize (${name})`, () => {
      const size = P.boardPoolSize(times, OPTIONS);
      assert.ok(size >= 1);
      for (const t of sweep(times, perGap)) {
        const pool = P.boardPool(times, t, OPTIONS);
        assert.ok(
          pool.count <= size,
          `t=${t} needs ${pool.count} slots, boardPoolSize is ${size}`,
        );
        assert.equal(P.poolIndices(pool).length, pool.count);
      }
    });
  }

  it("covers the start, the middle and the end as documented", () => {
    const times = TIMELINES.dense.times;
    const total = times.length;
    const first = P.boardPool(times, times[0] - 1.0, OPTIONS);
    assert.equal(first.lo, -1); // the pad is in the pool before the first landing
    assert.equal(first.active, -1);

    const middle = P.boardPool(times, times[Math.floor(total / 2)], OPTIONS);
    assert.equal(middle.active, Math.floor(total / 2));
    assert.ok(middle.lo > -1);
    assert.ok(middle.hi < total - 1);

    const end = P.boardPool(times, times[total - 1] + 60, OPTIONS);
    assert.equal(end.hi, total - 1); // clamped to the last board
    assert.equal(end.active, total - 1);
  });

  it("keeps the pad clamped at -1 even for a huge glow window", () => {
    const times = TIMELINES.dense.times;
    const pool = P.boardPool(times, times[10], { back: 999, ahead: 999, glowWindow: 600 });
    assert.equal(pool.lo, -1);
    assert.equal(pool.hi, times.length - 1);
    assert.equal(pool.count, times.length + 1);
  });

  it("emits indices in increasing order, pad first", () => {
    const times = TIMELINES.dense.times;
    const pool = P.boardPool(times, times[0] - 0.5, OPTIONS);
    const indices = P.poolIndices(pool);
    assert.equal(indices[0], -1);
    for (let k = 1; k < indices.length; k += 1) {
      assert.equal(indices[k], indices[k - 1] + 1);
    }
  });

  it("sizes pools for the widest possible range", () => {
    const times = TIMELINES.dense.times;
    assert.equal(P.boardPoolSize(times, OPTIONS), Math.min(
      times.length + 1, Math.max(P.POOL_BACK, P.maxLandingsWithin(times, GLOW_WINDOW))
      + P.POOL_AHEAD + 2,
    ));
  });
});

describe("burstPool", () => {
  it("covers every landing whose burst is still alive", () => {
    const { times, perGap } = TIMELINES.dense;
    const size = P.burstPoolSize(times, HOP_LIFE, STARS);
    for (const t of sweep(times, perGap)) {
      const pool = P.burstPool(times, t, HOP_LIFE);
      for (let i = 0; i < times.length; i += 1) {
        const age = t - times[i];
        if (age >= 0 && age <= HOP_LIFE) {
          assert.ok(i >= pool.lo && i <= pool.hi, `landing ${i} missing at t=${t}`);
        }
      }
      assert.ok(pool.count * STARS <= size, `t=${t}: ${pool.count} bursts > ${size / STARS}`);
    }
  });

  it("is empty before the first landing and after the last burst", () => {
    const times = TIMELINES.dense.times;
    assert.deepEqual(P.burstPool(times, times[0] - 1.0, HOP_LIFE), { lo: 0, hi: -1, count: 0 });
    const end = P.burstPool(times, times[times.length - 1] + HOP_LIFE + 10, HOP_LIFE);
    assert.equal(end.count, 0);
  });

  it("sizes one instance per star of the busiest window", () => {
    const times = TIMELINES.dense.times;
    assert.equal(
      P.burstPoolSize(times, HOP_LIFE, STARS),
      P.maxLandingsWithin(times, HOP_LIFE) * STARS,
    );
  });
});

describe("assertPoolFits", () => {
  it("returns the size when it fits", () => {
    assert.equal(P.assertPoolFits(26, "board"), 26);
    assert.equal(P.assertPoolFits(P.POOL_MAX_SLOTS, "particle"), P.POOL_MAX_SLOTS);
  });

  it("throws, naming the pool, when it does not", () => {
    assert.throws(() => P.assertPoolFits(0, "board"), /board pool needs 0 slots/);
    assert.throws(() => P.assertPoolFits(-1, "board"), /board pool needs -1 slots/);
    assert.throws(
      () => P.assertPoolFits(P.POOL_MAX_SLOTS + 1, "star burst"),
      /star burst pool needs 4097 slots, cap is 4096/,
    );
  });
});

describe("recentGlow", () => {
  it("equals the all-boards maximum the Blender renderer computes", () => {
    for (const { times, perGap } of Object.values(TIMELINES)) {
      for (const t of sweep(times, perGap)) {
        const pool = P.boardPool(times, t, OPTIONS);
        const fromPool = P.recentGlow(
          times, t, GLOW_LIFE, glowStrength, P.poolIndices(pool),
        );
        let fromAll = 0.0;
        for (let i = 0; i < times.length; i += 1) {
          fromAll = Math.max(fromAll, glowStrength(t - times[i], GLOW_LIFE));
        }
        assert.equal(fromPool, fromAll, `t=${t}`);
      }
    }
  });

  it("is 0 before the first landing and after the glow window", () => {
    const times = TIMELINES.dense.times;
    const indices = P.poolIndices(P.boardPool(times, times[0] - 1.0, OPTIONS));
    assert.equal(P.recentGlow(times, times[0] - 1.0, GLOW_LIFE, glowStrength, indices), 0);
    const after = times[times.length - 1] + GLOW_WINDOW + 1;
    const late = P.poolIndices(P.boardPool(times, after, OPTIONS));
    assert.equal(P.recentGlow(times, after, GLOW_LIFE, glowStrength, late), 0);
  });
});
