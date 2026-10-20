import { chromium } from "playwright-core";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const out=new URL("../../out/expressive_rails/",import.meta.url);
const server=spawn("D:/python/python11/python.exe",["webapp.py","--port","8012"],{
  cwd:fileURLToPath(new URL("../../../",import.meta.url)),windowsHide:true,stdio:"ignore",
  env:{...process.env,PYTHONUTF8:"1"},
});
let browser;
try {
  for(let i=0;i<100;i++) {
    if(server.exitCode!==null)throw new Error(`QA server exited: ${server.exitCode}`);
    try { if((await fetch("http://127.0.0.1:8012/editor")).ok)break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  browser=await chromium.launch({channel:"msedge",headless:true});
  const page=await browser.newPage({viewport:{width:1450,height:1300}}),errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto("http://127.0.0.1:8012/editor");
  await page.waitForFunction(()=>window.__editor);
  const response=await page.request.post("http://127.0.0.1:8012/api/editor/import?name=10_notes.json",{
    data:fs.readFileSync("D:/Downloads/10_notes.json"),headers:{"content-type":"application/json"},
  });
  const imported=await response.json();assert.equal(imported.ok,true);
  await page.evaluate(async id=>window.__editor.loadSong({import:id}),imported.import);
  await page.waitForFunction(()=>window.__editor.state.scene,null,{timeout:120000});
  await page.evaluate(()=>{
    const editor=window.__editor;editor.pause();editor.setTime(18);
    window.__gravityBefore=editor.state.layout;
    const gravity=editor.state.presentationGui.controllersRecursive().find(c=>c.property==="longMinSeconds");
    gravity.setValue(.8);gravity._callOnFinishChange();
  });
  await page.waitForFunction(()=>window.__editor.state.scene?.stats().presentation.tracks.longMinSeconds===.8);
  await page.evaluate(()=>{
    const state=window.__editor.state;
    window.__physicsChanged=state.layout!==window.__gravityBefore&&state.layout.audit.tracks.long!==window.__gravityBefore.audit.tracks.long;
    const gravity=state.presentationGui.controllersRecursive().find(c=>c.property==="longMinSeconds");
    gravity.setValue(.5);gravity._callOnFinishChange();
  });
  await page.waitForFunction(()=>window.__editor.state.scene?.stats().presentation.tracks.longMinSeconds===.5);
  const result=await page.evaluate(()=>{
    const editor=window.__editor,state=editor.state;
    const properties=state.presentationGui.controllersRecursive().map(c=>c.property);
    const physicsChanged=window.__physicsChanged,restored=state.layout===window.__gravityBefore;
    const built=state.scene,config=state.presentation;
    const index=built.layout.boards.findIndex(b=>b.hits[0].scale>.15);
    const board=built.scene.getObjectByName(`NoteBoard_${index}`),rod=built.scene.getObjectByName(`BoardRod_${index}`);
    const matrix=board.matrix.clone(),joint=board.position.clone().set(0,-.03,0),vertex=joint.clone();
    const onset=built.layout.boards[index].t,snapshots=[];
    for(const age of [-.01,0,.1,.2,1.9,.1]){
      built.update(onset+age);board.getMatrixAt(0,matrix);
      snapshots.push({age,hinge:joint.clone().applyMatrix4(matrix).toArray(),
        board:Array.from(matrix.elements),rod:rod.matrixWorld.toArray(),
        rodVertex:vertex.fromBufferAttribute(rod.geometry.getAttribute("position"),0).applyMatrix4(rod.matrixWorld).toArray()});
    }
    let overlapFrames=0,ballOutside=0,ordinaryChecks=0,futureFailures=0,restFrames=0,restRails=0,maxBoards=0,minGap=Infinity;
    for(let frame=0;frame<Math.ceil(built.layout.duration*10);frame++){
      built.update(frame/10);const sample=built.measureFrame();
      restFrames+=sample.rest?1:0;restRails+=sample.rest&&sample.visible_rails.length?1:0;maxBoards=Math.max(maxBoards,sample.boards_across);
      overlapFrames+=sample.plank_screen_overlaps.length>0?1:0;
      ballOutside+=sample.ball_inside?0:1;
      if(sample.upcoming.length>=2){ordinaryChecks++;futureFailures+=sample.future_complete<2?1:0;}
      const planks=sample.plank_screen_bounds;
      for(let i=0;i<planks.length;i++)for(let j=0;j<i;j++){
        const a=planks[i],b=planks[j];
        const dx=Math.max(0,a.min[0]-b.max[0],b.min[0]-a.max[0])*120;
        const dy=Math.max(0,a.min[1]-b.max[1],b.min[1]-a.max[1])*120*16/9;
        minGap=Math.min(minGap,Math.hypot(dx,dy));
      }
    }
    editor.setTime(27.2);
    return {properties,physicsChanged,restored,hinge:{index,onset,snapshots},
      whole_song:{fps:10,overlapFrames,ballOutside,ordinaryChecks,futureFailures,restFrames,restRails,maxBoards,minGapPixels240:minGap},
      stats:built.stats()};
  });
  fs.writeFileSync(new URL("gui_check.json",out),JSON.stringify({errors,...result},null,2));
  for(const key of ["gravity","longMinSeconds","longMedianFactor","glissMinNotes","glissMedianFactor","glissMaxSemitones","minFlightSeconds","maxLengthWidths","trailSeconds","beadSeconds","rodLengthWidths","maxTilt","dampingRatio","angularFrequency","deadZoneX","deadZoneY","heightSpread","heightFade"])
    assert.ok(result.properties.includes(key),key);
  assert.ok(result.physicsChanged&&result.restored,"physics GUI must change and restore the cached course");
  const base=result.hinge.snapshots[0];
  for(const pose of result.hinge.snapshots){
    assert.deepEqual(pose.rod,base.rod);assert.deepEqual(pose.rodVertex,base.rodVertex);
    // Instance matrices use float32; allow two ULPs at this world coordinate.
    assert.ok(Math.hypot(...pose.hinge.map((x,k)=>x-base.hinge[k]))<2e-7*Math.max(1,...base.hinge.map(Math.abs)));
  }
  assert.notDeepEqual(result.hinge.snapshots[1].board,base.board);
  assert.deepEqual(result.hinge.snapshots[2].board,result.hinge.snapshots[5].board);
  assert.equal(result.whole_song.overlapFrames,0);
  assert.equal(result.whole_song.ballOutside,0);
  assert.equal(result.whole_song.futureFailures,0);
  assert.equal(result.whole_song.restRails,0);
  assert.ok(result.whole_song.maxBoards<=7+1e-9);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(new URL("gui_check.json",out),JSON.stringify({ok:true,errors,...result},null,2));
  await page.screenshot({path:fileURLToPath(new URL("editor.png",out)),fullPage:true});
  console.log(JSON.stringify({ok:true,whole_song:result.whole_song,physicsChanged:result.physicsChanged,rodFixed:true}));
}finally{if(browser)await browser.close();server.kill();}
