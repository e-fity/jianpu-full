/** Browser acceptance for the formerly stalled 335-note course; no video. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const out=path.resolve('ball3d/out/web_editor/search_fix'),report={errors:[],checks:[]};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>report.errors.push(e.message));
const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});console.log(JSON.stringify({name,ok,detail}));assert.ok(ok,name);};
await page.addInitScript(()=>{
 const NativeWorker=Worker;window.jobs=[];window.ticks=[];
 window.Worker=class extends NativeWorker {
  constructor(...args){super(...args);this.record={started:performance.now(),progress:[],stopped:false};window.jobs.push(this.record);
   this.addEventListener('message',({data})=>{if(data.progress)this.record.progress.push({...data.progress,ms:performance.now()-this.record.started});});}
  postMessage(data,...args){this.record.notes=data.plan.landings.length;return super.postMessage(data,...args);}
  terminate(){this.record.stopped=true;this.record.ended=performance.now();return super.terminate();}
 };
 let previous=performance.now();setInterval(()=>{const now=performance.now();if(window.jobs.some(j=>!j.stopped))window.ticks.push(now-previous);previous=now;},50);
});
const ready=()=>page.waitForFunction(()=>window.__editor&&!__editor.state.pending&&__editor.state.solve.state==='ok'&&__editor.state.scene,null,{timeout:240000});
try {
 await page.goto('http://127.0.0.1:8011/editor?base=10',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__editor&&window.jobs.length);
 await page.locator('#audio-toggle').uncheck();
 await ready();await page.evaluate(()=>__editor.pause());
 const solved=await page.evaluate(()=>({layout:__editor.state.layout,progress:document.getElementById('layout-progress').value,label:document.getElementById('layout-progress-label').textContent,jobs:window.jobs}));
 const rounded=value=>JSON.stringify(value,(_,v)=>typeof v==='number'?Math.round(v*1e9)/1e9:v);
 check('Worker and command line agree within floating point precision',rounded(solved.layout)===rounded(JSON.parse(fs.readFileSync(path.join(out,'layout_10.json')))));
 check('335-note Worker finishes and matches the command-line solve',solved.layout.boards.length===335,{progress:solved.progress,label:solved.label,workerMs:solved.jobs[0].ended-solved.jobs[0].started});
 check('progress reaches 100 only after passing',solved.progress===100&&solved.layout.audit.clearance_fails===0);
 report.first={jobs:solved.jobs,audit:solved.layout.audit};
 const ticks=await page.evaluate(()=>window.ticks.slice().sort((a,b)=>a-b));report.timing={p95:ticks[Math.floor(ticks.length*.95)],max:ticks.at(-1)};
 await page.screenshot({path:path.join(out,'editor_completed.png')});
 await page.selectOption('#song','45');await page.waitForFunction(()=>__editor.state.pending&&window.jobs.length===2);
 await page.selectOption('#song','4');await page.locator('#song-switch-dialog').waitFor({state:'visible'});
 await page.locator('#song-switch-dialog button[value="no"]').click();
 check('No keeps the old layout task running',await page.evaluate(()=>__editor.state.song.base==='45'&&!window.jobs[1].stopped));
 await page.selectOption('#song','4');await page.locator('#song-switch-dialog').waitFor({state:'visible'});
 await page.locator('#song-switch-dialog button[value="yes"]').click();
 await ready();await page.evaluate(()=>__editor.pause());
 report.second=await page.evaluate(()=>({jobs:window.jobs,notes:__editor.state.layout.boards.length,audit:__editor.state.layout.audit,progress:document.getElementById('layout-progress').value}));
 check('Yes cancels the old worker and the new 164-note course completes',report.second.jobs[1].stopped&&report.second.notes===164&&report.second.progress===100);
 const cache=await page.evaluate(async()=>{const n=window.jobs.length,t=performance.now();const ok=await __editor.resolveLayout();return {ok,workers:window.jobs.length-n,ms:performance.now()-t};});
 check('same completed configuration reuses cache',cache.ok&&cache.workers===0,cache);
 check('no browser errors',report.errors.length===0,report.errors);
} finally {
 fs.writeFileSync(path.join(out,'editor_report.json'),JSON.stringify(report,null,1));await browser.close();
}
