import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as L from "../src/layout.mjs";
import { createGravityKit, buildGravityLayout, transitionPoint, transitionVelocity, sampleBall } from "../src/gravity_layout.mjs";
import { layoutFor, clearLayoutCache } from "../src/layout_kit.mjs";
import { geometryDefaults } from "../src/settings.mjs";
import { classifyRails, solveEnergyRail } from "../src/expressive_rails.mjs";
import { railVisible, passageGlow } from "../src/rail_glow.mjs";
const C=JSON.parse(fs.readFileSync(new URL("../config.json",import.meta.url)));
// Explicit legacy mode: these tests preserve the previous renderer contract.
C.spatial.enabled=false; C.ball.screenWidth=.11; C.camera.yaw=0;
const plan=(times,q=1)=>({format:"ball3d-plan-v1",duration:times.at(-1)+1,
  landings:times.map((t,i)=>({t,n:i%7+1,q,dur:.25,where:`note ${i}`,midi:60+i}))});

test("all free flights use one gravity and equal-height v0 = g*dt/2",()=>{
  for(const gravity of [3,9.81,15]){
    const config=structuredClone(C);config.physics.gravity=gravity;
    const layout=buildGravityLayout(plan([1,1.5,2,2.5,3,3.5]),L,config);
    const dt=1/60;
    for(const seg of layout.segments.filter(s=>s.kind==="flight")){
      assert.equal(seg.g,gravity);
      if(seg.p0[1]===seg.p1[1])assert.equal(seg.v0[1],gravity*(seg.t1-seg.t0)/2);
      const span=seg.t1-seg.t0;
      for(let age=dt;age<span-dt;age+=dt){
        const y=offset=>transitionPoint(seg,(age+offset)/span)[1];
        const acceleration=(y(dt)-2*y(0)+y(-dt))/dt**2;
        assert.ok(Math.abs(acceleration+gravity)<1e-7,`${acceleration} vs ${-gravity}`);
      }
      assert.ok(Math.hypot(...transitionPoint(seg,1).map((x,k)=>x-seg.p1[k]))<1e-10);
    }
    assert.equal(layout.audit.clearance_fails,0);
  }
});
test("fast notes, row changes and long onset gaps alone never create rails",()=>{
  const layout=buildGravityLayout(plan([1,1.5,1.7,1.9,3.5,4]),L,C);
  assert.deepEqual(layout.boards.map(b=>b.note_index),[0,1,2,3,4,5]);
  for(const contact of layout.contacts)assert.ok(Math.hypot(...sampleBall(layout,contact.t).map((x,k)=>x-contact.p[k]))<1e-10);
  const long=layout.segments.find(s=>s.t0===1.9);
  assert.equal(long.kind,"flight");assert.equal(long.t1,3.5);
  assert.notDeepEqual(transitionPoint(long,.8),transitionPoint(long,1));
  assert.ok(layout.audit.min_contact_spacing>=layout.audit.required_contact_spacing);
  assert.equal(layout.audit.plank_overlaps,0);
});
test("q >= 2 with a short true note-off stays a plank; long sound reserves flight time",()=>{
  const p=plan([1,1.5,2,2.5,4],2);p.landings[3].duration_sec=1;
  const layout=buildGravityLayout(p,L,C);
  assert.equal(layout.channels.length,1);
  const row=layout.channels[0];
  assert.equal(row.t0,2.5);assert.ok(row.t1<=3.5+1e-9);
  assert.equal(row.entrySpeed,Math.abs(row.entryVelocity[0]));
  assert.equal(layout.audit.clearance_fails,0);
});
test("course sampling is continuous at joins and independent of seek order",()=>{
  const layout=buildGravityLayout(plan([1,1.5,2,2.5,3,4.5]),L,C);
  for(let i=1;i<layout.segments.length;i++){
    const a=transitionPoint(layout.segments[i-1],1),b=transitionPoint(layout.segments[i],0);
    assert.ok(Math.hypot(...a.map((x,k)=>x-b[k]))<1e-10);
  }
  const before=sampleBall(layout,1.7);sampleBall(layout,5);sampleBall(layout,0);
  assert.deepEqual(sampleBall(layout,1.7),before);
  assert.deepEqual(createGravityKit(L,C).G_VEC,[0,-C.physics.gravity,0]);
});
test("the final long note stops its rail at note-off before trailing rests",()=>{
  const p=plan([1,1.5,2],2);p.duration=5;p.tail=1;
  p.landings[2].dur=1;p.rests=[{onset_sec:3,dur_sec:1}];
  const a=buildGravityLayout(p,L,C),last=a.channels.at(-1);
  assert.equal(last.reason.trigger,"long");assert.ok(last.t1<=3+1e-9);
  assert.equal(a.audit.tracks.rest_overlaps,0);
  for(const t of [3,3.2,4,4.5])assert.equal(railVisible(last,t),false);
  assert.notDeepEqual(sampleBall(a,4),sampleBall(a,4.5));
});
test("tilt axis follows the horizontal impulse rather than a preset orientation",()=>{
  const layout=buildGravityLayout(plan([1,1.5,2,2.5,3]),L,C);
  for(const b of layout.boards){
    const [x,,z]=b.collision.impulse_horizontal,h=Math.hypot(x,z);
    assert.ok(Math.abs(b.hits[0].scale-h)<1e-12);
    if(h>1e-10)assert.ok(Math.hypot(b.tilt_axis[0]-z/h,b.tilt_axis[2]+x/h)<1e-12);
  }
});
test("empty and single-note courses are finite",()=>{
  for(const p of [{duration:2,landings:[]},plan([1])]){
    const a=buildGravityLayout(p,L,C);
    for(const t of [-1,0,1,2,100])assert.ok(sampleBall(a,t).every(Number.isFinite));
  }
});
test("physics changes invalidate the editor course cache, material changes reuse it",async()=>{
  clearLayoutCache();
  const source=fs.readFileSync(new URL("../src/layout.mjs",import.meta.url),"utf8");
  const args={source,geometry:geometryDefaults(),plan:plan([1,1.5,2]),presentation:structuredClone(C)};
  const a=await layoutFor(args);args.presentation.ball.roughness=.1;
  assert.equal(await layoutFor(args),a);
  args.presentation.physics.gravity=7;
  const b=await layoutFor(args);assert.notEqual(b.layout,a.layout);assert.equal(b.kit.G,7);
  assert.equal(a.kit.G,9.81);
  args.presentation.tracks.longMinSeconds=1.5;
  assert.notEqual((await layoutFor(args)).layout,b.layout);
});

test("duration threshold includes its boundary and uses the true interval median",()=>{
  const p=plan([1,1.25,1.5,2,3,4]);
  for(const n of p.landings)n.duration_sec=.99999;
  assert.equal(classifyRails(p,C.tracks).delta0,.5);
  assert.equal(classifyRails(p,C.tracks).groups.length,0);
  p.landings[0].duration_sec=1;
  assert.equal(classifyRails(p,C.tracks).groups[0].type,'long');
});

const glissPlan=(direction=1)=>{
  const p=plan([1,2,3,3.1,3.2,3.3,4,5,6]);
  p.landings.forEach((n,i)=>{n.dur=p.landings[i+1]?.t-n.t||.3;n.midi=i>=2&&i<=5?60+direction*(i-2):72;});
  return p;
};
test("four monotonic close notes become one pitched rail and every original onset is sampled",()=>{
  for(const direction of [-1,1]) {
    const p=glissPlan(direction),layout=buildGravityLayout(p,L,C);
    const rails=layout.channels.filter(s=>s.reason.type==='glissando');
    assert.equal(rails.length,1);
    const rail=rails[0];assert.deepEqual(rail.note_indices,[2,3,4,5]);
    assert.equal(Math.sign(rail.p1[1]-rail.p0[1]),direction);
    assert.ok(!layout.boards.some(b=>rail.note_indices.includes(b.note_index)));
    for(const i of rail.note_indices)assert.ok(Math.hypot(...sampleBall(layout,p.landings[i].t).map((x,k)=>x-layout.contacts[i].p[k]))<1e-10);
    assert.equal(rail.beads.length,4);
    assert.ok(rail.t1<=p.landings[6].t-C.tracks.minFlightSeconds+1e-8);
  }
});
test("rests, note-off gaps, repeated/reversed pitches and large steps interrupt gliss groups",()=>{
  for(const change of [
    p=>{p.rests=[{onset_sec:3.15,dur_sec:.02}];},p=>{p.landings[3].dur=.05;},
    p=>{p.landings[4].midi=61;},p=>{p.landings[4].midi=60;},p=>{p.landings[4].midi=65;}
  ]) {
    const p=glissPlan();change(p);
    assert.equal(classifyRails(p,C.tracks).groups.filter(g=>g.type==='glissando').length,0);
  }
});
test("pitch bend and legacy explicit glissando make rails, including short notes",()=>{
  for(const fields of [{pitch_bend:[{time_sec:0,semitones:0},{time_sec:.4,semitones:2}]},
    {articulation:'glissando',glissando_to_midi:64}]) {
    const p=plan([1,2,3]);Object.assign(p.landings[1],{dur:.4,...fields});
    const layout=buildGravityLayout(p,L,C);
    assert.equal(layout.audit.tracks.glissando,1);
    assert.equal(layout.channels[0].note_indices[0],1);
  }
});

test("energy rails conserve v²+2gy; numerical positions obey the same speed without time stretching",()=>{
  for(const direction of [-1,0,1]) {
    const rail=solveEnergyRail({p0:[0,0,0],entrySpeed:1,target:.7,
      profile:[{u:0,y:0},{u:1,y:direction}],width:.25,g:9.81,rules:C.tracks,type:'glissando'});
    Object.assign(rail,{t0:0,t1:rail.duration});
    assert.ok(rail.arcLength<=1.25+1e-9);
    assert.ok(Math.abs(rail.duration-.7)<C.tracks.timeTolerance);
    const speeds=[];
    for(let i=0;i<=100;i++) {
      const u=i/100,p=transitionPoint(rail,u),v=transitionVelocity(rail,u),v2=v.reduce((s,x)=>s+x*x,0);
      assert.ok(Math.abs(v2+2*9.81*p[1]-1)<1e-10);
      speeds.push(Math.sqrt(v2));
      if(i>0&&i<100) {
        const dt=1e-5,a=transitionPoint(rail,u-dt/rail.duration),b=transitionPoint(rail,u+dt/rail.duration);
        assert.ok(Math.abs(Math.hypot(...b.map((x,k)=>(x-a[k])/(2*dt)))-Math.sqrt(v2))<.003);
      }
    }
    for(let i=1;i<speeds.length;i++)assert.ok(direction*(speeds[i]-speeds[i-1])<=1e-9);
    if(!direction)assert.ok(speeds.every(v=>v===1));
    assert.ok(speeds.at(-1)>0);
  }
});
test("arc length includes bends; impossible duration shortens geometry without changing energy",()=>{
  const rail=solveEnergyRail({p0:[0,0,0],entrySpeed:8,target:3,
    profile:[{u:0,y:0},{u:.3,y:-1},{u:.7,y:1},{u:1,y:0}],width:.25,g:9.81,rules:C.tracks,type:'glissando'});
  assert.ok(rail.shortened);assert.ok(rail.arcLength<=1.25+1e-9);
  assert.ok(rail.arcLength>=Math.hypot(...rail.p1.map((x,k)=>x-rail.p0[k])));
  assert.ok(rail.duration<3);
  assert.equal(solveEnergyRail({p0:[0,0,0],entrySpeed:0,target:1,profile:[],width:.25,g:9.81,rules:C.tracks,type:'long'}),null);
});
test("unreachable gliss groups report a fallback and preserve every onset as a plank",()=>{
  const p=glissPlan(),c=structuredClone(C);c.tracks.maxLengthWidths=.01;
  const a=buildGravityLayout(p,L,c);
  assert.ok(a.audit.tracks.rejected.some(r=>r.type==='glissando'));
  assert.ok([2,3,4,5].every(i=>a.boards.some(b=>b.note_index===i)));
});
test("passed sections and beads glow only after their event and fade independently of seek order",()=>{
  assert.equal(passageGlow(1,2,.7),0);assert.equal(passageGlow(2,2,.7),1);
  const expected=passageGlow(2.2,2,.7);passageGlow(10,2,.7);passageGlow(0,2,.7);
  assert.equal(passageGlow(2.2,2,.7),expected);assert.ok(passageGlow(3,2,.7)<expected);
});
