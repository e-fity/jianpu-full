import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {spatialRailPoint,spatialRailTangent,spatialRailNormal,spatialRailUAtTime,spatialRailRotation,spatialPoint} from '../src/spatial_course.mjs';
import {transitionPoint,transitionVelocity,sampleBall,sampleVelocity,supportAt} from '../src/gravity_layout.mjs';

const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
function integrate(fn,a,b,steps=128) {
  const h=(b-a)/steps;
  let sum=fn(a)+fn(b);
  for(let i=1;i<steps;i++)sum+=(i%2?4:2)*fn(a+h*i);
  return sum*h/3;
}
function edge(sign) {
  const edgeRadius=.04,g=9.81,entrySpeed=.15,angle0=-.05;
  const angle1=Math.acos((entrySpeed**2/(g*edgeRadius)+2*Math.cos(angle0))/3);
  const s={kind:'ride',spatial:true,edge:true,center:[.2,-.3,.15],edgeRadius,angle0,angle1,sign,entrySpeed,g};
  const speed=angle=>Math.sqrt(entrySpeed**2+2*g*edgeRadius*(Math.cos(angle0)-Math.cos(angle)));
  const timeTable=[{angle:angle0,time:0}];
  for(let i=1;i<=128;i++) {
    const angle=angle0+(angle1-angle0)*i/128,previous=timeTable.at(-1);
    timeTable.push({angle,time:previous.time+integrate(a=>edgeRadius/speed(a),previous.angle,angle)});
  }
  const duration=timeTable.at(-1).time;
  return {...s,timeTable,duration,arcLength:edgeRadius*(angle1-angle0),t0:3,t1:3+duration,
    p0:spatialRailPoint(s,0),p1:spatialRailPoint(s,1)};
}

test('rail end support follows a finite circular edge with energy-derived speed and smooth physical velocity',()=>{
  for(const sign of [-1,1]) {
    const s=edge(sign),energy=s.entrySpeed**2/2+s.g*s.p0[1];
    assert.equal(spatialRailUAtTime(s,-1),0);assert.equal(spatialRailUAtTime(s,s.duration+1),1);
    for(const age of [0,.1,.25,.5,.75,.9,1].map(u=>u*s.duration)) {
      const u=age/s.duration,along=spatialRailUAtTime(s,age),p=transitionPoint(s,u),v=transitionVelocity(s,u);
      const tangent=spatialRailTangent(s,along),normal=spatialRailNormal(s,along);
      assert.ok(distance(p,spatialPoint(s,u))<1e-13);
      assert.ok(Math.abs(distance(p,s.center)-s.edgeRadius)<1e-13);
      assert.ok(Math.abs(tangent.reduce((sum,x,k)=>sum+x*normal[k],0))<1e-13);
      assert.ok(Math.abs(v.reduce((sum,x)=>sum+x*x,0)/2+s.g*p[1]-energy)<1e-12);
      if(u>0&&u<1) {
        const dt=1e-6,low=transitionPoint(s,(age-dt)/s.duration),high=transitionPoint(s,(age+dt)/s.duration);
        assert.ok(distance(high.map((x,k)=>(x-low[k])/(2*dt)),v)<1e-8,'position derivative equals physical velocity');
        const lowV=transitionVelocity(s,(age-dt)/s.duration),highV=transitionVelocity(s,(age+dt)/s.duration);
        const angle=s.angle0+(s.angle1-s.angle0)*along,speed=Math.hypot(...v);
        const acceleration=tangent.map((x,k)=>x*s.g*Math.sin(angle)-normal[k]*speed**2/s.edgeRadius);
        assert.ok(distance(highV.map((x,k)=>(x-lowV[k])/(2*dt)),acceleration)<1e-6);
      }
      const angle=s.angle0+(s.angle1-s.angle0)*along;
      const reaction=s.g*Math.cos(angle)-v.reduce((sum,x)=>sum+x*x,0)/s.edgeRadius;
      assert.ok(reaction>=-1e-11,'the end cap pushes until separation, without pulling the ball inward');
    }
    const end=transitionVelocity(s,1);
    assert.ok(Math.abs(s.g*Math.cos(s.angle1)-end.reduce((sum,x)=>sum+x*x,0)/s.edgeRadius)<1e-12);
    assert.ok(end[1]<0,'the sphere leaves the rounded cap descending');
  }
});

test('end-support time inversion, support framing and rolling remain deterministic when seeking',()=>{
  for(const sign of [-1,1]) {
    const s=edge(sign),layout={segments:[s]},radius=.03;
    for(const u of [.003,.137,.501,.999]) {
      const along=spatialRailUAtTime(s,u*s.duration),angle=s.angle0+(s.angle1-s.angle0)*along;
      const time=integrate(a=>s.edgeRadius/Math.sqrt(s.entrySpeed**2+2*s.g*s.edgeRadius*(Math.cos(s.angle0)-Math.cos(a))),s.angle0,angle,16384);
      assert.ok(Math.abs(time-u*s.duration)<1e-12,'local table inversion agrees with an independent dense integration');
      const expected=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,-sign),s.arcLength*along/radius);
      assert.ok(expected.angleTo(spatialRailRotation(s,u,radius))<1e-7);
      assert.deepEqual(supportAt(layout,s.t0+u*s.duration),sampleBall(layout,s.t0+u*s.duration));
    }
    const times=[.9,.05,1,0,.4,.9].map(u=>s.t0+u*s.duration);
    const sample=t=>[sampleBall(layout,t),sampleVelocity(layout,t),spatialRailRotation(s,(t-s.t0)/s.duration,radius).toArray()];
    const expected=times.map(sample);
    for(const [i,t] of times.map((t,i)=>[i,t]).reverse())assert.deepEqual(sample(t),expected[i]);
  }
});
