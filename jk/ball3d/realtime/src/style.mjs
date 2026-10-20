/**
 * Visual constants and pure colour/light maths, mirrored from
 * ``ball3d/render_scene.py``.
 *
 * The look is program-generated (see realtime/README.md: it is **not** a copy
 * of the reference video), but the numbers below are the established ball3d
 * style: neutral grey world/floor, dark suspension boards with a hint of the
 * event hue, a saturated contact-light palette, one coloured point light at the
 * current landing, a low sun for long shadows.
 *
 * All colours are **linear** RGB (Blender's base/emission colours are linear),
 * so they are handed to three.js via ``setRGB`` without an sRGB conversion.
 */

// --- world / lighting (render_scene.py) --------------------------------------
export const BG = [0.45, 0.46, 0.48];
export const BG_STRENGTH = 0.3; // little ambient -> shadows keep contrast
export const SUN_ENERGY = 2.6; // W/m2, three.js directional intensity is the same
export const SUN_EULER_DEG = [52.0, 0.0, 126.0];
export const SUN_ANGLE_DEG = 1.5;
export const SUN_DISTANCE = 30; // only moves the shadow camera, ortho sun
export const FILL_ENERGY = 45.0; // W, area light in Blender
export const FILL_SIZE = 8.0;
export const FILL_OFFSET_BLENDER = [2.5, -3.0, 3.5];
export const SPARK_LANE = -0.4; // point light nudged toward the camera
export const SPARK_HEIGHT = 0.35; // just above the floor -> coloured floor halo
export const SPARK_DECAY = 0.35;
export const SPARK_IDLE = 6.0;
export const SPARK_PEAK = 45.0;
export const GROUND_COLOR = [0.3, 0.31, 0.33];
export const GROUND_ROUGHNESS = 0.9;
export const POST_COLOR = [0.28, 0.29, 0.32];
export const PEARL_COLOR = [0.97, 0.96, 0.94];
export const PEARL_EMISSION = [0.9, 0.93, 1.0];
export const PEARL_ROUGHNESS = 0.06;
export const PEARL_COAT = 0.6;
export const PEARL_COAT_ROUGHNESS = 0.05;
export const PEARL_IOR = 1.55;
// --- palette (saturated contact light, never white) -------------------------
export const PALETTE_HUES = [0.52, 0.36, 0.13, 0.08, 0.88];
export const GLOW_STRENGTH = 2.2;
export const GLOW_DECAY_FRACTION = 0.35; // strength = G * exp(-dt / (life*0.35))
export const GLOW_WINDOW_FACTOR = 3.0; // a board glows while dt < life*3
export const STAR_STRENGTH = 3.0;
export const STARS_PER_LANDING = 6;
export const IDLE_BOARD = [0.05, 0.06, 0.075];
export const GLOW_TINT = 0.09; // dark body with only a hint of the event hue
export const PEARL_GLOW_SCALE = 0.25;
export const PEARL_GLOW_MAX = 0.9;

// --- camera / floor (render_scene.py) ----------------------------------------
export const CAM_OFFSET_BLENDER = [-3.0, -6.0, 5.5];
export const CAM_LOOKAHEAD_BLENDER = [0.6, 0.0, 0.0];
export const ORTHO_SCALE = 8.0;
export const GROUND_MARGIN = 40.0;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 2000.0; // same as Blender's clip_end

// --- bloom (compositor FOG_GLOW in Blender) ----------------------------------
export const BLOOM_STRENGTH = 0.18;
export const BLOOM_RADIUS = 0.3;
export const BLOOM_THRESHOLD = 0.7; // Blender glare threshold
export const BLOOM_MSAA = 4;

// --- shadow rig (a shadow map has no Blender equivalent to copy) -------------
export const SHADOW_EXTENT = 10.0; // half-size in metres, 20 m across
export const SHADOW_MAP = 2048;
export const SHADOW_NORMAL_BIAS = 0.03;
export const SUN_NEAR = 1.0;
export const SUN_FAR = 100.0;

const DEG = Math.PI / 180.0;

export function deg2rad(deg) {
  return deg * DEG;
}

/**
 * ``render_scene._hsv`` (h, s, v in 0..1 -> linear rgb in 0..1).
 *
 * Kept expression-for-expression so the palette the realtime renderer uses is
 * the same saturated colour the Blender renderer used.
 */
export function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6.0);
  const f = h * 6.0 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const table = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ];
  return table[i % 6];
}

/** ``render_scene.palette_hue``: pitch class -> saturated contact-light hue. */
export function paletteHue(key) {
  const n = PALETTE_HUES.length;
  return PALETTE_HUES[(((Math.trunc(key) % n) + n) % n)];
}

/** ``render_scene.glow_color``. */
export function glowColor(key) {
  return hsv(paletteHue(key), 0.85, 1.0);
}

/** ``render_scene`` board body: dark charcoal/blue plus a hint of the hue. */
export function boardBodyColor(key, idle = IDLE_BOARD, tint = GLOW_TINT) {
  const c = glowColor(key);
  return [
    idle[0] + tint * c[0],
    idle[1] + tint * c[1],
    idle[2] + tint * c[2],
  ];
}

/** ``render_scene.apply_frame``: animated board emission strength. */
export function glowStrength(dt, glowLife) {
  if (dt >= 0 && dt < glowLife * GLOW_WINDOW_FACTOR) {
    return GLOW_STRENGTH * Math.exp(-dt / (glowLife * GLOW_DECAY_FRACTION));
  }
  return 0;
}

/** The pearl only answers the freshest landing, never a glowing white disk. */
export function pearlGlow(recent) {
  return Math.min(PEARL_GLOW_MAX, PEARL_GLOW_SCALE * recent);
}

/** Star-burst scale of a landing ``dt`` seconds old (0 outside its life). */
export function burstScale(dt, hopLife) {
  if (dt < 0 || dt > hopLife) return 0;
  const rise = Math.min(1.0, dt / 0.1);
  const fade = Math.max(0.0, 1.0 - dt / hopLife);
  return (0.35 + 0.95 * rise) * fade;
}

/**
 * ``render_scene.particle_geometry``: sparse radiating octahedra around a
 * landing.  Pure and deterministic in the landing index, so the burst is
 * identical on every run (no Math.random anywhere in this renderer).
 */
export function burstParticles(landing, ballR, stars = STARS_PER_LANDING) {
  const seed = landing.i;
  const out = [];
  for (let k = 0; k < stars; k += 1) {
    const ang = (2.0 * Math.PI * k) / stars;
    const rad = ballR * (1.8 + 0.45 * ((seed * 7 + k * 13) % 5));
    const size = 0.014 + 0.004 * ((seed * 5 + k * 3) % 4);
    const lift = 0.05 * ((seed + k) % 3);
    // Blender local (cos*rad, sin*rad, lift) -> plan axes (x, y, z)
    out.push({ offset: [Math.cos(ang) * rad, lift, Math.sin(ang) * rad], size });
  }
  return out;
}

/** ``render_scene.apply_frame``: the rising part of a burst. */
export function burstRise(dt) {
  return 0.35 * Math.max(0.0, dt);
}

/** ``render_scene.apply_frame``: coloured point light energy at ``age``. */
export function sparkEnergy(age) {
  return SPARK_IDLE + SPARK_PEAK * Math.exp(-age / SPARK_DECAY);
}

/**
 * Blender light energy (W) -> three.js candela.
 *
 * A point light's irradiance at distance d is ``P / (4 pi d^2)`` in Blender and
 * ``I / d^2`` in three.js, so the two agree exactly for ``I = P / (4 pi)``.
 */
export function wattsToCandela(watts) {
  return watts / (4.0 * Math.PI);
}

/**
 * Blender SUN direction from its XYZ euler (``R = Rz Ry Rx`` applied to the
 * light's own ``-Z`` axis), in **Blender** axes.  Unit length by construction.
 */
export function sunDirectionBlender(eulerDeg = SUN_EULER_DEG) {
  const [rx, ry, rz] = [deg2rad(eulerDeg[0]), deg2rad(eulerDeg[1]), deg2rad(eulerDeg[2])];
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  return [
    -cx * sy * cz - sx * sz,
    -cx * sy * sz + sx * cz,
    -cx * cy,
  ];
}

/** The same sun direction expressed in the plan's Y-up axes. */
export function sunDirectionPlan(eulerDeg = SUN_EULER_DEG) {
  const d = sunDirectionBlender(eulerDeg);
  return [d[0], d[2], d[1]];
}

/**
 * Where the directional light sits relative to its shadow target: opposite the
 * direction it shines, ``SUN_DISTANCE`` away.
 */
export function sunLightOffset(directionPlan, distance = SUN_DISTANCE) {
  return [-directionPlan[0] * distance, -directionPlan[1] * distance, -directionPlan[2] * distance];
}

/**
 * A shadow map has no analytic Blender counterpart, so its grid is kept still:
 * the quadric is snapped to whole shadow texels, which stops the shadow edges
 * from crawling as the camera follows the ball.  The step (2*extent/map) is
 * ~1 cm here, far below a pixel of shadow movement.
 */
export function shadowTexel(extent = SHADOW_EXTENT, map = SHADOW_MAP) {
  return (2 * extent) / map;
}

export function snapToTexel(value, extent = SHADOW_EXTENT, map = SHADOW_MAP) {
  const texel = shadowTexel(extent, map);
  return Math.round(value / texel) * texel;
}
