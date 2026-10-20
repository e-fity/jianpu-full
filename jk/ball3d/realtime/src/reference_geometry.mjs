/** Deform the approved Blender slide mesh in the shared ball-path frame. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { spatialRailNormal } from './spatial_course.mjs';

/** Reject flights that return through the twin rails, fittings or fixed supports. */
export function wallSlideClear(segment,passages,kit,wallZ,width) {
  const R=kit.BALL_R,scale=R*2,radius=.035*scale,spacing=.135*scale;
  const drop=Math.sqrt((R+radius)**2-spacing**2),support=slideWallSupport(segment,kit,wallZ,width);
  const positions=support.getAttribute('position'),index=support.index,triangles=[];
  for(let i=0;i<index.count;i+=3)triangles.push(new THREE.Triangle(...[0,1,2].map(k=>
    new THREE.Vector3().fromBufferAttribute(positions,index.getX(i+k)))));
  support.dispose();
  const p=new THREE.Vector3(),closest=new THREE.Vector3();
  const lines=segment.straight?[-1,1].map(sign=>{
    const offset=new THREE.Vector3(Math.cos(segment.angle0)*sign*spacing,0,Math.sin(segment.angle0)*sign*spacing)
      .addScaledVector(new THREE.Vector3(...spatialRailNormal(segment,0)),-drop);
    return new THREE.Line3(new THREE.Vector3(...segment.p0).add(offset),new THREE.Vector3(...segment.p1).add(offset));
  }):null;
  const fittings=[.2,.8].map(u=>new THREE.Vector3(...kit.channelCenter(segment,u))
    .addScaledVector(new THREE.Vector3(...spatialRailNormal(segment,u)),-drop-.22*scale));
  const bounds=new THREE.Box3().setFromBufferAttribute(positions);
  if(lines)for(const line of lines)bounds.union(new THREE.Box3().setFromPoints([line.start,line.end]).expandByScalar(radius));
  for(const center of fittings)bounds.union(new THREE.Box3(center.clone(),center.clone()).expandByScalar(.14*scale));
  // Circular rails also need their full tube envelope inside the broad phase.
  if(!lines)bounds.union(new THREE.Box3(
    new THREE.Vector3(segment.center[0]-segment.radius-spacing-radius,segment.center[1]-drop-radius,segment.center[2]-segment.radius-spacing-radius),
    new THREE.Vector3(segment.center[0]+segment.radius+spacing+radius,segment.center[1]-drop+radius,segment.center[2]+segment.radius+spacing+radius)));
  for(const s of passages)for(let j=0;j<=128;j++) {
    p.set(...kit.transitionPoint(s,j/128));
    if(bounds.distanceToPoint(p)>=R)continue;
    if(lines)for(const line of lines) {
      line.closestPointToPoint(p,true,closest);
      if(p.distanceTo(closest)<R+radius-1e-5)return false;
    } else {
      const angle=Math.atan2(p.z-segment.center[2],p.x-segment.center[0]);
      const delta=Math.atan2(Math.sin(angle-segment.angle0),Math.cos(angle-segment.angle0));
      const u=Math.max(0,Math.min(1,delta/segment.sweep)),a=segment.angle0+segment.sweep*u;
      for(const sign of [-1,1]) {
        closest.set(segment.center[0]+(segment.radius+sign*spacing)*Math.cos(a),segment.center[1]-drop,
          segment.center[2]+(segment.radius+sign*spacing)*Math.sin(a));
        if(p.distanceTo(closest)<R+radius-1e-5)return false;
      }
    }
    if(fittings.some(center=>p.distanceTo(center)<R+.14*scale-1e-5))return false;
    for(const triangle of triangles){triangle.closestPointToPoint(p,closest);if(p.distanceTo(closest)<R-1e-5)return false;}
  }
  return true;
}

/** Two fixed diagonal supports with wall plates and saddles under both rails. */
export function slideWallSupport(segment,kit,wallZ,width) {
  const pieces=[],scale=kit.BALL_R*2,radius=.035*scale,halfSpacing=.135*scale;
  const drop=Math.sqrt((kit.BALL_R+radius)**2-halfSpacing**2)+radius+width*.035;
  const rod=(a,b,r)=>{
    const direction=b.clone().sub(a),g=new THREE.CylinderGeometry(r,r,direction.length(),12);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()));
    g.translate(...a.clone().add(b).multiplyScalar(.5).toArray());pieces.push(g);
  };
  for(const u of [.2,.8]) {
    const p=new THREE.Vector3(...kit.channelCenter(segment,u))
      .addScaledVector(new THREE.Vector3(...spatialRailNormal(segment,u)),-drop);
    const angle=segment.angle0+segment.sweep*u,across=new THREE.Vector3(Math.cos(angle),0,Math.sin(angle));
    rod(p.clone().addScaledVector(across,-halfSpacing),p.clone().addScaledVector(across,halfSpacing),width*.035);
    const foot=new THREE.Vector3(p.x,p.y-width*.7,wallZ);
    rod(foot,p,width*.035);
    const plate=new THREE.CylinderGeometry(width*.09,width*.09,width*.05,16);
    plate.rotateX(Math.PI/2);plate.translate(...foot.toArray());pieces.push(plate);
  }
  const geometry=mergeGeometries(pieces);pieces.forEach(p=>p.dispose());
  geometry.computeBoundingSphere();return geometry;
}
export function noteFitting(source, segment, kit, u) {
  const geometry=source.clone();
  const path=geometry.getAttribute('_slide_u')||geometry.getAttribute('_SLIDE_U');
  // Each source saddle/neck/bead assembly has one fixed path coordinate.
  // Reuse one complete assembly at each musical onset, rather than squeezing
  // all seven reference decorations onto every short rail.
  const fraction=path.getX(geometry.index.getX(0)),indices=[];
  for(let i=0;i<geometry.index.count;i+=3) {
    const triangle=[0,1,2].map(k=>geometry.index.getX(i+k));
    if(triangle.every(v=>Math.abs(path.getX(v)-fraction)<1e-6))indices.push(...triangle);
  }
  geometry.setIndex(indices);
  for(let i=0;i<path.count;i++)path.setX(i,u);
  deformSlide(geometry,segment,kit);
  return geometry;
}

export function deformSlide(geometry, segment, kit) {
  const attribute = name => geometry.getAttribute(name.toLowerCase()) || geometry.getAttribute(name);
  const path = ['_SLIDE_U', '_SLIDE_N', '_SLIDE_T', '_SLIDE_Z'].map(attribute);
  const position = geometry.getAttribute('position');
  if (path.some(a => !a || a.itemSize !== 1 || a.count !== position.count)) {
    throw new Error('Reference slide is missing its Blender path coordinates; rebuild reference_music_machine.glb');
  }
  const scale = kit.BALL_R * (segment.spatial ? 2 : 5);
  const railRadius = .035 * scale;
  const halfSpacing = .135 * scale;
  const offset = Math.sqrt((kit.BALL_R + railRadius) ** 2 - halfSpacing ** 2);
  for (let i = 0; i < position.count; i += 1) {
    const u = segment.model_reversed ? 1 - path[0].getX(i) : path[0].getX(i);
    if (!Number.isFinite(u) || u < -1e-6 || u > 1 + 1e-6) throw new Error('Invalid slide path coordinate');
    const center = kit.channelCenter(segment, u);
    const normal = kit.channelNormal(segment, u);
    const a = kit.channelCenter(segment, Math.max(0, u - 1e-4));
    const b = kit.channelCenter(segment, Math.min(1, u + 1e-4));
    const length = Math.hypot(...a.map((v, k) => b[k] - v)) || 1;
    const tangent = a.map((v, k) => (b[k] - v) / length);
    const acrossLength = Math.hypot(tangent[0],tangent[2]) || 1;
    const across = segment.spatial ? [tangent[2]/acrossLength,0,-tangent[0]/acrossLength] : [0,0,1];
    const n = path[1].getX(i) * scale - offset;
    const t = path[2].getX(i) * scale * (segment.model_reversed ? -1 : 1);
    const z = path[3].getX(i) * scale;
    position.setXYZ(i, center[0] + normal[0] * n + tangent[0] * t + across[0] * z,
      center[1] + normal[1] * n + tangent[1] * t + across[1] * z,
      center[2] + normal[2] * n + tangent[2] * t + across[2] * z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}
