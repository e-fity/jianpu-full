/**
 * Music-driven layout for the "music machine" device -- natural descent.
 *
 * One module, one formula: the 3D scene (``music_machine.mjs``) and the 2D
 * preview (``preview2d.mjs``) both import it.
 *
 * Every sounding note owns a plank at its original onset. Notes with q >= 2,
 * or explicit sustain/glissando articulation, also own a reference brass slide.
 * Short hops use analytic gravity. Slide entry is a guided cubic approach;
 * riding follows the Blender profile, with a ballistic exit to the next note.
 * Rests consume time without creating planks or slides. All paths and static
 * planks/rails are checked for sphere clearance before export.
 *
 * Axes are the plan's: ``x`` across the wall, ``y`` up (negative = lower), ``z``
 * toward the camera.  The wall is at ``WALL_Z``, boards at ``BOARD_Z``.
 */

export const FORMAT = "ball3d-layout-v1";

// --- physics (all metre / second / radian) -----------------------------------
/** One gravity for every free flight.  Stylised (not 9.81): it is reported. */
export const G = 6.5;
export const G_VEC = [0, -G, 0];
// samples used when a newly placed plank is checked against the ball's earlier
// paths (see ``guard`` in solveFlight)
export const GUARD_SAMPLES = 28;
/** A sitting ball may hold a short note for at most this long. */
export const MAX_DWELL = 0.8;
/** ... and a long sounding note (the plank is held down, visibly glowing). */
export const LONG_DWELL_MAX = 1.7;
/** The ball keeps at least this fraction of the gap as contact dwell. */
export const SHORT_DWELL_FRACTION = 0.22;
/** Extra sitting allowed to absorb a gap that is too long for one arc. */
export const SIT_MAX = 2.4;
/** Half-width of the lateral corridor the descent prefers (metres).  The
 * corridor is soft: a dense run that cannot afford a turn may overshoot it. */
export const X_BAND = 2.1;
/** Nominal sideways speed of the descent (m/s). */
export const VX_NOMINAL = 0.85;
/** Steepest plank the layout will use; beyond this it steers less instead. */
export const TILT_MAX = 0.95;
/**
 * A flat-ish plank is almost always safe: when the chosen tilted arc would clip
 * a plank, the transition is re-solved on a shallow ramp before it is accepted.
 * The onsets never move -- only the plank pose and the arc do.
 */
export const TILT_SAFE = 0.35;
/**
 * Speed limits.  A plank may only redirect the ball; the layout never lets the
 * active strike pump the sideways speed (that is the "unlimited energy gain"
 * this refuses), so the out-going velocity is capped at the incoming speed and
 * the sideways speed is capped outright.  Both caps are audited.
 */
export const VX_MAX = 2.2;
export const V_MAX = 6.0;
/**
 * The ball touches the plank this far (metres, along the face) toward the end
 * it is travelling over.  The plank therefore trails behind the ball, which is
 * what lets a dense descent clear the plank it just left: the clearance only
 * needs DX_MIN of horizontal step instead of half a plank width plus the ball.
 */
export const CONTACT_OFF = 0.15; // = BOARD_W / 2: the ball is supported at the plank's leading edge
/** Smallest horizontal step the layout will take between two planks. */
export const DX_MIN = 0.34;
/**
 * Largest horizontal step of one flight.  A long interval flown far sideways
 * sweeps its descent leg across the planks placed before it, so long flights
 * are kept narrow (which is also what makes a long note read as a high bounce).
 */
export const STEP_MAX = 0.60;
/**
 * Full-path samples per flight (fractions of the flight time) used for the
 * sphere/OBB clearance check, so a flight is judged along its arc and not only
 * at its two endpoints.
 */
export const ARC_SAMPLES = [0.08, 0.2, 0.35, 0.5, 0.68, 0.85];
/** Sweep resolution of the per-flight sphere/OBB clearance check. */
export const FINE_SAMPLES = 256;
/**
 * Sweep resolution of the **post-build whole-path** clearance check.
 *
 * The per-flight test only looks at the planks the solver knew about while
 * placing that flight; a chute leg or a channel ride can still pass close to
 * a plank that was placed later (measured: one hop grazed a plank by 1.6 mm
 * on a whole song, invisible to a 24-sample sweep of that leg).  This sweep
 * runs over *every* segment against *every* plank, and the minimum is
 * refined around the best sample so the reported number is the true closest
 * approach, not the closest sample.
 */
export const PATH_SAMPLES = 256;
/** Extra clearance a candidate must keep over :data:`BALL_R` to be preferred. */
export const CLEAR_MARGIN = 0.012;
/** Restitution cap: above 1 the plank is an active strike with a visible flex. */
export const E_MAX = 5.0;
/** If even a chute is impossible the arc is forced up to this restitution. */
export const E_FORCED = 9.0;
/** Highest apex above the launch point that the camera is asked to hold. */
export const A_MAX = 2.9;
/** Per-transition drop bounds (the descent can never stall or teleport down). */
export const D_MIN = 0.12;
export const D_MAX = 10.0;
/** Rise share: 0 = a pure fall, RHO_MAX = a nearly level arc. */
export const RHO_MAX = 0.85;
export const T_RHO = 1.3;
/**
 * Long-note bounce-height preference (editor knob, 1.0 = the shipped plan).
 * The planned drop of a *long* transition is divided by it, so above 1 the ball
 * falls less and its apex is visibly higher, below 1 it flattens.  Only the
 * vertical profile of the arc between two unchanged landing times changes:
 * onsets, pitches and tempo are untouched.
 */
export const BOUNCE_SCALE = 1.0;
/** The bounce factor that applies to an interval of length ``T``. */
export function longBounce(T) {
  return T >= LONG_NOTE_MIN ? BOUNCE_SCALE : 1.0;
}
/** Planned drop of one transition including the long-note bounce preference. */
export function plannedDrop(T) {
  return clampRange(0.5 * G * T * T * (1 - riseShare(T)) / longBounce(T),
    D_MIN, D_MAX);
}
/** Number of drop candidates tried per transition (deterministic, no RNG). */
export const D_STEPS = 32;

// --- chute / trough thresholds (kept auditable, as before) -------------------
/** A sounding note at least this long is a "long tone". */
export const LONG_NOTE_MIN = 1.0;
/** ... and it must also be at least this many beats long. */
export const LONG_BEATS_MIN = 2;
/** A rest at least this long makes a transition a chute candidate. */
export const REST_CHANNEL_MIN = 1.2;
/** The ball may not need more than this much free flight in one arc (s). */
export const FLY_MAX = 2.25;
/** A chute needs this much time at the least. */
export const CHANNEL_MIN_TIME = 0.7;
/** ... and the ride may not exceed this speed (m/s). */
export const MAX_CHANNEL_SPEED = 4.2;
/** Slowest ride the layout will fall back to when a silence is very long. */
export const MIN_CHANNEL_SPEED = 0.22;
/** A rest at least this long ends the current phrase and starts a new one. */
export const REST_GROUP_MIN = 0.75;
/** Phrase caps, so a fast run still reads as a group. */
export const MAX_GROUP = 5;
export const MAX_GROUP_SPAN = 3.4;
/** A pitch jump of this many semitones or more also starts a new phrase. */
export const PITCH_LEAP = 7;

// --- geometry (metres) -------------------------------------------------------
export const BOARD_W = 0.30;
export const BOARD_H = 0.06;
export const BOARD_D = 0.50;
export const BALL_R = 0.10;
/**
 * Smallest *visible* gap between two neighbouring planks in the picture plane,
 * as a preference (not a hard failure): 15% of the plank width, i.e. the edge
 * gap the requirement asks a dense run to leave between the narrow planks.
 * A candidate that keeps it is ranked above one that does not, but only after
 * every collision axis -- block, interpenetration, ball clearance -- is equal,
 * so this can never buy a nicer gap with a grazing arc.
 */
export const PLANK_GAP_MIN = 0.15 * BOARD_W;
export const BOARD_Z = 0.0;
// The rear edge enters the wall; changing board depth keeps it attached.
export const WALL_Z = BOARD_Z - BOARD_D * 0.484;
export const SPACING = 0.72;      // nominal board pitch, kept for the pad offset
export const GLOW_LIFE = 0.45;    // seconds; same constant as the classic style
export const CHANNEL_HALFWIDTH = BALL_R * 0.675;
export const CHANNEL_RAIL_RADIUS = BALL_R * 0.175;
export function channelRailOffset() {
  return Math.sqrt((BALL_R + CHANNEL_RAIL_RADIUS) ** 2 - CHANNEL_HALFWIDTH ** 2);
}
export const CHANNEL_RAIL_H = 0.07;
export const CHANNEL_SUBDIV = 40;
export const CHANNEL_WINDOW = 6.0;
/**
 * Troughs live in the plank plane (``z = 0``).  A trough in front of the plane
 * looked tidier, but its exit flight then lands on a plank with a sideways
 * velocity the in-plane plank cannot return: the recorded pose drifted off the
 * ball by ~0.03 m and the ball/plank contact was no longer exact (measured on
 * boards 243/244 of the real song).  With the chute in-plane every position and
 * velocity keeps ``z = 0`` and every plank is a pure in-plane rotation.
 */
export const TROUGH_Z = 0.0;
/** Chute leg lengths: a hop up, a ride, a hop down onto the next plank. */
export const CHUTE_ENTRY_DROP = 0.55;
export const CHUTE_ENTRY_STEP = 0.35;
export const CHUTE_EXIT_LIFT = 0.85;
export const CHUTE_SIT_MAX = 2.0;
export const BOARD_PALETTE = [
  { name: "pink", rgb: [0.80, 0.32, 0.46] },
  { name: "ivory", rgb: [0.88, 0.89, 0.80] },
  { name: "yellow", rgb: [1.00, 0.68, 0.23] },
];

export const clamp = (u) => Math.max(0, Math.min(1, u));
export const clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const smoothstep = (u) => {
  const s = clamp(u);
  return s * s * (3 - 2 * s);
};
export const mix = (a, b, u) => [
  a[0] + (b[0] - a[0]) * u,
  a[1] + (b[1] - a[1]) * u,
  a[2] + (b[2] - a[2]) * u,
];
const round = (v) => Math.round(v * 1000) / 1000;
const vec = (p) => [p[0], p[1], p[2]];

export function hash32(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function layoutSeed(plan, seed = 0) {
  const counts = plan.counts || {};
  return hash32([
    plan.key || "", plan.tempo_qpm || 0, counts.sounding || 0,
    counts.rests || 0, plan.title || "", seed,
  ].join("|"));
}

export function restSecondsBetween(plan, t0, t1) {
  let seconds = 0;
  for (const rest of plan.rests || []) {
    const a = Math.max(rest.onset_sec, t0);
    const b = Math.min(rest.onset_sec + rest.dur_sec, t1);
    if (b > a) seconds += b - a;
  }
  return seconds;
}

export function paletteIndexFor(n) {
  const k = ((Math.trunc(n) - 1) % BOARD_PALETTE.length + BOARD_PALETTE.length)
    % BOARD_PALETTE.length;
  return k;
}

/**
 * How much brighter an emissive glow is than the plank's own diffuse colour.
 *
 * One constant for both channels on purpose: the renderer tints the diffuse
 * colour and the glow from the *same* final colour (see ``boardGlowColor``), so
 * a board painted brown/teal glows in that same hue instead of the palette's
 * original yellow/pink.
 */
export const BOARD_GLOW_GAIN = 1.6;

/**
 * The glow colour of a board, from its **final** colour.
 *
 * ``rgb`` is the board's linear colour *after* the editor's board colour and
 * strength have been applied -- the very value written to the instance's
 * diffuse colour.  Scaling that same value keeps the two channels in step, and
 * with ``board_tint = 0`` the final colour *is* the palette entry, so the
 * original glow is reproduced exactly.  ``out`` is optional, to keep per-frame
 * calls allocation-free.
 */
export function boardGlowColor(rgb, out) {
  const dst = out || [0, 0, 0];
  dst[0] = rgb[0] * BOARD_GLOW_GAIN;
  dst[1] = rgb[1] * BOARD_GLOW_GAIN;
  dst[2] = rgb[2] * BOARD_GLOW_GAIN;
  return dst;
}

export const SHAPES = ["descend", "zigzag", "long-arc", "turn"];

/**
 * Split the sounding landings into phrases for the report.  A new phrase starts
 * when a rest of at least REST_GROUP_MIN separates the notes, when the phrase
 * already holds MAX_GROUP notes, when it has spanned MAX_GROUP_SPAN seconds,
 * after a long sounding note, or on a pitch leap.  Placement is *not* phrase
 * based any more: boards follow the ball's descent.
 */
export function groupLandings(plan) {
  const landings = plan.landings || [];
  const groups = [];
  let current = null;
  let startT = 0;
  for (let i = 0; i < landings.length; i += 1) {
    const l = landings[i];
    let reason = null;
    if (current === null) {
      reason = "start";
    } else {
      const prev = landings[i - 1];
      const rest = restSecondsBetween(plan, prev.t, l.t);
      if (rest >= REST_GROUP_MIN) reason = "rest";
      else if (current.members.length >= MAX_GROUP) reason = "length";
      else if (Math.abs(l.t - startT) >= MAX_GROUP_SPAN) reason = "span";
      else if (prev.dur >= LONG_NOTE_MIN) reason = "long";
      else if (Math.abs(l.midi - prev.midi) >= PITCH_LEAP) reason = "leap";
    }
    if (current === null || reason !== null) {
      current = { index: groups.length, reason, from: i, to: i, members: [] };
      groups.push(current);
      startT = l.t;
    }
    current.members.push(i);
    current.to = i;
  }
  return groups;
}

/** Share of the half flight the planned arc spends rising (0 = a pure fall). */
export function riseShare(T) {
  return clampRange(T / T_RHO, 0, RHO_MAX);
}

/** Planned drop of one transition: longer intervals rise higher, fall less. */
export function idealDrop(T) {
  return plannedDrop(T);
}

/** Apex of a vertical launch vy under the one gravity. */
export function apexOf(vy) {
  return vy > 0 ? (vy * vy) / (2 * G) : 0;
}

/**
 * Plank pose from its hinge and tilt: normal, centre, contact, ball centre.
 * ``off`` slides the contact along the face (0 = face centre); the ball always
 * sits exactly ``BALL_R`` above ``contact`` along the normal, so the displayed
 * pose, the contact point and the collision test all share this one datum.
 */
export function plankPose(hinge, tilt, off = 0) {
  const normal = [Math.sin(tilt), Math.cos(tilt), 0];
  const tangent = [Math.cos(tilt), -Math.sin(tilt), 0];
  const contact = [
    hinge[0] + BOARD_H * normal[0] + off * tangent[0],
    hinge[1] + BOARD_H * normal[1] + off * tangent[1],
    hinge[2],
  ];
  // The plank's own centre is the face centre dropped half a thickness along
  // the normal.  ``off`` slides the *contact* along the face (the ball is
  // supported at the leading edge), it must NOT slide the plank: sliding both
  // put the plank back under the ball and made a landing clip the plank it had
  // just left (measured: 279 clearance failures, 99 overlapping planks).
  const centre = [
    hinge[0] + (BOARD_H / 2) * normal[0],
    hinge[1] + (BOARD_H / 2) * normal[1],
    hinge[2],
  ];
  return {
    normal, contact, off, centre,
    ball_pos: [contact[0] + BALL_R * normal[0],
               contact[1] + BALL_R * normal[1], contact[2]],
    tilt, hinge,
  };
}

/**
 * Hinge (plank underside mount) that puts the ball centre exactly on ``p`` and
 * the contact ``off`` along the face toward the ball's travel direction.
 */
export function hingeFor(p, n, off = 0) {
  const tilt = Math.atan2(n[0], n[1]);
  const tx = Math.cos(tilt) * off;
  const ty = -Math.sin(tilt) * off;
  return [
    p[0] - tx - (BOARD_H + BALL_R) * n[0],
    p[1] - ty - (BOARD_H + BALL_R) * n[1],
    p[2] - (BOARD_H + BALL_R) * n[2],
  ];
}

/**
 * Distance from a ball centre to a plank's oriented box (0 on the face, > 0
 * outside).  Same half extents and same rotation as the renderer, so the
 * displayed plank, the contact datum and this test cannot disagree.
 */
export function plankDistance(pose, p) {
  const c = Math.cos(pose.tilt ?? 0);
  const s = Math.sin(pose.tilt ?? 0);
  const dx = p[0] - pose.pos[0];
  const dy = p[1] - pose.pos[1];
  const dz = p[2] - pose.pos[2];
  const lx = c * dx - s * dy;
  const ly = s * dx + c * dy;
  const half = [BOARD_W / 2, BOARD_H / 2, BOARD_D / 2];
  let d2 = 0;
  const local = [lx, ly, dz];
  for (let k = 0; k < 3; k += 1) {
    const v = Math.min(half[k], Math.max(-half[k], local[k]));
    d2 += (local[k] - v) ** 2;
  }
  return Math.sqrt(d2);
}

/**
 * Axis-aligned bounds of a plank (its own OBB's bounding box).  The solver uses
 * it to pick the planks a flight could possibly touch: a parabola has a
 * monotone ``x`` and its ``y`` spans the fall plus the apex, so one box test per
 * plank rules out everything the ball cannot reach -- without it a long note
 * would have to be checked against every plank placed before it.
 */
/** Bounding box of a flight arc (x monotone, y spans start, apex and end). */
export function arcWindow(p, v0, T, apex) {
  const p1 = [
    p[0] + v0[0] * T + 0.5 * G_VEC[0] * T * T,
    p[1] + v0[1] * T + 0.5 * G_VEC[1] * T * T,
    p[2] + v0[2] * T + 0.5 * G_VEC[2] * T * T,
  ];
  return {
    lo: [Math.min(p[0], p1[0]) - BALL_R, Math.min(p[1], p1[1]) - BALL_R, -BALL_R],
    hi: [Math.max(p[0], p1[0]) + BALL_R,
      Math.max(p[1] + (apex ?? 0), p1[1]) + BALL_R, BALL_R],
  };
}

export function plankAabb(pose) {
  const c = Math.abs(Math.cos(pose.tilt ?? 0));
  const s = Math.abs(Math.sin(pose.tilt ?? 0));
  const hx = (BOARD_W / 2) * c + (BOARD_H / 2) * s;
  const hy = (BOARD_W / 2) * s + (BOARD_H / 2) * c;
  const p = pose.pos;
  return { lo: [p[0] - hx, p[1] - hy, p[2] - BOARD_D / 2],
           hi: [p[0] + hx, p[1] + hy, p[2] + BOARD_D / 2] };
}

/**
 * True when two slabs cannot intersect: some axis separates them by more than
 * the sum of their projected half extents.  Plates are boards, not ghosts, so
 * the layout uses this to keep neighbours from growing through each other.
 */
export function platesApart(a, b) {
  const tiltA = a.tilt ?? 0;
  const tiltB = b.tilt ?? 0;
  const d = [a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]];
  const probe = (ux, uy, uz) => {
    const ext = (tilt) => {
      const c = Math.cos(tilt), s = Math.sin(tilt);
      const along = Math.abs(c * ux - s * uy);
      const across = Math.abs(s * ux + c * uy);
      return (BOARD_W / 2) * along + (BOARD_H / 2) * across + (BOARD_D / 2) * Math.abs(uz);
    };
    return Math.abs(d[0] * ux + d[1] * uy + d[2] * uz) >= ext(tiltA) + ext(tiltB) - 1e-9;
  };
  return probe(Math.cos(tiltA), -Math.sin(tiltA), 0)
    || probe(Math.sin(tiltA), Math.cos(tiltA), 0)
    || probe(Math.cos(tiltB), -Math.sin(tiltB), 0)
    || probe(Math.sin(tiltB), Math.cos(tiltB), 0)
    || probe(0, 0, 1);
}

/**
 * In-plane corners of the *drawn* plank (the x-y plane the camera looks at).
 * The slab is BOARD_W along the tangent and BOARD_H along the normal; BOARD_D
 * is the depth into the screen and never appears here.  Same ``pos``/``tilt``
 * datum as :func:`plankAabb`, so the picture and the collision box agree.
 */
export function plankOutline(pose) {
  const tilt = pose.tilt ?? 0;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const hw = BOARD_W / 2, hh = BOARD_H / 2;
  const p = pose.pos;
  const out = [];
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push([p[0] + a * hw * c + b * hh * s, p[1] - a * hw * s + b * hh * c]);
  }
  return out;
}

function pointSegDistance(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / l2));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/**
 * Distance between the outlines of two drawn planks in the picture plane.
 * Both outlines are convex quads, so for disjoint polygons the minimum is
 * attained at a vertex of one and an edge of the other; that is all this
 * checks.  Returns 0 when they touch or cross.
 */
export function outlineGap(a, b) {
  const pa = plankOutline(a);
  const pb = plankOutline(b);
  let best = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const e0 = pa[i], e1 = pa[(i + 1) % 4];
    for (const p of pb) best = Math.min(best, pointSegDistance(p, e0, e1));
  }
  for (let i = 0; i < 4; i += 1) {
    const e0 = pb[i], e1 = pb[(i + 1) % 4];
    for (const p of pa) best = Math.min(best, pointSegDistance(p, e0, e1));
  }
  return best;
}

/** Solve a plain free flight between two fixed points (chute legs, lead-in). */
export function solveLeg(p, pNext, T) {
  return [
    (pNext[0] - p[0]) / T - 0.5 * G_VEC[0] * T,
    (pNext[1] - p[1]) / T - 0.5 * G_VEC[1] * T,
    (pNext[2] - p[2]) / T - 0.5 * G_VEC[2] * T,
  ];
}

/** Sample an analytic flight at local u in [0, 1]. */
export function flightPoint(seg, u) {
  const t = clamp(u) * (seg.t1 - seg.t0);
  return [
    seg.p0[0] + seg.v0[0] * t + 0.5 * G_VEC[0] * t * t,
    seg.p0[1] + seg.v0[1] * t + 0.5 * G_VEC[1] * t * t,
    seg.p0[2] + seg.v0[2] * t + 0.5 * G_VEC[2] * t * t,
  ];
}

/** Exact flight velocity at local u (analytic derivative, not finite diff). */
export function flightVelocity(seg, u) {
  const t = clamp(u) * (seg.t1 - seg.t0);
  return [
    seg.v0[0] + G_VEC[0] * t,
    seg.v0[1] + G_VEC[1] * t,
    seg.v0[2] + G_VEC[2] * t,
  ];
}

/**
 * Solve one free flight: leave p with incoming velocity vIn and touch pNext
 * exactly T seconds later.  The launch velocity is solved from the interval
 * (v0 = (pNext - p) / T - 0.5 g T), so the contact is exact by construction.
 *
 * The plank normal is the direction of the velocity change (n ~ vOut - vIn),
 * which preserves the tangential component exactly, and the restitution
 * e = -(vOut.n) / (vIn.n) is recorded: e <= 1 is a passive plank, e > 1 is an
 * active strike (recorded, capped at eMax, shown as a flex).
 *
 * wantX is where the layout would like the next contact; the tilt is clamped to
 * tiltMax by steering less, never by faking the reflection.
 */
/** Rejection counters for the solver, only filled when BALL3D_DEBUG_REJ is set. */
const REJ = {};
export function rejectionStats() { return REJ; }
// The same module runs in Node (tests, probes) and in the browser export
// bundle, so the debug switches must tolerate an absent ``process``.
const envFlag = (name) => typeof process !== "undefined" && process.env
  && Boolean(process.env[name]);
const rej = (why) => { if (envFlag("BALL3D_DEBUG_REJ")) REJ[why] = (REJ[why] || 0) + 1; };

export /** Ballistic position of the arc launched at ``p`` with ``v`` after ``tt`` s. */
function arcPoint(p, v, tt) {
  return [
    p[0] + v[0] * tt + 0.5 * G_VEC[0] * tt * tt,
    p[1] + v[1] * tt + 0.5 * G_VEC[1] * tt * tt,
    p[2] + v[2] * tt + 0.5 * G_VEC[2] * tt * tt,
  ];
}

/**
 * Times in ``[0, T]`` where a ballistic arc is closest to a plank along the
 * plank's own face: the along-face coordinate is affine in ``t`` plus a
 * quadratic from gravity, so the extreme is a root of a quadratic.  The exact
 * extreme is where a shallow arc grazes a plank between fixed sample fractions.
 */
export function closestApproachTimes(p, v, T, plate) {
  const c = Math.cos(plate.tilt ?? 0);
  const s = Math.sin(plate.tilt ?? 0);
  // along-face direction of the plank's local +x axis
  const tx = c;
  const ty = -s;
  const px = p[0] - plate.pos[0];
  const py = p[1] - plate.pos[1];
  const b = tx * v[0] + ty * v[1];
  const a = 0.5 * (tx * G_VEC[0] + ty * G_VEC[1]);
  const d0 = tx * px + ty * py;
  const out = [];
  const push = (tt) => {
    if (tt >= -1e-9 && tt <= T + 1e-9) out.push(Math.min(T, Math.max(0, tt)));
  };
  if (Math.abs(a) > 1e-12) {
    const disc = b * b - 4 * a * d0;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      push((-b - r) / (2 * a));
      push((-b + r) / (2 * a));
    }
  } else if (Math.abs(b) > 1e-12) {
    push(-d0 / b);
  }
  const wobble = 0.06 * T;
  for (const tt of out.slice()) { push(tt - wobble); push(tt + wobble); }
  return out;
}

/**
 * Times in ``[0, T]`` where the ball centre crosses one of the plank's four
 * face planes (its local ``x = +-BOARD_W/2`` and ``y = +-BOARD_H/2``).
 *
 * Between two such crossings the sphere-to-box distance is smooth, and its
 * interior extremes are the along-face root (see :func:`closestApproachTimes`)
 * or zero (the ball is inside the box).  Sampling exactly at the crossings,
 * plus a hair either side, therefore makes the clearance test complete instead
 * of merely dense -- which is what a graze of a narrow, thin plank needs.
 */
export function faceCrossTimes(p, v, T, plate) {
  const c = Math.cos(plate.tilt ?? 0);
  const s = Math.sin(plate.tilt ?? 0);
  const px = p[0] - plate.pos[0];
  const py = p[1] - plate.pos[1];
  const out = [];
  const push = (tt) => {
    if (tt >= -1e-9 && tt <= T + 1e-9) out.push(Math.min(T, Math.max(0, tt)));
  };
  const roots = (a, b, c0, target) => {
    const cc = c0 - target;
    if (Math.abs(a) > 1e-12) {
      const disc = b * b - 4 * a * cc;
      if (disc < 0) return;
      const r = Math.sqrt(disc);
      push((-b - r) / (2 * a));
      push((-b + r) / (2 * a));
    } else if (Math.abs(b) > 1e-12) push(-cc / b);
  };
  const ax = 0.5 * (c * G_VEC[0] - s * G_VEC[1]);
  const ay = 0.5 * (s * G_VEC[0] + c * G_VEC[1]);
  const bx = c * v[0] - s * v[1];
  const by = s * v[0] + c * v[1];
  const x0 = c * px - s * py;
  const y0 = s * px + c * py;
  for (const h of [BOARD_W / 2, -BOARD_W / 2]) roots(ax, bx, x0, h);
  for (const h of [BOARD_H / 2, -BOARD_H / 2]) roots(ay, by, y0, h);
  const eps = Math.max(1e-3, 0.004 * T);
  for (const tt of out.slice()) { push(tt - eps); push(tt + eps); }
  return out;
}

function solveFlight(p, vIn, T, wantX, opts = {}) {
  const tiltMax = opts.tiltMax ?? TILT_MAX;
  const eMax = opts.eMax ?? E_MAX;
  const offMag = opts.offMag ?? CONTACT_OFF;
  const recent = opts.recent ?? [];
  if (!(T > 0)) { rej("no_time"); return { ok: false, why: "no time" }; }
  // a short interval can only absorb the drop that free fall allows: the scan
  // must be able to go below D_MIN, otherwise no passive arc exists at all
  const dFree = 0.5 * G * T * T;
  const d0 = Math.min(idealDrop(T), dFree * 0.9);
  // A ball cannot leave a plank while already falling onto it: leaving with a
  // downward velocity means the sphere re-enters the slab it just left, so the
  // drop is capped at free fall (vy >= 0) and the policy drop keeps a margin
  // below it.  D = free fall is the "dead landing" (vy = 0, e = 0) which always
  // exists for a falling arrival -- that is what makes the solve total.
  const dMax = Math.min(Math.max(d0, opts.dropMax ?? D_MAX), dFree);
  const tanMax = Math.tan(tiltMax);
  let best = null;
  let vCapped = 0;
  // Candidates: the policy drop first; then shallower drops (a shallower drop
  // leaves more tilt authority, which is what a dense interval needs to clear
  // the plank it left); then deeper drops, up to the audited cap.
  const drops = [];
  // Passive-first: for a launch the plank does *not* have to add energy to, the
  // ball arrives with vIn.y < 0 and leaves with vOut.y = e * -vIn.y, so the drop
  // over the interval is  D = T (g T / 2 + e vIn.y).  Trying these first means a
  // long note becomes a high, *passive* bounce whose landing is far below (the
  // ball is falling fast when it lands), instead of a shallow arc propped up by
  // a big active strike that then sweeps sideways through earlier planks.
  for (const ePass of []) {
    const Dm = T * (0.5 * G * T + ePass * vIn[1]);
    if (Dm >= BOARD_H + 0.015 && Dm <= dMax + 1e-9) drops.push(Dm);
  }
  drops.push(d0);
  // never go below the slab thickness: two planks closer than this in the
  // normal direction would grow through each other
  for (let i = 1; i <= 6; i += 1) {
    const d = d0 * (1 - i / 6);
    if (d >= BOARD_H + 0.015) drops.push(d);
  }
  for (let i = 1; i <= D_STEPS; i += 1) drops.push(d0 + (dMax - d0) * (i / D_STEPS));
  for (let step = 0; step < drops.length; step += 1) {
    const D = Math.max(0, drops[step]);
    const vy = 0.5 * G * T - D / T;
    const apex = apexOf(vy);
    if (apex > A_MAX + 1e-9) { rej("apex"); continue; }
    // Tilt authority, exactly: the plank normal is the direction of the
    // velocity change, n ~ vOut - vIn = (s, 1)/|.| cos t for s = tan t, and the
    // ball can only land on that top face while it is still moving towards it:
    //   vIn.x sin t + vIn.y cos t < 0  <=>  tan t < -vIn.y / vIn.x   (vIn.x > 0)
    // A plank may therefore never be steeper than the trajectory landing on it,
    // and |t| <= tiltMax.  The out-going side (vOut.n > 0) then follows from
    // vOut - vIn = |dv| n, so this interval is the whole reachable set.
    const dvy = vy - vIn[1];
    if (!(dvy > 1e-9)) { rej("slack"); continue; }
    const slopeHi = vIn[0] > 1e-9 ? -vIn[1] / vIn[0] : Infinity;
    const slopeLo = vIn[0] < -1e-9 ? -vIn[1] / vIn[0] : -Infinity;
    const sHi = Math.min(tanMax, slopeHi);
    const sLo = Math.max(-tanMax, slopeLo);
    if (sHi < sLo - 1e-12) { rej("slope"); continue; }
    const dxWant = wantX - p[0];
    const dir = dxWant >= 0 ? 1 : -1;
    const wanted = Math.max(Math.abs(dxWant), DX_MIN) * dir;
    const lo = (vIn[0] + sLo * dvy) * T;
    const hi = (vIn[0] + sHi * dvy) * T;
    let capped = false;
    if (dir > 0 ? wanted > hi + 1e-12 : wanted < lo - 1e-12) capped = true;
    // the landing point inside the reachable set is free, so try the target,
    // the minimum clearing step either way and both ends of the set: the one
    // that clears the plank it left wins (the ball keeps its sideways drift
    // when a turn cannot be paid for)
    const build = (corridor) => {
      const cands = [];
      const add = (v) => {
        if (!(v >= lo - 1e-9 && v <= hi + 1e-9)) return;
        const c = Math.min(hi, Math.max(lo, v));
        if (Number.isFinite(corridor) && Math.abs(p[0] + c) > corridor) return;
        // one flight never travels further sideways than STEP_MAX: a wide
        // sideways sweep is what drags the arc across earlier planks
        if (Math.abs(c) > STEP_MAX + 1e-9) return;
        if (!cands.some((x) => Math.abs(x - c) < 1e-9)) cands.push(c);
      };
      add(wanted);
      add(Math.sign(vIn[0] || dir) * DX_MIN);
      add(dir * DX_MIN);
      add(hi);
      add(lo);
      add(0);
      // The landing point inside the reachable set is free (the plank's tilt is
      // chosen to land there), so sweep the interval instead of trying a few
      // hand-picked values: a step a few centimetres away from the wanted one
      // is what turns "grazes a plank by 3 mm" into a clean arc.
      for (let g = 1; g < 12; g += 1) add(lo + (hi - lo) * (g / 12));
      if (!cands.length) {
        // every reachable point is outside the corridor: take the one closest
        // to the middle of the frame (this is what turns the ball back inward)
        add(Math.min(hi, Math.max(lo, -Math.sign(p[0]) * X_BAND - p[0])));
        add(hi);
        add(lo);
      }
      return cands;
    };
    let cands = build(X_BAND + 0.6);
    if (!cands.length) cands = build(Infinity);
    if (!cands.length) { rej("empty"); continue; }
    cands.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
    for (const cand of cands) {
      const dx = cand;
      const vOut = [dx / T, vy, 0];
      const dvv = [vOut[0] - vIn[0], vOut[1] - vIn[1], vOut[2] - vIn[2]];
      const len = Math.hypot(dvv[0], dvv[1], dvv[2]) || 1e-9;
      const n = [dvv[0] / len, dvv[1] / len, dvv[2] / len];
      const vnIn = vIn[0] * n[0] + vIn[1] * n[1] + vIn[2] * n[2];
      const vnOut = vOut[0] * n[0] + vOut[1] * n[1] + vOut[2] * n[2];
      if (!(vnIn < -1e-9) || !(vnOut > -1e-9)) { rej("sign"); continue; }
      const e = -vnOut / vnIn;
      if (!(e >= 0) || e > eMax + 1e-9) { rej("e"); continue; }
      // speed caps: never faster sideways than vxMax, never faster overall than
      // the incoming speed (a plank redirects, it does not accelerate the ball)
      const spd = Math.hypot(vOut[0], vOut[1], vOut[2]);
      const speedCap = Math.max(opts.vMax ?? V_MAX, Math.hypot(vIn[0], vIn[1], vIn[2]));
      if (Math.abs(vOut[0]) > (opts.vxMax ?? VX_MAX) + 1e-9 || spd > speedCap + 1e-9) {
        rej("vcap");
        vCapped += 1;
        continue;
      }
      const pNext = [
        p[0] + vOut[0] * T + 0.5 * G_VEC[0] * T * T,
        p[1] + vOut[1] * T + 0.5 * G_VEC[1] * T * T,
        p[2] + vOut[2] * T + 0.5 * G_VEC[2] * T * T,
      ];
      // the plank under this collision, then the sphere/OBB clearance of the
      // landing against every plank still near it
      const tilt = Math.atan2(dvv[0], dvv[1]);
      // The ball is supported at the plank's leading edge *in the direction it
      // is travelling over it*, so the plank never overhangs the side the ball
      // leaves on -- that overhang is what used to make a landing clip the
      // plank it had just left.  When the step is given back to zero (a
      // vertical pop) the sign comes from the velocity instead of the step.
      const tdir = Math.abs(dx) > 1e-6 ? Math.sign(dx)
        : (Math.abs(vOut[0]) > 1e-6 ? Math.sign(vOut[0])
          : (Math.abs(vIn[0]) > 1e-6 ? Math.sign(vIn[0]) : 1));
      const off = tdir * offMag;
      const pose = plankPose(hingeFor(p, n, off), tilt, off);
      // The ball leaves this plank over its leading edge; a departure that is
      // only marginally clear of the face (a fast sideways slide, say) bends
      // back into the corner under gravity.  That clearance is analytic, so it
      // is exact instead of sample-dependent -- and it is the same rule the
      // chute's entry leg uses, so a launch is never smoother than a ride.
      let clear = entryCornerClearance(vOut, tilt, off, T);
      let near = -1;
      let overlaps = false;
      // Full-path sphere/OBB clearance, verified against *every* plank the
      // flight can possibly reach -- not only the last few.  The arc's own
      // bounding box (x is monotone, y spans the fall and the apex) selects
      // them, and each selected plank is swept finely and probed at the exact
      // along-face extreme.  Sample fractions alone are not enough: a reading
      // that only samples three points of a rise stepped straight over a plank
      // the long bounce punched through (measured: 115 of 147 real-song
      // clearances were a rising arc inside a plank it had already passed).
      const arcLo = [Math.min(p[0], pNext[0]) - BALL_R,
        Math.min(p[1], pNext[1]) - BALL_R, -BALL_R];
      const arcHi = [Math.max(p[0], pNext[0]) + BALL_R,
        Math.max(p[1] + apex, pNext[1]) + BALL_R, BALL_R];
      const ownBox = plankAabb({ pos: pose.centre, tilt });
      const plates = [{ pos: pose.centre, tilt, index: -1 }];
      for (const pl of (opts.placed ?? recent)) {
        const box = plankAabb(pl);
        if (box.hi[0] < arcLo[0] || box.lo[0] > arcHi[0]) continue;
        if (box.hi[1] < arcLo[1] || box.lo[1] > arcHi[1]) continue;
        if (box.hi[2] < arcLo[2] || box.lo[2] > arcHi[2]) continue;
        plates.push(pl);
      }
      const samples = [pNext];
      for (const u of ARC_SAMPLES) samples.push(arcPoint(p, vOut, u * T));
      for (let i = 1; i < FINE_SAMPLES; i += 1) {
        samples.push(arcPoint(p, vOut, (i / FINE_SAMPLES) * T));
      }
      for (let j = 0; j < plates.length; j += 1) {
        const pl = plates[j];
        const tag = pl.index === undefined ? -1 : pl.index;
        for (const q of samples) {
          const d = plankDistance(pl, q);
          if (d < clear) { clear = d; near = tag; }
        }
        // Fixed fractions can step over the true closest approach of a
        // shallow arc over a plank, which is where a graze hides.  For a
        // ballistic arc the along-plank coordinate is quadratic in t, so its
        // minimum is a root of a quadratic: sample there and just around it.
        for (const tt of closestApproachTimes(p, vOut, T, pl)) {
          const d = plankDistance(pl, arcPoint(p, vOut, tt));
          if (d < clear) { clear = d; near = tag; }
        }
        // ... and at every time the ball crosses one of the plank's face
        // planes, which is where a thin plank can hide a graze between samples
        for (const tt of faceCrossTimes(p, vOut, T, pl)) {
          const d = plankDistance(pl, arcPoint(p, vOut, tt));
          if (d < clear) { clear = d; near = tag; }
        }
        if (j > 0 && !platesApart(plates[0], pl)) overlaps = true;
      }
      for(const rail of opts.guard?.rails || []) {
        if(arcHi[1]<rail.y_lo-BALL_R || arcLo[1]>rail.y_hi+BALL_R)continue;
        for(let i=0;i<samples.length;i+=4)clear=Math.min(clear,slideDistance(rail,samples[i]));
      }
      // A candidate plank must also not interpenetrate *any* plank placed so
      // far -- not only the planks the current arc happens to fly near.  Two
      // neighbouring planks of a dense descending run sit a few centimetres
      // apart, and two steep tilts can swing one slab into the next even when
      // the ball flies nowhere near the pair (measured: 7 interpenetrating
      // pairs at |tilt| ~ 0.9 while the arc-local test reported none).  This
      // is the same exact separating-axis test, run over every placed plank;
      // the AABB pre-filter keeps it cheap.
      if (!overlaps) {
        for (const pl of (opts.placed ?? recent)) {
          const box = plankAabb(pl);
          if (box.hi[0] < ownBox.lo[0] || box.lo[0] > ownBox.hi[0]) continue;
          if (box.hi[1] < ownBox.lo[1] || box.lo[1] > ownBox.hi[1]) continue;
          if (!platesApart(plates[0], pl)) { overlaps = true; break; }
        }
      }
      // A plank is static: it must also keep clear of where the ball already
      // was.  The ball sits on the previous plank for the whole dwell and it
      // flew the previous arc, so a plank whose trailing end sweeps through
      // either of them is as much a collision as one in the current arc
      // (measured: the chute's plank passed 0.045 m from the resting ball).
      let blocked = false;
      let blockNear = null;
      const guard = opts.guard;
      if (guard) {
        const own = { pos: pose.centre, tilt };
        for (const g of guard.rests) {
          if (plankDistance(own, g) < BALL_R - 1e-9) { blocked = true; blockNear = "rest"; break; }
        }
        if (!blocked) {
          const box = plankAabb(own);
          const legs = [];
          for (const pa of guard.paths) {
            if (box.hi[0] < pa.lo[0] || box.lo[0] > pa.hi[0]) continue;
            if (box.hi[1] < pa.lo[1] || box.lo[1] > pa.hi[1]) continue;
            legs.push(pa);
          }
          for (const pa of legs) {
            const times = [];
            for (let i = 0; i <= GUARD_SAMPLES; i += 1) times.push((i / GUARD_SAMPLES) * pa.T);
            for (const tt of closestApproachTimes(pa.p0, pa.v0, pa.T, own)) times.push(tt);
            for (const tt of faceCrossTimes(pa.p0, pa.v0, pa.T, own)) times.push(tt);
            for (const tt of times) {
              if (plankDistance(own, arcPoint(pa.p0, pa.v0, tt)) < BALL_R - 1e-9) {
                blocked = true; blockNear = "path"; break;
              }
            }
            if (blocked) break;
          }
        }
      }
      if (!blocked && guard?.guidedPoints) {
        const own = { pos: pose.centre, tilt };
        for (const point of guard.guidedPoints) {
          if (Math.abs(point[1] - pose.centre[1]) > BOARD_W + BALL_R) continue;
          if (plankDistance(own, point) < BALL_R - 1e-9) {
            blocked = true; blockNear = "slide_path"; break;
          }
        }
      }
      // The picture-plane gap to the planks already placed, measured on the
      // drawn outlines (0.30 x 0.06 slabs) instead of the collision boxes: a
      // dense descending run may be perfectly collision-free while two planks
      // are drawn a millimetre apart, which reads as one fused plank.  This is
      // only a preference -- see the rank below -- so it never trades away a
      // collision axis.
      let gap = Infinity;
      let gapNear = -1;
      for (const pl of (opts.placed ?? recent)) {
        if (!pl || !pl.pos) continue;
        const box = plankAabb(pl);
        if (box.hi[0] + PLANK_GAP_MIN < ownBox.lo[0]
          || box.lo[0] - PLANK_GAP_MIN > ownBox.hi[0]) continue;
        if (box.hi[1] + PLANK_GAP_MIN < ownBox.lo[1]
          || box.lo[1] - PLANK_GAP_MIN > ownBox.hi[1]) continue;
        const g = outlineGap(plates[0], pl);
        if (g < gap) { gap = g; gapNear = pl.index === undefined ? -1 : pl.index; }
      }
      const res = {
        ok: true, vIn: vec(vIn), vOut, pNext, normal: n, tilt,
        blocked, blockNear,
        e, dv: len, drop: D, apex, tiltCapped: capped, lateral: dx,
        targetX: wantX, steps: step, pose, off,
        clearance: Number.isFinite(clear) ? clear : null,
        plankOverlap: overlaps,
        clearanceFail: Number.isFinite(clear) && clear < BALL_R - 1e-9,
        clearanceTight: Number.isFinite(clear) && clear < BALL_R + CLEAR_MARGIN,
        near, speedCapped: vCapped,
        plankGap: Number.isFinite(gap) ? gap : null,
        plankGapFail: gap < PLANK_GAP_MIN,
        plankGapNear: gapNear,
      };
      // Three axes, all auditable and strictly ordered: never block on the way
      // in, never interpenetrate a neighbour plank, keep a real margin over the
      // ball radius along the whole arc -- and only then prefer a visible gap
      // between the planks.  A candidate that merely passes a hard limit is
      // used only when nothing better exists, and whatever is chosen is what
      // the audit reports (audit.plank_gap_fails).
      const rank = (r) => (r.blocked ? 0 : 1) * ((r.plankOverlap ? 0 : 16)
        + (r.clearanceFail ? 0 : (r.clearanceTight ? 8 : 16))
        + (r.plankGapFail ? 0 : 4));
      if (best === null || rank(res) > rank(best)
        || (rank(res) === rank(best)
          && ((res.clearance ?? Infinity) - (best.clearance ?? Infinity) > 1e-9
            || (Math.abs((res.clearance ?? Infinity) - (best.clearance ?? Infinity)) <= 1e-9
              && (res.plankGap ?? Infinity) - (best.plankGap ?? Infinity) > 1e-9)))) {
        best = res;
      }
      // A residual overlap is reported, never hidden (see audit.clearance_fails)
      // and never solved by faking the reflection.
      if (!res.clearanceFail && !res.plankOverlap && !res.blocked) return res;
    }
  }
  if (best && envFlag("BALL3D_DEBUG_CLEAR")) {
    console.error(JSON.stringify({ p: vec(p).map(round), vIn: vec(vIn).map(round),
      T: round(T), wantX: round(wantX), off: best.off, D: round(best.drop),
      dx: round(best.lateral), tilt: round(best.tilt), e: round(best.e),
      clear: round(best.clearance), near: best.near,
      pose: { pos: best.pose.centre.map(round), tilt: round(best.pose.tilt),
        off: best.pose.off },
      recent: recent.map((r) => ({ pos: [round(r.pos[0]), round(r.pos[1]), round(r.pos[2])],
        tilt: round(r.tilt ?? 0), off: round(r.off ?? 0) })) }));
  }
  if (best) { rej("forced_clear"); return Object.assign(best, { clearanceForced: true }); }
  rej("none");
  if (envFlag("BALL3D_DEBUG_NONE")) {
    console.error("NONE", JSON.stringify({ p: vec(p).map(round), vIn: vec(vIn).map(round),
      T: round(T), wantX: round(wantX), tiltMax: round(tiltMax), eMax: round(eMax),
      offMag: round(offMag), recent: recent.length }));
  }
  return { ok: false, why: "no passive-or-capped arc fits" };
}

// --- trough (chute) geometry: the ball rides the floor, centre on the curve ---
export function channelCenter(seg, u) {
  if(seg.profile === "reference") {
    const point=referenceProfile(1-clamp(u));
    return [seg.entry[0]+seg.profile_dir*(2.94-point[0])*seg.profile_scale,
      seg.entry[1]+(point[1]-3.78)*seg.profile_scale,seg.entry[2]];
  }
  const s = clamp(u);
  const v = 1 - s;
  const P = [seg.entry, seg.c0, seg.c1, seg.exit];
  return P[0].map((_, i) => v * v * v * P[0][i] + 3 * v * v * s * P[1][i]
    + 3 * v * s * s * P[2][i] + s * s * s * P[3][i]);
}

export function channelNormal(seg, u) {
  const a = channelCenter(seg, Math.max(0, u - 1e-4));
  const b = channelCenter(seg, Math.min(1, u + 1e-4));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const sign = dx >= 0 ? 1 : -1;
  return [-sign * dy / len, sign * dx / len, 0];
}

/** Trough floor under the ball centre (the ball rests on it). */
export function channelFloorPoint(seg, u) {
  const p = channelCenter(seg, u);
  const n = channelNormal(seg, u);
  return [p[0] - BALL_R * n[0], p[1] - BALL_R * n[1], p[2]];
}

/** Floor point plus the two side rails of the open trough. */
export function channelCross(seg, u) {
  const normal = channelNormal(seg, u);
  const center = channelCenter(seg, u);
  const floor = center.map((v, i) => v - channelRailOffset() * normal[i]);
  return {
    floor, normal,
    left: [floor[0], floor[1], floor[2] - CHANNEL_HALFWIDTH],
    right: [floor[0], floor[1], floor[2] + CHANNEL_HALFWIDTH],
  };
}

/** Ride velocity along the trough at local u (numeric, the curve is a Bezier). */
export function channelVelocity(seg, u) {
  if(seg.profile === "reference") {
    const a=Math.max(0,u-1e-4),b=Math.min(1,u+1e-4);
    const pa=channelCenter(seg,a),pb=channelCenter(seg,b);
    return pa.map((v,k)=>(pb[k]-v)/((b-a)*(seg.t1-seg.t0)));
  }
  const s = clamp(u);
  const v = 1 - s;
  const span = seg.t1 - seg.t0 || 1;
  return seg.entry.map((_, i) => (3 * v * v * (seg.c0[i] - seg.entry[i])
    + 6 * v * s * (seg.c1[i] - seg.c0[i])
    + 3 * s * s * (seg.exit[i] - seg.c1[i])) / span);
}

/** Musical intent is measured in quarter-note beats, independently of tempo. */
export function noteSlideReason(note) {
  if (note.articulation === "glissando") return "glissando";
  if (note.articulation === "sustain") return "sustain";
  return Number(note.q) >= LONG_BEATS_MIN ? "long_note" : null;
}

// Source control points from reference_slide.blend, traversed from its high tip.
const SLIDE_PROFILE = [[-3.55,1.63],[-2.65,1.76],[-1.50,1.66],[-.25,1.52],
  [.92,1.61],[1.92,2.03],[2.58,2.77],[2.94,3.78]];
const PROFILE_PATH = [];
for (let j=0;j<SLIDE_PROFILE.length-1;j++) {
  const a=SLIDE_PROFILE[j],b=SLIDE_PROFILE[j+1];
  const tangent=i=>{const lo=SLIDE_PROFILE[Math.max(0,i-1)],hi=SLIDE_PROFILE[Math.min(7,i+1)];
    const d=hi.map((v,k)=>v-lo[k]),n=Math.hypot(...d);return d.map(v=>v/n);};
  const ta=tangent(j),tb=tangent(j+1),len=Math.hypot(b[0]-a[0],b[1]-a[1]);
  const c=a.map((v,k)=>v+ta[k]*len/3),d=b.map((v,k)=>v-tb[k]*len/3);
  for(let i=j?1:0;i<=80;i++){
    const u=i/80,v=1-u;const q=a.map((x,k)=>v*v*v*x+3*v*v*u*c[k]+3*v*u*u*d[k]+u*u*u*b[k]);
    const prev=PROFILE_PATH.at(-1);PROFILE_PATH.push({p:q,s:prev?prev.s+Math.hypot(q[0]-prev.p[0],q[1]-prev.p[1]):0});
  }
}
function referenceProfile(u){
  const wanted=clamp(u)*PROFILE_PATH.at(-1).s;let lo=0,hi=PROFILE_PATH.length-1;
  while(lo+1<hi){const m=(lo+hi)>>1;if(PROFILE_PATH[m].s<wanted)lo=m;else hi=m;}
  const a=PROFILE_PATH[lo],b=PROFILE_PATH[hi],t=(wanted-a.s)/(b.s-a.s);
  return a.p.map((v,k)=>v+(b.p[k]-v)*t);
}

const slideDistanceCache = new WeakMap();
/** Conservative surface clearance to both tubes and the seven lower spheres. */
export function slideDistance(slide, point) {
  if(point[1]<slide.y_lo-BALL_R || point[1]>slide.y_hi+BALL_R) return Infinity;
  let data=slideDistanceCache.get(slide);
  if(!data){
    const cross=Array.from({length:129},(_,i)=>channelCross(slide,i/128));
    const fittings=[.075,.19,.305,.42,.535,.65,.755].map(f=>{
      const u=slide.model_reversed?1-f:f,center=channelCenter(slide,u),normal=channelNormal(slide,u);
      return center.map((v,k)=>v-normal[k]*(channelRailOffset()+BALL_R*1.1));
    });
    data={cross,fittings,xlo:Math.min(...cross.map(c=>c.floor[0]))-BALL_R*3,
      xhi:Math.max(...cross.map(c=>c.floor[0]))+BALL_R*3};slideDistanceCache.set(slide,data);
  }
  if(point[0]<data.xlo||point[0]>data.xhi)return Infinity;
  let best=Infinity;
  for(let j=1;j<data.cross.length;j++)for(const side of ['left','right']){
    const a=data.cross[j-1][side],b=data.cross[j][side];
    const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
    const len=dx*dx+dy*dy+dz*dz;
    const u=clamp(((point[0]-a[0])*dx+(point[1]-a[1])*dy+(point[2]-a[2])*dz)/(len||1));
    const distance=Math.hypot(point[0]-a[0]-u*dx,point[1]-a[1]-u*dy,point[2]-a[2]-u*dz)-CHANNEL_RAIL_RADIUS;
    if(distance<best)best=distance;
  }
  for(const f of data.fittings)best=Math.min(best,Math.hypot(...point.map((v,k)=>v-f[k]))-BALL_R*.7);
  return best;
}
export function wholeSlideAudit(segments,channels) {
  let min=Infinity;const fails=[];
  for(const segment of segments){
    let worst=Infinity,near=null,time=null;
    for(let i=0;i<=128;i++){
      const p=transitionPoint(segment,i/128);
      for(const rail of channels){const d=slideDistance(rail,p);
        if(d<worst){worst=d;near=rail.reason.note_index;time=segment.t0+(segment.t1-segment.t0)*i/128;}}
    }
    min=Math.min(min,worst);
    if(worst<BALL_R-5e-4)fails.push({i:near,t:time,clearance:worst,kind:segment.kind,slide:true});
  }
  return {min_distance:Number.isFinite(min)?min:null,fails};
}

function referenceTransition(p, vIn, note, gap, terminal, dir, recent, placed, guard, pastSegments, existingRails) {
  const dwell=Math.min(.06,note.dur*.04);
  const directionOrder=Math.abs(p[0])>.5?[-Math.sign(p[0]),Math.sign(p[0])]:[dir,-dir];
  const entryTimes = [Math.min(.32,note.dur*.18), Math.min(.45,note.dur*.25), Math.min(.60,note.dur*.32)];
  // Fast expressive notes still need enough space for their curved approach.
  // The last candidate finds a roomy plank pose, then times the guided curve
  // to the score. It does not stretch the note's onset or duration.
  const approaches = [...entryTimes.map(t => [t, t]), [Math.min(.2,note.dur*.25), .35]];
  for(const direction of directionOrder) for(const [entryTime, poseTime] of approaches) {
    const chosen=solveFlight(p,vIn,poseTime,p[0]+direction*DX_MIN,{recent,placed,guard});
    if(!chosen.ok||chosen.clearanceFail||chosen.plankOverlap||chosen.blocked)continue;
    const entry=vec(chosen.pNext);
    for(const baseSize of [.28,.23,.34]) {
      const size = baseSize * Math.sqrt(BOUNCE_SCALE);
      const rail={kind:"ride",profile:"reference",model_reversed:true,
        profile_scale:size,profile_dir:direction,entry,
        t0:note.t+dwell+entryTime,t1:0,reason:null};
      rail.exit=channelCenter(rail,1);rail.p0=entry;rail.p1=rail.exit;
      // c0/c1 also bound the profile for existing preview/audit consumers.
      rail.c0=channelCenter(rail,1/3);rail.c1=channelCenter(rail,2/3);
      const exitTime=terminal?0:Math.min(.34,note.dur*.35);
      const exitStart=note.t+gap-exitTime;
      // Use the whole onset interval: rests are silent coasting, not a stop
      // at the end of the rail. The next plank is still reached on its onset.
      rail.t1=exitStart;
      if(rail.t1<=rail.t0+1e-5)continue;
      rail.y_lo=Math.min(entry[1],rail.exit[1],rail.c0[1],rail.c1[1])-.4;
      rail.y_hi=Math.max(entry[1],rail.exit[1])+BALL_R;
      if(Math.abs(rail.exit[0])>X_BAND+.8)continue;
      const uniformExit = channelVelocity(rail, 1);
      // Keep enough exit speed to clear the rail cap under gravity. Spread
      // long rests over the ride, then smoothly match this departing speed.
      rail.exit_speed_ratio = terminal ? 0 : .85 / Math.hypot(...uniformExit);
      rail.speed_blend = Math.min(.5, .6 / (rail.t1 - rail.t0),
        1 / Math.max(1, rail.exit_speed_ratio));
      const exitVelocity = uniformExit.map(v => v * rail.exit_speed_ratio);
      const next=terminal?rail.exit:arcPoint(rail.exit,exitVelocity,exitTime);
      const reason={type:"channel",trigger:noteSlideReason(note),note_index:note.i,
        note_start:note.t,note_end:note.t+note.dur,q:note.q,terminal,
        ride_sec:rail.t1-rail.t0,rest_sec:Math.max(0,gap-note.dur),forced:false};
      rail.reason=reason;
      const tipNormal=channelNormal(rail,0);
      const tipTangent=channelCenter(rail,.001).map((v,k)=>v-entry[k]);
      const tipLength=Math.hypot(...tipTangent);
      const entrySeg={kind:"approach",t0:note.t+dwell,t1:rail.t0,p0:vec(p),p1:entry,
        entry:vec(p),exit:entry,c0:p.map((v,k)=>v+chosen.vOut[k]*entryTime/3),
        c1:entry.map((v,k)=>v-tipTangent[k]/tipLength*BALL_R*1.8+tipNormal[k]*BALL_R*.8),
        v0:chosen.vOut,h:0,reason:{...reason,leg:"entry"}};
      const exitSeg={kind:"hop",t0:exitStart,t1:note.t+gap,p0:rail.exit,p1:next,v0:exitVelocity,h:0,reason:{...reason,leg:"exit"}};
      const own={pos:chosen.pose.centre,tilt:chosen.tilt};
      let clear=true;
      for(const segment of [entrySeg,rail,...(terminal?[]:[exitSeg])]){
        for(let j=0;j<=96&&clear;j++){
          const point=transitionPoint(segment,j/96);
          for(const plate of [...placed,own]) if(plankDistance(plate,point)<BALL_R-1e-7){clear=false;break;}
          for(const slide of [...existingRails,rail]) if(slideDistance(slide,point)<BALL_R-5e-4){clear=false;break;}
        }
      }
      if(clear)for(const old of pastSegments){
        for(let j=0;j<=64;j++)if(slideDistance(rail,transitionPoint(old,j/64))<BALL_R-5e-4){clear=false;break;}
        if(!clear)break;
      }
      if(!clear)continue;
      const pending=[];
      if(dwell>0)pending.push({kind:"hold",t0:note.t,t1:note.t+dwell,p0:vec(p),p1:vec(p),reason:{type:"sustain"}});
      pending.push(entrySeg,rail);
      if(!terminal)pending.push(exitSeg);
      const collision=collisionRecord(vIn,chosen.vOut,chosen);
      return {pending,rail,pose:chosen.pose,chosen,dwell,reason,collision,
        pNext:next,vInNext:terminal?[0,0,0]:exitVelocity.map((v,k)=>v+G_VEC[k]*exitTime),
        dir:direction,entrySeg,exitSeg,drop:p[1]-next[1]};
    }
  }
  throw new Error(`No clear reference slide fits note ${note.i} at ${note.t.toFixed(3)}s`);
}

const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export const CHUTE_DROP_MAX = 7.0;
export const RIDE_SPEED = 1.2;

/**
 * Build a chute transition: a short free flight onto the trough, a ride along
 * the trough floor, then a free flight down onto the next plank.  The trough's
 * control points keep the floor monotonically descending (a ball cannot ride up)
 * while matching the entry/exit tangent directions of the two flights.
 */
/**
 * Shortest entry-leg time for which the ball really *leaves* its plank.
 * Planks here are one-sided supports: a ball may rest on the top face and be
 * pushed off it, but it can never pass through.  If the entry leg were shorter
 * than the value returned here the out-going velocity would point into the
 * plank it is standing on (v_out . n < 0) -- the same rule the flight solver
 * enforces with ``dvy > 0``.  The search also keeps the resolved normal inside
 * TILT_MAX, so the plank that produces the departure is buildable.
 */
function chuteDeparture(vIn, step, drop, f) {
  const vOut = [step / f, -drop / f + 0.5 * G * f, 0];
  const d = [vOut[0] - vIn[0], vOut[1] - vIn[1], vOut[2] - (vIn[2] ?? 0)];
  const m = Math.hypot(d[0], d[1], d[2]);
  if (!(m > 1e-6)) return { ok: false, score: -Infinity, tilt: 0 };
  const n = [d[0] / m, d[1] / m, d[2] / m];
  const vnOut = vOut[0] * n[0] + vOut[1] * n[1] + vOut[2] * n[2];
  const tilt = Math.atan2(n[0], n[1]);
  const ok = n[1] > 0.05 && Math.abs(tilt) <= TILT_MAX - 1e-3 && vnOut >= 1e-6;
  return { ok, tilt, n, vOut, vnOut,
    score: n[1] > 0.05 && Math.abs(tilt) <= TILT_MAX ? vnOut : -Infinity };
}

/**
 * Distance from the ball to its own plank during an entry leg, computed
 * exactly (the plank is the only obstacle that matters there, and both the
 * contact offset and the tilt are known).  A leg whose ball leaves the leading
 * edge can still clip the corner when the out-going velocity is nearly parallel
 * to the face: the ball slides along, gravity bends it back and it grazes --
 * measured 0.1085 m against BALL_R 0.12 before this check existed.  The search
 * below rejects those legs instead of shipping them.
 */
export function entryCornerClearance(vOut, tilt, off, f) {
  const s = Math.sin(tilt);
  const c = Math.cos(tilt);
  const et = [c, -s];
  const en = [s, c];
  const vt = vOut[0] * et[0] + vOut[1] * et[1];
  const vn = vOut[0] * en[0] + vOut[1] * en[1];
  const gt = G_VEC[0] * et[0] + G_VEC[1] * et[1];
  const gn = G_VEC[0] * en[0] + G_VEC[1] * en[1];
  let dMin = Infinity;
  for (let i = 0; i <= 96; i += 1) {
    const t = (i / 96) * f;
    const lx = off + vt * t + 0.5 * gt * t * t;
    const ly = BOARD_H / 2 + BALL_R + vn * t + 0.5 * gn * t * t;
    const dx = Math.max(Math.abs(lx) - BOARD_W / 2, 0);
    const dy = Math.max(Math.abs(ly) - BOARD_H / 2, 0);
    const d = Math.hypot(dx, dy);
    if (d < dMin) dMin = d;
  }
  return dMin;
}

/**
 * Pick the entry leg of a chute: it must be a real departure *and* keep the
 * ball clear of the plank it leaves for the whole leg.  A tiny deterministic
 * grid (drop x step) is enough -- raising the drop lowers the trough, extending
 * the step pushes the ball past the plank's leading edge faster.
 */
export function chuteEntryLeg(p0, vIn, dir, T, guard = null) {
  const fCap = clampRange(0.40 * T, 0.35, 0.75);
  let best = null;
  const consider = (cand) => {
    if (!best || cand.score > best.score) best = cand;
    return cand.score >= BALL_R + 2e-3;
  };
  // The departure velocity of a one-sided plank is vOut = vIn + k n with k > 0
  // and n = (sin t, cos t): driving the search by the *tilt* (instead of by a
  // drop/step pair run through departureTime) is what lets a shallow plank be
  // chosen -- a steeply tilted plank swings its trailing end back into the arc
  // the ball arrived on (measured: 0.023 m, a deep clip).
  for (let it = -1; it <= 1.0001; it += 0.1) {
    const tilt = it * TILT_MAX;
    const n = [Math.sin(tilt), Math.cos(tilt)];
    for (const f of [0.18, 0.26, 0.34, 0.45, 0.60, fCap]) {
      for (const k of [0.5, 1.0, 1.6, 2.4, 3.4]) {
        const vOut = [vIn[0] + k * n[0], vIn[1] + k * n[1], vIn[2] ?? 0];
        const step = dir * vOut[0] * f;
        const drop = f * (0.5 * G * f - vOut[1]);
        if (!(step >= 0.08 && step <= 1.6 && drop >= 0.06 && drop <= 1.8)) continue;
        if (Math.hypot(vOut[0], vOut[1]) > V_MAX) continue;
        const clr = entryCornerClearance(vOut, tilt, dir * CONTACT_OFF, f);
        let g = Infinity;
        const pose = chutePlankPose(p0, vIn, dir, vOut);
        const own = { pos: pose.centre, tilt: pose.tilt };
        if (guard) {
          for (const r of guard.rests) g = Math.min(g, plankDistance(own, r));
          for (const pa of guard.paths) {
            for (let i = 0; i <= GUARD_SAMPLES; i += 1) {
              g = Math.min(g, plankDistance(own,
                arcPoint(pa.p0, pa.v0, (i / GUARD_SAMPLES) * pa.T)));
            }
            for (const tt of closestApproachTimes(pa.p0, pa.v0, pa.T, own)) {
              g = Math.min(g, plankDistance(own, arcPoint(pa.p0, pa.v0, tt)));
            }
            for (const tt of faceCrossTimes(pa.p0, pa.v0, pa.T, own)) {
              g = Math.min(g, plankDistance(own, arcPoint(pa.p0, pa.v0, tt)));
            }
          }
        }
        if (consider({ f1: f, v0: vOut, tilt, clear: clr, guardClear: g, step, drop,
          score: Math.min(clr, g) })) return best;
      }
    }
  }
  return best;
}

/** The plank a chute stands on, from its entry-leg departure velocity. */
export function chutePlankPose(p, vIn, dir, vOut) {
  const cn = norm3([vOut[0] - vIn[0], vOut[1] - vIn[1], vOut[2] - (vIn[2] ?? 0)]);
  const off = dir * CONTACT_OFF;
  return plankPose(hingeFor(p, cn, off), Math.atan2(cn[0], cn[1]), off);
}

export function departureTime(vIn, step, drop, T) {
  const fCap = clampRange(0.40 * T, 0.35, 0.75);
  const fLo = Math.min(fCap, 0.06);
  let best = fCap;
  let bestScore = -Infinity;
  for (let i = 0; i <= 60; i += 1) {
    const f = fLo + (fCap - fLo) * (i / 60);
    const r = chuteDeparture(vIn, step, drop, f);
    if (r.ok) return f;
    if (r.score > bestScore) { bestScore = r.score; best = f; }
  }
  return best;
}

export function buildChute(p0, vIn, T, wantX, opts = {}) {
  const dir = opts.dir ?? 1;
  const drop = clampRange(0.5 * G * T * T * (1 - riseShare(T)), D_MIN,
    opts.dropMax ?? CHUTE_DROP_MAX);
  const pNext = [wantX, p0[1] - drop, 0];
  // The entry leg is a *departure* from a one-sided plank and must clear the
  // plank's leading corner; both are enforced when the leg is chosen.
  const leg = chuteEntryLeg(p0, vIn, dir, T, opts.guard);
  if (!leg) return { ok: false, why: "no clean entry leg" };
  const entry = [p0[0] + dir * leg.step, p0[1] - leg.drop, TROUGH_Z];
  const exit = [pNext[0] + dir * 0.10, pNext[1] + CHUTE_EXIT_LIFT, TROUGH_Z];
  const f1 = leg.f1;
  const f2 = clampRange(0.26 * T, 0.30, 0.60);
  if (!(T - f1 - f2 >= CHANNEL_MIN_TIME)) return { ok: false, why: "too little time" };
  let ride = T - f1 - f2;
  const len = Math.hypot(exit[0] - entry[0], exit[1] - entry[1], exit[2] - entry[2]);
  let extraSit = 0;
  const natural = len / RIDE_SPEED;
  if (ride > natural) {
    extraSit = Math.min(ride - natural, opts.sitMax ?? CHUTE_SIT_MAX);
    ride -= extraSit;
  }
  const speed = ride > 0 ? len / ride : Infinity;
  if (!(speed <= MAX_CHANNEL_SPEED)) return { ok: false, why: "ride too fast" };
  const v0entry = solveLeg(p0, entry, f1);
  const v0exit = solveLeg(exit, pNext, f2);
  const din = norm3([v0entry[0], v0entry[1] - G * f1, v0entry[2]]);
  const dout = norm3(v0exit);
  const dy = Math.max(0.2, entry[1] - exit[1]);
  const k = 0.35 * len;
  const c0 = [entry[0] + din[0] * k, entry[1] - 0.33 * dy, entry[2] + din[2] * k];
  const c1 = [exit[0] - dout[0] * k, exit[1] + 0.33 * dy, exit[2] - dout[2] * k];
  return {
    ok: true, pNext, entry, exit, c0, c1, f1, f2, ride, extraSit, drop, speed, len,
    step: leg.step, entry_drop: leg.drop, entry_clear: leg.clear,
    entry_guard: leg.guardClear,
    v0entry, v0exit, vIn: vec(vIn),
  };
}

/**
 * Build the layout: plank poses (hinge, tilt, normal, contact), the ball's
 * analytic flights, the chutes and every auditable collision record.
 *
 * @param {object} plan  a ``ball3d-plan-v1`` object
 * @param {object} [options]
 * @param {number|string} [options.seed] extra seed mixed into the song seed
 */
export function buildLayout(plan, options = {}) {
  const seed = layoutSeed(plan, options.seed ?? 0);
  const landings = plan.landings || [];
  const groups = groupLandings(plan);
  const segments = [];
  const channels = [];
  const transitions = [];
  const clearanceFails = [];
  const risingArrivals = [];
  const boards = new Array(landings.length);
  const push = (seg) => segments.push(seg);
  const hold = (t0, t1, p, why) => {
    if (t1 > t0 + 1e-12) {
      segments.push({ kind: "hold", t0, t1, p0: vec(p), p1: vec(p), h: 0, reason: { type: why } });
    }
  };
  const flight = (t0, t1, p, v0, pNext, reason) => segments.push({
    kind: "hop", t0, t1, p0: vec(p), p1: vec(pNext), v0: vec(v0), h: 0, reason,
  });

  const startX = -0.45;
  const startY = 1.15;
  // the last few plank poses, so a landing can be tested against them
  const recent = [];
  // every plank placed so far, with its index: a flight is checked against all
  // of them (a long bounce must not rise through an earlier plank), and the
  // per-candidate bounding-box filter keeps that cheap.
  const placed = [];
  // Where the ball *was*: the rest points it sits on for each dwell and the
  // arcs it has already flown.  A plank placed later must keep clear of both
  // (see the ``guard`` block in solveFlight).
  const rests = [];
  const paths = [];
  const guidedPoints = [];
  const rememberPose = (pose, index) => {
    if (pose) {
      const rec = { pos: pose.pos, tilt: pose.tilt ?? 0, index: index ?? -1 };
      recent.unshift(rec);
      recent.length = Math.min(recent.length, 6);
      placed.push(rec);
    }
  };
  let dir = 1;
  let pad;

  if (!landings.length) {
    const p = [startX, startY + 0.4, 0];
    pad = makePadInfo(p, paletteIndexFor(plan.ref_midi));
    const end = Math.max(plan.duration || 0, 0);
    hold(0, end, p, "empty");
    return finish(plan, seed, groups, boards, pad, segments, channels, transitions,
      clearanceFails, risingArrivals);
  }

  // --- lead-in: the pad sits where a natural arc reaches board 0 ------------
  const tFirst = landings[0].t;
  const Tlead = clampRange(tFirst, 0.55, 1.4);
  const p0 = [startX, startY, 0];
  // The pad is a full plank back from board 0: nearer than that and board 0's
  // own landing point falls inside the pad's slab.  The launch is then whatever
  // parabola reaches board 0 in Tlead (constant gravity, solved, not decorated).
  const padBall = [p0[0] - dir * 0.6, p0[1] + 0.75, p0[2]];
  const vLead = solveLeg(padBall, p0, Tlead);
  pad = makePadInfo(padBall, paletteIndexFor(plan.ref_midi), dir * CONTACT_OFF);
  rememberPose({ pos: pad.pos, tilt: pad.tilt }, -1);
  hold(0, tFirst - Tlead, padBall, "lead_in");
  flight(tFirst - Tlead, tFirst, padBall, vLead, p0,
    { type: "arrival", why: "lead-in flight from the pad" });
  let vIn = [vLead[0] + G_VEC[0] * Tlead, vLead[1] + G_VEC[1] * Tlead,
    vLead[2] + G_VEC[2] * Tlead];
  let p = p0;

  // --- the descent ----------------------------------------------------------
  for (let k = 0; k < landings.length; k += 1) {
    options.onProgress?.({ stage: "排列木板", percent: 95 * k / landings.length, completed: k, total: landings.length });
    const l = landings[k];
    const group = groups.find((g) => g.members.includes(k));
    const isLong = l.dur >= LONG_NOTE_MIN;
    const slideReason = noteSlideReason(l);
    const terminal = k === landings.length - 1;
    const record = { i: k, t: l.t, group: group ? group.index : 0, dur: l.dur, slot: k };
    boards[k] = Object.assign(record, {
      yaw: 0, tilt: 0, normal: [0, 1, 0],
      hinge: hingeFor(p, [0, 1, 0]), pos: [p[0], p[1] - BALL_R - BOARD_H / 2, p[2]],
      top_y: p[1] - BALL_R, contact: [p[0], p[1] - BALL_R, p[2]],
      index: k, ball_pos: vec(p), midi: l.midi, n: l.n,
      palette: paletteIndexFor(l.n), collision: null, strike: null,
    });
    if (terminal && !slideReason) {
      // the last note is never struck, so it has no collision to take a pose
      // from: it stays a level landing plank, contact at its leading edge
      const offL = (Math.abs(vIn[0]) > 1e-6 ? Math.sign(vIn[0])
        : (dir >= 0 ? 1 : -1)) * CONTACT_OFF;
      const poseL = plankPose(hingeFor(p, [0, 1, 0], offL), 0, offL);
      boards[k].tilt = 0;
      boards[k].off = offL;
      boards[k].normal = [0, 1, 0];
      boards[k].hinge = poseL.hinge;
      boards[k].pos = poseL.centre;
      boards[k].contact = poseL.contact;
      boards[k].ball_pos = vec(p);
      boards[k].top_y = poseL.contact[1];
      boards[k].arrival = l.t;
      boards[k].departure = l.t;
      break;
    }

    if (!(vIn[1] < 0)) {
      // A top face can only catch a ball that is still moving towards it.  If an
      // arrival is not falling the layout would have to fake the collision, so
      // it is nudged to a small descent and recorded (never silently "turned in
      // the air").
      risingArrivals.push({ i: k, t: round(l.t), vy: round(vIn[1]) });
      vIn = [vIn[0], Math.min(-0.05, vIn[1]), vIn[2]];
    }
    const gap = terminal ? l.dur : landings[k + 1].t - l.t;
    const dwell0 = Math.max(0, Math.min(l.dur, isLong ? LONG_DWELL_MAX : MAX_DWELL,
      gap * SHORT_DWELL_FRACTION));
    const restInGap = terminal ? 0 : restSecondsBetween(plan, l.t, landings[k + 1].t);
    // Everything the ball has already done, for the guard check: the rest it
    // holds right now plus the last rests, and the arcs it has flown.
    const guard = { rests: [vec(p)].concat(rests).slice(0, 3), paths, rails: channels, guidedPoints };
    if (slideReason) {
      const r=referenceTransition(p,vIn,l,gap,terminal,dir,recent,placed,guard,segments,channels);
      const pose=r.pose;
      Object.assign(boards[k],{tilt:pose.tilt,normal:pose.normal,hinge:pose.hinge,
        pos:pose.centre,contact:pose.contact,ball_pos:vec(p),off:r.chosen.off,
        top_y:pose.contact[1],arrival:l.t,departure:l.t+r.dwell,collision:r.collision,
        clearance:r.chosen.clearance,tilt_deg:round(pose.tilt*180/Math.PI)});
      rememberPose({pos:pose.centre,tilt:pose.tilt},k);
      segments.push(...r.pending);channels.push(r.rail);
      for (const segment of [r.entrySeg, r.rail]) {
        for (let j = 0; j <= PATH_SAMPLES; j += 1) guidedPoints.push(transitionPoint(segment, j / PATH_SAMPLES));
      }
      transitions.push({kind:"chute",t0:l.t+r.dwell,t1:l.t+gap,dwell:r.dwell,
        reason:r.reason,collision:r.collision,drop:r.drop,pNext:r.pNext,dir:r.dir});
      for(const leg of (terminal?[]:[r.exitSeg])){
        const T=leg.t1-leg.t0;
        paths.unshift(Object.assign({p0:leg.p0,v0:leg.v0,T},arcWindow(leg.p0,leg.v0,T,apexOf(leg.v0[1]))));
      }
      paths.length=Math.min(paths.length,3);
      p=r.pNext;vIn=r.vInNext;dir=r.dir;
      continue;
    }
    const plan0 = planOneTransition(p, vIn, gap, dwell0, dir, recent, placed, guard);
    let chosen = plan0;
    if (!plan0.ok) {
      // a longer sit may buy a flyable interval (the ball holds the plank).
      // The flight may never be longer than the gap: a negative dwell would
      // overlap the previous segment (this used to leak a -0.019 s hop).
      const alts = [];
      for (const scale of [0.85, 0.7, 0.55, 0.45, 0.35, 0.28, 0.20, 0.12]) {
        const T = Math.min(gap, Math.max(0.25, plan0.flight * scale));
        const dwell = gap - T;
        if (!(T > 0) || dwell < -1e-9 || dwell > Math.max(SIT_MAX, restInGap + Math.min(l.dur, MAX_DWELL))) continue;
        const alt = planOneTransition(p, vIn, gap, dwell, dir, recent, placed, guard);
        if (alt.flight > FLY_MAX + 1e-9) continue;
        alts.push(alt);
        if (alt.ok) { chosen = alt; break; }
      }
      // no clean arc at any flight length: keep the one that at least stays
      // furthest from the planks and record it (never silently accept it)
      if (!chosen.ok && alts.length) {
        const score = (r) => (r.clearanceFail ? 0 : 2) + (r.plankOverlap ? 0 : 1)
          + Math.min(0.9, (r.clearance ?? 0) / Math.max(BALL_R, 1e-9));
        const best = [plan0, ...alts].reduce((a, b) => (score(b) > score(a) ? b : a));
        if (score(best) > score(plan0) + 1e-9) chosen = best;
      }
    }
    const pending = [];
    const pushEarly = (seg) => pending.push(seg);
    let transition;
    if (chosen.ok) {
      transition = buildFlightTransition(pushEarly, p, vIn, chosen,
        { t0: l.t + chosen.dwell, dwell: chosen.dwell, restInGap, dir: chosen.dir });
    } else {
      // last resort: the fastest arc the caps allow, its energy gain recorded.
      // If even that fails, a no-steer arc (tilt 0) always has a passive
      // solution for D <= 0.5 g T^2, so the layout can never produce an
      // undefined transition (that used to throw and lose the whole song).
      const wide = solveFlight(p, vIn, chosen.flight, chosen.targetX,
        { eMax: E_FORCED, tiltMax: TILT_MAX, recent, placed, guard });
      let forced = wide.ok ? wide : null;
      if (!forced) {
        forced = solveFlight(p, vIn, chosen.flight, p[0] + vIn[0] * chosen.flight,
          { eMax: E_FORCED, tiltMax: 0, offMag: 0, recent, placed, guard });
      }
      if (!forced || !forced.ok) {
        const Tlast = chosen.flight > 1e-6 ? chosen.flight
          : Math.max(gap - chosen.dwell, 0.02);
        forced = solveFlight(p, vIn, Tlast, p[0] + vIn[0] * Tlast,
          { eMax: E_FORCED, tiltMax: 0, offMag: 0, recent, placed, guard });
      }
      transition = buildFlightTransition(pushEarly, p, vIn,
        Object.assign({}, chosen, forced, { forced: true, dwell: chosen.dwell }),
        { t0: l.t + chosen.dwell, dwell: chosen.dwell, restInGap, dir: chosen.dir });
    }
    transitions.push(transition);
    // the plank under this collision gets its real tilt and collision record;
    // the pose is the one the solver already cleared (same hinge/normal/off)
    const n = transition.normal;
    boards[k].tilt = transition.pose ? transition.pose.tilt
      : Math.atan2(n[0], n[1]);
    boards[k].normal = n;
    boards[k].hinge = transition.pose ? transition.pose.hinge
      : hingeFor(p, n, transition.off || 0);
    boards[k].off = transition.off || 0;
    boards[k].clearance = transition.clearance ?? null;
    boards[k].clearance_fail = Boolean(transition.clearanceFail);
    boards[k].plank_overlap = Boolean(transition.plankOverlap);
    boards[k].plank_gap = Number.isFinite(transition.plankGap)
      ? transition.plankGap : null;
    boards[k].plank_gap_fail = Boolean(transition.plankGapFail);
    boards[k].collision = transition.collision;
    boards[k].safe_mode = Boolean(transition.safeMode);
    boards[k].arrival = l.t;
    boards[k].departure = l.t + transition.dwell;
    boards[k].tilt_deg = round(boards[k].tilt * 180 / Math.PI);
    if (transition.collision && transition.collision.e > 1) {
      boards[k].strike = {
        e: round(transition.collision.e),
        dv: round(transition.collision.dv),
        at: l.t,
      };
    }
    const pose = transition.pose || plankPose(boards[k].hinge, boards[k].tilt,
      boards[k].off);
    boards[k].pos = pose.centre;
    boards[k].contact = pose.contact;
    boards[k].ball_pos = vec(p);
    boards[k].top_y = pose.contact[1];
    rememberPose({ pos: pose.centre, tilt: boards[k].tilt }, k);
    // Last guard before the transition is kept: if the balls' path would clip a
    // plank, re-solve the same interval on a shallow ramp.  Timing is untouched.
    if (transition.clearanceFail || transition.plankOverlap) {
      const safe = solveFlight(p, vIn, chosen.flight, chosen.targetX,
        { recent, placed, guard, tiltMax: TILT_SAFE, eMax: E_MAX });
      if (safe.ok && !safe.clearanceFail && !safe.plankOverlap) {
        pending.length = 0;
        transition = buildFlightTransition(pushEarly, p, vIn,
          Object.assign({}, chosen, safe, { safeMode: true }),
          { t0: l.t + chosen.dwell, dwell: chosen.dwell, restInGap, dir: chosen.dir });
      }
    }
    if (transition.clearanceFail) clearanceFails.push({ i: k, t: round(l.t),
      clearance: round(transition.clearance), near: transition.near ?? null,
      off: round(transition.off || 0), tilt: round(boards[k].tilt) });

    // the arc that delivered the ball here becomes a guarded path, and the
    // point it rested on becomes a guarded rest
    if (transition.kind === "flight" && chosen.ok) {
      paths.unshift(Object.assign(
        { p0: vec(p), v0: vec(chosen.vOut), T: chosen.flight },
        arcWindow(p, chosen.vOut, chosen.flight, chosen.apex ?? 0)));
      paths.length = Math.min(paths.length, 3);
    }
    if (transition.dwell > 1e-9) {
      rests.unshift(vec(p));
      rests.length = Math.min(rests.length, 3);
    }
    hold(l.t, l.t + transition.dwell, p, "sustain");
    for (const seg of pending) segments.push(seg);
    p = transition.pNext;
    vIn = transition.vInNext;
    dir = transition.dir;
  }

  const last = landings[landings.length - 1];
  const tailStart = Math.max(last.t, segments.at(-1)?.t1 ?? last.t);
  hold(tailStart, Math.max(plan.duration, tailStart), p, "tail");
  options.onProgress?.({ stage: "检查球路", percent: 95 });
  return finish(plan, seed, groups, boards, pad, segments, channels, transitions,
    clearanceFails, risingArrivals);
}

/** The start pad is a plank too: same pose maths, its own palette entry. */
function makePadInfo(p, palette, off = 0) {
  // ``off`` puts the ball on the pad's *leading* edge: the ball then leaves
  // over the end of the plank instead of having to rise past the plank it is
  // standing on, which is what used to clip the pad on the first flight.
  const pose = plankPose(hingeFor(p, [0, 1, 0], off), 0, off);
  return {
    index: -1, group: -1, yaw: 0, tilt: 0, normal: [0, 1, 0], off,
    hinge: pose.hinge, pos: pose.centre, contact: pose.contact, top_y: pose.contact[1],
    ball_pos: vec(p), palette,
  };
}

/** Choose the steering target and solve the arc for one interval. */
function planOneTransition(p, vIn, gap, dwell, dir, recent = [], placed = [], guard = null) {
  const flight = gap - dwell;
  if (!(flight > 1e-6)) {
    return { ok: false, why: "no flight time", dwell, flight: 0, dir,
      targetX: clampRange(p[0], -X_BAND, X_BAND) };
  }
  // A dense interval cannot take a long step, but it must still step far
  // enough to clear the plank it leaves (DX_MIN) -- and such a step costs
  // nearly the whole tilt budget, so a turn is only taken where the interval
  // is actually long enough to pay for it.  Steering more gently than this
  // would put the ball back inside the plank above it.
  const step = clampRange(VX_NOMINAL * flight, DX_MIN, STEP_MAX);
  const moving = Math.abs(vIn[0]) > 0.2 ? Math.sign(vIn[0]) : dir;
  let d = moving;
  const turnNeed = Math.abs(vIn[0]) + step / flight;
  const turnSlack = Math.tan(TILT_MAX) * (G * flight + Math.abs(vIn[1]));
  // a steady sideways drift is free (the plank is level), a turn costs the
  // whole tilt budget and would leave nothing to clear the plank above
  if (Math.abs(p[0] + d * step) > X_BAND && turnSlack >= turnNeed + 0.45) d = -d;
  else if (Math.abs(p[0] + d * step) > X_BAND) d = moving;
  let wantX = clampRange(p[0] + d * step, -(X_BAND + 0.9), X_BAND + 0.9);
  const res = solveFlight(p, vIn, flight, wantX, { recent, placed, guard });
  // ``ok`` means "flyable *and* clear": a solved arc that still grazes a plank
  // is not accepted while any clean alternative exists (the caller tries
  // shorter flights and a shallow ramp before it keeps a grazing arc, and a
  // grazing arc that survives all of that is audited, never hidden).
  const clean = !res.clearanceFail && !res.plankOverlap && !res.blocked;
  return Object.assign({ dwell, flight, dir: d, targetX: wantX, clean }, res,
    { ok: Boolean(res.ok) && clean });
}

function collisionRecord(vIn, vOut, chosen) {
  return {
    e: round(chosen.e), dv: round(chosen.dv), tilt: round(chosen.tilt),
    normal: chosen.normal.map((v) => Number(v.toFixed(6))), v_in: vec(vIn).map(round),
    v_out: vec(vOut).map(round), drop: round(chosen.drop), apex: round(chosen.apex),
    active: chosen.e > 1, forced: Boolean(chosen.forced),
    tilt_capped: Boolean(chosen.tiltCapped),
  };
}

function buildFlightTransition(push, p, vIn, chosen, info) {
  const T = chosen.flight;
  const t0 = info.t0;
  const t1 = t0 + T;
  const reason = {
    type: "flight", T: round(T), drop: round(chosen.drop), apex: round(chosen.apex),
    e: round(chosen.e), tilt: round(chosen.tilt), dv: round(chosen.dv),
    normal: chosen.normal.map((v) => Number(v.toFixed(9))),
    v_in: vec(vIn).map(round), v_out: chosen.vOut.map(round),
    rest_sec: round(info.restInGap), forced: Boolean(chosen.forced),
  };
  push({
    kind: "hop", t0, t1, p0: vec(p), p1: vec(chosen.pNext), v0: vec(chosen.vOut),
    h: 0, reason,
  });
  return {
    kind: "flight", t0, t1, duration: T, dwell: info.dwell, pNext: chosen.pNext,
    vInNext: [
      chosen.vOut[0] + G_VEC[0] * T, chosen.vOut[1] + G_VEC[1] * T,
      chosen.vOut[2] + G_VEC[2] * T,
    ],
    normal: chosen.normal, tilt: chosen.tilt, dir: info.dir,
    pose: chosen.pose, off: chosen.off, clearance: chosen.clearance,
    clearanceFail: Boolean(chosen.clearanceFail),
    plankOverlap: Boolean(chosen.plankOverlap),
    targetX: chosen.targetX, drop: chosen.drop, apex: chosen.apex, T,
    collision: collisionRecord(vIn, chosen.vOut, chosen),
    reason,
  };
}

// --- sampling -----------------------------------------------------------------

/** Integrate a constant cruise speed followed by a smooth speed blend.
 * The blend covers at most 0.6 s and consumes at most half the rail length,
 * so even a very long rest has positive cruise speed. Geometry stays fixed. */
function rideMotion(seg, u) {
  const t = clamp(u), endSpeed = seg.exit_speed_ratio ?? 1;
  if (endSpeed === 1) return { progress: t, rate: 1 };
  const blend = seg.speed_blend;
  const cruise = (1 - .5 * endSpeed * blend) / (1 - .5 * blend);
  const w = clamp((t - 1 + blend) / blend);
  return {
    progress: clamp(cruise * t + (endSpeed - cruise) * blend * (w ** 3 - .5 * w ** 4)),
    rate: cruise + (endSpeed - cruise) * w * w * (3 - 2 * w),
  };
}

/** Point on any segment at local u in [0, 1]. */
export function transitionPoint(seg, u) {
  if (seg.kind === "hold") return seg.p0.slice();
  if (seg.kind === "ride") return channelCenter(seg, rideMotion(seg, u).progress);
  if (seg.kind === "approach") return channelCenter(seg, u);
  return flightPoint(seg, u);
}

/** Velocity on any segment at local u (free flight, trough ride or rest). */
export function transitionVelocity(seg, u) {
  if (seg.kind === "hold") return [0, 0, 0];
  if (seg.kind === "ride") {
    const motion = rideMotion(seg, u);
    return channelVelocity(seg, motion.progress).map(v => v * motion.rate);
  }
  if (seg.kind === "approach") return channelVelocity(seg, u);
  return flightVelocity(seg, u);
}

/** Index of the segment covering t (segments are contiguous). */
export function segmentIndexAt(layout, t) {
  const segs = layout.segments;
  if (!segs.length) return -1;
  for (let i = 0; i < segs.length; i += 1) if (t <= segs[i].t1) return i;
  return segs.length - 1;
}

/** Ball centre at absolute time t. */
export function sampleBall(layout, t) {
  const i = segmentIndexAt(layout, t);
  if (i < 0) return layout.pad.ball_pos.slice();
  const seg = layout.segments[i];
  const span = seg.t1 - seg.t0;
  return transitionPoint(seg, span > 0 ? (t - seg.t0) / span : 0);
}

/** Ball velocity at absolute time t (analytic where it is a free flight). */
export function sampleVelocity(layout, t) {
  const i = segmentIndexAt(layout, t);
  if (i < 0) return [0, 0, 0];
  const seg = layout.segments[i];
  const span = seg.t1 - seg.t0;
  return transitionVelocity(seg, span > 0 ? (t - seg.t0) / span : 0);
}

/** The ball's route: the piecewise line through its contacts (camera target). */
export function routeAt(layout, t) {
  const route = layout.route;
  if (!route.length) return layout.pad.ball_pos.slice();
  if (t <= route[0].t) return route[0].p.slice();
  for (let i = 1; i < route.length; i += 1) {
    if (t <= route[i].t) {
      const span = route[i].t - route[i - 1].t;
      const u = span > 0 ? (t - route[i - 1].t) / span : 0;
      return mix(route[i - 1].p, route[i].p, u);
    }
  }
  return route[route.length - 1].p.slice();
}

/** Smooth camera target: the route with the hop arcs removed and a light blur. */
export function sampleTrack(layout, t) {
  const eps = 0.12;
  const a = routeAt(layout, Math.max(0, t - eps));
  const b = routeAt(layout, t);
  const c = routeAt(layout, Math.min(layout.duration, t + eps));
  return [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4,
    (a[2] + 2 * b[2] + c[2]) / 4];
}

/** Landing index whose glow can be live at t (-1 during the lead-in). */
export function activeLanding(layout, t) {
  let lo = 0;
  let hi = layout.boards.length;
  const key = t + 1e-9;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (layout.boards[mid].t <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Board glow strength of board i at time t (0 unless recently hit). */
export function glowAt(layout, t, i) {
  const b = layout.boards[i];
  if (!b || b.t === undefined) return 0;
  const dt = t - b.t;
  if (!(dt >= 0) || dt >= GLOW_LIFE * 3) return 0;
  return 0.65 * Math.exp(-dt / (GLOW_LIFE * 0.5));
}

/** Trough meshes whose Y span is within CHANNEL_WINDOW of trackY. */
export function channelsNear(layout, trackY) {
  return layout.channels.filter((seg) => {
    const lo = seg.y_lo - CHANNEL_WINDOW;
    const hi = seg.y_hi + CHANNEL_WINDOW;
    return trackY >= lo && trackY <= hi;
  });
}

/** Length of a segment's path by dense sampling (used for reports). */
export function pathLength(seg, samples = 32) {
  let total = 0;
  let prev = transitionPoint(seg, 0);
  for (let i = 1; i <= samples; i += 1) {
    const p = transitionPoint(seg, i / samples);
    total += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
  }
  return total;
}

/**
 * Closest approach of the whole path to every plank -- the check the gate, the
 * preview and the export all share.
 *
 * Per-flight sweeps only see the planks that existed when the flight was
 * solved.  This pass runs *after* the layout is complete, sweeps every segment
 * against every plank, and then refines around the closest sample (the distance
 * along a ballistic arc is smooth and locally unimodal, so a short ternary
 * search lands on the true minimum instead of the closest sample).
 *
 * A segment whose closest approach is below ``BALL_R`` is a real clip: the
 * sphere of the drawn ball would cut into a drawn plank.  It is reported, never
 * rounded away -- ``1e-9`` is a floating-point guard, not a tolerance for
 * hiding a 1.6 mm interpenetration.
 */
export function wholePathAudit(segments, plates) {
  const spheres = plates.filter((pl) => pl && pl.pos).map((pl) => {
    const box = plankAabb(pl);
    return { pose: { pos: pl.pos, tilt: pl.tilt ?? 0 }, box,
      index: pl.index === undefined ? -1 : pl.index };
  });
  const clean = spheres.filter((sp) => Number.isFinite(sp.pose.pos[0]));
  let min = Infinity;
  let worst = null;
  const fails = [];
  // A ball resting on a plank *is* exactly BALL_R away from it, so the absolute
  // minimum of any real layout is the contact distance itself.  To get a number
  // a reviewer can compare (and to name the worst *graze*), each segment also
  // reports its clearance with the plank it lands on / rides excluded.
  let travelMin = Infinity;
  let travelWorst = null;
  for (const seg of segments) {
    if (!(seg.t1 > seg.t0)) {
      // a zero-length hold is a single point: test it once
      const p = transitionPoint(seg, 0);
      for (const sp of clean) {
        const d = plankDistance(sp.pose, p);
        if (d < min) { min = d; worst = { t: seg.t0, board: sp.index, kind: seg.kind }; }
      }
      continue;
    }
    const T = seg.t1 - seg.t0;
    // Plates the ball is *standing on* at either end of this segment: touching
    // them is a contact, not a graze, so they are left out of the travelling
    // number (the gate below still counts them).
    const start = transitionPoint(seg, 0);
    const end = transitionPoint(seg, 1);
    const own = clean.filter((sp) => Math.abs(plankDistance(sp.pose, start) - BALL_R) < 1e-6
      || Math.abs(plankDistance(sp.pose, end) - BALL_R) < 1e-6);
    const pts = [];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i <= PATH_SAMPLES; i += 1) {
      const p = transitionPoint(seg, i / PATH_SAMPLES);
      pts.push(p);
      for (let k = 0; k < 3; k += 1) {
        if (p[k] < lo[k]) lo[k] = p[k];
        if (p[k] > hi[k]) hi[k] = p[k];
      }
    }
    // Only planks whose box can come within BALL_R of the arc's own box can
    // possibly clip it; everything else is ruled out in one comparison.
    const reach = BALL_R + 1e-9;
    const near = clean.filter((sp) => sp.box.hi[0] >= lo[0] - reach
      && sp.box.lo[0] <= hi[0] + reach
      && sp.box.hi[1] >= lo[1] - reach && sp.box.lo[1] <= hi[1] + reach
      && sp.box.hi[2] >= lo[2] - reach && sp.box.lo[2] <= hi[2] + reach);
    let segMin = Infinity;
    let segPlate = null;
    let segU = 0;
    let arrMin = Infinity;
    for (const sp of near) {
      const isOwn = own.includes(sp);
      for (let i = 0; i <= PATH_SAMPLES; i += 1) {
        const d = plankDistance(sp.pose, pts[i]);
        if (d < segMin) { segMin = d; segPlate = sp.index; segU = i / PATH_SAMPLES; }
        if (!isOwn && d < arrMin) arrMin = d;
      }
    }
    // Refine: ternary search on the bracketing interval of the best sample.
    if (Number.isFinite(segMin) && segPlate !== null) {
      const pose = near.find((sp) => sp.index === segPlate).pose;
      let a = Math.max(0, segU - 1 / PATH_SAMPLES);
      let b = Math.min(1, segU + 1 / PATH_SAMPLES);
      for (let it = 0; it < 60; it += 1) {
        const m1 = a + (b - a) / 3;
        const m2 = b - (b - a) / 3;
        const d1 = plankDistance(pose, transitionPoint(seg, m1));
        const d2 = plankDistance(pose, transitionPoint(seg, m2));
        if (d1 < d2) b = m2; else a = m1;
        const d = Math.min(d1, d2);
        if (d < segMin) { segMin = d; segU = d1 < d2 ? m1 : m2; }
      }
    }
    if (segMin < min) {
      min = segMin;
      worst = { t: seg.t0 + segU * T, board: segPlate, kind: seg.kind };
    }
    if (arrMin < travelMin) {
      travelMin = arrMin;
      travelWorst = { t: seg.t0 + segU * T, kind: seg.kind };
    }
    if (segMin < BALL_R - 1e-9) {
      fails.push({ i: segPlate, t: seg.t0 + segU * T, clearance: segMin,
        kind: seg.kind, path: true });
    }
  }
  return {
    samples: PATH_SAMPLES,
    min_distance: Number.isFinite(min) ? min : null,
    worst,
    travel_min: Number.isFinite(travelMin) ? travelMin : null,
    travel_worst: travelWorst,
    fails: fails.sort((a, b) => a.clearance - b.clearance),
    planks_checked: clean.length,
  };
}

/** Assemble the layout object (shared by every consumer) plus its audit. */
function finish(plan, seed, groups, boards, pad, segments, channels, transitions,
  clearanceFails = [], risingArrivals = []) {
  const used = boards.filter(Boolean);
  const pairPlates = [pad].concat(used);
  const pairs = [];
  for (let i = 0; i < pairPlates.length; i += 1) {
    for (let j = i + 1; j < pairPlates.length; j += 1) {
      const A = pairPlates[i];
      const B = pairPlates[j];
      if (!A || !B || !A.pos || !B.pos) continue;
      if (!platesApart(A, B)) {
        pairs.push({ a: A.index, b: B.index, ta: A.tilt ?? 0, tb: B.tilt ?? 0,
          d: plankDistance(A, B.pos) });
      }
    }
  }
  // Complete picture-plane gap sweep (every pair, the drawn 0.30 x 0.06
  // outlines): the per-board flag only records what the solver saw while
  // placing its neighbours.  This is a *visible* property, reported separately
  // from the collision checks -- a pair below PLANK_GAP_MIN is one the viewer
  // reads as fused, not one the ball hits.
  const gaps = [];
  let nearestGap = Infinity;
  for (let i = 0; i < pairPlates.length; i += 1) {
    for (let j = i + 1; j < pairPlates.length; j += 1) {
      const A = pairPlates[i];
      const B = pairPlates[j];
      if (!A || !B || !A.pos || !B.pos) continue;
      // a rotated slab reaches at most hypot(W/2, H/2) from its centre on
      // either axis, so this prefilter can never hide a sub-threshold pair
      const dx = Math.abs(A.pos[0] - B.pos[0]);
      const dy = Math.abs(A.pos[1] - B.pos[1]);
      const reach = 2 * Math.hypot(BOARD_W / 2, BOARD_H / 2) + PLANK_GAP_MIN;
      if (dx > reach || dy > reach) continue;
      const d = outlineGap(A, B);
      if (d < PLANK_GAP_MIN) {
        gaps.push({ a: A.index, b: B.index, d, ta: A.tilt ?? 0, tb: B.tilt ?? 0 });
      }
      if (d < nearestGap) nearestGap = d;
    }
  }
  gaps.sort((x, y) => x.d - y.d);
  const plankGapMin = Number.isFinite(nearestGap) ? round(nearestGap) : null;
  const duration = Math.max(plan.duration || 0, used.length ? used[used.length - 1].t : 0);
  const route = [{ t: 0, p: vec(pad.ball_pos) }];
  for (const b of used) route.push({ t: b.t, p: vec(b.ball_pos) });
  route.push({
    t: duration,
    p: segments.length ? vec(transitionPoint(segments.at(-1), 1)) : vec(pad.ball_pos),
  });
  // The complete path, checked after the fact against every plank.  Its
  // failures join ``clearance_fails`` so the page, the CLI gate and the API all
  // refuse the same layouts -- one gate, not three.
  const pathAudit = wholePathAudit(segments, pairPlates);
  const pathFails = pathAudit.fails.map((f) => ({ i: f.i, t: f.t,
    clearance: f.clearance, near: f.i, kind: f.kind, path: true }));
  const railAudit = wholeSlideAudit(segments,channels);
  const allClearanceFails = clearanceFails.concat(pathFails,railAudit.fails);
  const flights = transitions.filter((tr) => tr.kind === "flight");
  const chutes = transitions.filter((tr) => tr.kind === "chute");
  const strikes = used.filter((b) => b.strike);
  const num = (v) => (Number.isFinite(v) ? round(v) : 0);
  let lateralMax = 0;
  let reversals = 0;
  let monotone = true;
  let prevDx = 0;
  for (let i = 1; i < used.length; i += 1) {
    const dx = used[i].ball_pos[0] - used[i - 1].ball_pos[0];
    lateralMax = Math.max(lateralMax, Math.abs(dx));
    if (dx * prevDx < 0) reversals += 1;
    if (Math.abs(dx) > 1e-9) prevDx = dx;
    if (!(used[i].ball_pos[1] < used[i - 1].ball_pos[1] - 1e-9)) monotone = false;
  }
  const audit = {
    gravity: G,
    transitions: transitions.length,
    flights: flights.length,
    chutes: chutes.length,
    active_strikes: strikes.length,
    forced: transitions.filter((tr) => tr.reason && tr.reason.forced).length,
    tilt_capped: transitions.filter((tr) => tr.collision && tr.collision.tilt_capped).length,
    max_e: num(Math.max(0, ...flights.map((tr) => tr.collision.e))),
    max_dv: num(Math.max(0, ...transitions.map((tr) => (tr.collision ? tr.collision.dv : 0)))),
    max_apex: num(Math.max(0, ...flights.map((tr) => tr.apex))),
    max_drop: num(Math.max(0, ...transitions.map((tr) => tr.drop))),
    max_tilt: num(Math.max(0, ...used.map((b) => Math.abs(b.tilt)))),
    max_sit: num(Math.max(0, ...transitions.map((tr) => tr.sit || 0))),
    lateral_max: num(lateralMax),
    safe_mode_boards: boards.filter((b) => b && b.safe_mode).length,
    clearance_fails: allClearanceFails.length,
    slide_clearance_fails: railAudit.fails.length,
    slide_min_clearance: railAudit.min_distance,
    clearance_fail_deep: allClearanceFails.filter((f) => f.clearance < 0.1).length,
    clearance_scan: FINE_SAMPLES,
    // Post-build whole-path sphere/OBB sweep: every segment, every plank, the
    // minimum refined off the samples.  ``path_clearance_fails`` is included in
    // ``clearance_fails`` above, so an old-style reader of that key gets the
    // stricter verdict too.
    path_scan: pathAudit.samples,
    path_clearance_fails: pathFails.length,
    path_min_clearance: pathAudit.min_distance === null ? null
      : Math.round(pathAudit.min_distance * 1e6) / 1e6,
    // 不含「小球正踩在那块板上」的接触，纯粹是行进中的最小距离：Codex 的独立
    // 扫描量出来的就是这一条（0.09842 = 1.6 mm 的嵌入）
    path_travel_clearance: pathAudit.travel_min === null ? null
      : Math.round(pathAudit.travel_min * 1e6) / 1e6,
    path_worst: pathAudit.worst ? { t: round(pathAudit.worst.t),
      board: pathAudit.worst.board, kind: pathAudit.worst.kind } : null,
    path_planks_checked: pathAudit.planks_checked,
    rising_arrivals: risingArrivals.length,
    rising_arrival_list: risingArrivals.slice(0, 6),
    plank_overlaps: used.filter((b) => b.plank_overlap).length,
    // Visible (picture-plane) gap between neighbouring planks: the 15% guide
    // PLANK_GAP_MIN, measured on the drawn outlines over every pair.  This is
    // the one number in the audit that is about how the machine *looks* -- the
    // ball cannot tell a 1 mm seam from a 45 mm one.
    plank_gap_min: plankGapMin,
    plank_gap_guide: PLANK_GAP_MIN,
    plank_gap_fails: gaps.filter((g) => g.d < PLANK_GAP_MIN * 0.5).length,
    plank_gap_list: gaps.slice(0, 8).map((g) => ({ a: g.a, b: g.b, gap: round(g.d),
      tilt_a: round(g.ta), tilt_b: round(g.tb) })),
    // Complete post-build plank-vs-plank sweep (every pair, exact SAT): the
    // per-board flag above only records what the solver saw while placing.
    plank_overlap_pairs: pairs.length,
    plank_overlap_list: pairs.slice(0, 8).map((x) => ({ a: x.a, b: x.b,
      d: round(x.d), tilt_a: round(x.ta), tilt_b: round(x.tb) })),
    clearance_fail_list: allClearanceFails.slice(0, 12),
    // The pose/contact datum, checked on every board: the ball sits exactly
    // BALL_R from its own plank's box, and nothing ever leaves the plank plane.
    contact_error: num(Math.max(0, ...used.map((b) => Math.abs(
      plankDistance({ pos: b.pos, tilt: b.tilt }, b.ball_pos) - BALL_R)))),
    planar_z: num(Math.max(0, ...used.map((b) => Math.abs(b.ball_pos[2])))),
    // The honest number: the smaller of what the solver saw per flight and what
    // the whole-path sweep measures afterwards.
    min_clearance: num(Math.min(
      Math.min(...used.map((b) => (b.clearance === null
        || b.clearance === undefined ? Infinity : b.clearance))),
      pathAudit.min_distance === null ? Infinity : pathAudit.min_distance)),
    reversals,
    descends: monotone,
    top_y: used.length ? num(used[0].top_y) : num(pad.top_y),
    bottom_y: used.length ? num(used[used.length - 1].top_y) : num(pad.top_y),
    active_strike_boards: strikes.map((b) => ({ i: b.index, t: num(b.t), e: b.strike.e,
      dv: b.strike.dv, drop: b.collision.drop, apex: b.collision.apex })),
    chute_list: chutes.map((tr) => ({ t0: num(tr.t0), ride_sec: num(tr.reason.ride_sec),
      ride_speed: num(tr.reason.ride_speed), rest_sec: num(tr.reason.rest_sec),
      drop: num(tr.drop) })),
  };
  const groupInfo = groups.map((g) => {
    const members = g.members.filter((i) => boards[i]);
    const ys = members.map((i) => boards[i].top_y);
    return {
      index: g.index, reason: g.reason, from: g.from, to: g.to,
      members: g.members.slice(), n: g.members.length,
      top_y: ys.length ? round(ys[0]) : 0, bottom_y: ys.length ? round(ys[ys.length - 1]) : 0,
      apex_max: num(Math.max(0, ...members.map((i) => (boards[i].collision
        ? boards[i].collision.apex : 0)))),
      tilt_max_deg: num(Math.max(0, ...members.map((i) => Math.abs(boards[i].tilt)
        * 180 / Math.PI))),
    };
  });
  return {
    format: FORMAT, seed, duration, ref_midi: plan.ref_midi, gravity: G,
    constants: {
      board_w: BOARD_W, board_h: BOARD_H, board_d: BOARD_D, ball_r: BALL_R,
      spacing: SPACING, dx_min: DX_MIN, contact_off: CONTACT_OFF,
      bounce_scale: BOUNCE_SCALE, plank_gap_min: PLANK_GAP_MIN,
      glow_life: GLOW_LIFE, gravity: G,
    },
    thresholds: {
      long_note_min: LONG_NOTE_MIN, long_beats_min: LONG_BEATS_MIN,
      rest_channel_min: REST_CHANNEL_MIN, channel_min_time: CHANNEL_MIN_TIME,
      max_channel_speed: MAX_CHANNEL_SPEED, min_channel_speed: MIN_CHANNEL_SPEED,
      rest_group_min: REST_GROUP_MIN, max_group: MAX_GROUP,
      max_group_span: MAX_GROUP_SPAN, pitch_leap: PITCH_LEAP,
      tilt_max: TILT_MAX, e_max: E_MAX, apex_max: A_MAX, drop_min: D_MIN,
      drop_max: D_MAX, fly_max: FLY_MAX, x_band: X_BAND, sit_max: SIT_MAX,
      dx_min: DX_MIN, contact_off: CONTACT_OFF,
    },
    groups: groupInfo, boards, pad, channels, segments, transitions, route, audit,
  };
}
