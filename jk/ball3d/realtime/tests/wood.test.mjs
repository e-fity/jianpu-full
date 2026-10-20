import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as W from '../src/wood_motion.mjs';
const plan={duration:20,landings:Array.from({length:24},(_,i)=>({t:1+i*.6}))};
const segments=W.woodSegments(plan);
const close=(a,b,eps=1e-9)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<eps,`${a} != ${b}`));
test('reference course handles silence, one note, partial sections, and exact contacts',()=>{
  for(const p of [{duration:4,landings:[]},{duration:4,landings:[{t:1}]},plan]) {
    const s=W.woodSegments(p);
    for(let t=0;t<=p.duration;t+=.017) assert.ok(W.sampleWoodBall(s,t).every(Number.isFinite));
    p.landings.forEach((h,i)=>close(W.sampleWoodBall(s,h.t),W.restPosition(i)));
    for(let i=1;i<s.length;i++) close(W.transitionPoint(s[i-1],1),W.transitionPoint(s[i],0));
  }
});
test('channel joins and actual open trough triangles stay clear of the sphere',()=>{
  const troughs=segments.filter(s=>s.kind==='channel').map(seg=>{
    const triangles=[];
    const tri=(a,b,c)=>triangles.push(new THREE.Triangle(...[a,b,c].map(p=>new THREE.Vector3(...p))));
    const quad=(a,b,c,d)=>{tri(a,b,c);tri(a,c,d);};
    const raised=(p,n)=>p.map((v,i)=>v+n[i]*W.CHANNEL_RAIL_H);
    for(let i=0;i<W.CHANNEL_SUBDIV;i++) {
      const a=W.channelCross(seg,i/W.CHANNEL_SUBDIV),b=W.channelCross(seg,(i+1)/W.CHANNEL_SUBDIV);
      quad(a.left,a.right,b.right,b.left);
      quad(a.left,b.left,raised(b.left,b.normal),raised(a.left,a.normal));
      quad(a.right,b.right,raised(b.right,b.normal),raised(a.right,a.normal));
    }
    return {seg,triangles};
  });
  const center=new THREE.Vector3(),nearest=new THREE.Vector3();
  for(const seg of segments) for(let i=0;i<=200;i++) {
    const p=W.transitionPoint(seg,i/200);center.set(...p);
    for(const {seg:other,triangles} of troughs) {
      if(Math.abs(W.boardTopY(other.from)-p[1])>5) continue;
      for(const triangle of triangles) {
        triangle.closestPointToPoint(center,nearest);
        assert.ok(center.distanceTo(nearest)>=W.BALL_R-.003,
          `penetration from ${seg.from} at ${i/200}, channel ${other.from}: ${center.distanceTo(nearest)}`);
      }
    }
  }
  for(const {seg} of troughs) {
    for(const u of [.25,.8]) close(W.transitionPoint(seg,u-1e-8),W.transitionPoint(seg,u+1e-8),1e-6);
    for(let i=0;i<=100;i++) {
      const u=i/100,center=W.channelCenterPoint(seg,u),floor=W.channelFloorPoint(seg,u);
      assert.ok(Math.abs(Math.hypot(...center.map((v,j)=>v-floor[j]))-W.BALL_R)<1e-9);
    }
  }
});
test('spatial channel pool always contains the current chute and fits capacity',()=>{
  const s=W.woodSegments({duration:200,landings:Array.from({length:335},(_,i)=>({t:1+i*.5}))});
  for(let t=0;t<169;t+=.05) {
    const y=W.sampleWoodTrack(s,t)[1],live=W.channelsNear(s,y),current=s[W.segmentIndexAt(s,t)];
    assert.ok(live.length<=W.MAX_CHANNELS);
    if(current.kind==='channel') assert.ok(live.some(x=>x.seg===current));
  }
});

