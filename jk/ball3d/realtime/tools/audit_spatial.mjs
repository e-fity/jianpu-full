import fs from 'node:fs';
import { PerspectiveCamera, Vector3, Frustum, Matrix4, Box3 } from 'three';
import * as kit from '../src/layout.mjs';
import { buildGravityLayout, sampleBall, supportAt } from '../src/gravity_layout.mjs';
import { boardPose } from '../src/spatial_course.mjs';
import { cameraPresentation, boardSpring } from '../src/presentation.mjs';
import { hull, clipScreen, intersects } from '../src/screen_geometry.mjs';
import { wallSwing } from '../src/wall_course.mjs';
const [planPath,configPath,startArg='18.5',secondsArg='30',outPath]=process.argv.slice(2);
const plan=JSON.parse(fs.readFileSync(planPath)),config=JSON.parse(fs.readFileSync(configPath));
const layout=buildGravityLayout(plan,kit,config),start=+startArg,frames=[];
const camera=new PerspectiveCamera(config.camera.fov,9/16,.05,400),frustum=new Frustum(),matrix=new Matrix4();
const w=2*kit.BALL_R*config.boards.sideDiameters;
for(let frame=0;frame<+secondsArg*60;frame++) {
  const t=start+frame/60,view=cameraPresentation(s=>supportAt(layout,s),plan.duration,t,9/16,kit.BALL_R,config);
  const wall=layout.format==='ball3d-wall-v1';
  camera.position.fromArray(view.position);camera.lookAt(...view.lookAt);camera.far=view.depth+(wall?layout.boards[0].size[2]+4:1.5);
  camera.setViewOffset(camera.aspect,1,view.shift[0]*camera.aspect/2,-view.shift[1]/2,camera.aspect,1);camera.updateMatrixWorld(true);
  frustum.setFromProjectionMatrix(matrix.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
  const visible=[];let future=0;
  const first=layout.boards.findIndex(b=>b.t>t);
  for(const b of layout.boards) {
    if(first>=0&&b.index>=first+10)continue;
    const size=b.size??[w,kit.BOARD_H,w],pose=boardPose(b,size[1],wall?wallSwing(t,b,config.boards):boardSpring(t,b.hits,config.boards));
    const points=Array.from({length:8},(_,i)=>new Vector3((i&1?1:-1)*size[0]/2,(i&2?1:-1)*size[1]/2,(i&4?1:-1)*size[2]/2).applyQuaternion(pose.quaternion).add(pose.center));
    if(!frustum.intersectsBox(new Box3().setFromPoints(points)))continue;
    const projected=points.map(p=>p.project(camera).toArray()),poly=clipScreen(hull(projected));
    if(poly.length>2)visible.push({index:b.index,poly});
    if(b.t>t && projected.every(p=>p.every(v=>v>=-1&&v<=1)))future++;
  }
  const overlaps=[];
  for(let i=0;i<visible.length;i++)for(let j=0;j<i;j++)if(intersects(visible[i].poly,visible[j].poly))overlaps.push([visible[i].index,visible[j].index]);
  const ball=new Vector3(...sampleBall(layout,t)).project(camera);
  frames.push({frame,t,overlaps,future,ball:[(ball.x+1)/2,(1-ball.y)/2]});
}
const bad=frames.filter(f=>f.overlaps.length),summary={overlap_frames:bad.length,pairs:[...new Set(bad.flatMap(f=>f.overlaps.map(p=>p.join(','))))],
  future_min:Math.min(...frames.map(f=>f.future)),future_max:Math.max(...frames.map(f=>f.future)),future_under6:frames.filter(f=>f.future<6).length,
  examples:bad.filter((f,i)=>i%60===0),audit:layout.audit};
if(outPath)fs.writeFileSync(outPath,JSON.stringify({summary,frames}));
console.log(JSON.stringify({...summary,audit:layout.audit.spatial}));
