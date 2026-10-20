/**
 * Style/look unit tests: the colour, glow and light maths in ``style.mjs``.
 *
 * These are the numbers that make the realtime output *look like* ball3d.  The
 * exact agreement with ``render_scene.py``'s constants is asserted from Python
 * (``tests/test_realtime_video.py`` parses that file); here the invariants are
 * pinned: the palette is never white, a board fades out inside the glow window,
 * the sun really is above the floor, and the shadow grid is still.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as S from "../src/style.mjs";

const EPS = 1e-12;

function close(actual, expected, eps = EPS, what = "") {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${what} expected ${expected}, got ${actual}`,
  );
}

describe("hsv", () => {
  it("reproduces the primary and secondary colours", () => {
    assert.deepEqual(S.hsv(0, 1, 1), [1, 0, 0]);
    assert.deepEqual(S.hsv(0, 0, 1), [1, 1, 1]);
    const green = S.hsv(1 / 3, 1, 1);
    close(green[1], 1, 1e-12, "green");
    close(green[0], 0, 1e-12, "green");
    close(green[2], 0, 1e-12, "green");
    const blue = S.hsv(2 / 3, 1, 1);
    close(blue[2], 1, 1e-12, "blue");
  });

  it("wraps hue and never leaves 0..1", () => {
    assert.deepEqual(S.hsv(1.0, 1, 1), S.hsv(0.0, 1, 1));
    assert.deepEqual(S.hsv(-0.25, 1, 1), S.hsv(0.75, 1, 1));
    for (let k = 0; k <= 24; k += 1) {
      for (const channel of S.hsv(k / 24, 0.85, 1.0)) {
        assert.ok(channel >= 0 && channel <= 1, `channel ${channel}`);
      }
    }
  });
});

describe("palette", () => {
  it("keys the hue by pitch class, wrapping both ways", () => {
    assert.equal(S.paletteHue(0), S.PALETTE_HUES[0]);
    assert.equal(S.paletteHue(5), S.PALETTE_HUES[0]);
    assert.equal(S.paletteHue(60), S.PALETTE_HUES[0]); // middle C
    assert.equal(S.paletteHue(61), S.PALETTE_HUES[1]);
    assert.equal(S.paletteHue(-1), S.PALETTE_HUES[4]);
  });

  it("never returns white: the contact light stays saturated", () => {
    for (let midi = 55; midi <= 75; midi += 1) {
      const color = S.glowColor(midi);
      const max = Math.max(...color);
      const min = Math.min(...color);
      assert.ok(Math.abs(max - 1.0) <= EPS, `max ${max} for ${midi}`);
      close(min, 0.15, 1e-12, `min for ${midi}`); // 1 - saturation
    }
  });

  it("keeps the board body dark, with only a hint of the hue", () => {
    const darkest = Math.max(...S.IDLE_BOARD) + S.GLOW_TINT;
    for (let midi = 55; midi <= 75; midi += 1) {
      for (const channel of S.boardBodyColor(midi)) {
        assert.ok(channel <= darkest + EPS, `body channel ${channel}`);
      }
    }
    // the tint is what makes two neighbouring boards differ at all
    assert.notDeepEqual(S.boardBodyColor(60), S.boardBodyColor(61));
    assert.ok(S.GLOW_TINT < 0.2);
  });
});

describe("glow", () => {
  it("starts at the full glow strength and decays", () => {
    assert.equal(S.glowStrength(0, 1.1), S.GLOW_STRENGTH);
    let previous = Infinity;
    for (let k = 0; k < 40; k += 1) {
      const value = S.glowStrength(k * 0.02, 1.1);
      assert.ok(value <= previous + EPS, `glow rose at ${k}`);
      previous = value;
    }
  });

  it("is exactly 0 outside [0, glow_life * 3)", () => {
    const life = 1.1;
    assert.equal(S.glowStrength(-1e-9, life), 0);
    assert.equal(S.glowStrength(-1.0, life), 0);
    assert.equal(S.glowStrength(life * S.GLOW_WINDOW_FACTOR, life), 0);
    assert.equal(S.glowStrength(life * 10, life), 0);
    assert.ok(S.glowStrength(life * S.GLOW_WINDOW_FACTOR - 1e-9, life) > 0);
  });

  it("fades to almost nothing within the window (no board cuts off lit)", () => {
    const life = 1.1;
    const tail = S.glowStrength(life * S.GLOW_WINDOW_FACTOR - 1e-3, life);
    assert.ok(tail < S.GLOW_STRENGTH * 1e-3, `tail glow ${tail}`);
  });

  it("brightens the pearl but never blows it out", () => {
    assert.equal(S.pearlGlow(0), 0);
    assert.ok(S.pearlGlow(S.GLOW_STRENGTH) < S.PEARL_GLOW_MAX);
    assert.equal(S.pearlGlow(1e6), S.PEARL_GLOW_MAX);
    let previous = -1;
    for (let k = 0; k < 20; k += 1) {
      const value = S.pearlGlow(k * 0.1);
      assert.ok(value >= previous);
      previous = value;
    }
  });
});

describe("star bursts", () => {
  it("rises for 0.1 s, then fades to 0 at the end of the burst life", () => {
    const life = 0.55;
    close(S.burstScale(0.0, life), 0.35, EPS, "t=0");
    close(S.burstScale(0.1, life), 1.3 * (1 - 0.1 / life), EPS, "t=0.1");
    assert.equal(S.burstScale(life, life), 0);
    assert.equal(S.burstScale(-1, life), 0);
    assert.equal(S.burstScale(life + 1, life), 0);
    // the peak is where the rise saturates, and nothing after it is bigger
    const peak = S.burstScale(0.1, life);
    for (let k = 0; k <= 22; k += 1) {
      assert.ok(S.burstScale((life * k) / 22, life) <= peak + 1e-9, `k=${k}`);
    }
  });

  it("lifts the burst with age but never before the landing", () => {
    assert.equal(S.burstRise(-0.5), 0);
    assert.equal(S.burstRise(0), 0);
    assert.equal(S.burstRise(0.2), 0.35 * 0.2);
  });

  it("spreads the stars deterministically, and never on top of the ball", () => {
    const landing = { i: 3 };
    const ballR = 0.16;
    const first = S.burstParticles(landing, ballR);
    const again = S.burstParticles(landing, ballR);
    assert.deepEqual(first, again);
    assert.equal(first.length, S.STARS_PER_LANDING);
    const radius = (offset) => Math.hypot(offset[0], offset[2]);
    for (const particle of first) {
      assert.ok(radius(particle.offset) >= ballR, `particle inside the ball`);
      assert.ok(radius(particle.offset) <= ballR * 3.6 + EPS);
      assert.ok(particle.offset[1] >= 0 && particle.offset[1] <= 0.1 + EPS);
      assert.ok(particle.size > 0 && particle.size < 0.04);
    }
    // a different landing index moves the burst
    assert.notDeepEqual(S.burstParticles({ i: 4 }, ballR), first);
  });
});

describe("lights", () => {
  it("converts Blender watts to three.js candela", () => {
    assert.equal(S.wattsToCandela(4 * Math.PI), 1);
    close(S.wattsToCandela(S.SPARK_PEAK), 45 / (4 * Math.PI), EPS, "spark peak");
  });

  it("flashes at the landing and settles to the idle pool", () => {
    assert.equal(S.sparkEnergy(0), S.SPARK_IDLE + S.SPARK_PEAK);
    close(S.sparkEnergy(S.SPARK_DECAY), S.SPARK_IDLE + S.SPARK_PEAK * Math.exp(-1), EPS);
    assert.ok(Math.abs(S.sparkEnergy(100) - S.SPARK_IDLE) < 1e-12);
    assert.ok(S.sparkEnergy(0.01) < S.sparkEnergy(0));
  });

  it("puts the sun opposite the direction it shines, above the floor", () => {
    const direction = S.sunDirectionBlender();
    close(Math.hypot(...direction), 1.0, 1e-12, "sun direction length");
    // R = Rz @ Ry @ Rx applied to the light's own -Z axis, worked through for
    // 52/0/126: z = -cos(52), y = sin(52) * cos(126), x = -sin(52) * sin(126).
    close(direction[2], -Math.cos(S.deg2rad(52)), 1e-12, "z");
    close(direction[1], Math.sin(S.deg2rad(52)) * Math.cos(S.deg2rad(126)), 1e-12, "y");
    close(direction[0], -Math.sin(S.deg2rad(52)) * Math.sin(S.deg2rad(126)), 1e-12, "x");

    const plan = S.sunDirectionPlan();
    assert.equal(plan[0], direction[0]);
    assert.equal(plan[1], direction[2]); // plan Y is Blender Z
    assert.equal(plan[2], direction[1]);
    assert.ok(plan[1] < 0, "the sun must shine downwards in the plan's Y-up axes");

    const offset = S.sunLightOffset(plan);
    assert.ok(offset[1] > 0, "the light must sit above the floor");
    close(Math.hypot(...offset), S.SUN_DISTANCE, 1e-9, "light distance");
  });

  it("keeps a fixed shadow grid", () => {
    close(S.shadowTexel(), (2 * S.SHADOW_EXTENT) / S.SHADOW_MAP, EPS, "texel");
    close(S.shadowTexel(), 0.009765625, EPS, "texel value");
    for (const value of [-3.14, -0.0004, 0, 0.5, 7.77]) {
      const snapped = S.snapToTexel(value);
      assert.equal(S.snapToTexel(snapped), snapped); // idempotent
      assert.ok(Math.abs(snapped - value) <= S.shadowTexel() / 2 + EPS);
      const whole = snapped / S.shadowTexel();
      close(whole, Math.round(whole), 1e-9, "whole texels");
    }
  });
});
