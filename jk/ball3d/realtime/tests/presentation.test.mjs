import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { boardSpring, shadowPresentation, deadZone, visibleBoards, cameraPresentation, validatePresentation } from "../src/presentation.mjs";
const C = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url)));
// Explicit legacy mode: these tests preserve the previous renderer contract.
C.spatial.enabled=false; C.ball.screenWidth=.11; C.camera.yaw=0; C.boards.sideDiameters=1.25;

test("camera looks downward 20..30 degrees from above its Gaussian target", () => {
  for (const downwardTilt of [20, 25, 30]) {
    const config = structuredClone(C); config.camera.downwardTilt = downwardTilt;
    const view = cameraPresentation(t => [t, -t, 0], 20, 5, 9/16, .1, config);
    assert.ok(view.position[1] > view.target[1]);
    const camera = new THREE.PerspectiveCamera(config.camera.fov, 9/16, .05, 400);
    camera.position.fromArray(view.position); camera.lookAt(...view.target);
    const look = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(Math.abs(-Math.asin(look.y) * 180 / Math.PI - downwardTilt) < 1e-10);
  }
});
test("horizontal coverage never exceeds seven board widths at ball depth", () => {
  for (const fov of [35, 37, 40]) for (const aspect of [9/16, 16/9]) {
    const config = structuredClone(C); config.camera.fov = fov;
    const radius = .1, sample = () => [0, 0, 0];
    const view = cameraPresentation(sample, 20, 5, aspect, radius, config);
    const camera = new THREE.PerspectiveCamera(fov, aspect, .05, 400);
    camera.position.fromArray(view.position); camera.lookAt(...view.target); camera.updateMatrixWorld();
    const side = 2 * radius * config.boards.sideDiameters;
    const left = new THREE.Vector3(-side * 7 / 2, 0, 0).project(camera);
    const right = new THREE.Vector3(side * 7 / 2, 0, 0).project(camera);
    assert.ok(right.x - left.x >= 2 - 1e-10);
    assert.ok(view.horizontalSpan <= 7 * side + 1e-10);
    assert.ok(view.boardsAcross <= 7 + 1e-10);
    // The default seven-wide framing still keeps the sphere within 10..12%.
    const ballFraction = radius / (aspect * Math.tan(fov * Math.PI / 360) * Math.sqrt(view.depth ** 2 - radius ** 2));
    assert.ok(ballFraction >= .1 && ballFraction <= .12);
  }
});

test("a high future arc cannot flip the camera or clip the off-axis sphere",()=>{
  const sample=t=>[t,15*(t-5)**2,0],aspect=9/16,radius=.1;
  const view=cameraPresentation(sample,20,5,aspect,radius,C);
  const camera=new THREE.PerspectiveCamera(C.camera.fov,aspect,.05,400);
  camera.position.fromArray(view.position);camera.lookAt(...view.lookAt);
  camera.setViewOffset(aspect,1,view.shift[0]*aspect/2,-view.shift[1]/2,aspect,1);camera.updateMatrixWorld();
  assert.ok(Math.abs(-Math.asin(camera.getWorldDirection(new THREE.Vector3()).y)*180/Math.PI-25)<1e-8);
  const sphere=new THREE.SphereGeometry(radius,64,48),positions=sphere.getAttribute('position');
  for(let i=0;i<positions.count;i++) {
    const p=new THREE.Vector3().fromBufferAttribute(positions,i).add(new THREE.Vector3(...sample(5))).project(camera);
    assert.ok(Math.abs(p.x)<=1&&Math.abs(p.y)<=1&&Math.abs(p.z)<=1);
  }
  sphere.dispose();
});
test("spatial visibility retains past/future boards and more than nine total boards", () => {
  const camera = new THREE.PerspectiveCamera(37, 9/16, .05, 100);
  camera.position.set(0, 4 * Math.sin(25*Math.PI/180), 4 * Math.cos(25*Math.PI/180));
  camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const bounds = [];
  for (const y of [-.9, -.3, .3, .9]) for (const x of [-.5, 0, .5]) {
    bounds.push(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x,y,0), new THREE.Vector3(.2,.06,.2)));
  }
  bounds.push(new THREE.Box3(new THREE.Vector3(100,0,0),new THREE.Vector3(101,1,1)));
  bounds.push(new THREE.Box3(new THREE.Vector3(-1,-10,20),new THREE.Vector3(1,-9,21)));
  assert.deepEqual(visibleBoards(bounds, frustum), Array.from({length:12}, (_,i)=>i));
  const oldCamera = camera.matrixWorld.clone();
  camera.position.x = 100; camera.updateMatrixWorld();
  const elsewhere = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  visibleBoards(bounds, elsewhere);
  assert.deepEqual(visibleBoards(bounds, frustum), Array.from({length:12}, (_,i)=>i));
  assert.notDeepEqual(camera.matrixWorld.elements, oldCamera.elements);
});
test("wide asymmetric Gaussian uses exactly t-2..t+3 and remains seek independent", () => {
  const visited = [];
  const sample = t => { assert.ok(t >= 0 && t <= 20); visited.push(t); return [2*t, -t, 0]; };
  const result = cameraPresentation(sample, 20, 5, 9/16, .1, C);
  assert.ok(result.target[0] > 10 && result.target[0] < 10.2);
  assert.ok(Math.abs(Math.min(...visited) - 3) < 1e-10);
  assert.ok(Math.abs(Math.max(...visited) - 8) < 1e-10);
  cameraPresentation(sample, 20, 0, 9/16, .1, C);
  cameraPresentation(sample, 20, 20, 9/16, .1, C);
  assert.deepEqual(cameraPresentation(sample, 20, 5, 9/16, .1, C), result);
});
test("lens shift biases a travelling ball backwards while retaining a dead zone", () => {
  for (const sample of [t => [0, -t, 0], t => [t, 0, 0]]) {
    const view = cameraPresentation(sample, 20, 5, 9/16, .1, C);
    const camera = new THREE.PerspectiveCamera(C.camera.fov, 9/16, .05, 400);
    camera.position.fromArray(view.position); camera.lookAt(...view.target);
    camera.setViewOffset(9/16, 1, view.shift[0]*9/32, -view.shift[1]/2, 9/16, 1);
    camera.updateMatrixWorld();
    const point = new THREE.Vector3(...sample(5)).project(camera);
    if (sample(1)[1] < 0) assert.ok(Math.abs((1-point.y)/2 - .35) < .05);
    else assert.ok(Math.abs((point.x+1)/2 - .35) < .05);
    assert.ok(Math.abs(-Math.asin(camera.getWorldDirection(new THREE.Vector3()).y)*180/Math.PI - 25) < 1e-10);
  }
  const still = cameraPresentation(() => [4,-100,0],20,5,9/16,.1,C);
  assert.ok(still.ballScreen.every(x=>Math.abs(x-.5)<1e-12));
});
test("upcoming boards fit without expanding seven-wide framing", () => {
  const points = (x,y) => [-.125,.125].flatMap(dx => [-.35,.03].flatMap(dy => [-.25,0].map(z=>[x+dx,y+dy,z])));
  const ahead = [0,1,2].map(index => ({index,points:points(.6+index*.35,-5.3-index*.25)}));
  const view = cameraPresentation(t=>[0,-t,0],20,5,9/16,.1,C,ahead);
  const camera = new THREE.PerspectiveCamera(C.camera.fov,9/16,.05,400);
  camera.position.fromArray(view.position);camera.lookAt(...view.target);
  camera.setViewOffset(9/16,1,view.shift[0]*9/32,-view.shift[1]/2,9/16,1);camera.updateMatrixWorld();
  assert.ok(view.protectedBoards.length >= 2);
  for(const index of view.protectedBoards) for(const p of ahead[index].points){
    const projected=new THREE.Vector3(...p).project(camera);
    assert.ok(Math.abs(projected.x)<=1-2*C.camera.edgeMargin+1e-10);
    assert.ok(Math.abs(projected.y)<=1-2*C.camera.edgeMargin+1e-10);
  }
  assert.ok(view.boardsAcross<=7+1e-10);
});
test("hinge response superposes the requested damped cosine and ignores future/expired hits", () => {
  const hits=[{t:5,amplitude:.2},{t:5.08,amplitude:.1}],z=.2,w=30;
  const expected=t=>hits.filter(h=>h.t<=t&&t-h.t<2).reduce((sum,h)=>sum+h.amplitude*Math.exp(-z*w*(t-h.t))*Math.cos(w*Math.sqrt(1-z*z)*(t-h.t)),0);
  for(const t of [4,5,5.05,5.1,5.4,6.9,7,7.08,100])assert.ok(Math.abs(boardSpring(t,hits,C.boards)-expected(t))<1e-12);
  assert.ok(boardSpring(5,hits,C.boards)>0);
  assert.ok(boardSpring(5.12,[hits[0]],C.boards)<0);
  const angle=boardSpring(5.1,hits,C.boards);
  boardSpring(100,hits,C.boards);assert.equal(boardSpring(5.1,hits,C.boards),angle);
});
test("higher ball casts a more distant, broader and fainter soft shadow",()=>{
  const low=shadowPresentation([0,.1,0],[0,.1,0],.25,-.242,C.shadow);
  const high=shadowPresentation([0,1.1,0],[0,.1,0],.25,-.242,C.shadow);
  assert.ok(high.radius>low.radius && high.opacity<low.opacity);
  assert.ok(1.1-high.position[1]>.1-low.position[1]);
});
test("stateless camera dead zone retains visible parabolic excursions",()=>{
  assert.equal(deadZone(.1,.2),0);assert.equal(deadZone(-.1,.2),0);
  const sample=t=>[0,.15*Math.cos(2*Math.PI*t),0];
  const a=cameraPresentation(sample,20,5,9/16,.1,C),b=cameraPresentation(sample,20,5.5,9/16,.1,C);
  assert.ok(Math.abs(a.ballScreen[1]-b.ballScreen[1])>.04);
  assert.deepEqual(cameraPresentation(sample,20,5,9/16,.1,C),a);
});
test("invalid angles/counts and removed visibility parameters are rejected", () => {
  for (const [group, key, value] of [["camera", "sigma", 0], ["camera", "samples", 25.5],
    ["camera", "maxBoardsAcross", 8], ["camera", "maxBoardsAcross", 6.5],
    ["camera", "pastWindow", 0], ["boards", "dampingRatio", 0],
    ["ball", "attenuationColor", "white"], ["camera", "downwardTilt", -25], ["ball", "screenWidth", .2], ["boards", "ahead", 7],
    ["boards", "appearBefore", 1.5]]) {
    const invalid = structuredClone(C); invalid[group][key] = value;
    assert.throws(() => validatePresentation(invalid), /config.json/);
  }
  assert.equal(validatePresentation(C), C);
});

test("phrase layering is a strict boolean and both modes remain valid",()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  assert.equal(config.spatial.layeredPhrases,true);
  for(const enabled of [true,false]) {
    config.spatial.layeredPhrases=enabled;
    assert.equal(validatePresentation(config),config);
  }
  for(const value of [0,1,"true",null]) {
    config.spatial.layeredPhrases=value;
    assert.throws(()=>validatePresentation(config),/spatial.layeredPhrases/);
  }
});

 test("wide wall level rows retain a visible sphere without changing zoom and remain seek independent",()=>{
  const c=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  const aspect=9/16,radius=.1;
  for(const x of [-1.8,0,1.8]) {
    const sample=()=>[x,0,0],view=cameraPresentation(sample,20,5,aspect,radius,c);
    const camera=new THREE.PerspectiveCamera(c.camera.fov,aspect,.05,400);
    camera.position.fromArray(view.position);camera.lookAt(...view.lookAt);
    camera.setViewOffset(aspect,1,view.shift[0]*aspect/2,-view.shift[1]/2,aspect,1);camera.updateMatrixWorld();
    const sphere=new THREE.SphereGeometry(radius,64,48),positions=sphere.getAttribute('position');
    for(let i=0;i<positions.count;i++) {
      const p=new THREE.Vector3().fromBufferAttribute(positions,i).add(new THREE.Vector3(x,0,0)).project(camera);
      assert.ok(Math.abs(p.x)<=1-2*c.camera.edgeMargin+1e-10);
    }
    sphere.dispose();
    assert.equal(view.depth,cameraPresentation(()=>[0,0,0],20,5,aspect,radius,c).depth);
    cameraPresentation(sample,20,15,aspect,radius,c);
    assert.deepEqual(cameraPresentation(sample,20,5,aspect,radius,c),view);
  }
 });

test("layered camera ignores sudden changes in the fitting prefix of upcoming boards",()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  const sample=t=>[.4*t,-.6*t,0],epsilon=1e-6;
  for(const sign of [-1,1]) {
    const plank=(offset,index)=>({index,points:[-.12,.12].flatMap(dx=>[-.02,.02].flatMap(dy=>[-.9,.15].map(z=>[2+sign*offset+dx,-3.2+dy,z])))});
    const ahead=[plank(1.6,0),plank(4,1)];
    const before=cameraPresentation(sample,20,5-epsilon,9/16,.1,config,ahead);
    const after=cameraPresentation(sample,20,5+epsilon,9/16,.1,config,ahead.slice(1));
    assert.ok(Math.abs(before.shift[0]-after.shift[0])<1e-4,'removing the fitting board cannot jump the lens');
    assert.ok(Math.hypot(...before.position.map((x,k)=>x-after.position[k]))<1e-4);
    assert.deepEqual(cameraPresentation(sample,20,5,9/16,.1,config,ahead).shift,
      cameraPresentation(sample,20,5,9/16,.1,config,[]).shift,'the changing board list does not steer the camera');
    const legacyBefore=cameraPresentation(sample,20,5-epsilon,9/16,.1,config,ahead,{legacyWallFraming:true});
    const legacyAfter=cameraPresentation(sample,20,5+epsilon,9/16,.1,config,ahead.slice(1),{legacyWallFraming:true});
    assert.ok(Math.abs(legacyBefore.shift[0]-legacyAfter.shift[0])>.1,'the fixture reproduces the old prefix discontinuity used by the layout guard');
  }
});

test("layered tracking stays continuous on a straight route and independent of seek order",()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  const sample=t=>[.4*t,-.6*t,.02*t],epsilon=1e-6,times=[0,1,5,19,20];
  const frame=t=>cameraPresentation(sample,20,t,9/16,.1,config,[],{ballPosition:sample(t)});
  const frames=times.map(frame);
  for(const t of times) {
    const a=frame(Math.max(0,t-epsilon)),b=frame(Math.min(20,t+epsilon));
    for(const field of ['position','target','shift'])assert.ok(Math.hypot(...a[field].map((x,k)=>x-b[field][k]))<1e-4,`${field} stays continuous at ${t}s`);
  }
  for(const i of [4,1,3,0,2])assert.deepEqual(frame(times[i]),frames[i]);
});

test("layered soft framing keeps the actual off-route sphere inside both screen margins",()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  const aspect=9/16,radius=.1,sample=()=>[0,0,0],safe=1-2*config.camera.edgeMargin;
  const expectedPosition=cameraPresentation(sample,20,5,aspect,radius,config).position;
  const sphere=new THREE.SphereGeometry(radius,48,32),vertices=sphere.getAttribute('position');
  for(const x of [-1.8,1.8])for(const y of [-3,3]) {
    const ballPosition=[x,y,0],view=cameraPresentation(sample,20,5,aspect,radius,config,[],{ballPosition});
    assert.deepEqual(view.position,expectedPosition,'a jump only changes the safety edge, preserving the low-frequency camera path');
    const camera=new THREE.PerspectiveCamera(config.camera.fov,aspect,.05,400);
    camera.position.fromArray(view.position);camera.lookAt(...view.lookAt);
    camera.setViewOffset(aspect,1,view.shift[0]*aspect/2,-view.shift[1]/2,aspect,1);camera.updateMatrixWorld();
    for(let i=0;i<vertices.count;i++) {
      const point=new THREE.Vector3().fromBufferAttribute(vertices,i).add(new THREE.Vector3(...ballPosition)).project(camera);
      assert.ok(Math.abs(point.x)<=safe+1e-8&&Math.abs(point.y)<=safe+1e-8,'the actual sphere, including its radius, remains inside the safety margin');
    }
    const center=new THREE.Vector3(...ballPosition).project(camera);
    assert.ok(Math.abs(view.ballScreen[0]-(center.x+1)/2)<1e-10&&Math.abs(view.ballScreen[1]-(1-center.y)/2)<1e-10,'reported ball framing describes the actual sphere');
  }
  sphere.dispose();
});

test("layered safety correction has no velocity or acceleration kink",()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../config.json',import.meta.url)));
  const sweep=step=>{
    const shifts=Array.from({length:Math.round(1/step)+1},(_,i)=>cameraPresentation(()=>[0,0,0],20,5,9/16,.1,config,[],{ballPosition:[.8+i*step,0,0]}).shift[0]);
    assert.ok(shifts.at(-1)>.1,'the sweep crosses the active safety edge');
    const slopes=shifts.slice(1).map((x,i)=>(x-shifts[i])/step);
    const acceleration=slopes.slice(1).map((x,i)=>(x-slopes[i])/step);
    return {velocityChange:Math.max(...slopes.slice(1).map((x,i)=>Math.abs(x-slopes[i]))),
      accelerationChange:Math.max(...acceleration.slice(1).map((x,i)=>Math.abs(x-acceleration[i])))};
  };
  const coarse=sweep(.005),fine=sweep(.0025);
  assert.ok(coarse.velocityChange<.03,'crossing the safety edge cannot abruptly change lens velocity');
  assert.ok(fine.accelerationChange<.65*coarse.accelerationChange,'halving the step shrinks acceleration changes instead of retaining a kink');
});

test("legacy framing option preserves the established camera modes",()=>{
  for(const spatial of [{enabled:false},{enabled:true,wallMounted:false},{enabled:true,wallMounted:true,layeredPhrases:false}]) {
    const config=structuredClone(C);Object.assign(config.spatial,spatial);
    const sample=t=>[.4*t,-.6*t,0],ahead=[{index:0,points:[[2.5,-3,0],[2.7,-3.3,-.2]]}];
    assert.deepEqual(cameraPresentation(sample,20,5,9/16,.1,config,ahead,{legacyWallFraming:true}),
      cameraPresentation(sample,20,5,9/16,.1,config,ahead));
  }
});
