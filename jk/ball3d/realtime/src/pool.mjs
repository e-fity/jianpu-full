/**
 * Bounded, *exact* pools over the plan's own timeline.
 *
 * The Blender renderer builds one object and one material per board, post and
 * star burst (678 objects / 343 materials for the 10-note fixture).  A realtime
 * renderer cannot afford that, so every repeated thing here is an
 * ``InstancedMesh`` with a fixed number of slots -- but the slot count is not a
 * guess: it is derived from the plan so that the pool provably contains
 * everything that can be visible at any ``t`` (see ``boardPool`` and
 * ``maxBurstWindow``).  Nothing pops in or out mid-shot.
 *
 * All functions are pure so the coverage claims are unit tested.
 */

/** Boards that must exist on each side of the ball for the visible frame. */
export const POOL_BACK = 12; // >= the shadow frustum (10 m / 1.05 m step)
export const POOL_AHEAD = 12;
/** Hard cap: a cap this large cannot be reached by a real score, and blowing
 * it is reported instead of silently dropping boards. */
export const POOL_MAX_SLOTS = 4096;

/**
 * The landing the ball has most recently reached: ``-1`` during the lead-in.
 *
 * Exactly ``bisect.bisect_right(times, t + 1e-9) - 1`` from
 * ``render_scene.apply_frame`` -- the same rule picks the coloured point
 * light's hue, so light and board glow can never disagree.
 */
export function activeLanding(times, t) {
  let lo = 0;
  let hi = times.length;
  const key = t + 1e-9;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Largest number of landings inside any ``window``-second span of ``times``.
 *
 * Used to size a pool that must contain every landing whose age is below
 * ``window``: at any ``t`` the count of such landings is at most this.
 */
export function maxLandingsWithin(times, window) {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi += 1) {
    while (times[hi] - times[lo] > window) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

/**
 * Board slots (plan board index, ``-1`` = the start pad) that must exist at
 * time ``t``: the ball's own board, the board it is hopping to, a margin for
 * the visible frame, and -- so no board ever stops glowing abruptly inside the
 * shot -- every board young enough to still be glowing.
 */
export function boardPool(times, t, opts = {}) {
  const back = opts.back ?? POOL_BACK;
  const ahead = opts.ahead ?? POOL_AHEAD;
  const glowWindow = opts.glowWindow ?? 0;
  const total = times.length;
  const active = activeLanding(times, t);
  const glowBack = glowWindow > 0 ? maxLandingsWithin(times, glowWindow) : 0;
  const lo = Math.max(-1, active - Math.max(back, glowBack));
  const hi = Math.min(total - 1, active + 1 + ahead);
  const count = Math.max(0, hi - lo + 1);
  return { lo, hi, count, active };
}

/**
 * Largest number of boards whose top lies within ``span`` world units vertically.
 *
 * Rows are uneven (a row can hold 1..MAX_GROUP boards), so a fixed count of
 * landings does *not* cover the visible frame: twelve landings may be two rows
 * or twelve.  Sizing the back/ahead margin by the real Y spread guarantees the
 * pool contains every board inside the camera's vertical window at any ``t``.
 */
export function maxLandingsWithinY(ys, span) {
  let best = 0;
  for (let i = 0; i < ys.length; i += 1) {
    let count = 0;
    for (let j = 0; j < ys.length; j += 1) {
      if (Math.abs(ys[j] - ys[i]) <= span) count += 1;
    }
    best = Math.max(best, count);
  }
  return best;
}

/** ``boardPool`` for the whole song: a fixed slot count plus the widest range. */
export function boardPoolSize(times, opts = {}) {
  const back = opts.back ?? POOL_BACK;
  const ahead = opts.ahead ?? POOL_AHEAD;
  const glowWindow = opts.glowWindow ?? 0;
  const glowBack = glowWindow > 0 ? maxLandingsWithin(times, glowWindow) : 0;
  // Interior worst case is (active + 1 + ahead) - (active - back) + 1; the pad
  // (index -1) means the widest pool any song can ever need is one per landing
  // plus the pad, i.e. times.length + 1.
  return Math.min(times.length + 1, Math.max(back, glowBack) + ahead + 2);
}

/**
 * Landings whose star burst is still alive at ``t`` (age in ``[0, hopLife]``).
 * An empty range is reported as ``hi < lo``.
 */
export function burstPool(times, t, hopLife) {
  const hi = activeLanding(times, t);
  if (hi < 0 || t - times[hi] > hopLife) return { lo: 0, hi: -1, count: 0 };
  let lo = hi;
  while (lo > 0 && t - times[lo - 1] <= hopLife) lo -= 1;
  return { lo, hi, count: hi - lo + 1 };
}

/** Fixed burst-slot capacity: one instance per star of the busiest window. */
export function burstPoolSize(times, hopLife, starsPerLanding) {
  return Math.max(1, maxLandingsWithin(times, hopLife)) * starsPerLanding;
}

/**
 * Board indices of a pool range, ``-1`` first when the pad is included.  The
 * scene maps each slot to a plan board through this list.
 */
export function poolIndices(range) {
  const out = [];
  for (let i = range.lo; i <= range.hi; i += 1) out.push(i);
  return out;
}

/**
 * Assert that a computed pool size is inside the hard cap; the scene calls this
 * so an absurd score fails loudly instead of silently rendering with holes.
 */
export function assertPoolFits(size, what, cap = POOL_MAX_SLOTS) {
  if (!(size > 0) || size > cap) {
    throw new Error(`${what} pool needs ${size} slots, cap is ${cap}`);
  }
  return size;
}

/**
 * ``render_scene.apply_frame``'s ``recent`` (the glow the pearl answers to),
 * computed from a pool instead of from every board.
 *
 * The maximum is always attained by the most recently reached landing, which
 * every pool contains -- the equivalence test asserts this against the
 * all-boards result.
 */
export function recentGlow(times, t, glowLife, strengthOf, indices) {
  let recent = 0;
  for (let k = 0; k < indices.length; k += 1) {
    const i = indices[k];
    if (i < 0 || i >= times.length) continue;
    recent = Math.max(recent, strengthOf(t - times[i], glowLife));
  }
  return recent;
}
