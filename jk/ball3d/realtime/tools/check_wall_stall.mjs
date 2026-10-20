/** Reproduce and verify the full 335-note score; no video. */
import fs from 'node:fs';
import * as kit from '../src/layout.mjs';
import { buildWallCourse } from '../src/wall_course.mjs';
const base=process.argv.find(a=>/^\d+$/.test(a))||'10';
const out='ball3d/out/web_editor/stall282/';
const plan=JSON.parse(fs.readFileSync('ball3d/out/web_editor/search_fix/plan_'+base+'.json'));
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const progress=[],started=performance.now();let high=-1;
try {
 const layout=buildWallCourse(plan,kit,config,p=>{
  progress.push(p);
  if(p.completed>high+39||p.stage==='重新规划局部节奏'){
   high=Math.max(high,p.completed??0);console.log(JSON.stringify({...p,ms:Math.round(performance.now()-started)}));
  }
 });
 const ms=performance.now()-started;
 fs.writeFileSync(out+'layout_'+base+'.json',JSON.stringify(layout));
 fs.writeFileSync(out+'result_'+base+'.json',JSON.stringify({ms,audit:layout.audit,progress},null,1));
 console.log(JSON.stringify({done:true,ms,audit:layout.audit}));
 if(layout.audit.clearance_fails||layout.audit.plank_overlaps)process.exitCode=1;
} catch(e) {
 fs.writeFileSync(out+'failure_'+base+'.json',JSON.stringify({ms:performance.now()-started,error:e.message,progress},null,1));
 console.error(e);process.exitCode=1;
}
