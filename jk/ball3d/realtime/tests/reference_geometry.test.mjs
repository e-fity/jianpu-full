import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import * as L from '../src/layout.mjs';
import { deformSlide, noteFitting, slideWallSupport, wallSlideClear } from '../src/reference_geometry.mjs';
import { loadKit } from '../src/layout_kit.mjs';
import { geometryDefaults } from '../src/settings.mjs';
import { solveEnergyRail } from '../src/expressive_rails.mjs';
import { createGravityKit } from '../src/gravity_layout.mjs';
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));

test('a departure flight cannot return underneath and cut through its slide',()=>{
  const kit=createGravityKit(L,config);
  const rail={spatial:true,center:[.6420535850948197,0,.799472097210591],radius:.78,
    angle0:4.6592884513215225,sweep:-.7,visibleFrom:0,visibleUntil:.75};
  const departure={kind:'flight',p0:[.10860838506526549,0,.23040600389152044],
    p1:[.14888349306676538,-.304063807586215,.0445833679760362],t0:0,t1:.75,
    g:3.8497343341841304,v0:[.05370014400199985,1.0382319652040968,-.24776351455397896]};
  assert.equal(wallSlideClear(rail,[departure],kit,-1.0575990400000002,.21),false);
  assert.equal(wallSlideClear(rail,[{...departure,t0:2,t1:2.75}],kit,-1.0575990400000002,.21),false,
    'a fixed rail must also reject collisions after the former visibility window');
});

test('wall slide uses the Blender twin rails with fixed wall brackets and real ball clearance',()=>{
  const C=structuredClone(config);C.spatial.seed=26;C.spatial.layeredPhrases=false;
  const kit=createGravityKit(L,C),layout=kit.buildLayout({duration:6,
    landings:[1,1.5,4,4.5].map((t,i)=>({t,midi:60,n:i+1,dur:.5}))});
  assert.equal(layout.channels.length,1);
  const rail=layout.channels[0],source=assetGeometry(['SlideRails'])[0].geometry;
  const vertexCount=source.getAttribute('position').count;
  deformSlide(source,rail,kit);
  assert.equal(source.getAttribute('position').count,vertexCount,'use source topology');
  const support=slideWallSupport(rail,kit,layout.wallZ,2*kit.BALL_R*C.boards.sideDiameters);
  support.computeBoundingBox();assert.ok(support.boundingBox.min.z<layout.wallZ,'wall plates enter wall');
  const p=new THREE.Vector3(),nearest=new THREE.Vector3();
  const fittings=assetGeometry(['SlideFittings'])[0].geometry;
  for(const [name,geometry] of [['rails',source],['brackets',support],
    ...[.2,.8].map(u=>['fitting',noteFitting(fittings,rail,kit,u)])]) {
    const triangles=[],position=geometry.getAttribute('position'),index=geometry.index;
    for(let i=0;i<index.count;i+=3)triangles.push(new THREE.Triangle(...[0,1,2].map(k=>
      new THREE.Vector3().fromBufferAttribute(position,index.getX(i+k)))));
    let minimum=Infinity,at;
    for(const segment of layout.segments)for(let i=0;i<=64;i++) {
      p.set(...kit.transitionPoint(segment,i/64));
      for(const triangle of triangles){triangle.closestPointToPoint(p,nearest);const d=p.distanceTo(nearest);if(d<minimum){minimum=d;at=[segment.kind,segment.t0,i/64,p.toArray(),nearest.toArray()];}}
    }
    assert.ok(minimum>=kit.BALL_R-.001,`${name} must not penetrate the ball: ${minimum} at ${JSON.stringify(at)}`);
    if(name==='rails')assert.ok(minimum<kit.BALL_R+.002,'ball touches the actual rails');
  }
});

function assetGeometry(names) {
  const data = fs.readFileSync(new URL('../../assets/reference_music_machine.glb', import.meta.url));
  const jsonSize = data.readUInt32LE(12);
  const glb = JSON.parse(data.subarray(20, 20 + jsonSize).toString('utf8'));
  const binary = 28 + jsonSize;
  const attribute = id => {
    const a = glb.accessors[id], v = glb.bufferViews[a.bufferView];
    const components = { SCALAR: 1, VEC3: 3 }[a.type];
    const ArrayType = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
    assert.ok(components && ArrayType && !v.byteStride, 'packed glTF accessor');
    const start = binary + (v.byteOffset || 0) + (a.byteOffset || 0);
    const bytes = data.subarray(start, start + a.count * components * ArrayType.BYTES_PER_ELEMENT);
    return new THREE.BufferAttribute(new ArrayType(Uint8Array.from(bytes).buffer), components);
  };
  return glb.nodes.filter(n => names.includes(n.name)).map(n => {
    const primitive = glb.meshes[n.mesh].primitives[0];
    const geometry = new THREE.BufferGeometry();
    for (const [name, id] of Object.entries(primitive.attributes)) {
      if (name === 'POSITION' || name.startsWith('_SLIDE_')) geometry.setAttribute(name.toLowerCase(), attribute(id));
    }
    geometry.setIndex(attribute(primitive.indices));
    return { name: n.name, geometry };
  });
}

test('energy rails preserve actual sphere clearance on uphill, downhill and pitch reversals',()=>{
  const kit=createGravityKit(L,config),p=new THREE.Vector3(),near=new THREE.Vector3();
  for(const heights of [[0,1],[0,-1],[0,1,-.5]]) {
    const rail=solveEnergyRail({p0:[0,0,0],entrySpeed:1,target:.7,
      profile:heights.map((y,i)=>({u:i/(heights.length-1),y})),width:.25,g:9.81,rules:config.tracks,type:'glissando'});
    Object.assign(rail,{t0:0,t1:rail.duration});
    const triangles=[];
    for(const {geometry} of assetGeometry(['SlideRails','SlideFittings'])) {
      deformSlide(geometry,rail,kit);
      const positions=geometry.getAttribute('position'),idx=geometry.index;
      for(let i=0;i<idx.count;i+=3)triangles.push(new THREE.Triangle(
        ...[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(positions,idx.getX(i+k)))));
    }
    let minimum=Infinity;
    for(let i=0;i<=48;i++) {
      p.set(...kit.transitionPoint(rail,i/48));
      for(const triangle of triangles){triangle.closestPointToPoint(p,near);minimum=Math.min(minimum,p.distanceTo(near));}
    }
    assert.ok(minimum>=L.BALL_R-.001,`actual rail mesh clearance ${minimum}, profile ${heights}`);
    assert.ok(minimum<L.BALL_R+.002);
  }
});

test('each note uses one complete reference gold fitting at its own rail position',()=>{
  const kit=createGravityKit(L,config),source=assetGeometry(['SlideFittings'])[0].geometry;
  const rail=solveEnergyRail({p0:[0,0,0],entrySpeed:1,target:.7,
    profile:[{u:0,y:0},{u:1,y:1}],width:.25,g:9.81,rules:config.tracks,type:'glissando'});
  for(const u of [0,.2,.5,.9]) {
    const geometry=noteFitting(source,rail,kit,u),path=geometry.getAttribute('_slide_u');
    assert.equal(geometry.index.count,source.index.count/7);
    const p=new THREE.Vector3(...kit.channelCenter(rail,u)),near=new THREE.Vector3(),positions=geometry.getAttribute('position');
    for(let i=0;i<geometry.index.count;i+=3) {
      const ids=[0,1,2].map(k=>geometry.index.getX(i+k));
      assert.ok(ids.every(v=>Math.abs(path.getX(v)-u)<1e-7));
      const triangle=new THREE.Triangle(...ids.map(v=>new THREE.Vector3().fromBufferAttribute(positions,v)));
      triangle.closestPointToPoint(p,near);assert.ok(p.distanceTo(near)>=L.BALL_R-.001);
    }
    geometry.dispose();
  }
});

test('the actual deformed Blender rails and fittings clear the animated ball', () => {
  const layout = L.buildLayout({ ref_midi: 60, duration: 4.3, lead: 1.2, tail: 1.1,
    events: [], rests: [], landings: [{ i: 0, t: 1.2, q: 2, dur: 2, midi: 60, n: 1 }] });
  const rail = layout.channels[0], triangles = [];
  const geometries = assetGeometry(['SlideRails', 'SlideFittings']);
  assert.equal(geometries.length, 2);
  for (const { geometry } of geometries) {
    deformSlide(geometry, rail, L);
    const p = geometry.getAttribute('position'), idx = geometry.index;
    for (let i = 0; i < idx.count; i += 3) triangles.push(new THREE.Triangle(
      ...[0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, idx.getX(i + k)))));
  }
  const p = new THREE.Vector3(), near = new THREE.Vector3();
  let minimum = Infinity;
  for (const segment of layout.segments) for (let i = 0; i <= 24; i++) {
    p.set(...L.transitionPoint(segment, i / 24));
    for (const triangle of triangles) {
      triangle.closestPointToPoint(p, near);
      minimum = Math.min(minimum, p.distanceTo(near));
    }
  }
  assert.ok(minimum >= L.BALL_R - .001, `actual mesh clearance ${minimum}`);
  assert.ok(minimum < L.BALL_R + .002, 'ball should contact the rail, not float above it');
});


test('upward planks enter the wall and their fixed brackets stay behind the ball', async () => {
  const parts = Object.fromEntries(assetGeometry(['Board', 'BoardMount']).map(({ name, geometry }) => {
    geometry.computeBoundingBox();
    return [name, geometry.boundingBox];
  }));
  const source = fs.readFileSync(new URL('../src/layout.mjs', import.meta.url), 'utf8');
  for (const depth of [.28, .5, 1.5]) {
    const kit = await loadKit(source, { ...geometryDefaults(), board_d: depth });
    const scale = kit.BOARD_D / .5;
    assert.ok(parts.Board.min.z * scale < kit.WALL_Z, 'rear edge enters the wall');
    assert.ok(kit.WALL_Z - parts.Board.min.z * scale < depth * .02, 'only the root is embedded');
    assert.ok(parts.Board.max.y > 0 && parts.Board.max.z > 0, 'top faces up and front projects out');
    assert.ok(parts.BoardMount.min.z * scale <= kit.WALL_Z, 'foot reaches the wall at every depth');
    assert.ok(parts.BoardMount.max.z * scale < kit.BOARD_Z - kit.BALL_R,
      'the entire bracket remains behind the ball corridor even on tilted boards');
  }
  assert.ok(parts.BoardMount.min.y < -.45, 'the bracket is visible below the platform');
});
