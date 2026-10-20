/** Verify the current staggered wall course without overwriting old baselines. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as kit from '../src/layout.mjs';
import {buildGravityLayout} from '../src/gravity_layout.mjs';

const out=path.resolve('ball3d/out/web_editor/staggered_faces');
fs.mkdirSync(out,{recursive:true});
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
for(const base of ['4','45','10']) {
  const plan=JSON.parse(fs.readFileSync(path.resolve('ball3d/out/web_editor/search_fix',`plan_${base}.json`)));
  const start=performance.now(),layout=buildGravityLayout(plan,kit,config),ms=performance.now()-start;
  const p=layout.audit.spatial.phrasing,w=layout.audit.spatial.board_width;
  const edges=layout.boards.slice(1).map((b,i)=>({
    dx:Math.abs(b.p[0]-layout.boards[i].p[0])/w,dy:(layout.boards[i].top_y-b.top_y)/w,
    level:b.level_group!=null||layout.boards[i].level_group!=null,
    rebound:b.rebound_pair!=null||layout.boards[i].rebound_pair!=null}));
  const regular=edges.slice(1).filter((b,i)=>{
    const a=edges[i];
    return !a.level&&!b.level&&!a.rebound&&!b.rebound&&
      Math.abs(a.dx-b.dx)/Math.max(a.dx,b.dx)<.15&&Math.abs(a.dy-b.dy)/Math.max(a.dy,b.dy)<.15;
  }).length;
  assert.equal(layout.audit.clearance_fails,0);
  assert.equal(layout.audit.plank_overlaps,0);
  assert.equal(regular,0,'ordinary downward steps vary in height or horizontal distance');
  assert.ok(p.descending_steps>=.8*(layout.boards.length-1));
  assert.ok(p.level_groups.length>0&&p.rebound_pairs.length>0);
  const result={base,ms,boards:layout.boards.length,levels:p.level_groups.length,reboundPairs:p.rebound_pairs,
    descendingRatio:p.descending_steps/(layout.boards.length-1),regular,
    maxTilt:layout.audit.spatial.steering.max_tilt_degrees,
    horizontalWidths:[Math.min(...edges.map(e=>e.dx)),Math.max(...edges.map(e=>e.dx))],audit:layout.audit};
  for(const [name,value] of [['plan',plan],['layout',layout],['result',result]])
    fs.writeFileSync(path.join(out,`${name}_${base}.json`),JSON.stringify(value));
  console.log(JSON.stringify({...result,audit:undefined}));
}
