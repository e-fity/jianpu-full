import { createGravityKit, courseKey } from "./gravity_layout.mjs";
/**
 * Per-task layout instantiation.
 *
 * ``layout.mjs`` keeps its geometry in module-level ``const``s, and the solver,
 * the renderer, the export page and the tests must all agree on one geometry for
 * one task.  Instead of mutating those constants (which would bleed one task's
 * geometry into another page or a running export), the source text is rewritten
 * for the requested geometry and imported as a *separate module instance*:
 * Node imports a ``data:`` URL, the browser a ``blob:`` URL.  Two tasks holding
 * two different geometries therefore hold two independent module namespaces and
 * cannot affect each other, while an identical geometry is served from a cache so
 * instance pools and materials stay shareable.
 */

/** Compact-asset proportions kept when the plank width changes. */
export const BOARD_H_RATIO = 0.06 / 0.30;

const OVERRIDE_NAMES = [
  "BOARD_W", "BOARD_H", "BOARD_D", "BALL_R", "CONTACT_OFF", "DX_MIN", "BOUNCE_SCALE",
];

/** The layout constants a geometry config implies (everything stays coupled). */
export function geometryOverrides(geometry) {
  const w = Number(geometry.board_w);
  const out = {
    BOARD_W: w,
    BOARD_H: round6(w * BOARD_H_RATIO),
    BOARD_D: Number(geometry.board_d),
    BALL_R: Number(geometry.ball_r),
    // the ball is supported at the plank's leading edge: half the plank width
    CONTACT_OFF: round6(w / 2),
    DX_MIN: Number(geometry.spacing),
    BOUNCE_SCALE: Number(geometry.bounce),
  };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isFinite(v) || v <= 0) throw new Error("bad geometry override " + k + "=" + v);
  }
  return out;
}

function round6(v) { return Math.round(v * 1e6) / 1e6; }

function formatNumber(v) {
  if (Number.isInteger(v)) return String(v);
  return String(round6(v));
}

/**
 * Rewrite ``export const NAME = ...;`` for every overridden constant.  A name
 * that is not found in the source is an error, never a silent no-op, so a future
 * rename cannot quietly stop the controls from doing anything.
 */
export function applyGeometry(source, geometry) {
  let out = String(source);
  const overrides = geometryOverrides(geometry);
  for (const name of OVERRIDE_NAMES) {
    const re = new RegExp("^(export const " + name + " = )[^;\\n]*;", "m");
    if (!re.test(out)) throw new Error("layout source has no constant " + name);
    out = out.replace(re, "$1" + formatNumber(overrides[name]) + ";");
  }
  return out;
}

/** Stable cache key: identical configs share one module instance. */
export function geometryKey(geometry) {
  const o = geometryOverrides(geometry);
  return OVERRIDE_NAMES.map((n) => n + "=" + o[n]).join(",");
}

export function geometryFromKey(key) {
  const map = {};
  for (const part of String(key).split(",")) {
    const i = part.indexOf("=");
    if (i > 0) map[part.slice(0, i)] = Number(part.slice(i + 1));
  }
  return {
    board_w: map.BOARD_W, board_h: map.BOARD_H, board_d: map.BOARD_D,
    ball_r: map.BALL_R, contact_off: map.CONTACT_OFF, dx_min: map.DX_MIN,
    bounce_scale: map.BOUNCE_SCALE,
  };
}

/**
 * Bounded module cache.  A module instance exists per distinct geometry, which
 * is one per *applied* configuration -- the panel debounces a slider and only
 * applies whole configs, so this holds a handful of entries, never one per
 * slider tick.  The cap keeps a long session from growing without bound, and a
 * dropped instance is simply re-imported if it is asked for again.
 *
 * Honest limitation: clearing this map releases *our* reference, not the
 * engine's.  A browser keeps an imported module (and Node its ``data:`` URL
 * module) alive for the life of the page/process, so a session that walked
 * through hundreds of *distinct* geometries would still hold hundreds of module
 * namespaces.  It stays finite in practice because the panel applies whole
 * configurations after a debounce -- a slider drag is one geometry, not sixty --
 * and a fresh page (or a fresh export run) starts empty.  Re-importing the
 * rewritten source is the deliberate price of never mutating a shared module's
 * constants, which would bleed one task's geometry into another.
 */
const MAX_CACHED_KITS = 8;
const cache = new Map();

/** FNV-1a over any string: cheap identity for a source text or a plan. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** FNV-1a over the serialised plan: cheap identity for a solved song. */
export function planKey(plan) {
  return fnv1a(JSON.stringify(plan));
}

const layoutCache = new Map();
const MAX_CACHED_LAYOUTS = 8;

/**
 * The solved layout of one song under one geometry.
 *
 * Solving includes placement, steering and visibility checks and depends on
 * the plan, geometry and course configuration, so a visual change (exposure,
 * colour, light) reuses the cached result instead of re-running the physics.
 */
export function layoutKey({ source, geometry, plan, presentation }) {
  return `${planKey(plan)}|${geometryKey(geometry)}|${fnv1a(String(source))}|${presentation ? courseKey(presentation) : "legacy"}`;
}

export async function layoutFor({ source, geometry, plan, importModule, presentation, onProgress }) {
  // The source text is part of the identity: two different layout.mjs
  // revisions must never share a solved layout (the tests load a rewritten
  // source -- e.g. an older sweep resolution -- through the same geometry).
  const key = layoutKey({ source, geometry, plan, presentation });
  const hit = layoutCache.get(key);
  if (hit) {
    layoutCache.delete(key); // refresh recency
    layoutCache.set(key, hit);
    return hit;
  }
  const promise = (async () => {
    onProgress?.({ stage: "准备排版", percent: 0 });
    const baseKit = await loadKit(source, geometry, importModule);
    const kit = presentation ? createGravityKit(baseKit, presentation) : baseKit;
    const layout = kit.buildLayout(plan, { seed: plan.layout_seed ?? 0, onProgress });
    onProgress?.({ stage: "检查排版结果", percent: 99 });
    return { key, kit, layout };
  })().catch((error) => {
    layoutCache.delete(key);
    throw error;
  });
  layoutCache.set(key, promise);
  while (layoutCache.size > MAX_CACHED_LAYOUTS) {
    layoutCache.delete(layoutCache.keys().next().value);
  }
  return promise;
}

export function clearLayoutCache() { layoutCache.clear(); }

export function cacheSizes() {
  return { kits: cache.size, layouts: layoutCache.size };
}

function defaultImporter(source) {
  // Node >= 18 and every Chromium support data: module imports; encodeURIComponent
  // keeps the UTF-8 comments in layout.mjs intact.
  return import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
}

/**
 * Import one layout module instance for ``geometry``.  ``source`` is the text of
 * realtime/src/layout.mjs (fs.readFileSync in Node, fetch in the browser).
 */
export async function loadKit(source, geometry, importModule = defaultImporter) {
  const key = geometryKey(geometry) + "|" + fnv1a(String(source));
  const hit = cache.get(key);
  if (hit) return hit;
  while (cache.size >= MAX_CACHED_KITS) {
    cache.delete(cache.keys().next().value);
  }
  const promise = Promise.resolve(importModule(applyGeometry(source, geometry)))
    .then((mod) => {
      // the module must really carry the requested geometry
      const o = geometryOverrides(geometry);
      for (const name of OVERRIDE_NAMES) {
        if (Math.abs(Number(mod[name]) - o[name]) > 1e-9) {
          throw new Error("layout module ignored the " + name + " override");
        }
      }
      return mod;
    })
    .catch((err) => { cache.delete(key); throw err; });
  cache.set(key, promise);
  return promise;
}

export function clearKitCache() { cache.clear(); }
export function kitCacheSize() { return cache.size; }

