import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import * as L from '../src/layout.mjs';
import {spatialPoint,spatialRailPoint,spatialRailTangent,spatialRailNormal,spatialRailUAtTime,spatialRailRotation} from '../src/spatial_course.mjs';
import {createGravityKit,transitionPoint,transitionVelocity,sampleBall,sampleVelocity} from '../src/gravity_layout.mjs';
import {deformSlide,noteFitting,slideWallSupport,wallSlideClear} from '../src/reference_geometry.mjs';

const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const kit=createGravityKit(L,config),width=2*L.BALL_R*config.boards.sideDiameters,wallZ=-1;
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
function rail(direction,rise=1) {
  const slope=rise*.12,g=9.81,deceleration=g*Math.sin(slope),duration=1,entrySpeed=2;
  const exitSpeed=entrySpeed-deceleration*duration,arcLength=(entrySpeed+exitSpeed)*duration/2;
  const p0=[direction*-.3,.5,.15],p1=p0.map((x,k)=>x+[direction*Math.cos(slope),Math.sin(slope),0][k]*arcLength);
  return {kind:'ride',spatial:true,straight:true,decelerating:true,p0,p1,entrySpeed,exitSpeed,deceleration,duration,
    t0:3,t1:4,g,arcLength,angle0:-direction*Math.PI/2,sweep:0};
}
function assetGeometry(name) {
  const data=fs.readFileSync(new URL('../../assets/reference_music_machine.glb',import.meta.url));
  const jsonSize=data.readUInt32LE(12),glb=JSON.parse(data.subarray(20,20+jsonSize).toString('utf8')),binary=28+jsonSize;
  const attribute=id=>{
    const a=glb.accessors[id],v=glb.bufferViews[a.bufferView],components={SCALAR:1,VEC3:3}[a.type];
    const ArrayType={5126:Float32Array,5123:Uint16Array,5125:Uint32Array}[a.componentType];
    const start=binary+(v.byteOffset||0)+(a.byteOffset||0),bytes=data.subarray(start,start+a.count*components*ArrayType.BYTES_PER_ELEMENT);
    return new THREE.BufferAttribute(new ArrayType(Uint8Array.from(bytes).buffer),components);
  };
  const node=glb.nodes.find(n=>n.name===name),primitive=glb.meshes[node.mesh].primitives[0],geometry=new THREE.BufferGeometry();
  for(const [name,id] of Object.entries(primitive.attributes))if(name==='POSITION'||name.startsWith('_SLIDE_'))geometry.setAttribute(name.toLowerCase(),attribute(id));
  geometry.setIndex(attribute(primitive.indices));return geometry;
}
function triangles(geometry) {
  const positions=geometry.getAttribute('position'),index=geometry.index,result=[];
  for(let i=0;i<index.count;i+=3)result.push(new THREE.Triangle(...[0,1,2].map(k=>
    new THREE.Vector3().fromBufferAttribute(positions,index.getX(i+k)))));
  return result;
}

test('inclined spatial rides use constant gravity, preserve energy and return exact point/velocity derivatives',()=>{
  for(const direction of [-1,1])for(const rise of [-1,1]) {
    const s=rail(direction,rise),tangent=spatialRailTangent(s,0),normal=spatialRailNormal(s,0);
    assert.ok(Math.abs(Math.hypot(...normal)-1)<1e-12);assert.ok(normal[1]>0);
    assert.ok(Math.abs(normal.reduce((sum,x,k)=>sum+x*tangent[k],0))<1e-12);
    assert.deepEqual(kit.channelNormal(s,.4),normal);
    const energy=s.entrySpeed**2/2+s.g*s.p0[1];
    for(const u of [0,.1,.2,.5,.8,.9,1]) {
      const p=transitionPoint(s,u),v=transitionVelocity(s,u),along=spatialRailUAtTime(s,u*s.duration);
      assert.ok(distance(p,spatialRailPoint(s,along))<1e-12);
      assert.ok(distance(p,spatialPoint(s,u))<1e-12);
      assert.ok(Math.abs(v.reduce((sum,x)=>sum+x*x,0)/2+s.g*p[1]-energy)<1e-11);
      const step=1e-5,low=Math.max(0,u-step),high=Math.min(1,u+step);
      const derivative=transitionPoint(s,high).map((x,k)=>(x-transitionPoint(s,low)[k])/((high-low)*s.duration));
      const midpoint=transitionVelocity(s,(high+low)/2);
      assert.ok(distance(derivative,midpoint)<1e-9);
    }
    assert.ok(Math.abs(Math.hypot(...transitionVelocity(s,1))-s.exitSpeed)<1e-12);
    assert.ok(distance(transitionPoint(s,0),s.p0)<1e-12);assert.ok(distance(transitionPoint(s,1),s.p1)<1e-12);
    const layout={segments:[s]},times=[.9,.1,1,0,.5,.9];
    const values=times.map(u=>[sampleBall(layout,s.t0+u),sampleVelocity(layout,s.t0+u),spatialRailRotation(s,u,kit.BALL_R).toArray()]);
    assert.deepEqual(values,times.map(u=>[sampleBall(layout,s.t0+u),sampleVelocity(layout,s.t0+u),spatialRailRotation(s,u,kit.BALL_R).toArray()]));
    const axis=new THREE.Vector3(...normal).cross(new THREE.Vector3(...tangent)).normalize();
    const q=new THREE.Quaternion().setFromAxisAngle(axis,s.arcLength*spatialRailUAtTime(s,.5)/kit.BALL_R);
    assert.ok(q.angleTo(spatialRailRotation(s,.5,kit.BALL_R))<1e-7);
  }
});

test('inclined double rails, fittings and fixed brackets clear the sphere in both directions using the real Blender mesh',()=>{
  for(const direction of [-1,1])for(const rise of [-1,1]) {
    const s=rail(direction,rise),source=assetGeometry('SlideRails'),count=source.getAttribute('position').count;
    deformSlide(source,s,kit);assert.equal(source.getAttribute('position').count,count);
    const fitting=assetGeometry('SlideFittings'),support=slideWallSupport(s,kit,wallZ,width);
    support.computeBoundingBox();assert.ok(support.boundingBox.min.z<wallZ);
    const meshes=[['rails',source],['support',support],...[.2,.8].map(u=>['fitting',noteFitting(fitting,s,kit,u)])];
    for(const [name,geometry] of meshes) {
      const faces=triangles(geometry),p=new THREE.Vector3(),near=new THREE.Vector3();let minimum=Infinity;
      for(let j=0;j<=48;j++) {
        p.set(...transitionPoint(s,j/48));
        for(const face of faces){face.closestPointToPoint(p,near);minimum=Math.min(minimum,p.distanceTo(near));}
      }
      assert.ok(minimum>=kit.BALL_R-.001,`${name} ${direction}/${rise}: mesh clearance ${minimum}`);
      if(name==='rails')assert.ok(minimum<kit.BALL_R+.002,'the sphere rests on the real double rails');
      geometry.dispose();
    }
    fitting.dispose();
    assert.equal(wallSlideClear(s,[s],kit,wallZ,width),true);
    const normal=spatialRailNormal(s,.2),R=kit.BALL_R,scale=R*2,drop=Math.sqrt((R+.035*scale)**2-(.135*scale)**2);
    const fittingCenter=spatialRailPoint(s,.2).map((x,k)=>x-normal[k]*(drop+.22*scale));
    const hold=p=>({kind:'hold',p0:p,p1:p,t0:10,t1:11});
    assert.equal(wallSlideClear(s,[hold(fittingCenter)],kit,wallZ,width),false);
    const railCenter=spatialRailPoint(s,.5).map((x,k)=>x-normal[k]*drop+(k===2?.135*scale:0));
    assert.equal(wallSlideClear(s,[hold(railCenter)],kit,wallZ,width),false);
  }
});
