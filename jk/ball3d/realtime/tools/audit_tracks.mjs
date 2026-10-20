/** Independent fine-polyline quadrature, numerical velocity and sounding bounds. */
import fs from 'node:fs';
import path from 'node:path';
import { solvePlan } from './solve_layout.mjs';
import { channelCenter, transitionPoint, transitionVelocity, sampleBall } from '../src/gravity_layout.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,all)=>i%2?a:[...a,[x.slice(2),all[i+1]]],[]));
if(!args.plan||!args.out)throw new Error('--plan PLAN --out DIRECTORY [--config CONFIG]');
const plan=JSON.parse(fs.readFileSync(args.plan));
const config=JSON.parse(fs.readFileSync(args.config||new URL('../config.json',import.meta.url)));
const solved=await solvePlan({plan,presentation:config}),layout=solved.layout,w=2*solved.constants.ball_r*config.boards.sideDiameters;
const rows=[];
for(const [index,rail] of layout.channels.entries()) {
  let length=0,time=0,previous=channelCenter(rail,0),energyError=0,speedError=0;
  for(let i=1;i<=20000;i++) {
    const p=channelCenter(rail,i/20000),ds=Math.hypot(...p.map((x,k)=>x-previous[k]));
    const h=(p[1]+previous[1])/2-rail.p0[1];
    length+=ds;time+=ds/Math.sqrt(rail.entrySpeed**2-2*rail.g*h);previous=p;
  }
  for(let i=1;i<500;i++) {
    const u=i/500,p=transitionPoint(rail,u),v=transitionVelocity(rail,u);
    const energy=v.reduce((s,x)=>s+x*x,0)+2*rail.g*(p[1]-rail.p0[1]);
    energyError=Math.max(energyError,Math.abs(energy-rail.entrySpeed**2));
    const dt=1e-5,a=transitionPoint(rail,u-dt/rail.duration),b=transitionPoint(rail,u+dt/rail.duration);
    const numerical=b.map((x,k)=>(x-a[k])/(2*dt));
    speedError=Math.max(speedError,Math.hypot(...numerical.map((x,k)=>x-v[k])));
  }
  const remaining=plan.landings[rail.note_indices.at(-1)+1]?.t-rail.t1;
  rows.push({index,type:rail.reason.type,t0:rail.t0,t1:rail.t1,requested:rail.requestedDuration,
    actual:rail.duration,shortened:rail.shortened,entry_speed:rail.entrySpeed,exit_speed:Math.hypot(...transitionVelocity(rail,1)),
    energy_error:energyError,numerical_velocity_error:speedError,independent_time_error:Math.abs(time-rail.duration),
    arc_widths:length/w,arc_error:Math.abs(length-rail.arcLength),flight_after:Number.isFinite(remaining)?remaining:null,
    sounding_end:rail.soundingEnd,passes:energyError<1e-8&&speedError<.01&&Math.abs(time-rail.duration)<config.tracks.timeTolerance&&
      length/w<=config.tracks.maxLengthWidths+1e-7&&rail.t1<=rail.soundingEnd+1e-8&&
      (!Number.isFinite(remaining)||remaining>=config.tracks.minFlightSeconds-1e-8)&&
      (rail.shortened||Math.abs(rail.duration-rail.requestedDuration)<config.tracks.timeTolerance)});
}
let onsetError=0;
for(const contact of layout.contacts)onsetError=Math.max(onsetError,Math.hypot(...sampleBall(layout,contact.t).map((x,k)=>x-contact.p[k])));
const max=key=>Math.max(0,...rows.map(r=>r[key]));
const report={passed:solved.ok&&rows.every(r=>r.passes)&&onsetError<1e-8&&layout.audit.tracks.rest_overlaps===0,
  tracks:layout.audit.tracks,onset_error:onsetError,max_energy_error:max('energy_error'),max_numerical_velocity_error:max('numerical_velocity_error'),
  max_independent_time_error:max('independent_time_error'),max_arc_error:max('arc_error'),rows};
fs.mkdirSync(args.out,{recursive:true});
fs.writeFileSync(path.join(args.out,'energy_check.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,rows:undefined}));
if(!report.passed)process.exitCode=1;
