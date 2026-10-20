import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeDecelerationPassages} from '../src/deceleration_rail.mjs';

const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
const dot=(a,b)=>a.reduce((sum,x,k)=>sum+x*b[k],0);
const a={t:19.661538,p:[.3,-14.2,-.0315]},b={t:22.661538,p:[-.162,-15.866343,-.0315]};
const options={g:9.81,width:.21,ballRadius:.1};
const at=(flight,age)=>flight.p0.map((x,k)=>x+flight.v0[k]*age-(k===1?flight.g*age*age/2:0));

test('the long 都 to 是 interval has passive deceleration passages with exact physical timing',()=>{
  const candidates=[...proposeDecelerationPassages(a,b,options)];
  assert.ok(candidates.length>0&&candidates.length<=32);
  const example=candidates.find(([entry,rail,edge,exit])=>Math.abs(entry.t1-entry.t0-.5)<1e-9&&
    Math.abs(exit.t1-exit.t0-.6)<1e-9&&Math.abs(rail.incline-.5*Math.PI/180)<1e-12);
  assert.ok(example,'the half-degree, .5-second approach and .6-second departure remain feasible');
  for(const passage of candidates) {
    const [entry,rail,edge,exit]=passage;
    assert.equal(entry.t0,a.t);assert.equal(exit.t1,b.t);
    assert.equal(entry.g,options.g);assert.equal(rail.g,options.g);assert.equal(edge.g,options.g);assert.equal(exit.g,options.g);
    assert.ok(entry.t1-entry.t0>=.2-1e-12&&exit.t1-exit.t0>=.2-1e-12);
    assert.ok(Math.abs(entry.t1-entry.t0+rail.duration+edge.duration+exit.t1-exit.t0-3)<1e-12);
    assert.equal(entry.t1,rail.t0);assert.equal(rail.t1,edge.t0);assert.equal(edge.t1,exit.t0);
    assert.ok(distance(at(entry,entry.t1-entry.t0),rail.p0)<1e-11);
    const target=[b.p[0]+passage.shiftX,b.p[1],b.p[2]];
    assert.ok(Math.abs(passage.shiftX)<=.8);
    assert.ok(distance(at(exit,exit.t1-exit.t0),target)<1e-11,'the translated endpoint closes without clock scaling');
    assert.ok(rail.arcLength>=options.width&&rail.arcLength<=4*options.width);
    assert.ok(Math.abs(distance(rail.p0,rail.p1)-rail.arcLength)<1e-11);
    assert.ok(rail.entrySpeed>rail.exitSpeed&&rail.exitSpeed>0);
    assert.ok(rail.normal[1]>0&&rail.normalAcceleration>0);
    assert.ok(Math.abs(dot(rail.tangent,rail.normal))<1e-12);
    assert.ok(Math.abs(distance(rail.tangent,[0,0,0])-1)<1e-12);
    assert.ok(Math.abs(distance(rail.normal,[0,0,0])-1)<1e-12);
    const capture=rail.capture;
    assert.ok(distance(capture.v_in,[entry.v0[0],entry.v0[1]-entry.g*(entry.t1-entry.t0),0])<1e-11);
    assert.ok(capture.normal_speed<0,'the ball approaches the top of the rail');
    assert.ok(capture.energy_loss>0,'a passive catch only removes energy');
    assert.ok(Math.abs(dot(capture.v_in,rail.tangent)-rail.entrySpeed)<1e-12);
    assert.ok(Math.abs(dot(capture.v_out,rail.normal))<1e-12);
    assert.ok(Math.abs(capture.energy_loss-capture.normal_speed**2/2)<1e-11);
    assert.ok(Math.abs(rail.normalAcceleration-rail.g*rail.normal[1])<1e-12);
    const impulse=capture.v_out.map((x,k)=>x-capture.v_in[k]);
    assert.ok(distance(impulse,rail.normal.map(x=>-capture.normal_speed*x))<1e-11);
    assert.equal(edge.entrySpeed,rail.exitSpeed);
    assert.ok(distance(edge.p0,rail.p1)<1e-12);
    const tangent0=[edge.sign*Math.cos(edge.angle0),-Math.sin(edge.angle0),0];
    assert.ok(distance(tangent0,rail.tangent)<1e-12,'the supported roll-off starts with the complete rail velocity');
    const tangent1=[edge.sign*Math.cos(edge.angle1),-Math.sin(edge.angle1),0];
    assert.ok(distance(exit.v0,tangent1.map(x=>x*edge.exitSpeed))<1e-12,'natural release retains the entire velocity');
    const energy=rail.entrySpeed**2/2+rail.g*rail.p0[1];
    for(const u of [0,.1,.4,.8,1]) {
      const age=u*rail.duration,travel=rail.entrySpeed*age-rail.deceleration*age*age/2;
      const p=rail.p0.map((x,k)=>x+rail.tangent[k]*travel),speed=rail.entrySpeed-rail.deceleration*age;
      assert.ok(Math.abs(speed**2/2+rail.g*p[1]-energy)<1e-11);
      if(u===1)assert.ok(distance(p,rail.p1)<1e-11);
    }
    const edgeEnergy=edge.entrySpeed**2/2+edge.g*edge.p0[1];
    const tubeRadius=.035*2*options.ballRadius,spacing=.135*2*options.ballRadius;
    for(const u of [0,.1,.4,.8,1]) {
      const angle=edge.angle0+(edge.angle1-edge.angle0)*u;
      const p=[edge.center[0]+edge.sign*edge.edgeRadius*Math.sin(angle),edge.center[1]+edge.edgeRadius*Math.cos(angle),edge.center[2]];
      const v2=edge.entrySpeed**2+2*edge.g*edge.edgeRadius*(Math.cos(edge.angle0)-Math.cos(angle));
      const force=edge.g*Math.cos(angle)-v2/edge.edgeRadius;
      assert.ok(force>=-1e-11,'support is never attractive');
      assert.ok(Math.abs(v2/2+edge.g*p[1]-edgeEnergy)<1e-11);
      for(const sign of [-1,1])assert.ok(Math.abs(distance(p,[edge.center[0],edge.center[1],edge.center[2]+sign*spacing])-
        options.ballRadius-tubeRadius)<1e-12,'the ball touches the real twin rail ends');
      if(u===1) {
        assert.ok(Math.abs(force)<1e-11,'release occurs when support reaches zero');
        assert.ok(distance(p,exit.p0)<1e-12);
        assert.ok(distance(p,edge.p1)<1e-12);
      }
    }
    assert.equal(edge.timeTable.length,129);
    assert.equal(edge.timeTable[0].time,0);
    assert.equal(edge.timeTable.at(-1).time,edge.duration);
    for(let i=1;i<edge.timeTable.length;i++) {
      assert.ok(edge.timeTable[i].angle>edge.timeTable[i-1].angle);
      assert.ok(edge.timeTable[i].time>edge.timeTable[i-1].time);
    }
    for(let i=0;i<=128;i++) {
      const p=at(exit,(exit.t1-exit.t0)*i/128);
      for(const sign of [-1,1])assert.ok(distance(p,[edge.center[0],edge.center[1],edge.center[2]+sign*spacing])>=
        options.ballRadius+tubeRadius-1e-11,'free flight clears both rounded endcaps');
    }
  }
});

test('deceleration candidates are mirror-symmetric and deterministic without hidden frame history',()=>{
  const original=[...proposeDecelerationPassages(a,b,options)];
  const mirror=n=>({...n,p:[-n.p[0],n.p[1],n.p[2]]});
  const mirrored=[...proposeDecelerationPassages(mirror(a),mirror(b),options)];
  assert.equal(mirrored.length,original.length);
  for(let i=0;i<original.length;i++)for(let j=0;j<4;j++) {
    const x=original[i][j],y=mirrored[i][j];
    assert.ok(distance(y.p0,[-x.p0[0],x.p0[1],x.p0[2]])<1e-12);
    assert.ok(distance(y.p1,[-x.p1[0],x.p1[1],x.p1[2]])<1e-12);
    if(x.kind==='ride')assert.equal(x.entrySpeed,y.entrySpeed);
    else assert.ok(distance(y.v0,[-x.v0[0],x.v0[1],x.v0[2]])<1e-12);
  }
  assert.deepEqual([...proposeDecelerationPassages(a,b,options)],original);
});

test('equivalent shifts retain timing priority despite endpoint rounding',()=>{
  const source={t:19.66153846153846,p:[-2.016000000000009,-31.022733632284734,-.0315]};
  const target={t:22.66153846153846,p:[-2.520000000000009,-32.68907693578998,-.0315]};
  for(const rounding of [0,-1e-14,-1e-12]) {
    const end={...target,p:[target.p[0],target.p[1]+rounding,target.p[2]]};
    const equivalent=[...proposeDecelerationPassages(source,end,options)].filter(p=>
      p[1].exitSpeed===.18&&Math.abs(p[1].incline-.5*Math.PI/180)<1e-12&&
      Math.abs(p[3].t1-p[3].t0-.6)<1e-12);
    assert.equal(equivalent.length,3);
    assert.ok(Math.max(...equivalent.map(p=>p.shiftX))-Math.min(...equivalent.map(p=>p.shiftX))<1e-12);
    const approaches=equivalent.map(p=>Math.round((p[0].t1-p[0].t0)*10)/10);
    assert.equal(approaches[0],.5,'the preferred approach must win an equivalent shift');
    assert.deepEqual(approaches.sort(),[.4,.5,.6]);
  }
});

test('the supported edge clock agrees with an independent fine Simpson integral',()=>{
  const edge=[...proposeDecelerationPassages(a,b,options)][0][2],steps=16384;
  const integrand=angle=>edge.edgeRadius/Math.sqrt(edge.entrySpeed**2+2*edge.g*edge.edgeRadius*(Math.cos(edge.angle0)-Math.cos(angle)));
  let sum=integrand(edge.angle0)+integrand(edge.angle1);
  for(let i=1;i<steps;i++)sum+=(i%2?4:2)*integrand(edge.angle0+(edge.angle1-edge.angle0)*i/steps);
  const duration=sum*(edge.angle1-edge.angle0)/(3*steps);
  assert.ok(Math.abs(duration-edge.duration)<1e-11);
});

test('a dense or unsupported nonplanar interval yields no fabricated rail',()=>{
  assert.deepEqual([...proposeDecelerationPassages(a,{...b,t:a.t+.4},options)],[]);
  assert.deepEqual([...proposeDecelerationPassages(a,{...b,p:[...a.p]},options)],[]);
  assert.deepEqual([...proposeDecelerationPassages(a,{...b,p:[b.p[0],b.p[1],b.p[2]+.1]},options)],[]);
});
