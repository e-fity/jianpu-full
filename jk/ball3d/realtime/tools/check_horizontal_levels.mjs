/** Horizontal repeated-note rows: numerical acceptance, no video. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as kit from '../src/layout.mjs';
import {buildGravityLayout,transitionVelocity} from '../src/gravity_layout.mjs';
const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
const out='ball3d/out/web_editor/horizontal_levels/';
for(const name of process.argv.slice(2).length?process.argv.slice(2):['row3','row6']) {
 const n=Number(name.slice(3));
 const plan=name.startsWith('row')?{duration:23,tempo_qpm:120,landings:Array.from({length:40},(_,i)=>
   ({t:1+i*.5,midi:i>=24&&i<24+n?60:60+i,n:i>=24&&i<24+n?1:1+i%7,dur:.5,lyric:i>=24&&i<24+n?'同':''}))}:
   JSON.parse(fs.readFileSync(out+'plan_'+name+'.json'));
 let high=-1;const started=performance.now();
 const layout=buildGravityLayout(plan,kit,config,p=>{
   if(p.completed>high+19||p.stage==='重新规划局部节奏') {
     high=Math.max(high,p.completed);console.log(JSON.stringify({name,...p,ms:Math.round(performance.now()-started)}));
   }
 });
 const groups=layout.audit.spatial.phrasing.level_groups;
 assert.equal(layout.audit.clearance_fails,0);assert.equal(layout.audit.plank_overlaps,0);
 assert.ok(layout.audit.min_contact_spacing>=layout.audit.required_contact_spacing);
 console.log(JSON.stringify({name,groups,steering:layout.audit.spatial.steering}));
 // Clearance can shorten a long run, but can never leave a two-board row.
 if(name.startsWith('row'))assert.ok(groups.some(g=>g.end-g.start+1>=3&&g.end-g.start+1<=n),'retain a legal row from the candidate run');
 for(const g of groups) {
   const row=layout.boards.slice(g.start,g.end+1);
   assert.ok(row.length>=3&&row.length<=6);
   for(const b of row) {
     assert.deepEqual(b.quaternion,[0,0,0,1]);assert.equal(b.tilt,0);
     assert.deepEqual(b.collision.normal,[0,1,0]);
     assert.equal(b.midi,row[0].midi);assert.equal(b.top_y,row[0].top_y);
     assert.equal(b.pos[2],row[0].pos[2]);assert.deepEqual(b.size,row[0].size);
     const incoming=layout.segments.find(s=>Math.abs(s.t1-b.t)<1e-8),outgoing=layout.segments.find(s=>Math.abs(s.t0-b.t)<1e-8);
     const vin=transitionVelocity(incoming,1),vout=transitionVelocity(outgoing,0);
     assert.ok(Math.hypot(vin[0]-vout[0],vin[2]-vout[2])<1e-9);
   }
 }
 const report={name,ms:performance.now()-started,notes:layout.boards.length,audit:layout.audit};
 fs.writeFileSync(out+'plan_'+name+'.json',JSON.stringify(plan));
 fs.writeFileSync(out+'layout_'+name+'.json',JSON.stringify(layout));
 fs.writeFileSync(out+'result_'+name+'.json',JSON.stringify(report,null,1));
 console.log(JSON.stringify({name,done:true,ms:report.ms,groups,rails:layout.channels.length}));
}
