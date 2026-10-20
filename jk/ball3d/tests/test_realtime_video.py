"""Cross-language motion parity on the real score and a short rest fixture."""
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import score


def compare_motion(plan, tmp_path):
    node = shutil.which('node')
    assert node, 'Node.js is required for realtime renderer tests'
    times = set(score.frame_times(plan['fps'], plan['duration']))
    for segment in plan['segments']:
        times.update((segment['t0'], segment['t1'], (segment['t0'] + segment['t1']) / 2))
    for rest in plan['rests']:
        times.update((rest['onset_sec'], rest['onset_sec'] + rest['dur_sec'] / 2,
                      rest['onset_sec'] + rest['dur_sec']))
    times.update(landing['t'] for landing in plan['landings'])
    probe = tmp_path / 'motion.json'
    probe.write_text(json.dumps({'plan': plan, 'times': sorted(times)}), encoding='utf8')
    script = '''
import fs from 'node:fs';
const {sampleBall,sampleTrack}=await import(process.argv[1]);
const {plan,times}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
console.log(JSON.stringify(times.map(t=>[sampleBall(plan,t),sampleTrack(plan,t)])));
'''
    proc = subprocess.run([node, '--input-type=module', '-e', script,
                           (ROOT / 'realtime/src/motion.mjs').as_uri(), str(probe)],
                          capture_output=True, text=True, check=True)
    samples = json.loads(proc.stdout)
    assert len(samples) == len(times)
    for t, (ball, track) in zip(sorted(times), samples):
        assert ball == score.sample_ball(plan, t), t
        assert track == score.sample_track(plan, t), t


def test_real_song_motion(tmp_path):
    path = Path(os.environ.get('JPK_FIXTURE', 'D:/Downloads/10_notes.json'))
    if not path.exists():
        pytest.skip('real song fixture not installed')
    compare_motion(score.build_plan(score.load_score(path)), tmp_path)


def test_leading_rest_octaves_and_tail(tmp_path):
    path = tmp_path / 'score.json'
    path.write_text(json.dumps({
        'format': 'jianpu2letter-notes-v1', 'key': '1=Eb', 'tempo_qpm': 97,
        'lines': [{'notes': [{'n': n, 'o': o, 'q': q} for n, o, q in
                            [(0, 0, 2), (1, -1, .25), (7, 1, .75),
                             (0, 0, 4), (3, 0, 2), (0, 0, 1)]]}]
    }), encoding='utf8')
    compare_motion(score.build_plan(score.load_score(path)), tmp_path)


def run_layout(plan, tmp_path):
    """Ask Node for the shared layout of ``plan`` and return the parsed result."""
    node = shutil.which('node')
    assert node, 'Node.js is required for realtime renderer tests'
    probe = tmp_path / 'plan.json'
    probe.write_text(json.dumps(plan), encoding='utf8')
    script = """
import fs from 'node:fs';
const L = await import(process.argv[1]);
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const layout = L.buildLayout(plan);
const keys = new Set(plan.rests.map(r => r.onset_sec));
const contacts = layout.boards.map(b => {
  const p = L.sampleBall(layout, b.t);
  return [b.index, b.t, Math.hypot(p[0]-b.ball_pos[0], p[1]-b.ball_pos[1], p[2]-b.ball_pos[2])];
});
const joints = layout.segments.slice(1).map((s, i) => {
  const a = L.transitionPoint(layout.segments[i], 1);
  const b = L.transitionPoint(s, 0);
  return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
});
const r = L.BALL_R;
const boxes = [layout.pad].concat(layout.boards).map(b => ({
  pos: b.pos, tilt: b.tilt || 0, index: b.index,
}));
let minD2 = Infinity, worst = null;
for (const seg of layout.segments) {
  for (let i = 0; i <= 60; i += 1) {
    const p = L.transitionPoint(seg, i/60);
    for (const plate of boxes) {
      if (Math.abs(plate.pos[1] - p[1]) > 3) continue;
      // the same tilted sphere/OBB datum the solver, the renderer and the
      // 2D preview share (plankPose -> centre + tilt)
      const d = L.plankDistance(plate, p);
      if (d * d < minD2) { minD2 = d * d; worst = [seg.kind, plate.index, i/60, d]; }
    }
  }
}
console.log(JSON.stringify({
  contacts, joints, minD2, worst, ballR: r,
  channels: layout.channels.map(s => s.reason),
  hopFallbacks: layout.segments.filter(s => s.kind === 'hop' && s.reason &&
    s.reason.fallback).length,
  restIsBoard: layout.boards.some(b => keys.has(b.t)),
  thresholds: layout.thresholds,
  groups: layout.groups.length,
  boards: layout.boards.length,
  audit: layout.audit,
  tilts: layout.boards.map(b => b.tilt || 0),
}));
"""
    return json.loads(subprocess.run(
        [node, '--input-type=module', '-e', script,
         (ROOT / 'realtime/src/layout.mjs').as_uri(), str(probe)],
        check=True, capture_output=True, text=True).stdout)


def test_music_machine_layout_contract(tmp_path):
    path = Path(os.environ.get('JPK_FIXTURE', 'D:/Downloads/10_notes.json'))
    if not path.exists():
        pytest.skip('real song fixture not installed')
    plan = score.build_plan(score.load_score(path))
    data = run_layout(plan, tmp_path)
    assert data['boards'] == len(plan['landings'])
    assert data['groups'] >= 1
    assert not data['restIsBoard'], 'a rest must never own a board'
    for index, t, error in data['contacts']:
        assert error == pytest.approx(0.0, abs=1e-9), (index, t, error)
    for half in data['joints']:
        assert half == pytest.approx(0.0, abs=1e-9)
    long_notes = [n for n in plan['landings'] if n['q'] >= 2]
    assert len(data['channels']) == len(long_notes) == 14
    for reason, note in zip(data['channels'], long_notes):
        assert reason['trigger'] == 'long_note'
        assert reason['note_start'] == note['t']
        assert reason['note_end'] == note['t'] + note['dur']
        assert 0 < reason['ride_sec'] <= note['dur'] + reason['rest_sec']
    assert data['audit']['slide_clearance_fails'] == 0
    audit = data['audit']
    # The narrow assembly (0.30 m plank, 0.10 m ball) places every transition of
    # the real song cleanly.  Nothing is forced, the solver reports no failure to
    # clear, and no two planks share space -- the previous 0.60 m/0.22 m geometry
    # could only answer this song with "the dense passage is unsupported", which
    # is why these are hard equalities rather than a tolerated minority.
    assert audit['forced'] == 0, audit['forced']
    assert audit['clearance_fails'] == 0, audit['clearance_fail_list']
    assert audit['clearance_fail_deep'] == 0
    assert audit['plank_overlaps'] == 0, audit['plank_overlap_list']
    assert audit['min_clearance'] >= data['ballR'] - 1e-6, audit['min_clearance']
    # the independent whole-path sphere/OBB scan agrees with the solver's audit:
    # the ball never comes within its own radius of a plank it is not landing on
    assert data['minD2'] >= data['ballR'] ** 2 - 1e-9, data['worst']
    # the rotation is real: some plank must be visibly tilted, not yaw-only
    assert max(abs(t) for t in data['tilts']) > 0.15, max(data['tilts'])
    # Non-penetration is not the whole requirement: the narrow planks must also
    # *read* as separate planks.  The audit carries the picture-plane gap of the
    # drawn outlines (15% of the plank width is the guide) and lists every pair
    # below it, so a future change cannot quietly fuse two planks into one.
    assert audit['plank_gap_guide'] == pytest.approx(0.15 * 0.30, abs=1e-9)
    assert audit['plank_gap_min'] > 0, audit['plank_gap_min']
    for pair in audit['plank_gap_list']:
        assert pair['gap'] < audit['plank_gap_guide'] + 1e-9, pair
    # Pairs below *half* the guide (a seam under 0.02 m, i.e. ~2 px) are the
    # fusion limit.  Measured on this song: three, all the turnaround of the
    # 0.231 s run against the side of the frame, where a 0.231 s interval cannot
    # fall further than free fall (~0.17 m < 0.30 m plank width) and both planks
    # must sit near the 0.95 rad tilt cap to reverse the ball.  A shallow pair
    # there would be a real, fixable failure, so the shape is asserted too.
    tight = [p for p in audit['plank_gap_list']
             if p['gap'] < 0.5 * audit['plank_gap_guide']]
    assert len(tight) == audit['plank_gap_fails'] <= 4, audit['plank_gap_list']
    for pair in tight:
        assert abs(pair['tilt_a']) >= 0.45 and abs(pair['tilt_b']) >= 0.45, pair
    # no flight may change gravity or turn in the air, and a plane must not
    # change between frames: the motion probe above already checks sampling
    assert audit['clearance_scan'] >= 8


def test_supported_spacing_never_touches_a_plank(tmp_path):
    """The supported envelope of this assembly now reaches 0.25 s onsets (the
    real song's densest run is 0.231 s).  Nowhere on the path may the ball come
    within its own radius of a plank it is not landing on -- tilted OBB datum,
    the same one the solver, the renderer and the 2D preview use."""
    for spec in ([{'n': 1, 'o': 0, 'q': 0.5}] * 8,
                 [{'n': 3, 'o': 0, 'q': 1.0}, {'n': 0, 'o': 0, 'q': 0.5},
                  {'n': 5, 'o': 0, 'q': 0.5}, {'n': 2, 'o': 0, 'q': 1.0}],
                 [{'n': 7, 'o': 0, 'q': 0.6}] * 6,
                 [{'n': 1, 'o': 0, 'q': 0.45}] * 10,
                 [{'n': 2, 'o': 0, 'q': 0.3}] * 10,
                 [{'n': 1, 'o': 0, 'q': 0.25}] * 12,
                 [{'n': 5, 'o': 0, 'q': 0.25}, {'n': 1, 'o': 1, 'q': 0.25},
                  {'n': 3, 'o': -1, 'q': 0.25}] * 4):
        path = tmp_path / 'score.json'
        path.write_text(json.dumps({
            'format': 'jianpu2letter-notes-v1', 'key': '1=C', 'tempo_qpm': 60,
            'lines': [{'notes': spec}],
        }), encoding='utf8')
        plan = score.build_plan(score.load_score(str(path)))
        data = run_layout(plan, tmp_path)
        assert data['audit']['clearance_fails'] == 0, (spec[0]['q'], data['audit'])
        assert data['audit']['plank_overlaps'] == 0
        assert data['minD2'] >= data['ballR'] ** 2 - 1e-9, data['worst']


def test_layout_differs_between_songs(tmp_path):
    def score_of(notes):
        return {
            'format': 'jianpu2letter-notes-v1', 'key': '1=C', 'tempo_qpm': 60,
            'lines': [{'notes': [{'n': n, 'o': 0, 'q': q} for n, q in notes]}],
        }

    fast = score_of([(1, .25)] * 20)
    slow = score_of([(1, 2.0), (0, 2.0), (2, 2.0), (0, 2.0), (3, 2.0), (0, 2.0)])
    fast_file = tmp_path / 'fast.json'
    fast_file.write_text(json.dumps(fast), encoding='utf8')
    slow_file = tmp_path / 'slow.json'
    slow_file.write_text(json.dumps(slow), encoding='utf8')
    a = run_layout(score.build_plan(score.load_score(str(fast_file))), tmp_path)
    b = run_layout(score.build_plan(score.load_score(str(slow_file))), tmp_path)
    assert a['groups'] != b['groups'] or a['boards'] != b['boards']
    assert a['audit']['chutes'] == 0
    assert b['audit']['chutes'] == 3
    assert b['audit']['clearance_fails'] == 0
