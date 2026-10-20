/** Inspect the browser scene without encoding or exporting a video. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [planPath,outPath,startArg='18.5',secondsArg='30',layoutPath,levelAuditArg]=process.argv.slice(2);
if(!planPath||!outPath)throw new Error('usage: node preview_wall.mjs PLAN.json OUT_DIR [START] [SECONDS] [LAYOUT.json] [levels]');
const out=path.resolve(outPath),config=JSON.parse(fs.readFileSync(path.join(root,'config.json')));
fs.mkdirSync(out,{recursive:true});
const entry=`
import * as THREE from 'three';
import { buildMusicMachine } from './music_machine.mjs';
import { boardPose } from './spatial_course.mjs';
import { wallSwing } from './wall_course.mjs';
const plan=await (await fetch('/plan')).json(),presentation=await (await fetch('/config')).json();
const layout=${layoutPath?"await (await fetch('/layout')).json()":"undefined"};
const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true,preserveDrawingBuffer:true});
renderer.setSize(720,1280,false);renderer.setPixelRatio(1);renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
renderer.debug.onShaderError=(gl,p)=>{throw new Error(gl.getProgramInfoLog(p));};
const machine=await buildMusicMachine({renderer,plan,presentation,layout,width:720,height:1280,bloom:true,glbUrl:'/glb',hdrUrl:'/hdr'});
window.preview={machine,renderer,THREE,boardPose,wallSwing,presentation};
`;
const bundled=await build({stdin:{contents:entry,resolveDir:path.join(root,'src'),sourcefile:'preview.mjs'},bundle:true,
  format:'esm',platform:'browser',target:'edge120',write:false});
const server=http.createServer((req,res)=>{
  const route=new URL(req.url,'http://localhost').pathname;
  const files={'/plan':path.resolve(planPath),'/glb':path.resolve(root,'../assets/reference_music_machine.glb'),
    '/hdr':path.resolve(root,'../assets',config.environment.file)};
  if(layoutPath)files['/layout']=path.resolve(layoutPath);
  if(route==='/'){res.setHeader('Content-Type','text/html');res.end('<style>body{margin:0;background:#222}canvas{display:block}</style><canvas></canvas><script type="module" src="/preview.js"></script>');}
  else if(route==='/preview.js'){res.setHeader('Content-Type','text/javascript');res.end(bundled.outputFiles[0].contents);}
  else if(route==='/config'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(config));}
  else if(files[route]){res.setHeader('Content-Type',route==='/plan'?'application/json':'application/octet-stream');fs.createReadStream(files[route]).pipe(res);}
  else {res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const page=await browser.newPage({viewport:{width:720,height:1280},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded',timeout:120000});
  await page.waitForFunction(()=>Boolean(window.preview),null,{timeout:300000});
  await page.evaluate(t=>{preview.machine.update(t);preview.machine.render();preview.machine.render();},+startArg);
  const frames=await page.evaluate(({start,seconds})=>{
    const frames=[];
    for(let i=0;i<seconds*60;i++){preview.machine.update(start+i/60);preview.machine.render();frames.push(preview.machine.measureFrame());}
    return frames;
  },{start:+startArg,seconds:+secondsArg});
  const times=[0,1.22,2.3,4.93,8.5,13.4,17.5,23.7,28.3].filter(offset=>offset<+secondsArg).map(offset=>+startArg+offset);
  const hashes=[];
  for(const t of times) {
    await page.evaluate(t=>{preview.machine.update(t);preview.machine.render();},t);
    const png=await page.locator('canvas').screenshot();
    fs.writeFileSync(path.join(out,`frame_${t.toFixed(2)}.png`),png);hashes.push(png);
  }
  const repeats=[];
  for(let i=times.length-1;i>=0;i--) {
    await page.evaluate(t=>{preview.machine.update(t);preview.machine.render();},times[i]);
    repeats.push({t:times[i],identical:(await page.locator('canvas').screenshot()).equals(hashes[i])});
  }
  const levelPairs=[],turns=[];
  if(levelAuditArg==='levels'&&layoutPath) {
    const solved=JSON.parse(fs.readFileSync(layoutPath));
    for(const b of solved.boards.filter(b=>b.level_repeat)) {
      const a=solved.boards[b.i-1],samples=[];
      for(const [phase,t] of [['before',a.t-.02],['flight',(a.t+b.t)/2],['landing',b.t]]) {
        const frame=await page.evaluate(t=>{preview.machine.update(t);preview.machine.render();return preview.machine.measureFrame();},t);
        const bounds=[a,b].map(board=>frame.plank_screen_bounds.find(p=>p.index===board.i));
        const heightError=bounds.every(Boolean)?Math.abs(bounds[0].min[1]+bounds[0].max[1]-bounds[1].min[1]-bounds[1].max[1])*320:null;
        const horizontalGap=bounds.every(Boolean)?Math.max(0,Math.max(...bounds.map(p=>p.min[0]))-Math.min(...bounds.map(p=>p.max[0])))*360:null;
        samples.push({phase,t,height_error_px:heightError,horizontal_gap_px:horizontalGap,ball_inside:frame.ball_inside,ball_occluded_by:frame.ball_occluded_by});
        fs.writeFileSync(path.join(out,`level_${b.i}_${phase}.png`),await page.locator('canvas').screenshot());
      }
      levelPairs.push({from:a.i,to:b.i,onset:b.t,samples});
    }
    fs.writeFileSync(path.join(out,'level_pairs.json'),JSON.stringify(levelPairs,null,2));
  }
  if(levelAuditArg==='turns'&&layoutPath) {
    const solved=JSON.parse(fs.readFileSync(layoutPath));
    for(const b of solved.boards.filter(b=>b.surface_accent)) {
      const previous=solved.boards[b.i-1],samples=[];
      for(const [phase,t] of [['before',previous.t-.02],['landing',b.t]]) {
        const measured=await page.evaluate(({index,t})=>{
          const {machine,THREE,boardPose,wallSwing,presentation}=preview;
          machine.update(t);machine.render();
          const frame=machine.measureFrame();
          const surfaces=[index-1,index,index+1].map(i=>{
            const board=machine.layout.boards[i],pose=boardPose(board,board.size[1],wallSwing(t,board,presentation.boards));
            const normal=new THREE.Vector3(0,1,0).applyQuaternion(pose.quaternion);
            return {index:i,tilt_degrees:Math.acos(Math.max(-1,Math.min(1,normal.y)))*180/Math.PI,
              lateral_degrees:Math.atan2(normal.x,normal.y)*180/Math.PI,slope_degrees:Math.atan2(normal.z,normal.y)*180/Math.PI};
          });
          return {t,surfaces,opposite:[surfaces[0],surfaces[2]].some(s=>s.lateral_degrees*surfaces[1].lateral_degrees<0),ball_inside:frame.ball_inside,
            overlaps:frame.plank_screen_overlaps,ball_occluded_by:frame.ball_occluded_by,
            both_visible:[index-1,index].every(i=>frame.plank_screen_bounds.some(p=>p.index===i))};
        },{index:b.i,t});
        samples.push({phase,...measured});
        fs.writeFileSync(path.join(out,`turn_${b.i}_${phase}.png`),await page.locator('canvas').screenshot());
      }
      turns.push({index:b.i,time:b.t,lyric:b.lyric,tilt_degrees:b.tilt*180/Math.PI,samples});
    }
    fs.writeFileSync(path.join(out,'turns.json'),JSON.stringify(turns,null,2));
  }
  const stats=await page.evaluate(()=>preview.machine.stats());
  const report={errors,config,stats,frames,repeats,levelPairs,turns};fs.writeFileSync(path.join(out,'browser_report.json'),JSON.stringify(report));
  const sorted=key=>frames.map(f=>f[key]).sort((a,b)=>a-b),widths=sorted('ball_width_fraction'),ys=frames.map(f=>f.ball_screen[1]).sort((a,b)=>a-b);
  const futureVisible=frames.map(f=>f.plank_screen_bounds.filter(p=>f.future_boards.some(b=>b.index===p.index)).length);
  console.log(JSON.stringify({errors,frames:frames.length,board_overlap_frames:frames.filter(f=>f.plank_screen_overlaps.length).length,
    ball_occlusion_frames:frames.filter(f=>f.ball_occluded_by.length).length,ball_outside_frames:frames.filter(f=>!f.ball_inside).length,
    label_overlaps:frames.flatMap(f=>f.label_overlaps).length,future:[Math.min(...frames.map(f=>f.future_complete)),Math.max(...frames.map(f=>f.future_complete))],
    future_visible:[Math.min(...futureVisible),Math.max(...futureVisible)],
    ball_width:[widths[0],widths[Math.floor(widths.length/2)],widths.at(-1)],ball_y:ys[Math.floor(ys.length/2)],repeats,rails:stats.spatial.rails}));
  if(errors.length)process.exitCode=1;
} finally {
  if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
}
