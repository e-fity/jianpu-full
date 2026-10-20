import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vector3, Quaternion, PerspectiveCamera } from 'three';
import * as kit from '../src/layout.mjs';
import { buildGravityLayout, sampleBall, transitionPoint, transitionVelocity, courseKey } from '../src/gravity_layout.mjs';
import { referencePlankSize, NOTE_LIGHTS, notePulse, wallSwing } from '../src/wall_course.mjs';
import { boardPose } from '../src/spatial_course.mjs';
const C=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
C.spatial.layeredPhrases=false; // Keep the earlier wall layout covered separately.
const plan={duration:25,tempo_qpm:100,landings:Array.from({length:42},(_,i)=>({t:1+i*.5,midi:60+i%12,n:1+i%7,dur:.5}))};
const layout=buildGravityLayout(plan,kit,C);
const accentPlan=JSON.parse(fs.readFileSync(new URL('./fixtures/wall_accents.json',import.meta.url)));
const accents=buildGravityLayout(accentPlan,kit,C);
test('nonrepeated pitches descend, without camera-dependent fake falling',()=>{
  assert.equal(layout.format,'ball3d-wall-v1');
  for(let i=1;i<layout.contacts.length;i++)assert.ok(layout.contacts[i].p[1]<layout.contacts[i-1].p[1]);
  assert.ok(new Set(layout.contacts.map(n=>n.p[2].toFixed(4))).size>20);
  assert.equal(layout.audit.forced,0);assert.equal(layout.audit.clearance_fails,0);assert.equal(layout.audit.plank_overlaps,0);
  assert.ok(layout.audit.min_contact_spacing>=layout.audit.required_contact_spacing);
  assert.deepEqual(buildGravityLayout(plan,kit,C),layout);
});

test('rhythmic groups stay on one side with local reversals and occasional level repeated notes',()=>{
  const repeated={duration:25,tempo_qpm:100,landings:Array.from({length:42},(_,i)=>
    ({t:1+i*.5,midi:60+Math.floor(i/3)%5,n:1+Math.floor(i/3)%5,dur:.5}))};
  const course=buildGravityLayout(repeated,kit,C),boards=course.boards;
  const groups=new Map();let level=0,localOpposite=0;
  for(const [i,b] of boards.entries()) {
    assert.ok(b.p[0]===0||b.p[0]*b.phrase_side>0,'ordinary slabs stay on their planned side');
    if(!groups.has(b.phrase))groups.set(b.phrase,[]);groups.get(b.phrase).push(b);
    if(!i)continue;
    const prev=boards[i-1];
    if(b.level_repeat) {
      level++;assert.equal(b.midi,prev.midi);assert.equal(b.p[1],prev.p[1]);
      assert.equal(b.top_y,prev.top_y,'the entire resting surface is at exactly the same height');
      assert.deepEqual(b.size,prev.size,'level slabs use identical proportions and depth');
      assert.ok(Math.abs(b.pos[2]-prev.pos[2])<1e-8,'perspective cannot turn the group into a depth staircase');
      const camera=new PerspectiveCamera(C.camera.fov,9/16,.1,1000),cy=(b.pos[1]+prev.pos[1])/2;
      camera.position.set(.12,cy+4,8);camera.lookAt(0,cy,0);camera.updateMatrixWorld();
      const top=board=>new Vector3(0,board.size[1]/2,0).applyQuaternion(new Quaternion(...board.quaternion))
        .add(new Vector3(...board.pos)).project(camera);
      assert.ok(Math.abs(top(b).y-top(prev).y)*640<8,'paired top centres visibly align within 8 pixels at 720x1280');
      assert.equal(b.level_group,prev.level_group,'flat hops belong to a reserved passage');
    } else assert.ok(b.p[1]<prev.p[1]);
    if(b.phrase===prev.phrase&&b.collision.normal[0]*prev.collision.normal[0]<0)localOpposite++;
  }
  assert.equal(course.audit.spatial.phrasing.level_groups.length,1,'several descending phrases precede a single short level passage');
  assert.equal(level,2,'three equal-pitch boards form two horizontal hops');
  const g=course.audit.spatial.phrasing.level_groups[0];
  for(const b of boards.slice(g.start,g.end+1)) {
    assert.deepEqual(b.quaternion,[0,0,0,1]);assert.equal(b.tilt,0);
    assert.deepEqual(b.collision.normal,[0,1,0]);
    const before=course.segments.find(s=>Math.abs(s.t1-b.t)<1e-8),after=course.segments.find(s=>Math.abs(s.t0-b.t)<1e-8);
    const vin=transitionVelocity(before,1),vout=transitionVelocity(after,0);
    assert.ok(Math.hypot(vin[0]-vout[0],vin[2]-vout[2])<1e-9,'flat entry/interior/exit cannot steer sideways');
  }
  assert.ok(g.descending_phrases>=3&&g.descending_phrases<=5);
  assert.ok(boards[g.start].p[1]<boards[g.start-1].p[1]&&boards[g.end+1].p[1]<boards[g.end].p[1]);
  assert.ok(localOpposite>=5,'opposite real tilts appear within same-side groups');
  assert.ok(new Set([...groups.values()].map(g=>g.length)).size>=3,'group durations vary');
  assert.equal(course.audit.clearance_fails,0);assert.equal(course.audit.plank_overlaps,0);
  assert.deepEqual(buildGravityLayout(repeated,kit,C),course,'random seeking/solving has no stateful random history');
});
test('phrase accents have real opposite surface slopes, without yawing a flat board',()=>{
  const turns=accents.boards.filter(b=>b.surface_accent);
  assert.ok(turns.length>=1&&turns.length<accents.boards.length*.1);
  for(const [i,b] of turns.entries()) {
    assert.notEqual(b.phrase,accents.boards[b.i-1].phrase);
    assert.ok(b.tilt>=25*Math.PI/180&&b.tilt<=C.boards.maxTilt*Math.PI/180);
    assert.ok(!b.yaw,'in-plane heading cannot stand in for a real surface slope');
    assert.ok(Math.abs(b.collision.normal[0])>=Math.sin(23*Math.PI/180));
    assert.ok([accents.boards[b.i-1],accents.boards[b.i+1]].some(a=>a.collision.normal[0]*b.collision.normal[0]<-.03),'an adjacent surface has the opposite lateral slope');
    if(i)assert.ok(b.phrase-turns[i-1].phrase>=7);
  }
});

test('accent neighbours retain natural projected lengths before and after a hit',()=>{
  const tilt=C.camera.downwardTilt*Math.PI/180,nominal=2*kit.BALL_R*C.boards.sideDiameters;
  const depth=kit.BALL_R*Math.sqrt(1+(1/((9/16)*Math.tan(C.camera.fov*Math.PI/360)*C.ball.screenWidth))**2);
  for(const b of accents.boards.filter(b=>b.accent_group!==undefined)) {
    assert.ok(Math.abs(Math.atan2(b.collision.normal[2],b.collision.normal[1]))<=8*Math.PI/180);
    for(const age of [-.02,0,.045,.12])for(const offset of [-1,0,3,6])for(const cx of [-.15,0,.15]) {
      const pose=boardPose(b,b.size[1],wallSwing(b.t+age,b,C.boards));
      const camera=new PerspectiveCamera(C.camera.fov,9/16,.1,1000),cy=b.p[1]-kit.BALL_R+offset;
      camera.position.set(cx,cy+depth*Math.sin(tilt),-.35*nominal+depth*Math.cos(tilt));
      camera.lookAt(cx,cy,-.35*nominal);camera.updateMatrixWorld();
      const length=rotation=>{
        const p=[-1,1].map(sign=>new Vector3(0,0,sign*b.size[2]/2).applyQuaternion(rotation).add(pose.center).project(camera));
        return Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y);
      };
      const ratio=length(pose.quaternion)/length(new Quaternion());
      assert.ok(ratio>=.75&&ratio<=1.35,`board ${b.i} projected length ratio ${ratio}`);
    }
  }
});

test('original source proportions and outward wall mounts survive the steering tilt',()=>{
  const source=JSON.parse(fs.readFileSync(new URL('../../assets/reference_planks/model_check.json',import.meta.url)));
  const [sw,sl,sh]=source.boards.find(b=>b.name==='Plank_02_Ivory').dimensions_m;
  const [w,h,l]=referencePlankSize(.25);
  assert.ok(Math.abs(l/w-sl/sw)<1e-10);assert.ok(Math.abs(h/w-sh/sw)<1e-10);
  for(const board of [...layout.boards,...accents.boards]) {
    assert.ok(Math.abs(board.size[1]/board.size[0]-h/w)<1e-10);
    assert.ok(Math.abs(board.size[2]/board.size[0]-l/w)<1e-10);
    const nominal=2*kit.BALL_R*C.boards.sideDiameters;
    assert.ok(board.size[0]>=.9*nominal&&board.size[0]<=1.1*nominal);
    const axis=new Vector3(0,0,1).applyQuaternion(new Quaternion(...board.quaternion));
    assert.ok(axis.z>=Math.cos(45*Math.PI/180),'inclined slabs still project out from the wall');
    assert.ok(board.pos[2]-axis.z*board.size[2]/2<layout.wallZ);
    assert.ok(board.pos[2]+axis.z*board.size[2]/2>layout.wallZ);
    const local=new Vector3(...board.contact).sub(new Vector3(...board.pos)).applyQuaternion(new Quaternion(...board.quaternion).invert());
    assert.ok(Math.abs(local.y-board.size[1]/2)<1e-9);
    assert.ok(Math.abs(local.x)<board.size[0]/2&&Math.abs(local.z)<board.size[2]/2);
    const a=boardPose(board,h,0),b=boardPose(board,h,.1);
    assert.deepEqual(a.pivot,b.pivot,'the support rod does not move with the slab');
  }
});

test('every direction change has a matching real surface normal and preserves tangential velocity',()=>{
  let reversals=0;
  for(const course of [layout,accents])for(const b of course.boards) {
    const before=course.segments.find(s=>Math.abs(s.t1-b.t)<1e-8),after=course.segments.find(s=>Math.abs(s.t0-b.t)<1e-8);
    const vin=new Vector3(...transitionVelocity(before,1)),vout=new Vector3(...transitionVelocity(after,0));
    const normal=new Vector3(0,1,0).applyQuaternion(new Quaternion(...b.quaternion));
    const impulse=vout.clone().sub(vin);
    assert.ok(impulse.clone().cross(normal).length()<1e-8,'a flat or oppositely tilted board cannot steer the ball');
    assert.ok(vin.dot(normal)<0&&vout.dot(normal)>=-1e-9);
    assert.ok(vin.clone().addScaledVector(normal,-vin.dot(normal)).distanceTo(
      vout.clone().addScaledVector(normal,-vout.dot(normal)))<1e-8);
    assert.ok(b.tilt<=(b.accent_group===undefined?15:C.boards.maxTilt)*Math.PI/180+1e-9);
    assert.deepEqual(b.collision.v_in,vin.toArray());assert.deepEqual(b.collision.v_out,vout.toArray());
    assert.ok(new Vector3(...b.p).sub(new Vector3(...b.contact)).distanceTo(normal.clone().multiplyScalar(kit.BALL_R))<1e-9);
    if(vin.x*vout.x<0) {
      reversals++;
      assert.ok(normal.x*(vout.x-vin.x)>0,'the surface tilts toward the outgoing impulse');
      assert.ok(Math.abs(normal.x)>.01,'the turn must have a visible lateral slope');
    }
  }
  assert.ok(reversals>2);
  for(const s of [...layout.segments,...accents.segments].filter(s=>s.kind==='flight')) {
    const a=transitionVelocity(s,.1),b=transitionVelocity(s,.9);
    assert.equal(a[0],b[0]);assert.equal(a[2],b[2]);
    assert.equal(s.apex,Math.max(s.p0[1],s.p1[1])+.7*2*kit.BALL_R);
  }
});

test('seed changes continuous lateral placement and uneven downward spacing',()=>{
  const other=structuredClone(C);other.spatial.seed++;
  const changed=buildGravityLayout(plan,kit,other);
  assert.notDeepEqual(changed.contacts.map(n=>n.p),layout.contacts.map(n=>n.p));
  const drops=layout.contacts.slice(1).map((n,i)=>layout.contacts[i].p[1]-n.p[1]);
  assert.ok(Math.max(...drops)-Math.min(...drops)>.15);
  const w=layout.boards[0].size[0];
  assert.ok(layout.contacts.every(n=>Math.abs(n.p[0]/(w/10)-Math.round(n.p[0]/(w/10)))>1e-6));
  assert.ok(layout.contacts.some((n,i)=>i&&n.p[0]*layout.contacts[i-1].p[0]>0),'allow successive contacts on the same side');
});

test('a hit presses the tip down continuously and rebounds to the fixed hinge stop',()=>{
  const b=layout.boards[0],tip=new Vector3(...b.contact),rest=boardPose(b,b.size[1],0);
  assert.ok(Math.abs(wallSwing(b.t,b,C.boards))<1e-10);
  const angle=wallSwing(b.t+.045,b,C.boards),hit=boardPose(b,b.size[1],angle);
  const moved=tip.clone().sub(rest.pivot).applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(...b.tilt_axis),angle)).add(rest.pivot);
  assert.ok(angle>2.9*Math.PI/180&&angle<6.2*Math.PI/180);
  assert.ok(moved.y<tip.y-.04);assert.deepEqual(hit.pivot,rest.pivot);
  for(let t=b.t;t<b.t+2;t+=.01)assert.ok(wallSwing(t,b,C.boards)>=0);
  const changed=structuredClone(C);changed.boards.dampingRatio+=.05;
  assert.notEqual(courseKey(C),courseKey(changed));
});

test('gap rails conserve energy and tangent entry speed, with count, spacing and length limits',()=>{
  const notes=Array.from({length:36},(_,i)=>({t:1+i*.5+Math.floor(i/9)*2,midi:60,n:1+i%7,dur:.5}));
  const course=buildGravityLayout({duration:30,landings:notes},kit,C);
  assert.ok(course.channels.length<=3,'unsafe steering may reject an otherwise eligible gap rail');
  assert.equal(course.audit.clearance_fails,0);
  const railConfig=structuredClone(C);railConfig.spatial.seed=26;
  const railCourse=buildGravityLayout({duration:6,landings:[1,1.5,4,4.5].map((t,i)=>({t,midi:60,n:i+1,dur:.5}))},kit,railConfig);
  assert.equal(railCourse.channels.length,1,'exercise an accepted rail as well as rejected candidates');
  assert.equal(railCourse.audit.clearance_fails,0);
  for(const candidateCourse of [railCourse,course])for(const [i,s] of candidateCourse.channels.entries()) {
    assert.ok(s.reason.gap>=Math.max(1,3.5*candidateCourse.audit.tracks.delta0));
    if(i)assert.ok(s.visibleFrom-candidateCourse.channels[i-1].visibleFrom>=8);
    assert.ok(s.t0-s.visibleFrom>=.25&&s.visibleUntil-s.t1>=.25);
    assert.ok(s.arcLength<=4*candidateCourse.audit.spatial.board_width);
    const incoming=candidateCourse.segments.find(p=>p.t1===s.t0),entry=transitionVelocity(incoming,1),rolling=transitionVelocity(s,0);
    assert.ok(Math.hypot(entry[0]-rolling[0],entry[2]-rolling[2])<1e-8);
    for(const u of [0,.2,.5,.8,1]) {
      const p=transitionPoint(s,u),v=transitionVelocity(s,u);
      assert.ok(Math.abs(v.reduce((sum,x)=>sum+x*x,0)/2+s.g*p[1]-(s.entrySpeed**2/2+s.g*s.p0[1]))<1e-9);
    }
    for(const t of [s.visibleFrom,s.visibleUntil]) {
      const b=candidateCourse.boards.find(b=>b.t===t),normal=new Vector3(0,1,0).applyQuaternion(new Quaternion(...b.quaternion));
      const before=candidateCourse.segments.find(p=>p.t1===t),after=candidateCourse.segments.find(p=>p.t0===t);
      const impulse=new Vector3(...transitionVelocity(after,0)).sub(new Vector3(...transitionVelocity(before,1)));
      assert.ok(impulse.cross(normal).length()<1e-8,'rail placement must also recompute the real contact normals');
    }
  }
  const short={duration:25,landings:notes.map((n,i)=>({...n,t:1+i*.5,dur:4,pitch_bend:[{time_sec:0,semitones:0},{time_sec:3,semitones:4}]}))};
  assert.equal(buildGravityLayout(short,kit,C).channels.length,0);
});
test('an empty course or a single onset at zero has no undefined steering velocity',()=>{
  assert.equal(buildGravityLayout({duration:1,landings:[]},kit,C).boards.length,0);
  const single=buildGravityLayout({duration:1,landings:[{t:0,midi:60,n:1}]},kit,C);
  assert.ok(single.boards[0].quaternion.every(Number.isFinite));
  assert.ok(single.boards[0].collision.v_in.every(Number.isFinite));
  assert.deepEqual(sampleBall(single,.5),single.contacts[0].p);
});
test('the same analytic flight reaches each onset even after seeking backwards',()=>{
  for(const n of layout.contacts.slice().reverse())assert.ok(Math.hypot(...sampleBall(layout,n.t).map((v,k)=>v-n.p[k]))<1e-8);
});
test('notes 1–7 map to red, orange, yellow, green, cyan, blue, violet; pre-hit emission is exactly zero',()=>{
  assert.deepEqual(NOTE_LIGHTS,['#ff2028','#ff810d','#ffdf18','#39e651','#16e5dd','#2465ff','#aa38ff']);
  for(let n=1;n<=7;n++) {
    assert.equal(notePulse(3-1e-9,3),0);assert.equal(notePulse(3,3),0);
    assert.ok(Math.abs(notePulse(3.05,3)-1)<1e-10);
    assert.ok(notePulse(3.2,3)>notePulse(3.8,3));assert.equal(notePulse(6,3),0);
  }
  assert.deepEqual([4,2,3,3.5,4].map(t=>notePulse(t,3)),[4,2,3,3.5,4].map(t=>notePulse(t,3)));
});
