import * as THREE from 'three';
import { railTimeAtU } from './expressive_rails.mjs';

export function railVisible(rail,t,wallMounted=false) {
  // Fixed wall fixtures remain present; the camera determines what is in view.
  if(wallMounted)return true;
  // Each rail belongs to its uninterrupted sounding phrase. Geometry outside
  // that phrase is retired, so old or upcoming rails cannot fill a rest frame.
  return t>=rail.visibleFrom-1e-9 && t<rail.visibleUntil-1e-9;
}
export function passageGlow(t,passedAt,decay) {
  return t<passedAt?0:Math.exp(-(t-passedAt)/decay);
}
export function withRailGlow(material,geometry,rail,config,clock) {
  const path=geometry.getAttribute('_slide_u')||geometry.getAttribute('_SLIDE_U');
  const times=Float32Array.from({length:path.count},(_,i)=>railTimeAtU(rail,path.getX(i)));
  geometry.setAttribute('aPassTime',new THREE.BufferAttribute(times,1));
  material.onBeforeCompile=shader=>{
    shader.uniforms.railAge=clock;
    shader.uniforms.railDecay={value:config.trailSeconds};
    shader.vertexShader=shader.vertexShader.replace('#include <common>',
      '#include <common>\nattribute float aPassTime; varying float vPassTime;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvPassTime=aPassTime;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',
      '#include <common>\nvarying float vPassTime; uniform float railAge; uniform float railDecay;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\nfloat age=railAge-vPassTime; float glow=step(0.0,age)*exp(-max(0.0,age)/railDecay); totalEmissiveRadiance+=vec3(1.0,0.48,0.06)*glow;');
  };
  material.customProgramCacheKey=()=> 'ball3d-rail-passage-glow';
  return material;
}
