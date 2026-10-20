/** Exercise the actual editor and Worker; no video is produced. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const out=path.resolve('ball3d/out/web_editor/sparse_layers'),report={checks:[],errors:[]};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>report.errors.push(e.message));
const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});console.log(JSON.stringify({name,ok,detail}));assert.ok(ok,name);};
await page.addInitScript(()=>{
  const NativeWorker=Worker;window.jobs=[];
  window.Worker=class extends NativeWorker {
    constructor(...args){super(...args);this.record={started:performance.now(),progress:[]};jobs.push(this.record);
      this.addEventListener('message',({data})=>{if(data.progress)this.record.progress.push(data.progress);});}
    postMessage(data,...args){this.record.notes=data.plan.landings.length;return super.postMessage(data,...args);}
    terminate(){this.record.ended=performance.now();return super.terminate();}
  };
});
const ready=base=>page.waitForFunction(base=>window.__editor&&__editor.state.song?.base===base&&!__editor.state.pending&&__editor.state.solve.state==='ok'&&__editor.state.scene,base,{timeout:30000});
try {
  await page.goto('http://127.0.0.1:8010/editor?base=10',{waitUntil:'domcontentloaded'});
  await ready('10');await page.evaluate(()=>{__editor.pause();document.getElementById('audio-toggle').checked=false;});
  for(const [base,count] of [['10',335],['4',164],['45',215]]) {
    if(base!=='10'){await page.selectOption('#song',base);await ready(base);await page.evaluate(()=>__editor.pause());}
    const solved=await page.evaluate(()=>({layout:__editor.state.layout,mode:__editor.state.presentation.spatial.layeredPhrases,
      progress:document.getElementById('layout-progress').value,job:window.jobs.at(-1)}));
    const rounded=value=>JSON.stringify(value,(_,v)=>typeof v==='number'?Math.round(v*1e9)/1e9:v);
    check(`${count} notes: default layers complete in the real Worker`,solved.mode&&solved.progress===100&&solved.layout.boards.length===count,
      {workerMs:solved.job.ended-solved.job.started,layers:solved.layout.groups.length});
    check(`${count} notes: browser and CLI layouts agree`,rounded(solved.layout)===rounded(JSON.parse(fs.readFileSync(path.join(out,`layout_${base}.json`)))));
    check(`${count} notes: physical and level checks pass`,solved.layout.audit.clearance_fails===0&&solved.layout.audit.plank_overlaps===0&&
      solved.layout.audit.spatial.phrasing.level_groups.every(g=>g.end-g.start>=3&&g.end-g.start<=5&&g.top_y_range.every(y=>Math.abs(y-g.y)<1e-10))&&
      solved.layout.audit.spatial.phrasing.level_steps<=.2*(count-1)&&solved.layout.audit.spatial.phrasing.descending_steps>=.8*(count-1));
    const selected=solved.layout.audit.spatial.phrasing.level_groups[0],index=selected.index;
    const times=solved.layout.audit.spatial.phrasing.phrase_groups.slice(index-1,index+2).map(g=>(g.t0+g.t1)/2);
    for(const t of times) {
      await page.evaluate(t=>__editor.setTime(t),t);
      await page.locator('#view').screenshot({path:path.join(out,`editor_${base}_${t.toFixed(2)}.png`)});
    }
    const playback=await page.evaluate(async()=>{const a=__editor.state.t;__editor.play();await new Promise(r=>setTimeout(r,300));__editor.pause();return {a,b:__editor.state.t};});
    check(`${count} notes: playback advances`,playback.b>playback.a,playback);
    report[base]={audit:solved.layout.audit,workerMs:solved.job.ended-solved.job.started};
  }
  const cache=await page.evaluate(async()=>{const count=jobs.length,t=performance.now(),ok=await __editor.resolveLayout();return {ok,workers:jobs.length-count,ms:performance.now()-t};});
  check('the same layered layout reuses cache',cache.ok&&cache.workers===0,cache);
  check('no page script errors',report.errors.length===0,report.errors);
} finally {
  fs.writeFileSync(path.join(out,'editor_report.json'),JSON.stringify(report,null,2));await browser.close();
}
