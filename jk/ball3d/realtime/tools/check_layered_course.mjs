/** Real-song acceptance for sparse shelves; this never encodes a video. */
import fs from 'node:fs';
import path from 'node:path';
import * as kit from '../src/layout.mjs';
import {buildGravityLayout} from '../src/gravity_layout.mjs';
const out=path.resolve('ball3d/out/web_editor/sparse_layers');
fs.mkdirSync(out,{recursive:true});
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
for(const base of ['4','45','10']) {
  const file=path.resolve('ball3d/out/web_editor/search_fix',`plan_${base}.json`);
  const plan=JSON.parse(fs.readFileSync(file)),started=performance.now(),progress=[];
  const layout=buildGravityLayout(plan,kit,config,p=>progress.push(p));
  const ms=performance.now()-started;
  fs.writeFileSync(path.join(out,`plan_${base}.json`),JSON.stringify(plan));
  fs.writeFileSync(path.join(out,`layout_${base}.json`),JSON.stringify(layout));
  fs.writeFileSync(path.join(out,`result_${base}.json`),JSON.stringify({ms,progress,audit:layout.audit},null,2));
  console.log(JSON.stringify({base,ms,boards:layout.boards.length,groups:layout.groups.length,
    levelGroups:layout.audit.spatial.phrasing.level_groups.length,
    levelSteps:layout.audit.spatial.phrasing.level_steps,descendingSteps:layout.audit.spatial.phrasing.descending_steps,
    sizes:[...new Set(layout.groups.map(g=>g.members.length))].sort(),clearance:layout.audit.clearance_fails,
    minSpacing:layout.audit.min_contact_spacing,tilt:layout.audit.spatial.steering.max_tilt_degrees}));
  if(layout.audit.clearance_fails||layout.audit.plank_overlaps||layout.audit.spatial.phrasing.level_steps>.2*(layout.boards.length-1))process.exitCode=1;
}
