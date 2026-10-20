import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import * as L from '../src/layout.mjs';
import {spatialRailPoint,spatialRailTangent,spatialRailRotation} from '../src/spatial_course.mjs';
import {createGravityKit,transitionPoint,transitionVelocity} from '../src/gravity_layout.mjs';
import {deformSlide,noteFitting,slideWallSupport,wallSlideClear} from '../src/reference_geometry.mjs';

const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const kit=createGravityKit(L,config),width=2*L.BALL_R*config.boards.sideDiameters,wallZ=-1;
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
const rail=sign=>({kind:'ride',spatial:true,straight:true,p0:[sign*-.3,.5,.15],p1:[sign*.3,.5,.15],
  angle0:-sign*Math.PI/2,sweep:0,arcLength:.6,entrySpeed:.4,duration:1.5,
  t0:3,t1:4.5,g:9.81,visibleFrom:2.5,visibleUntil:5});

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

test('straight spatial rails travel in either direction at constant speed and conserve roll energy',()=>{
  for(const sign of [-1,1]) {
    const s=rail(sign);
    assert.deepEqual(spatialRailPoint(s,0),s.p0);assert.deepEqual(spatialRailPoint(s,1),s.p1);
    for(const u of [0,.2,.5,.9,1]) {
      const point=transitionPoint(s,u),v=transitionVelocity(s,u),epsilon=1e-5;
      assert.deepEqual(point,spatialRailPoint(s,u));
      assert.deepEqual(spatialRailTangent(s,u),[sign,0,0]);
      assert.ok(distance(v,[sign*s.entrySpeed,0,0])<1e-12);
      const derivative=distance(transitionPoint(s,u<1?u+epsilon:u-epsilon),point)/(epsilon*s.duration);
      assert.ok(Math.abs(derivative-s.entrySpeed)<1e-10);
      assert.ok(Math.abs(v.reduce((sum,x)=>sum+x*x,0)/2+s.g*point[1]-(s.entrySpeed**2/2+s.g*s.p0[1]))<1e-12);
      assert.ok(Math.abs(spatialRailRotation(s,u,kit.BALL_R).length()-1)<1e-12);
    }
    const times=[.9,.1,1,0,.9],samples=times.map(u=>spatialRailPoint(s,u));
    assert.deepEqual(samples,times.map(u=>spatialRailPoint(s,u)));
  }
});

test('straight twin-rail collision checks use finite ends and include permanent fittings and wall supports',()=>{
  const s=rail(1),R=kit.BALL_R,scale=2*R,radius=.035*scale,spacing=.135*scale;
  const drop=Math.sqrt((R+radius)**2-spacing**2);
  const hold=p=>({kind:'hold',p0:p,p1:p,t0:20,t1:21});
  assert.equal(wallSlideClear(s,[s],kit,wallZ,width),true,'the intended ride is tangent to the rails');
  assert.equal(wallSlideClear(s,[hold([0,s.p0[1]-drop,s.p0[2]-spacing])],kit,wallZ,width),false,
    'a later passage through a fixed rail is unsafe');
  assert.equal(wallSlideClear(s,[hold([s.p0[0]-2*R,s.p0[1]-drop,s.p0[2]])],kit,wallZ,width),true,
    'the rails do not extend infinitely beyond their endpoints');
  const fitting=spatialRailPoint(s,.2);fitting[1]-=drop+.22*scale;
  assert.equal(wallSlideClear(s,[hold(fitting)],kit,wallZ,width),false,'the reference gold fittings remain solid');
  const bracket=spatialRailPoint(s,.2);bracket[1]-=drop+width*.35;bracket[2]=(wallZ+bracket[2])/2;
  assert.equal(wallSlideClear(s,[hold(bracket)],kit,wallZ,width),false,'the fixed diagonal wall brackets remain solid');
});

test('straight rails retain Blender topology and the real rail, fitting and wall-support meshes clear the sphere',()=>{
  for(const sign of [-1,1]) {
    const s=rail(sign),source=assetGeometry('SlideRails'),count=source.getAttribute('position').count;
    deformSlide(source,s,kit);assert.equal(source.getAttribute('position').count,count);
    const fitting=assetGeometry('SlideFittings'),support=slideWallSupport(s,kit,wallZ,width);
    support.computeBoundingBox();assert.ok(support.boundingBox.min.z<wallZ,'wall plates remain embedded');
    const geometries=[['rails',source],['support',support],...[.2,.8].map(u=>['fitting',noteFitting(fitting,s,kit,u)])];
    for(const [name,geometry] of geometries) {
      const position=geometry.getAttribute('position'),index=geometry.index,triangles=[];
      for(let i=0;i<index.count;i+=3)triangles.push(new THREE.Triangle(...[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(position,index.getX(i+k)))));
      const p=new THREE.Vector3(),nearest=new THREE.Vector3();let minimum=Infinity;
      for(let i=0;i<=64;i++) {
        p.set(...transitionPoint(s,i/64));
        for(const triangle of triangles){triangle.closestPointToPoint(p,nearest);minimum=Math.min(minimum,p.distanceTo(nearest));}
      }
      assert.ok(minimum>=kit.BALL_R-.001,`${name}: actual mesh clearance ${minimum}`);
      if(name==='rails')assert.ok(minimum<kit.BALL_R+.002,'the ball touches the actual Blender rails');
      geometry.dispose();
    }
    fitting.dispose();
  }
});
