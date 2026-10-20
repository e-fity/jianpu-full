/** Export flight samples on the offline frame clock; never differentiate across impacts. */
import fs from "node:fs";
import path from "node:path";
import { solvePlan } from "./solve_layout.mjs";
import { sampleBall, sampleVelocity, segmentAt } from "../src/gravity_layout.mjs";
const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,x,i,all)=>i%2===0?[...pairs,[x.slice(2),all[i+1]]]:pairs,[]));
if(!args.plan||!args.out)throw new Error("--plan PLAN --out DIRECTORY [--config CONFIG] [--fps FPS] [--start SECONDS] [--seconds SECONDS]");
const plan=JSON.parse(fs.readFileSync(args.plan));
const presentation=JSON.parse(fs.readFileSync(args.config||new URL("../config.json",import.meta.url)));
const solved=await solvePlan({plan,presentation});
if(!solved.ok)throw new Error("course audit failed");
const layout=solved.layout,fps=Number(args.fps||60),dt=1/fps,start=Number(args.start||0);
const seconds=Number(args.seconds||plan.duration-start),rows=["segment,t,y,vy,acceleration_fd,expected_acceleration"];
let worst=0,count=0,min=Infinity,max=-Infinity,samples=0;
for(let frame=0;frame<Math.ceil(seconds*fps);frame++){
  const t=start+frame/fps,seg=segmentAt(layout,t);
  if(seg?.kind!=="flight")continue;
  const y=sampleBall(layout,t)[1],vy=sampleVelocity(layout,t)[1];
  let a="";
  if(t-dt>seg.t0&&t+dt<seg.t1){
    a=(sampleBall(layout,t+dt)[1]-2*y+sampleBall(layout,t-dt)[1])/dt**2;
    worst=Math.max(worst,Math.abs(a+layout.gravity));min=Math.min(min,a);max=Math.max(max,a);count++;
  }
  rows.push([layout.segments.indexOf(seg),t.toFixed(9),y.toFixed(12),vy.toFixed(12),a, -layout.gravity].join(","));samples++;
}
const report={fps,start,seconds,gravity:layout.gravity,flight_segments:layout.audit.flights,
  flight_samples:samples,second_difference_samples:count,min_acceleration:min,max_acceleration:max,
  max_absolute_error:worst,tolerance:1e-6,passed:count>0&&worst<1e-6,course:layout.audit};
fs.mkdirSync(args.out,{recursive:true});
fs.writeFileSync(path.join(args.out,"flight_y.csv"),rows.join("\n")+"\n");
fs.writeFileSync(path.join(args.out,"gravity_check.json"),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
if(!report.passed)process.exitCode=1;
