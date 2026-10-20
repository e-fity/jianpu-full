import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vector3 } from 'three';
import * as kit from '../src/layout.mjs';
import { apexFlight, spatialRailPoint, spatialRailRotation, seededRandom } from '../src/spatial_course.mjs';
import { buildGravityLayout, transitionPoint, transitionVelocity, sampleBall, supportAt, courseKey } from '../src/gravity_layout.mjs';
import { cameraPresentation, validatePresentation } from '../src/presentation.mjs';
import { hull, intersects, rectangle, clipScreen } from '../src/screen_geometry.mjs';
const C=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
C.spatial.wallMounted=false; // The free-space mode remains independently covered.
const p={duration:48,tempo_qpm:120,meter:'3/4',landings:[]};
let time=1;
for(let i=0;i<64;i++){p.landings.push({t:time,midi:60+[0,4,2,7,-2,5,0,-5][i%8],n:1+i%7,dur:.25});time+=i%13===0?3:.25;}
p.duration=time+1;
const layout=buildGravityLayout(p,kit,C);
test('unequal endpoints and arbitrary duration have exactly the requested apex and constant horizontal velocity',()=>{
  for(const y0 of [-.8,0,.8])for(const y1 of [-.8,0,.8])for(const dt of [.08,.5,2,14]) {
    const flight=apexFlight([1,y0,2],[3,y1,4],5,5+dt,.2),span=flight.t1-flight.t0;
    assert.ok(Math.abs(transitionPoint(flight,flight.v0[1]/flight.g/span)[1]-(Math.max(y0,y1)+.14))<1e-9);
    assert.ok(Math.hypot(...transitionPoint(flight,1).map((x,k)=>x-flight.p1[k]))<1e-9);
    assert.equal(transitionVelocity(flight,.2)[0],transitionVelocity(flight,.8)[0]);
    assert.equal(transitionVelocity(flight,.2)[2],transitionVelocity(flight,.8)[2]);
  }
});
test('seed and time sampling are reproducible, including seeking backwards',()=>{
  assert.deepEqual(buildGravityLayout(p,kit,C),layout);
  const changed=structuredClone(C);changed.spatial.seed++;
  assert.notDeepEqual(buildGravityLayout(p,kit,changed).contacts.map(n=>n.p),layout.contacts.map(n=>n.p));
  const times=[4,19,1,30,2,4],values=times.map(t=>sampleBall(layout,t));
  assert.deepEqual(values,times.map(t=>sampleBall(layout,t)));
  const a=seededRandom(C.spatial.seed),b=seededRandom(C.spatial.seed);
  assert.deepEqual(Array.from({length:100},a),Array.from({length:100},b));
});
test('spline progress, bounded pitch heights, board spacing, yaw and reflection direction',()=>{
  const D=2*kit.BALL_R,w=D*C.boards.sideDiameters;
  assert.equal(layout.audit.spatial.ema_seconds,3);
  for(const [i,b] of layout.boards.entries()) {
    assert.ok(Math.abs(b.pitch_height)<=4*D);
    if(i){assert.ok(Math.abs(b.top_y-layout.boards[i-1].top_y)<=1.5*D);assert.ok(b.step>=C.spatial.minStepWidths*w-1e-8&&b.step<=C.spatial.maxStepWidths*w+1e-8);}
    assert.ok(Math.abs(b.tilt)<=23*Math.PI/180);
    const impulse=new Vector3(...b.collision.v_out).sub(new Vector3(...b.collision.v_in));
    assert.ok(Math.abs(new Vector3(...b.tilt_axis).dot(impulse))<1e-8);
  }
  assert.ok(layout.audit.min_contact_spacing>=2*w);
  assert.ok(new Set(layout.boards.map(b=>b.pos[0].toFixed(4))).size>10);
  assert.ok(new Set(layout.boards.map(b=>b.pos[2].toFixed(4))).size>10);
});
test('rare arcs respect global interval/count limits and have exact conserved roll energy',()=>{
  assert.ok(layout.channels.length<=3);
  for(const [i,s] of layout.channels.entries()) {
    assert.ok(s.reason.gap>=Math.max(1,3.5*layout.audit.tracks.delta0));
    if(i)assert.ok(s.visibleFrom-layout.channels[i-1].visibleFrom>=8);
    assert.ok(s.t0-s.visibleFrom>=.25&&s.visibleUntil-s.t1>=.25);
    assert.ok(s.arcLength<=4*layout.audit.spatial.board_width);
    for(const u of [0,.1,.5,.9,1]) {
      const point=transitionPoint(s,u),v=transitionVelocity(s,u);
      assert.ok(Math.abs(v.reduce((sum,x)=>sum+x*x,0)/2+s.g*point[1]-(s.entrySpeed**2/2+s.g*s.p0[1]))<1e-9);
      assert.deepEqual(point,spatialRailPoint(s,u));
      assert.ok(Math.abs(spatialRailRotation(s,u,kit.BALL_R).length()-1)<1e-10);
    }
  }
  const simple={...p,landings:p.landings.slice(0,12).map((n,i)=>({...n,t:1+i*.25,dur:4,pitch_bend:[{time_sec:0,semitones:0},{time_sec:3,semitones:3}]}))};
  assert.equal(buildGravityLayout(simple,kit,C).channels.length,0,'long notes and pitch bends alone never trigger rails');
});
test('spatial camera uses low frequency support and a 7–9 percent framing target',()=>{
  const view=cameraPresentation(()=>[0,0,0],10,4,9/16,.1,C);
  const fraction=.1/(9/16*Math.tan(C.camera.fov*Math.PI/360)*Math.sqrt(view.depth**2-.01));
  assert.ok(fraction>=.07&&fraction<=.09);assert.ok(Math.abs(view.ballScreen[1]-.35)<1e-10);
  const flight=layout.segments.find(s=>s.kind==='flight');
  assert.notDeepEqual(sampleBall(layout,(flight.t0+flight.t1)/2),supportAt(layout,(flight.t0+flight.t1)/2));
  for(const [group,key,value] of [['spatial','seed',1.5],['spatial','maxRails',4]]) {
    const invalid=structuredClone(C);invalid[group][key]=value;assert.throws(()=>validatePresentation(invalid));
  }
});
test('screen overlap uses clipped silhouettes rather than inflated axis aligned boxes',()=>{
  const a=hull([[0,0],[.8,.8],[.7,.9],[-.1,.1]]),b=rectangle(.5,.2,.1,.1);
  assert.equal(intersects(a,b),false);
  assert.equal(intersects(a,rectangle(.4,.4,.1,.1)),true);
  assert.deepEqual(clipScreen(rectangle(2,0,.1,.1)),[]);
});
test('projection-dependent packing is invalidated when camera or ball framing changes',()=>{
  const config=structuredClone(C),key=courseKey(config);
  config.camera.yaw+=1;assert.notEqual(courseKey(config),key);
  config.camera.yaw-=1;config.ball.screenWidth=.08;assert.notEqual(courseKey(config),key);
  config.ball.screenWidth=C.ball.screenWidth;config.ball.roughness=.02;assert.equal(courseKey(config),key);
});
