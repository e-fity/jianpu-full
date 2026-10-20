import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/layout.mjs';
import * as THREE from 'three';
import fs from 'node:fs';

/** Build a plan from a spec of {kind:'note'|'rest', dur, midi, n, o}. */
function makePlan(spec, extra = {}) {
  let t = 0;
  const events = [];
  const landings = [];
  for (const item of spec) {
    const dur = item.dur;
    const event = {
      kind: item.kind, onset_sec: t, dur_sec: dur,
      midi: item.midi ?? null, n: item.n ?? 0, o: item.o ?? 0,
    };
    events.push(event);
    if (item.kind === 'note') {
      landings.push({
        i: landings.length, t, midi: event.midi, n: event.n, o: event.o,
        q: dur, dur, onset_sec: t,
      });
    }
    t += dur;
  }
  return {
    format: 'ball3d-plan-v1', key: '1=C', tempo_qpm: 60, title: 'synth',
    ref_midi: 60, lead: 0, tail: 1, duration: t + 1,
    events, landings,
    rests: events.filter((e) => e.kind === 'rest'),
    counts: {
      lines: 1, events: events.length, sounding: landings.length,
      rests: events.length - landings.length,
    },
    ...extra,
  };
}

const notes = (n, dur, midi = 60, step = 0) => Array.from({ length: n }, (_, i) => ({
  kind: 'note', dur, midi: midi + ((i * (step || 1)) % 5), n: 1 + (i % 5),
}));

const shortRun = makePlan(notes(18, 0.25));
const mixed = makePlan([
  ...notes(4, 0.25, 62),
  { kind: 'note', dur: 1.6, midi: 64, n: 3 },
  { kind: 'rest', dur: 1.8 },
  ...notes(4, 0.5, 60),
  { kind: 'note', dur: 1.4, midi: 67, n: 5 },
  { kind: 'rest', dur: 2.2 },
  ...notes(5, 0.3, 65),
]);
const dense = makePlan(notes(40, 0.24));

function flights(layout) {
  return layout.segments.filter((s) => s.kind === 'hop');
}

function flightPoint(seg, t) {
  const dt = t - seg.t0;
  return [0, 1, 2].map((k) => seg.p0[k] + seg.v0[k] * dt
    + 0.5 * L.G_VEC[k] * dt * dt);
}

test('every onset lands exactly on its board top (exact contact)', () => {
  for (const plan of [shortRun, mixed, dense]) {
    const layout = L.buildLayout(plan);
    for (const board of layout.boards) {
      const p = L.sampleBall(layout, board.t);
      for (let k = 0; k < 3; k += 1) {
        assert.ok(Math.abs(p[k] - board.ball_pos[k]) < 1e-9,
          `contact board ${board.index} at ${board.t}: ${p} != ${board.ball_pos}`);
      }
      const pose = L.plankPose(board.hinge, board.tilt, board.off);
      for (let k = 0; k < 3; k += 1) {
        assert.ok(Math.abs(pose.ball_pos[k] - board.ball_pos[k]) < 1e-9,
          `pose disagrees with the board at ${board.index}`);
        assert.ok(Math.abs(pose.centre[k] - board.pos[k]) < 1e-9,
          `rendered centre disagrees at ${board.index}`);
      }
      assert.ok(Math.abs(Math.abs(board.off) - L.CONTACT_OFF) < 1e-9,
        `contact offset must be the leading edge, got ${board.off}`);
      assert.ok(Math.abs(board.tilt) <= L.TILT_MAX + 1e-9);
      const d = L.plankDistance({ pos: board.pos, tilt: board.tilt }, board.ball_pos);
      assert.ok(Math.abs(d - L.BALL_R) < 1e-9, `contact distance ${d}`);
    }
  }
});

test('the path is continuous at every segment boundary and always finite', () => {
  for (const plan of [shortRun, mixed, dense]) {
    const layout = L.buildLayout(plan);
    const segs = layout.segments;
    for (let i = 1; i < segs.length; i += 1) {
      const end = L.transitionPoint(segs[i - 1], 1);
      const start = L.transitionPoint(segs[i], 0);
      for (let k = 0; k < 3; k += 1) {
        assert.ok(Math.abs(end[k] - start[k]) < 1e-9,
          `gap between ${segs[i - 1].kind} and ${segs[i].kind}`);
      }
      assert.ok(segs[i].t0 >= segs[i - 1].t1 - 1e-9, 'segments may not overlap');
    }
    for (let t = 0; t <= plan.duration; t += 1 / 30) {
      assert.ok(L.sampleBall(layout, t).every(Number.isFinite));
    }
  }
});

test('the layout is music-driven, not a fixed cycle, and is reproducible', () => {
  const a = L.buildLayout(shortRun);
  const b = L.buildLayout(mixed);
  const a2 = L.buildLayout(shortRun);
  const a3 = L.buildLayout(shortRun, { seed: 7 });
  assert.deepEqual(a, a2, 'same plan and seed must give the same layout');
  assert.notDeepEqual(a.boards.map((x) => x.top_y), b.boards.map((x) => x.top_y),
    'different songs must produce different arrangements');
  assert.notDeepEqual(a, a3, 'an explicit seed changes the arrangement');
});

// --- the three defects this round had to remove ------------------------------

test('regression: no sideways reset between rows (defect 1)', () => {
  for (const plan of [shortRun, mixed, dense]) {
    const layout = L.buildLayout(plan);
    for (const seg of flights(layout)) {
      const dx = seg.p1[0] - seg.p0[0];
      assert.ok(Math.abs(dx) <= L.STEP_MAX + 1e-6,
        `flight at ${seg.t0} moves ${dx} sideways`);
    }
    const xs = layout.boards.map((b) => b.pos[0]);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 2 * (L.X_BAND + L.STEP_MAX + 0.7),
      'the descent stays inside the corridor');
  }
});

test('regression: no mid-air speed change or turn (defect 2)', () => {
  const layout = L.buildLayout(mixed);
  for (const seg of flights(layout)) {
    const T = seg.t1 - seg.t0;
    const steps = 24;
    for (let i = 1; i < steps; i += 1) {
      const t0 = seg.t0 + (i - 0.5) * T / steps;
      const t1 = seg.t0 + (i + 0.5) * T / steps;
      const a = flightPoint(seg, t0);
      const b = flightPoint(seg, t1);
      const vx = (b[0] - a[0]) / (t1 - t0);
      const vy = (b[1] - a[1]) / (t1 - t0);
      assert.ok(Math.abs(vx - seg.v0[0]) < 1e-9, `vx changed mid-air: ${vx}`);
      const expected = seg.v0[1] - L.G * ((t0 + t1) / 2 - seg.t0);
      assert.ok(Math.abs(vy - expected) < 1e-9, `vy is not g*t: ${vy}`);
    }
    const h = T / 40;
    for (let i = 0; i + 2 <= 40; i += 1) {
      const t = seg.t0 + i * h;
      const p0 = flightPoint(seg, t);
      const p1 = flightPoint(seg, t + h);
      const p2 = flightPoint(seg, t + 2 * h);
      const ay = (p2[1] - 2 * p1[1] + p0[1]) / (h * h);
      const ax = (p2[0] - 2 * p1[0] + p0[0]) / (h * h);
      assert.ok(Math.abs(ay + L.G) < 1e-6, `vertical acceleration ${ay}`);
      assert.ok(Math.abs(ax) < 1e-6, `horizontal acceleration ${ax}`);
    }
  }
});

test('regression: a long note bounces high and still lands on the onset (defect 3)', () => {
  // the *interval* after the first note is what varies (same endpoints)
  const one = (dur) => L.buildLayout(makePlan([
    { kind: 'note', dur, midi: 62, n: 2 },
    { kind: 'note', dur: 0.8, midi: 62, n: 2 },
    { kind: 'note', dur: 0.3, midi: 62, n: 2 },
  ]));
  const apexOfFlightAfter = (layout, t) => {
    const seg = flights(layout).find((s) => s.t0 >= t - 1e-6);
    assert.ok(seg, `no flight at ${t}`);
    let best = -Infinity;
    for (let i = 0; i <= 40; i += 1) {
      best = Math.max(best, flightPoint(seg, seg.t0 + (i / 40) * (seg.t1 - seg.t0))[1]);
    }
    return best - seg.p0[1];
  };
  const short = one(0.4);
  const long = one(1.6);
  const aShort = apexOfFlightAfter(short, 0);
  const aLong = apexOfFlightAfter(long, 0);
  assert.ok(aLong > aShort + 0.05,
    `the long interval must rise higher (${aLong} vs ${aShort})`);
  assert.equal(long.channels.length, 0, 'a long note must not be given a chute');
  assert.equal(short.channels.length, 0);
  for (const layout of [short, long]) {
    for (const board of layout.boards) {
      assert.ok(board.departure - board.arrival <= L.SIT_MAX + 1e-9, 'sit too long');
    }
    for (const seg of flights(layout)) {
      assert.ok(seg.t1 - seg.t0 <= L.FLY_MAX + 1e-9, 'rushed catch-up flight');
    }
  }
});

// --- the motion and collision model ------------------------------------------

test('every collision keeps the tangent and reports its restitution', () => {
  for (const plan of [mixed, dense]) {
    const layout = L.buildLayout(plan);
    let strikes = 0;
    for (const seg of flights(layout)) {
      const c = seg.reason;
      if (!c || c.e === undefined) continue;
      const n = c.normal;
      const len = Math.hypot(n[0], n[1], n[2]);
      assert.ok(Math.abs(len - 1) < 1e-9, `normal is not unit: ${len}`);
      if (c.e > 1) {
        strikes += 1;
        assert.ok(c.dv > 0, 'an active strike must record its gain');
      }
      assert.ok(c.e >= 0 && c.e <= L.E_MAX + 1e-9, `e=${c.e} out of range`);
      assert.ok(Math.abs(c.tilt) <= L.TILT_MAX + 1e-9);
    }
    assert.equal(strikes, layout.audit.active_strikes,
      'every active strike is recorded in the audit');
    for (const b of layout.boards) {
      if (b.strike) assert.ok(b.strike.e > 1 && b.strike.dv > 0);
    }
  }
});

test('a plain descending phrase needs no active energy', () => {
  const layout = L.buildLayout(makePlan([
    { kind: 'note', dur: 0.6, midi: 60, n: 1 },
    { kind: 'note', dur: 0.6, midi: 62, n: 2 },
    { kind: 'note', dur: 0.6, midi: 64, n: 3 },
    { kind: 'note', dur: 0.6, midi: 65, n: 4 },
    { kind: 'note', dur: 0.6, midi: 67, n: 5 },
    { kind: 'note', dur: 0.6, midi: 69, n: 6 },
  ]));
  assert.equal(layout.audit.active_strikes, 0,
    'plain descending notes must be flown passively');
  assert.ok(layout.audit.max_e <= 1 + 1e-9);
});

/**
 * Full-path sphere/OBB scan with the same datum the renderer and solver use.
 *
 * ``samples`` is the number of intervals per segment and ``apex`` adds the
 * turning point of every arc, which an endpoint-only sweep would never see: the
 * highest point of a hop is exactly where a board above it could be clipped.
 */
function scanPath(layout, { samples = 120, apex = true } = {}) {
  const plates = [{ index: -1, pos: layout.pad.pos, tilt: layout.pad.tilt || 0 }]
    .concat(layout.boards.map((b) => ({ index: b.index, pos: b.pos, tilt: b.tilt || 0 })));
  let count = 0;
  let checked = 0;
  let worst = null;
  for (const seg of layout.segments) {
    const us = [];
    for (let i = 0; i <= samples; i += 1) us.push(i / samples);
    if (apex && seg.kind === 'hop' && seg.v0[1] > 0) {
      // y(t) = y0 + v0y t - g t^2 / 2 has its apex at t = v0y / g
      const t = seg.v0[1] / -L.G_VEC[1];
      const u = t / (seg.t1 - seg.t0);
      if (u > 0 && u < 1) us.push(u, u - 1e-6, u + 1e-6);
    }
    for (const u of us) {
      const p = L.transitionPoint(seg, u);
      checked += 1;
      for (const pl of plates) {
        const d = L.plankDistance(pl, p);
        if (d < L.BALL_R - 1e-9) {
          count += 1;
          if (!worst || d < worst.d) {
            worst = { d, board: pl.index, kind: seg.kind, u };
          }
        }
      }
    }
  }
  return { count, checked, worst, boards: plates.length };
}


function scanPenetrations(layout) {
  const plates = [{ index: -1, pos: layout.pad.pos, tilt: layout.pad.tilt || 0 }]
    .concat(layout.boards.map((b) => ({ index: b.index, pos: b.pos, tilt: b.tilt || 0 })));
  let count = 0;
  let samples = 0;
  let worst = null;
  for (const seg of layout.segments) {
    for (let i = 0; i <= 60; i += 1) {
      const u = i / 60;
      const p = L.transitionPoint(seg, u);
      samples += 1;
      for (const pl of plates) {
        const d = L.plankDistance(pl, p);
        if (d < L.BALL_R - 1e-9) {
          count += 1;
          if (!worst || d < worst.d) {
            worst = { d, board: pl.index, kind: seg.kind, u };
          }
        }
      }
    }
  }
  return { count, samples, worst };
}

test('the ball does not sweep through a plank (full-path sphere/OBB)', () => {
  // Ordinary spacing plus the two dense regimes the narrow assembly must now
  // handle: 0.24 s (the old "geometric limit") and 0.30 s.
  // 0.25 s is the tightest *synthetic* uniform run this assembly places
  // cleanly; the real song's 0.231 s passage is covered by the fixture test
  // below.  0.24 s with rising pitch is over the limit and must report itself
  // (next test) rather than pretend.
  for (const plan of [makePlan(notes(12, 0.5)), makePlan(notes(8, 1.0)),
    makePlan(notes(10, 0.6, 57, 3)), makePlan(notes(9, 0.75, 64, 2)),
    makePlan(notes(24, 0.3)), shortRun]) {
    const layout = L.buildLayout(plan);
    const scan = scanPath(layout);
    assert.equal(scan.count, 0,
      `no spacing may clip a plank: ${JSON.stringify(scan.worst)}`);
    assert.equal(layout.audit.clearance_fails, 0);
    assert.equal(layout.audit.plank_overlaps, 0);
  }
});

test('a run the assembly cannot place is reported, never hidden', () => {
  // 0.24 s uniform notes with a rising pitch pattern: the ball has to climb
  // under the plank above it.  The layout may fail to find a clean route here,
  // and if it does, every clip the full-path scan finds has to appear in
  // ``audit.clearance_fail_list`` with the clearance it measured -- a silent
  // penetration is the one outcome not allowed.
  const layout = L.buildLayout(dense);
  const audit = layout.audit;
  const scan = scanPath(layout, { samples: 300 });
  assert.equal(audit.plank_overlaps, 0);
  if (scan.count === 0) return; // a future solver is welcome to fix it
  assert.ok(audit.clearance_fails > 0,
    `the scan found ${scan.count} clips but the audit reports none`);
  assert.ok(audit.clearance_fail_list.length > 0,
    'the failing transitions must be listed, not just counted');
  assert.ok(audit.clearance_fail_deep <= audit.clearance_fails);
  assert.ok(audit.clearance_fail_list.every(
    (f) => Number.isFinite(f.clearance) && f.clearance >= 0 && f.clearance <= L.BALL_R),
    'every reported failure must carry its measured clearance');
  // and the report must not be rosier than the independent scan
  assert.ok(audit.min_clearance <= scan.worst.d + 1e-6,
    `audit min_clearance ${audit.min_clearance} > scanned ${scan.worst.d}`);
  // every clipped flight departs from a board the audit listed
  const listed = new Set(audit.clearance_fail_list.map((f) => f.i));
  for (const seg of layout.segments) {
    if (seg.kind !== 'hop') continue;
    let hit = false;
    for (let i = 0; i <= 60 && !hit; i += 1) {
      const p = L.transitionPoint(seg, i / 60);
      for (const b of layout.boards) {
        if (L.plankDistance({ pos: b.pos, tilt: b.tilt || 0 }, p) < L.BALL_R - 1e-9) {
          hit = true;
          break;
        }
      }
    }
    if (!hit) continue;
    const from = layout.boards.findIndex((b) => b.t >= seg.t0 - 1e-9);
    assert.ok(listed.has(from) || listed.has(from - 1),
      `a clip in the flight starting at t=${seg.t0} is not in the audit`);
  }
});

test('the densest 30 s of the real song clears every board', () => {
  // The 0.231 s run of eighth notes the song actually contains -- the passage
  // the previous round called a geometric hard limit.  It is a fixture, not the
  // user's file, so the check runs offline and cannot be skipped away.
  const fixture = JSON.parse(fs.readFileSync(
    new URL('./fixtures/dense_window.json', import.meta.url), 'utf8'));
  const provenance = fixture._fixture;
  assert.ok(provenance.onsets >= 60,
    `the fixture must stay dense: ${JSON.stringify(provenance)}`);
  const gaps = fixture.landings.map((l) => l.t)
    .slice(1).map((t, i) => t - fixture.landings[i].t);
  const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  assert.ok(median <= 0.30, `the fixture must stay dense: median gap ${median}`);

  const layout = L.buildLayout(fixture);
  const scan = scanPath(layout, { samples: 400 });
  assert.equal(scan.count, 0,
    `the real dense passage must clear every board: ${JSON.stringify(scan.worst)}`);
  assert.ok(scan.checked > 400 * layout.segments.length * 0.9,
    `the scan must really cover the whole path (${scan.checked} samples)`);
  const audit = layout.audit;
  assert.equal(audit.clearance_fails, 0,
    `the solver must not report the dense passage as failed: ${JSON.stringify(audit.clearance_fail_list)}`);
  assert.equal(audit.clearance_fail_deep, 0);
  assert.equal(audit.plank_overlaps, 0);
  assert.ok(audit.min_clearance >= L.BALL_R - 1e-6,
    `closest approach ${audit.min_clearance} must stay at or above the ball radius`);
});

test('the dense run keeps a visible gap between the drawn planks', () => {
  // Non-penetration is not the whole requirement: the narrow planks must also
  // read as separate planks.  This measures the *drawn* outlines in the
  // picture plane (0.30 x 0.06, not the 0.40 deep collision box) and holds the
  // dense real-song passage to the 15%-of-width guide on average, with every
  // sub-guide pair listed rather than hidden.
  const fixture = JSON.parse(fs.readFileSync(
    new URL('./fixtures/dense_window.json', import.meta.url), 'utf8'));
  const layout = L.buildLayout(fixture);
  const boards = layout.boards;
  const gaps = [];
  for (let i = 1; i < boards.length; i += 1) {
    gaps.push(L.outlineGap(boards[i - 1], boards[i]));
  }
  assert.ok(gaps.length > 20, `the fixture must stay dense (${gaps.length} pairs)`);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median >= L.PLANK_GAP_MIN,
    `median visible gap ${median.toFixed(4)} must reach the ${L.PLANK_GAP_MIN} guide`);
  const tight = [];
  for (let i = 1; i < boards.length; i += 1) {
    const g = L.outlineGap(boards[i - 1], boards[i]);
    if (g < L.PLANK_GAP_MIN * 0.5) {
      tight.push({ i: i - 1, tilt_a: boards[i - 1].tilt, tilt_b: boards[i].tilt, g });
    }
  }
  // What is left is the turnaround of a dense run against the side of the
  // frame: a 0.231 s interval cannot fall further than free fall (~0.17 m), so
  // two planks that both have to be near the 0.95 rad tilt cap to reverse the
  // ball can only be a few millimetres apart.  It is a stated limit, measured
  // on the frames -- never a silent pass -- so the shape is asserted too.
  for (const t of tight) {
    assert.ok(Math.abs(t.tilt_a) >= 0.45 && Math.abs(t.tilt_b) >= 0.45,
      `a shallow pair may not be tight: ${JSON.stringify(t)}`);
  }
  assert.ok(tight.length <= 4, `too many tight pairs: ${JSON.stringify(tight)}`);
  const listed = new Set(layout.audit.plank_gap_list.map((p) => `${p.a}/${p.b}`));
  for (const t of tight) {
    assert.ok(listed.has(`${t.i}/${t.i + 1}`),
      `tight pair ${t.i}/${t.i + 1} is not in audit.plank_gap_list`);
  }
  assert.equal(layout.audit.plank_gap_guide, L.PLANK_GAP_MIN);
  assert.ok(layout.audit.plank_gap_min > 0, 'planks must never be drawn overlapping');
});

test('boards never interpenetrate each other', () => {
  // A plank-vs-plank overlap is the failure mode that made an earlier "clean"
  // layout impossible to render: the solver's own clearance checks passed while
  // two boxes shared a slice of space.  Checked here for the dense fixture and
  // for the synthetic runs, with the audit's own pair list as the witness.
  for (const plan of [dense, shortRun, mixed,
    JSON.parse(fs.readFileSync(
      new URL('./fixtures/dense_window.json', import.meta.url), 'utf8'))]) {
    const layout = L.buildLayout(plan);
    assert.equal(layout.audit.plank_overlaps, 0,
      `overlapping planks: ${JSON.stringify(layout.audit.plank_overlap_list)}`);
    const boards = layout.boards;
    for (let i = 0; i < boards.length; i += 1) {
      for (let j = i + 1; j < boards.length; j += 1) {
        const a = { pos: boards[i].pos, tilt: boards[i].tilt || 0 };
        const b = { pos: boards[j].pos, tilt: boards[j].tilt || 0 };
        assert.ok(L.platesApart(a, b),
          `board ${i} and board ${j} share space`);
      }
    }
  }
});

test('rests alone do not create slides', () => {
  const layout = L.buildLayout(mixed);
  assert.equal(layout.channels.length, 0);
  const onlyShort = L.buildLayout(makePlan(
    notes(24, 0.25).map((n, i) => (i % 3 === 2 ? { kind: 'rest', dur: 0.5 } : n)),
  ));
  assert.equal(onlyShort.channels.length, 0);
  assert.ok(onlyShort.segments.every((s) => s.kind !== 'ride'));
});

test('rests are not boards, never contact and never glow', () => {
  const layout = L.buildLayout(mixed);
  const restOnsets = new Set(mixed.rests.map((r) => r.onset_sec));
  for (const board of layout.boards) {
    assert.ok(!restOnsets.has(board.t), 'a rest must not own a board');
    assert.equal(L.glowAt(layout, board.t - 0.001, board.index), 0);
    assert.ok(L.glowAt(layout, board.t + 0.001, board.index) > 0, 'the hit board glows');
  }
  const lead = L.buildLayout(makePlan([
    { kind: 'rest', dur: 1.5 }, { kind: 'note', dur: 0.5, midi: 62, n: 2 },
  ]));
  assert.equal(L.activeLanding(lead, 0.75), -1);
});

function assertRailClearance(layout) {
  // Independently measure sphere distance to the two open rail tubes, using
  // dense polylines rather than the removed solid trough surface.
  const rails = [];
  for (const seg of layout.channels) for (let i = 0; i < 256; i += 1) {
    const a = L.channelCross(seg, i / 256);
    const b = L.channelCross(seg, (i + 1) / 256);
    for (const side of ['left', 'right']) rails.push(new THREE.Line3(
      new THREE.Vector3(...a[side]), new THREE.Vector3(...b[side])));
  }
  const p = new THREE.Vector3(), near = new THREE.Vector3();
  for (const seg of layout.segments) for (let i = 0; i <= 200; i += 1) {
    p.set(...L.transitionPoint(seg, i / 200));
    for (const rail of rails) {
      rail.closestPointToPoint(p, true, near);
      const distance = p.distanceTo(near) - L.CHANNEL_RAIL_RADIUS;
      assert.ok(distance >= L.BALL_R - 5e-4, `${seg.kind}: ${distance}`);
    }
  }
  assert.equal(layout.audit.slide_clearance_fails, 0);
}

test('sphere clears brass rails and adjacent slide exits', () => {
  assertRailClearance(L.buildLayout(mixed));
  const consecutive = makePlan([
    { kind: 'note', dur: 2, midi: 60, n: 1 }, { kind: 'rest', dur: 2 },
    { kind: 'note', dur: 2, midi: 62, n: 2 }, { kind: 'rest', dur: 2 },
    { kind: 'note', dur: 2, midi: 64, n: 3 }, { kind: 'rest', dur: 2 },
    { kind: 'note', dur: .5, midi: 65, n: 4 },
  ]);
  assertRailClearance(L.buildLayout(consecutive));
});

test('empty and one-note layouts stay finite through the tail', () => {
  for (const plan of [makePlan([]), makePlan([{ kind: 'note', dur: 2, midi: 60, n: 1 }])]) {
    const layout = L.buildLayout(plan);
    for (let t = 0; t <= plan.duration; t += .01) {
      assert.ok(L.sampleBall(layout, t).every(Number.isFinite));
    }
    assert.equal(layout.channels.length, plan.landings.length);
  }
});

test('the descent never stalls and never rises overall', () => {
  const layout = L.buildLayout(mixed);
  const ys = layout.boards.map((b) => b.top_y);
  for (let i = 1; i < ys.length; i += 1) {
    assert.ok(ys[i] <= ys[i - 1] + 1e-9,
      `board ${i} is above its predecessor (${ys[i]} > ${ys[i - 1]})`);
  }
  assert.equal(layout.audit.descends, true);
});


test('q >= 2 creates slides at different tempos, including the last note', () => {
  for (const tempo of [40, 65, 120, 180, 240]) for (const q of [1, 1.5, 2, 3]) {
    const dur = q * 60 / tempo;
    const plan = makePlan(notes(3, dur), { tempo_qpm: tempo });
    for (const landing of plan.landings) landing.q = q;
    const layout = L.buildLayout(plan);
    assert.equal(layout.channels.length, q >= 2 ? 3 : 0, `${tempo} bpm, q=${q}`);
    assert.equal(layout.audit.clearance_fails, 0);
    assert.equal(layout.audit.forced, 0);
    assert.equal(layout.audit.plank_overlaps, 0);
    for (const rail of layout.channels) {
      const note = plan.landings[rail.reason.note_index];
      assert.equal(rail.reason.trigger, 'long_note');
      assert.ok(rail.t0 >= note.t && rail.t1 <= note.t + note.dur + 1e-9);
    }
    for (const board of layout.boards) assert.ok(Math.hypot(...L.sampleBall(layout, board.t).map((v, k) => v - board.ball_pos[k])) < 1e-9);
    for (let i = 1; i < layout.segments.length; i++) {
      const a = layout.segments[i - 1], b = layout.segments[i];
      assert.ok(Math.abs(a.t1 - b.t0) < 1e-9);
      assert.ok(Math.hypot(...L.transitionPoint(a, 1).map((v, k) => v - L.transitionPoint(b, 0)[k])) < 1e-9);
    }
  }
});

test('explicit sustain and glissando use slides even when q < 2', () => {
  const plan = makePlan(notes(3, 1));
  plan.landings[0].articulation = 'sustain';
  plan.landings[1].articulation = 'glissando';
  plan.landings[1].glissando_to_midi = 72;
  const layout = L.buildLayout(plan);
  assert.deepEqual(layout.channels.map(c => c.reason.trigger), ['sustain', 'glissando']);
  assert.equal(layout.audit.clearance_fails, 0);
});


test('slides coast through rests without waiting and leave with continuous velocity', () => {
  for (const rest of [0, .5, 2, 12.5]) {
    const plan = makePlan([
      { kind: 'note', dur: 2, midi: 60, n: 1 },
      ...(rest ? [{ kind: 'rest', dur: rest }] : []),
      { kind: 'note', dur: .5, midi: 62, n: 2 },
    ]);
    const layout = L.buildLayout(plan);
    const ride = layout.channels[0];
    const exit = layout.segments.find(s => s.reason?.leg === 'exit');
    assert.ok(!layout.segments.some(s => s.reason?.type === 'rail_stop'), 'no wait at the end of a slide');
    assert.ok(Math.abs(ride.t1 - exit.t0) < 1e-9);
    assert.equal(exit.t1, plan.landings[1].t);
    assert.equal(layout.audit.clearance_fails, 0);
    assert.equal(layout.audit.forced, 0);
    for (let i = 1; i <= 200; i++) {
      const before = L.transitionPoint(ride, (i - 1) / 200);
      const after = L.transitionPoint(ride, i / 200);
      assert.ok(Math.hypot(...after.map((v, k) => v - before[k])) > 1e-5, 'keeps moving on the slide');
    }
    // Position differences independently check the rendered velocity at the join.
    const dt = 1e-5, at = L.transitionPoint(ride, 1);
    const before = L.transitionPoint(ride, 1 - dt / (ride.t1 - ride.t0));
    const after = L.transitionPoint(exit, dt / (exit.t1 - exit.t0));
    const mismatch = Math.hypot(...at.map((v, k) => (v - before[k]) / dt - (after[k] - v) / dt));
    assert.ok(mismatch < 1e-3, `exit speed jump ${mismatch}, rest ${rest}`);
  }
});

test('the final slide slows to a stop only at the end of the song', () => {
  const layout = L.buildLayout(makePlan([{ kind: 'note', dur: 2, midi: 60, n: 1 }]));
  const ride = layout.channels[0];
  assert.ok(Math.hypot(...L.transitionVelocity(ride, .95)) > 0);
  assert.ok(Math.hypot(...L.transitionVelocity(ride, 1)) < 1e-9);
});
