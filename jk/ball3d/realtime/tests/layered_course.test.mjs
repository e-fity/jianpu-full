import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Vector3,Quaternion} from 'three';
import * as kit from '../src/layout.mjs';
import {buildGravityLayout,sampleBall,transitionPoint,transitionVelocity} from '../src/gravity_layout.mjs';
import {boardPose} from '../src/spatial_course.mjs';
import {wallSwing} from '../src/wall_course.mjs';

const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
const score=(count=24,start=1)=>({duration:start+count*.5+1,tempo_qpm:120,
  landings:Array.from({length:count},(_,i)=>({t:start+i*.5,n:1+i%7,midi:60+i%12,dur:.5}))});

function assertBoardPhysics(course,settings=config) {
  for(const b of course.boards) {
    const limit=Math.min(b.rebound_pair!=null?35:25,settings.boards.maxTilt)*Math.PI/180;
    const label=`board ${b.i}`,q=new Quaternion(...b.quaternion);
    const normal=new Vector3(0,1,0).applyQuaternion(q);
    assert.ok(normal.y>=Math.cos(limit)-1e-10,`${label}: the real face stays inside the upward normal cone`);
    assert.ok(Math.abs(normal.z)<1e-10,`${label}: tilt has no wall-depth component`);
    assert.ok(distance(new Vector3(0,0,1).applyQuaternion(q).toArray(),[0,0,1])<1e-10,`${label}: long axis remains perpendicular to the wall`);
    assert.deepEqual(b.tilt_axis,[0,0,1]);
    const before=course.segments.find(s=>Math.abs(s.t1-b.t)<1e-8),after=course.segments.find(s=>Math.abs(s.t0-b.t)<1e-8);
    const vin=new Vector3(...(before?transitionVelocity(before,1):[0,0,0]));
    const vout=new Vector3(...(after?transitionVelocity(after,0):[0,0,0]));
    assert.ok(distance(vin.toArray(),b.collision.v_in)<1e-10,`${label}: incoming velocity comes from the actual flight`);
    assert.ok(distance(vout.toArray(),b.collision.v_out)<1e-10,`${label}: outgoing velocity comes from the actual flight`);
    const impulse=vout.clone().sub(vin);
    assert.ok(distance(normal.toArray(),impulse.normalize().toArray())<1e-9,`${label}: real face normal supplies the flight impulse`);
    assert.ok(distance(normal.toArray(),b.collision.normal)<1e-9,`${label}: reported normal agrees with the mesh pose`);
    assert.ok(vin.dot(normal)<=1e-9&&vout.dot(normal)>=-1e-9,`${label}: the ball approaches and leaves the top face`);
    const tangent=v=>v.clone().addScaledVector(normal,-v.dot(normal));
    assert.ok(tangent(vin).distanceTo(tangent(vout))<1e-9,`${label}: collision preserves tangential velocity`);
    const contact=new Vector3(...b.p).addScaledVector(normal,-kit.BALL_R);
    const local=contact.clone().sub(new Vector3(...b.pos)).applyQuaternion(q.clone().invert());
    assert.ok(distance(contact.toArray(),b.contact)<1e-10,`${label}: contact is one ball radius below its centre`);
    assert.ok(Math.abs(local.y-b.size[1]/2)<1e-9,`${label}: contact lies on the actual top face`);
    assert.ok(b.size[0]/2-Math.abs(local.x)>=.12*b.size[0]-1e-9,`${label}: contact clears the side edges`);
    assert.ok(b.size[2]/2-Math.abs(local.z)>=.12*b.size[0]-1e-9,`${label}: contact clears the front and rear edges`);
    if(b.level_group!=null) {
      assert.ok(normal.distanceTo(new Vector3(0,1,0))<1e-10,`${label}: level passages have truly flat boards`);
      assert.ok(Math.abs(vin.x-vout.x)<1e-10,`${label}: level entry and exit share horizontal speed`);
    }
    if(b.ordinary_flat) {
      assert.equal(b.rebound_pair,null,`${label}: ordinary flat boards are separate from opposed faces`);
      assert.equal(b.turn,false,`${label}: only declared turns can steer an ordinary descent`);
      assert.ok(normal.distanceTo(new Vector3(0,1,0))<1e-10,`${label}: ordinary descending faces are horizontal`);
      assert.ok(Math.abs(vin.x-vout.x)<1e-10,`${label}: a flat descending face preserves horizontal speed`);
      assert.ok(b.hits.every(h=>h.amplitude===0),`${label}: ordinary flat boards stay horizontal during impact`);
    }
    assert.ok(Math.acos(Math.min(1,normal.y))+b.hits.reduce((sum,h)=>sum+Math.abs(h.amplitude),0)<=limit+1e-10,`${label}: response envelope respects the tilt budget`);
    for(const age of [0,.025,.05,.1,.2,.5,1]) {
      const pose=boardPose(b,b.size[1],wallSwing(b.t+age,b,settings.boards));
      const animatedNormal=new Vector3(0,1,0).applyQuaternion(pose.quaternion);
      assert.ok(animatedNormal.y>=Math.cos(limit)-1e-10,`${label} at ${age}s: impact response keeps the face upward`);
      assert.ok(Math.abs(animatedNormal.z)<1e-10,`${label} at ${age}s: response has no depth tilt`);
      assert.ok(distance(new Vector3(0,0,1).applyQuaternion(pose.quaternion).toArray(),[0,0,1])<1e-10,`${label} at ${age}s: response preserves the long axis`);
      assert.ok(distance(pose.pivot.toArray(),b.pivot)<1e-10,`${label}: the wall pivot remains fixed`);
    }
  }
  for(const [a,b] of course.audit.spatial.phrasing.rebound_pairs) {
    assert.equal(b,a+1,'opposed boards form a consecutive pair');
    const first=course.boards[a],second=course.boards[b],dx=second.p[0]-first.p[0];
    assert.equal(first.rebound_pair,a);assert.equal(second.rebound_pair,a);
    assert.equal(first.layer_group,second.layer_group,'opposed boards remain inside one phrase');
    const na=new Vector3(0,1,0).applyQuaternion(new Quaternion(...first.quaternion));
    const nb=new Vector3(0,1,0).applyQuaternion(new Quaternion(...second.quaternion));
    assert.ok(na.x*dx>0&&nb.x*dx<0,'the two real faces incline towards each other');
    assert.equal(first.fast_rebound,second.fast_rebound);
    const target=Math.min(35,settings.boards.maxTilt)*Math.PI/180;
    for(const normal of [na,nb])assert.ok(Math.acos(normal.y)>0&&Math.acos(normal.y)<=target+1e-8,
      'opposed tilt follows the compact real route within the rhythm-specific limit');
    const width=course.audit.spatial.board_width;
    for(const edge of [a,b])assert.ok(Math.abs(course.boards[edge+1].p[0]-course.boards[edge].p[0])<=5*width+1e-9,
      'the opposed crossing and its receiving descent stay within five board widths');
  }
}

function assertCourse(course,plan,settings=config) {
  assert.equal(course.audit.spatial.mode,'wall-phrase-layers');
  assert.equal(course.boards.length,plan.landings.length);
  assert.equal(course.audit.forced,0);
  assert.equal(course.audit.clearance_fails,0);
  assert.equal(course.audit.plank_overlaps,0);
  assert.ok(course.audit.min_contact_spacing>=course.audit.required_contact_spacing);
  const phrasing=course.audit.spatial.phrasing,groups=phrasing.phrase_groups,covered=[];
  const ordinary=course.boards.filter(b=>b.rebound_pair==null&&b.level_group==null&&!b.rail_connector);
  assert.ok(ordinary.filter(b=>b.ordinary_flat).length>=.6*ordinary.length,
    'most ordinary descending boards are truly horizontal rather than steering faces');
  assert.ok(phrasing.level_steps<=.2*Math.max(0,plan.landings.length-1),'level jumps are occasional');
  assert.ok(phrasing.descending_steps>=.8*Math.max(0,plan.landings.length-1),'descending jumps dominate');
  assert.equal(phrasing.level_steps+phrasing.descending_steps,Math.max(0,plan.landings.length-1));
  assert.ok(phrasing.level_groups.length>0,'long real songs retain a few level passages');
  assert.ok(phrasing.rebound_pairs.length>0,'long real songs retain occasional opposed rebounds');
  for(const [i,g] of groups.entries()) {
    const row=course.boards.slice(g.start,g.end+1);
    assert.ok(row.length>=4&&row.length<=8,`group ${i}: ${row.length} boards`);
    if(i)assert.ok(g.top_y_start<groups[i-1].top_y_end,'the next phrase continues descending');
    if(g.level)assert.ok(row.length<=6,'occasional level passages stay short');
    for(const b of row) {
      covered.push(b.note_index);
      assert.equal(b.layer_group,i);
      if(g.level)assert.equal(b.top_y,g.top_y_start,'only selected passages share one height');
      else if(b.i>g.start)assert.ok(b.top_y<course.boards[b.i-1].top_y,'ordinary boards continue falling');
      const normal=new Vector3(0,1,0).applyQuaternion(new Quaternion(...b.quaternion));
      const actualTop=b.pos[1]+b.size[1]/2*normal.y;
      assert.ok(Math.abs(actualTop-b.top_y)<1e-10,`board ${b.i}: actual top ${actualTop} vs target ${b.top_y}`);
      const impulse=new Vector3(...b.collision.v_out).sub(new Vector3(...b.collision.v_in));
      assert.ok(impulse.cross(new Vector3(...b.collision.normal)).length()<1e-9,'real board tilt supplies the direction change');
    }
    for(let k=1;k<row.length;k++) {
      const previous=row[k-1],opposed=phrasing.rebound_pairs.some(([a,b])=>a===previous.i&&b===row[k].i);
      assert.ok((opposed?-1:1)*g.direction*(row[k].p[0]-previous.p[0])>0,'travel follows the phrase except for the audited short rebound');
    }
  }
  assert.deepEqual(covered,plan.landings.map((_,i)=>i),'every note occurs in one group without gaps or duplicates');
  const width=course.audit.spatial.board_width;
  for(let i=0;i<course.boards.length;i++)for(let j=0;j<i;j++)
    assert.ok(distance(course.boards[i].pos,course.boards[j].pos)>=2*width-1e-10,'all 3D plank centres retain two widths of spacing');
  const diameter=course.audit.spatial.diameter;
  for(const s of course.segments.filter(s=>s.kind==='flight')) {
    const dt=s.t1-s.t0,apex=Math.max(s.p0[1],s.p1[1])+.7*diameter;
    if(s.reason?.decelerating) {
      assert.equal(s.g,settings.physics.gravity,'long-gap slide flights retain the configured gravity');
      const peak=Math.max(0,Math.min(dt,s.v0[1]/s.g));
      assert.ok(Math.abs(transitionPoint(s,peak/dt)[1]-s.apex)<1e-9,'physical apex matches the actual flight');
    } else {
      const g=2*(Math.sqrt(apex-s.p0[1])+Math.sqrt(apex-s.p1[1]))**2/dt**2;
      assert.ok(Math.abs(s.g-g)<1e-9);
      assert.ok(Math.abs(s.v0[1]-Math.sqrt(2*g*(apex-s.p0[1])))<1e-9);
      const peakTime=s.v0[1]/s.g;
      assert.ok(peakTime>=0&&peakTime<=dt);
      assert.ok(Math.abs(transitionPoint(s,peakTime/dt)[1]-apex)<1e-9,'no extra height beyond the 0.7D apex');
    }
    assert.ok(distance(transitionPoint(s,1),s.p1)<1e-9);
    const first=transitionVelocity(s,0),last=transitionVelocity(s,1);
    assert.equal(first[0],last[0]);assert.equal(first[2],last[2]);
  }
  for(const b of course.boards.slice().reverse())
    assert.ok(distance(sampleBall(course,b.t),b.p)<1e-9,'reverse seeking still reaches each note contact');
  assertBoardPhysics(course,settings);
}

for(const [name,count] of [['wall_accents',164],['wall_search',215],['wall_stall_335',335]]) {
  test(`${count}-note real score descends with occasional short level passages`,()=>{
    const plan=JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url))),before=structuredClone(plan);
    const course=buildGravityLayout(plan,kit,config);
    assert.equal(course.boards.length,count);
    assertCourse(course,plan);
    assert.deepEqual(plan,before,'phrase placement does not rewrite the score');
  });
}

test('layered courses remain seeded and progress reporting does not alter geometry',()=>{
  const plan=score(),before=structuredClone(plan),updates=[];
  const course=buildGravityLayout(plan,kit,config);
  assert.deepEqual(buildGravityLayout(plan,kit,config,p=>updates.push(p)),course);
  assert.deepEqual(buildGravityLayout(plan,kit,config),course);
  assert.deepEqual(plan,before);
  const different=structuredClone(config);different.spatial.seed++;
  assert.notDeepEqual(buildGravityLayout(plan,kit,different).boards.map(b=>b.pos),course.boards.map(b=>b.pos));
  assert.ok(updates.some(p=>p.stage==='排列木板'));
  assert.ok(updates.some(p=>p.stage==='检查球路'));
  for(const p of updates)assert.ok(p.percent>=0&&p.percent<100);
});

test('a long phrase gap slows the crossing instead of stretching the next group away',()=>{
  const plan=score(24,.8);
  plan.landings.forEach((n,i)=>Object.assign(n,{t:.8+i*.366+(i>=12?.734:0),dur:.366,lyric:'字'}));
  plan.duration=plan.landings.at(-1).t+1;
  const before=structuredClone(plan),settings=structuredClone(config);
  settings.spatial.maxRails=0;
  const course=buildGravityLayout(plan,kit,settings),a=course.boards[11],b=course.boards[12];
  const width=course.audit.spatial.board_width;
  assert.equal(b.layer_group,a.layer_group+1,'the long gap connects two distinct phrases');
  assert.ok(Math.abs(b.p[0]-a.p[0])<=4*width,'the long gap does not inherit the preceding fast horizontal speed');
  assert.ok(distance(a.p,b.p)<=7*width,'the phrase transition stays compact in both directions');
  assert.equal(course.audit.clearance_fails,0);
  assert.equal(course.audit.plank_overlaps,0);
  assert.deepEqual(plan,before,'spacing changes preserve the score and note times');
  for(const board of course.boards)assert.ok(distance(sampleBall(course,board.t),board.p)<1e-9);
  assertBoardPhysics(course,settings);
});

test('real courses keep their physical constraints with seeds 0, 1 and 2026',()=>{
  for(const name of ['wall_accents','wall_search','wall_stall_335']) {
    const plan=JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url)));
    for(const seed of [0,1,2026]) {
      const settings=structuredClone(config);settings.spatial.seed=seed;
      const course=buildGravityLayout(plan,kit,settings);
      assertCourse(course,plan,settings);
      assert.deepEqual(buildGravityLayout(plan,kit,settings),course,`${name}, seed ${seed}: seeking or repeated generation cannot alter the layout`);
    }
  }
});

test('unequal note intervals retain flat level faces with one entry-to-exit speed',()=>{
  const plan=score(120);let t=1;
  for(const [i,n] of plan.landings.entries()) {
    n.t=t;n.midi=60;t+=[.4,.6,.8][i%3];
  }
  plan.duration=t+1;
  const course=buildGravityLayout(plan,kit,config);
  assertCourse(course,plan);
  assert.ok(course.audit.spatial.phrasing.level_groups.some(g=>{
    const intervals=plan.landings.slice(g.start,g.end+1).slice(1).map((n,i)=>n.t-plan.landings[g.start+i].t);
    return Math.max(...intervals)-Math.min(...intervals)>.1;
  }),'the flat-face check includes genuinely unequal timing');
});

test('empty, single-note and zero-onset layered inputs remain finite and seekable',()=>{
  for(const plan of [{duration:0,landings:[]},{duration:2},score(1),score(1,0),score(8,0)]) {
    const course=buildGravityLayout(plan,kit,config);
    assert.equal(course.boards.length,plan.landings?.length??0);
    for(const t of [-1,0,.1,1,plan.duration,100])assert.ok(sampleBall(course,t).every(Number.isFinite));
    for(const b of course.boards)assert.ok(distance(sampleBall(course,b.t),b.p)<1e-9);
    assert.ok(course.segments.every(s=>s.t1>s.t0),'zero-onset inputs never create zero-duration flights');
  }
});

test('unequal fast timing keeps four rebounds and their flat receiving descent compact',()=>{
  const plan=score(25,.8);
  plan.landings.forEach((n,i)=>Object.assign(n,{t:.8+i*.3-(i>19?.175:0),dur:.3,lyric:'字'}));
  plan.duration=plan.landings.at(-1).t+1;
  const settings=structuredClone(config);settings.spatial.seed=1515;settings.spatial.maxRails=0;
  const course=buildGravityLayout(plan,kit,settings);
  const group=course.audit.spatial.phrasing.phrase_groups.find(g=>g.rebound_starts.length===2);
  assert.ok(group?.fast_rebound,'unequal fast intervals keep their short opposed burst');
  assert.deepEqual(group.rebound_starts,[19,21]);
  assert.equal(course.audit.clearance_fails,0);
  assert.ok(course.boards[23].ordinary_flat,'the first receiver after the four-board burst is horizontal');
  assertBoardPhysics(course,settings);
  for(let i=18;i<=22;i++) {
    const intended=(i===19||i===21)?-group.direction:group.direction;
    assert.ok(intended*(course.boards[i+1].p[0]-course.boards[i].p[0])>0,'all five flights retain the intended alternating direction');
  }
});

test('six consecutive rebound boards retain opposing real faces and exact note contacts',()=>{
  const plan=score(96,.8);let onset=.8;
  for(const [i,n] of plan.landings.entries()) {
    n.t=onset;n.lyric=i%8===7?'字，':'字';
    n.dur=[.2,.2,.2,.2,.4,.4,.4,.8][i%8];onset+=n.dur;
  }
  plan.duration=onset+1;
  const before=structuredClone(plan),settings=structuredClone(config);
  settings.spatial.maxRails=0;
  const course=buildGravityLayout(plan,kit,settings);
  const bursts=course.audit.spatial.phrasing.phrase_groups.filter(g=>g.rebound_starts.length===3);
  assert.ok(bursts.length>0);
  assert.equal(course.audit.forced,0);
  assert.equal(course.audit.clearance_fails,0);
  assert.equal(course.audit.plank_overlaps,0);
  for(const g of bursts) {
    const pairs=course.boards.slice(g.rebound_starts[0],g.rebound_starts.at(-1)+2);
    assert.equal(pairs.length,6);
    assert.ok(pairs.every(b=>b.rebound_pair!=null&&b.fast_rebound));
  }
  for(const board of course.boards)assert.ok(distance(sampleBall(course,board.t),board.p)<1e-9);
  assert.deepEqual(plan,before);
  assertBoardPhysics(course,settings);
});

test('the reported 50.99 second exit retains nearby horizontal receiving boards',()=>{
  const plan=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_stall_335.json',import.meta.url)));
  const course=buildGravityLayout(plan,kit,config),width=course.audit.spatial.board_width;
  assert.equal(course.boards[85].lyric,'光');
  assert.ok(course.boards[85].ordinary_flat,'the first ordinary receiving board is horizontal');
  assert.ok(course.boards[86].turn,'the following phrase corner may steer the ball');
  for(let i=81;i<=85;i++)assert.ok(Math.abs(course.boards[i+1].p[0]-course.boards[i].p[0])<=5*width+1e-9,
    `edge ${i}: the active rebound chain and both receiving steps stay nearby`);
  assertBoardPhysics(course);
});
