/** Real-score search regression and numerical acceptance (no video export). */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as kit from '../src/layout.mjs';
import {buildGravityLayout} from '../src/gravity_layout.mjs';
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const out='ball3d/out/web_editor/search_fix/';
for(const base of process.argv.slice(2).length?process.argv.slice(2):['10','45','4']) {
 const plan=JSON.parse(fs.readFileSync(out+'plan_'+base+'.json'));
 const progress=[],started=performance.now();let high=-1;
 const layout=buildGravityLayout(plan,kit,config,p=>{
   progress.push(p);
   if(p.completed>high+39||p.stage==='重新规划局部节奏') {
     high=Math.max(high,p.completed);console.log(JSON.stringify({base,...p,ms:Math.round(performance.now()-started)}));
   }
 });
 const ms=performance.now()-started,a=layout.audit;
 assert.equal(layout.boards.length,plan.landings.length);
 assert.equal(a.forced,0);assert.equal(a.clearance_fails,0);assert.equal(a.plank_overlaps,0);
 assert.ok(a.min_contact_spacing>=a.required_contact_spacing);
 const report={base,notes:plan.landings.length,ms,audit:a,placementVisits:progress.filter(p=>p.stage==='排列木板').length,progress};
 fs.writeFileSync(out+'result_'+base+'.json',JSON.stringify(report,null,1));
 fs.writeFileSync(out+'layout_'+base+'.json',JSON.stringify(layout));
 console.log(JSON.stringify({base,done:true,ms,steering:a.spatial.steering,phrasing:a.spatial.phrasing,rails:layout.channels.length}));
}
