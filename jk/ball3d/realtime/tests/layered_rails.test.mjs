import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as kit from '../src/layout.mjs';
import {buildGravityLayout,sampleBall,transitionPoint,transitionVelocity} from '../src/gravity_layout.mjs';

const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const plan=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_accents.json',import.meta.url)));
const course=buildGravityLayout(plan,kit,config);
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));

test('long-gap rails stay sparse while wide jumps can receive additional support',()=>{
  assert.equal(course.boards.length,164);
  assert.ok(course.channels.length>=2);
  assert.ok(course.channels.filter(s=>!s.reason.wide).length<=3);
  assert.ok(course.channels.filter(s=>s.reason.wide).length<=3);
  const intervals=plan.landings.slice(1).map((n,i)=>n.t-plan.landings[i].t).sort((a,b)=>a-b);
  const middle=(intervals.length-1)/2,median=(intervals[Math.floor(middle)]+intervals[Math.ceil(middle)])/2;
  assert.equal(course.audit.tracks.delta0,median);
  assert.equal(course.audit.tracks.gap_threshold,Math.max(1,3.5*median));
  assert.equal(course.audit.tracks.gap,course.channels.length);
  assert.equal(course.audit.chutes,course.channels.length);
  assert.equal(course.audit.spatial.rails.length,course.channels.length);
  assert.equal(course.segments.filter(s=>s.kind==='ride').length,course.channels.length+course.channels.filter(s=>s.decelerating).length);
  assert.equal(course.audit.flights,course.segments.filter(s=>s.kind==='flight').length);
  assert.equal(course.audit.clearance_fails,0);
  const width=course.audit.spatial.board_width;
  for(const [i,s] of course.channels.entries()) {
    assert.ok(s.reason.wide?s.reason.gap>=1:s.reason.gap>=course.audit.tracks.gap_threshold);
    assert.ok(s.arcLength<=4*width);
    assert.ok(Math.abs(distance(s.p0,s.p1)-s.arcLength)<1e-10);
    if(i)assert.ok(s.reason.wide?s.visibleFrom>=course.channels[i-1].visibleUntil+.5:
      s.visibleFrom-course.channels[i-1].visibleFrom>=8);
  }
  assert.equal(course.audit.tracks.longest_widths,Math.max(...course.channels.map(s=>s.arcLength/width)));
});

test('layered rails preserve heights and special passages, with only audited horizontal room for deceleration',()=>{
  const disabled=structuredClone(config);disabled.spatial.maxRails=0;
  const ordinary=buildGravityLayout(plan,kit,disabled);
  assert.equal(ordinary.channels.length,0);assert.equal(ordinary.audit.chutes,0);assert.equal(ordinary.audit.tracks.gap,0);
  const shiftAt=index=>course.channels.filter(s=>s.reason.note_index<index).reduce((sum,s)=>sum+(s.layoutShiftX||0),0);
  for(const b of course.boards)assert.ok(distance(b.p,ordinary.boards[b.i].p.map((x,k)=>x+(k===0?shiftAt(b.i):0)))<1e-9);
  assert.deepEqual(course.boards.map(b=>b.top_y),ordinary.boards.map(b=>b.top_y));
  assert.deepEqual(course.groups,ordinary.groups);
  assert.deepEqual(course.route.map(s=>s.t),ordinary.route.map(s=>s.t));
  const fields=b=>[b.group,b.layer_group,b.level_group,b.level_repeat,b.rebound_pair];
  assert.deepEqual(course.boards.map(fields),ordinary.boards.map(fields));
  assert.deepEqual(course.audit.spatial.phrasing.level_groups,ordinary.audit.spatial.phrasing.level_groups);
  assert.deepEqual(course.audit.spatial.phrasing.rebound_pairs,ordinary.audit.spatial.phrasing.rebound_pairs);
  const endpoints=new Set(course.channels.flatMap(s=>[s.reason.note_index,s.reason.note_index+1]));
  for(const b of course.boards)if(!endpoints.has(b.i)) {
    const expected=structuredClone(ordinary.boards[b.i]);
    for(const key of ['p','ball_pos','pos','pivot','contact']) {
      const translated=expected[key].map((x,k)=>x+(k===0?shiftAt(b.i):0));
      assert.ok(distance(b[key],translated)<1e-10,`board ${b.i} ${key}: only the audited horizontal translation`);
      expected[key]=b[key];
    }
    assert.deepEqual(b,expected,`unrelated board ${b.i} only follows the audited horizontal translation`);
  }
});

test('rail joins retain passive capture and continuous departure with deterministic seeking',()=>{
  const times=[];
  for(const s of course.channels) {
    const before=course.segments.find(p=>p.t1===s.t0),after=course.segments.find(p=>p.t0===s.t1);
    assert.equal(before.kind,'flight');assert.equal(after.kind,s.decelerating?'ride':'flight');
    assert.ok(distance(transitionPoint(before,1),transitionPoint(s,0))<1e-9);
    assert.ok(distance(transitionPoint(s,1),transitionPoint(after,0))<1e-9);
    const entering=transitionVelocity(before,1),rollingIn=transitionVelocity(s,0);
    const leaving=transitionVelocity(after,0),rollingOut=transitionVelocity(s,1);
    if(s.decelerating) {
      const tangent=s.tangent,projection=entering.reduce((sum,x,k)=>sum+x*tangent[k],0);
      assert.ok(distance(rollingIn,tangent.map(x=>x*projection))<1e-9,'the catch preserves tangent speed');
      assert.ok(Math.hypot(...rollingIn)<Math.hypot(...entering),'the catch removes normal energy');
      assert.ok(after.edge);
      const exit=course.segments.find(p=>p.t0===after.t1);
      assert.equal(exit.kind,'flight');
      assert.ok(distance(transitionPoint(after,1),transitionPoint(exit,0))<1e-9);
      assert.ok(distance(transitionVelocity(after,1),transitionVelocity(exit,0))<1e-9,'natural endcap release retains velocity');
      assert.equal(before.g,config.physics.gravity);assert.equal(exit.g,config.physics.gravity);
      assert.ok(distance(leaving,rollingOut)<1e-9);
    } else {
      for(const k of [0,2]) {
        assert.ok(Math.abs(entering[k]-rollingIn[k])<1e-9);
        assert.ok(Math.abs(leaving[k]-rollingOut[k])<1e-9);
      }
    }
    for(const t of [s.visibleFrom,s.t0,(s.t0+s.t1)/2,s.t1,s.visibleUntil])times.push(t);
  }
  const samples=new Map(times.map(t=>[t,sampleBall(course,t)]));
  for(const t of [...times].reverse())assert.deepEqual(sampleBall(course,t),samples.get(t));
  for(const t of times)assert.deepEqual(sampleBall(course,t),samples.get(t));
});

test('long durations and pitch bends cannot create layered rails between dense note onsets',()=>{
  const dense={duration:16,tempo_qpm:120,landings:Array.from({length:48},(_,i)=>({
    t:1+i*.25,midi:60+i%7,n:1+i%7,dur:4,articulation:'glissando',
    pitch_bend:[{time_sec:0,semitones:0},{time_sec:3,semitones:4}]}))};
  const result=buildGravityLayout(dense,kit,config);
  assert.equal(result.channels.length,0);assert.equal(result.audit.tracks.gap,0);
  assert.equal(result.audit.tracks.delta0,.25);assert.equal(result.audit.tracks.gap_threshold,1);
});

test('the wide 祖 to 先 jump has a rail without moving the note onsets',()=>{
  const a=course.boards[50],b=course.boards[51];
  assert.equal(a.lyric,'祖');assert.equal(b.lyric,'先');
  const rail=course.channels.find(s=>s.reason.note_index===50);
  assert.ok(rail,'a wide one-second crossing needs support below the ordinary long-gap threshold');
  assert.ok(rail.decelerating);
  assert.ok(rail.entrySpeed>rail.exitSpeed&&rail.exitSpeed>0);
  assert.ok(rail.t0>a.t&&rail.t1<b.t);
  assert.deepEqual(course.boards.map(b=>b.t),plan.landings.map(n=>n.t));
  assert.ok(distance(sampleBall(course,a.t),a.p)<1e-9);
  assert.ok(distance(sampleBall(course,b.t),b.p)<1e-9);
  assert.equal(course.audit.clearance_fails,0);
});

test('the reported long 都 tail uses a passive slide with real gravity and still lands on the 是 onset',()=>{
  const song=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_stall_335.json',import.meta.url)));
  const solved=buildGravityLayout(song,kit,config),rail=solved.channels.find(s=>s.reason.note_index===40);
  assert.ok(rail?.decelerating,'the reported slow fall must actually use the physical slide');
  const a=solved.boards[40],b=solved.boards[41];
  assert.equal(a.lyric,'都');assert.equal(b.lyric,'是');
  const passage=solved.segments.filter(s=>s.t0>=a.t&&s.t1<=b.t);
  assert.equal(passage.length,4);assert.equal(passage[2].edge,true);
  assert.equal(passage[0].g,9.81);assert.equal(passage[3].g,9.81);
  assert.ok(rail.entrySpeed>rail.exitSpeed&&rail.exitSpeed>0);
  assert.ok(Math.abs(rail.layoutShiftX)<=.8);
  assert.equal(passage[0].t0,song.landings[40].t);
  assert.equal(passage[3].t1,song.landings[41].t);
  assert.ok(distance(sampleBall(solved,b.t),b.p)<1e-9);
});
