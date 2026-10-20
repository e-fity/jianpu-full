/** Seeded 3D score course and apex-constrained analytic flights. */
import { CatmullRomCurve3, Vector3, Quaternion } from 'three';
import { cameraPresentation } from './presentation.mjs';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
const edgeSpeed=(s,angle)=>Math.sqrt(s.entrySpeed**2+2*s.g*s.edgeRadius*(Math.cos(s.angle0)-Math.cos(angle)));
const edgeQuadrature=[[.1834346424956498,.362683783378362],[.525532409916329,.3137066458778873],
  [.796666477413627,.2223810344533745],[.9602898564975363,.1012285362903763]];
function edgeTimeBetween(s,a,b) {
  const half=(b-a)/2,mid=(b+a)/2;
  return half*s.edgeRadius*edgeQuadrature.reduce((sum,[x,w])=>sum+w*(1/edgeSpeed(s,mid-half*x)+1/edgeSpeed(s,mid+half*x)),0);
}
export function seededRandom(seed) {
  let state=seed>>>0;
  return ()=>{state+=0x6D2B79F5;let x=state;x=Math.imul(x^(x>>>15),x|1);x^=x+Math.imul(x^(x>>>7),x|61);return ((x^(x>>>14))>>>0)/4294967296;};
}
export function apexFlight(p0,p1,t0,t1,diameter) {
  const dt=t1-t0,apex=Math.max(p0[1],p1[1])+.7*diameter;
  const g=2*(Math.sqrt(apex-p0[1])+Math.sqrt(apex-p1[1]))**2/dt**2;
  return {kind:'flight',p0:p0.slice(),p1:p1.slice(),t0,t1,g,apex,
    v0:[(p1[0]-p0[0])/dt,Math.sqrt(2*g*(apex-p0[1])),(p1[2]-p0[2])/dt]};
}
export function spatialRailPoint(s,u) {
  if(s.edge) {
    const angle=s.angle0+(s.angle1-s.angle0)*u;
    return [s.center[0]+s.sign*s.edgeRadius*Math.sin(angle),s.center[1]+s.edgeRadius*Math.cos(angle),s.center[2]];
  }
  if(s.straight)return s.p0.map((x,k)=>x+(s.p1[k]-x)*u);
  const angle=s.angle0+s.sweep*u;
  return [s.center[0]+s.radius*Math.cos(angle),s.center[1],s.center[2]+s.radius*Math.sin(angle)];
}
export function spatialRailTangent(s,u) {
  if(s.edge){const angle=s.angle0+(s.angle1-s.angle0)*u;return [s.sign*Math.cos(angle),-Math.sin(angle),0];}
  if(s.straight){const length=distance(s.p0,s.p1);return s.p0.map((x,k)=>(s.p1[k]-x)/length);}
  const a=s.angle0+s.sweep*u,sign=Math.sign(s.sweep);
  return [-Math.sin(a)*sign,0,Math.cos(a)*sign];
}
export function spatialRailNormal(s,u) {
  if(s.edge){const angle=s.angle0+(s.angle1-s.angle0)*u;return [s.sign*Math.sin(angle),Math.cos(angle),0];}
  if(!s.straight)return [0,1,0];
  const tangent=spatialRailTangent(s,u),sign=Math.sign(tangent[0])||1;
  return [(-sign*tangent[1])||0,Math.abs(tangent[0]),0];
}
export function spatialRailUAtTime(s,age) {
  const t=clamp(age,0,s.duration);
  if(s.edge) {
    if(t===0)return 0;
    if(t===s.duration)return 1;
    const table=s.timeTable;
    let low=1,high=table.length-1;
    while(low<high){const mid=(low+high)>>1;if(table[mid].time<t)low=mid+1;else high=mid;}
    const a=table[low-1],b=table[low],target=t-a.time;
    let lo=a.angle,hi=b.angle,angle=lo+(hi-lo)*target/(b.time-a.time);
    for(let i=0;i<6;i++) {
      const error=edgeTimeBetween(s,a.angle,angle)-target;
      if(Math.abs(error)<1e-13)break;
      if(error>0)hi=angle;else lo=angle;
      const next=angle-error*edgeSpeed(s,angle)/s.edgeRadius;
      angle=next>lo&&next<hi?next:(lo+hi)/2;
    }
    return clamp((angle-s.angle0)/(s.angle1-s.angle0),0,1);
  }
  return s.decelerating?clamp((s.entrySpeed*t-.5*s.deceleration*t*t)/s.arcLength,0,1):t/s.duration;
}
export function spatialRailRotation(s,u,ballRadius) {
  if(s.edge||s.straight&&s.decelerating) {
    const along=spatialRailUAtTime(s,u*s.duration),tangent=new Vector3(...spatialRailTangent(s,along));
    const axis=new Vector3(...spatialRailNormal(s,along)).cross(tangent).normalize();
    return new Quaternion().setFromAxisAngle(axis,s.arcLength*along/ballRadius);
  }
  const age=u*s.duration,rate=s.sweep/s.duration,axis=new Vector3(s.entrySpeed/ballRadius,rate,0);
  const q=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),-s.angle0-rate*age);
  return q.multiply(new Quaternion().setFromAxisAngle(axis.clone().normalize(),axis.length()*age))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),s.angle0));
}
const velocity=(s,end)=>s.kind==='flight'?[s.v0[0],s.v0[1]-s.g*(end?s.t1-s.t0:0),s.v0[2]]:
  s.kind==='ride'?spatialRailTangent(s,end?1:0).map(x=>x*(s.edge?edgeSpeed(s,end?s.angle1:s.angle0):s.decelerating&&end?s.exitSpeed:s.entrySpeed)):[0,0,0];
export function spatialPoint(s,u) {
  if(s.kind==='ride')return spatialRailPoint(s,s.edge||s.decelerating?spatialRailUAtTime(s,u*s.duration):u);
  if(s.kind==='hold')return s.p0.slice();
  const age=u*(s.t1-s.t0);
  return s.p0.map((x,k)=>x+s.v0[k]*age-(k===1?.5*s.g*age*age:0));
}
export function boardPose(board,height,angle=0) {
  const q=new Quaternion().fromArray(board.quaternion),axis=new Vector3(...board.tilt_axis);
  const rotation=new Quaternion().setFromAxisAngle(axis,angle);
  const normal=new Vector3(0,1,0).applyQuaternion(q);
  const pivot=board.pivot?new Vector3(...board.pivot):new Vector3(...board.pos).addScaledVector(normal,-height/2);
  const center=new Vector3(...board.pos).sub(pivot).applyQuaternion(rotation).add(pivot);
  return {center,quaternion:rotation.multiply(q),pivot};
}
export function buildSpatialCourse(plan,kit,config,rejectedRails=[],onProgress) {
  const S=config.spatial,R=kit.BALL_R,D=2*R,w=D*config.boards.sideDiameters,H=kit.BOARD_H;
  const random=seededRandom(S.seed),notes=plan.landings||[],steps=[];
  const gaps=notes.slice(1).map((b,i)=>b.t-notes[i].t).sort((a,b)=>a-b);
  const median=a=>a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:0;
  const delta0=median(gaps),threshold=Math.max(1,3.5*delta0);
  let length=0;
  for(let i=0;i<notes.length;i++) {if(i)length+=clamp(S.speed*(notes[i].t-notes[i-1].t),S.minStepWidths*w,S.maxStepWidths*w);steps.push(length);}
  const controls=Array.from({length:Math.max(5,Math.ceil(length/(12*w))+1)},(_,i)=>{
    const z=i*12*w;return new Vector3(.10*z+1.1*w*Math.sin(i*.85),0,z);
  });
  const curve=new CatmullRomCurve3(controls);curve.arcLengthDivisions=Math.max(2048,notes.length*16);
  const curveLength=curve.getLength(),contacts=[];
  let ema=notes[0]?.midi??60,lastY=0;
  const beat=60/(plan.tempo_qpm||120),meter=plan.meter||'4/4';
  const [beats,unit]=String(meter).split('/').map(Number),emaSeconds=2*(beats||4)*4/(unit||4)*beat;
  for(let i=0;i<notes.length;i++) {
    onProgress?.({stage:"排列木板",percent:20*i/notes.length,completed:i,total:notes.length});
    const n=notes[i],alpha=1-Math.exp(-(i?n.t-notes[i-1].t:0)/emaSeconds);
    ema+=alpha*(n.midi-ema);
    const y=clamp(4*D*Math.tanh(S.pitchScale*D*(n.midi-ema)/(4*D)),lastY-1.5*D+.012,lastY+1.5*D-.012);
    const u=steps[i]/curveLength,ref=curve.getPointAt(u),tangent=curve.getTangentAt(u);
    const lateral=new Vector3(tangent.z,0,-tangent.x).normalize();
    let offset=(random()<.5?-1:1)*(1+random())*w;
    let p;
    // A deterministic lateral correction leaves arc progress and pitch height intact.
    for(let trial=0;trial<160;trial++) {
      const candidate=trial===0?offset:((trial%2)?1:-1)*(w+(trial>>1)*.025*w);
      p=ref.clone().addScaledVector(lateral,candidate);p.y=y+R;
      if(contacts.every(b=>distance(p.toArray(),b.p)>=2*w+.01)){offset=candidate;break;}
    }
    const event=plan.events?.find(e=>e.kind==='note'&&Math.abs(e.onset_sec-n.t)<1e-7);
    contacts.push({...n,note_index:i,group:0,p:p.toArray(),reference:ref.toArray(),lateral:lateral.toArray(),
      offset,step:i?steps[i]-steps[i-1]:0,pitch_height:y,pitch_ema:ema,lyric:n.lyric??event?.lyric,
      yaw:Math.atan2(tangent.x,tangent.z)+(random()*2-1)*35*Math.PI/180,tilt_noise:(random()*2-1)*8*Math.PI/180});
    lastY=y;
  }
  // Projected packing is evaluated from multiple nearby camera locations, not
  // merely in world X/Y. Only the lateral coordinate may move.
  const sample=t=>{
    let i=contacts.findIndex(n=>n.t>=t);if(i<0)return contacts.at(-1).p;
    if(i===0)return contacts[0].p;
    const a=contacts[i-1],b=contacts[i],u=(t-a.t)/(b.t-a.t);
    return a.p.map((x,k)=>x+(b.p[k]-x)*u);
  };
  if(contacts.length)for(let pass=0;pass<6;pass++) {
    const views=contacts.map(n=>cameraPresentation(sample,plan.duration,n.t,9/16,R,config));
    const tilt=config.camera.downwardTilt*Math.PI/180,c=Math.cos(tilt),s=Math.sin(tilt),yaw=config.camera.yaw*Math.PI/180;
    const project=(p,v)=>{
      const wx=p[0]-v.position[0],y=p[1]-R-v.position[1],wz=p[2]-v.position[2];
      const x=wx*Math.cos(yaw)-wz*Math.sin(yaw),z=wx*Math.sin(yaw)+wz*Math.cos(yaw),depth=-y*s-z*c;
      if(depth<2 || depth>v.depth+1.5)return null;
      const xx=x/depth,yy=(y*c-z*s)/depth;
      if(Math.abs(xx)>.23 || yy<-.47 || yy>.25)return null;
      return [xx,yy,.9*w/depth,.55*w/depth];
    };
    for(let i=0;i<contacts.length;i++) {
      onProgress?.({stage:"调整间距",percent:20+55*(pass*contacts.length+i)/(6*contacts.length),completed:i,total:contacts.length});
      const n=contacts[i],base=n.offset;
      let best=Infinity,bestP=n.p,bestOffset=base;
      const candidates=[base,...Array.from({length:49},(_,j)=>(j-24)*w/8)];
      for(const offset of candidates) {
        const p=n.reference.map((x,k)=>k===1?n.p[1]:x+n.lateral[k]*offset);
        if(contacts.some((b,j)=>j!==i && Math.abs(j-i)<8 && distance(p,b.p)<2*w+.025))continue;
        let cost=.000002*(offset-base)**2;
        for(let k=Math.max(0,i-6);k<i;k++) {
          const rect=project(p,views[k]);
          if(!rect){cost+=.02;continue;}
          const tan=Math.tan(config.camera.fov*Math.PI/360);
          cost+=4*Math.max(0,Math.abs(rect[0])+rect[2]-tan*9/16*.96)**2;
          cost+=4*Math.max(0,-rect[1]+rect[3]-1.3*tan*.96)**2;
        }
        for(let j=Math.max(0,i-12);j<Math.min(contacts.length,i+13);j++)if(j!==i) {
          const b=contacts[j];
          for(let k=Math.max(0,Math.min(i,j)-10);k<=Math.min(contacts.length-1,Math.max(i,j)+3);k++) {
            const aRect=project(p,views[k]),bRect=project(b.p,views[k]);if(!aRect||!bRect)continue;
            const dx=aRect[2]+bRect[2]-Math.abs(aRect[0]-bRect[0]);
            const dy=aRect[3]+bRect[3]-Math.abs(aRect[1]-bRect[1]);
            if(dx>0&&dy>0)cost+=200*dx*dy;
          }
        }
        if(cost<best){best=cost;bestP=p;bestOffset=offset;}
      }
      n.p=bestP;n.offset=bestOffset;
    }
  }
  onProgress?.({stage:"连接球路",percent:75});
  const segments=[],channels=[];
  const eligible=contacts.slice(0,-1).map((n,i)=>({i,t:n.t,gap:contacts[i+1].t-n.t,
    priority:Number(S.longNoteRails && n.dur>=Math.max(.5,2*delta0))+Number(S.glissandoRails && Boolean(n.pitch_bend?.length||n.articulation==='glissando'))}))
    .filter(n=>n.gap>=threshold).sort((a,b)=>b.priority-a.priority||a.t-b.t);
  const selected=[];
  for(const candidate of eligible)if(selected.length<S.maxRails&&selected.every(n=>Math.abs(n.t-candidate.t)>=8))selected.push(candidate);
  const padPoint=contacts.length?contacts[0].p.map((x,k)=>x-(k===2?w*2:0)):[0,R,0];
  const pad={ball_pos:padPoint,pos:[padPoint[0],padPoint[1]-R,padPoint[2]],top_y:padPoint[1]-R};
  if(contacts.length) {
    const first=contacts[0],start=Math.max(0,first.t-config.physics.leadFlight);
    if(start>0)segments.push({kind:'hold',p0:padPoint,p1:padPoint,t0:0,t1:start});
    if(first.t>start)segments.push(apexFlight(padPoint,first.p,start,first.t,D));
    for(let i=0;i<contacts.length-1;i++) {
      const a=contacts[i],b=contacts[i+1],gap=b.t-a.t;
      if(selected.some(n=>n.i===i) && !rejectedRails.includes(i)) {
        // Horizontal circular arcs have constant potential energy, hence constant
        // speed. Parameter u is exact arc length / total length, not time-warped.
        const dx=b.p[0]-a.p[0],dz=b.p[2]-a.p[2],heading=Math.atan2(dz,dx);
        const chord=Math.min(Math.hypot(dx,dz)*.45,3*w),sweep=.65;
        const radius=chord/(2*Math.sin(sweep/2)),angle0=heading-Math.PI/2-sweep/2;
        const center=[(a.p[0]+b.p[0])/2-radius*Math.cos(heading-Math.PI/2)*Math.cos(sweep/2),
          (a.p[1]+b.p[1])/2,(a.p[2]+b.p[2])/2-radius*Math.sin(heading-Math.PI/2)*Math.cos(sweep/2)];
        center[0]-=Math.sin(heading)*1.6*w;center[2]+=Math.cos(heading)*1.6*w;
        const fly=Math.max(.25,gap*.25),t0=a.t+fly,t1=b.t-fly,duration=t1-t0;
        const rail={kind:'ride',spatial:true,center,radius,angle0,sweep,t0,t1,duration,g:config.physics.gravity,
          arcLength:radius*sweep,entrySpeed:radius*sweep/duration,note_indices:[],beads:[],
          visibleFrom:a.t,visibleUntil:b.t,reason:{type:'gap',note_index:i,gap},shortened:false};
        rail.p0=spatialRailPoint(rail,0);rail.p1=spatialRailPoint(rail,1);
        segments.push(apexFlight(a.p,rail.p0,a.t,t0,D),rail,apexFlight(rail.p1,b.p,t1,b.t,D));
        channels.push(rail);
      } else segments.push(apexFlight(a.p,b.p,a.t,b.t,D));
    }
    const last=contacts.at(-1);
    if(last.t<plan.duration)segments.push({kind:'hold',p0:last.p,p1:last.p,t0:last.t,t1:plan.duration});
  }
  const boards=contacts.map((n,i)=>{
    const incoming=segments.find(s=>Math.abs(s.t1-n.t)<1e-8),outgoing=segments.find(s=>Math.abs(s.t0-n.t)<1e-8);
    const vin=incoming?velocity(incoming,true):[0,0,0],vout=outgoing?velocity(outgoing,false):[0,0,0];
    const impulse=new Vector3(...vout).sub(new Vector3(...vin)).normalize();
    const axis=new Vector3(impulse.z,0,-impulse.x);if(axis.lengthSq()<1e-12)axis.set(1,0,0);axis.normalize();
    const tilt=Math.min(15*Math.PI/180,Math.atan2(Math.hypot(impulse.x,impulse.z),Math.abs(impulse.y)))+n.tilt_noise;
    const q=new Quaternion().setFromAxisAngle(axis,tilt).multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),n.yaw));
    const normal=new Vector3(0,1,0).applyQuaternion(q),point=new Vector3(...n.p);
    const contact=point.clone().addScaledVector(normal,-R),pos=point.clone().addScaledVector(normal,-R-H/2);
    return {...n,index:i,i,ball_pos:n.p.slice(),contact:contact.toArray(),pos:pos.toArray(),top_y:contact.y,
      quaternion:q.toArray(),tilt,tilt_axis:axis.toArray(),off:0,palette:kit.paletteIndexFor(n.n),
      hits:[{t:n.t,amplitude:-Math.min(.12,Math.hypot(impulse.x,impulse.z)*.12)}],collision:{v_in:vin,v_out:vout}};
  });
  onProgress?.({stage:"检查球路",percent:95});
  let minSpacing=Infinity,overlaps=0,minClearance=Infinity,clearanceFails=0;
  const failures=[];
  for(let i=0;i<boards.length;i++)for(let j=0;j<i;j++) {
    const d=distance(boards[i].pos,boards[j].pos);minSpacing=Math.min(minSpacing,d);
    if(d<2*w-1e-8)overlaps++;
  }
  const inverses=boards.map(b=>new Quaternion().fromArray(b.quaternion).invert());
  for(const s of segments)if(s.kind!=='hold')for(let j=0;j<=128;j++) {
    const p=spatialPoint(s,j/128);
    for(let i=0;i<boards.length;i++) {
      const b=boards[i];if(distance(p,b.pos)>w+R)continue;
      const local=new Vector3(...p).sub(new Vector3(...b.pos)).applyQuaternion(inverses[i]);
      const d=Math.hypot(Math.max(0,Math.abs(local.x)-w/2),Math.max(0,Math.abs(local.y)-H/2),Math.max(0,Math.abs(local.z)-w/2));
      minClearance=Math.min(minClearance,d);if(d<R-1e-6){clearanceFails++;if(failures.length<60)failures.push({t:s.t0+(s.t1-s.t0)*j/128,board:i,d,segment:[s.t0,s.t1]});}
    }
  }
  const unsafeRails=channels.filter(s=>failures.some(f=>f.t>=s.visibleFrom&&f.t<=s.visibleUntil)).map(s=>s.reason.note_index);
  if(unsafeRails.length)return buildSpatialCourse(plan,kit,config,[...rejectedRails,...unsafeRails],onProgress);
  const dys=boards.slice(1).map((b,i)=>Math.abs(b.top_y-boards[i].top_y)).sort((a,b)=>a-b);
  const stats={height_range:[Math.min(...boards.map(b=>b.top_y)),Math.max(...boards.map(b=>b.top_y))],
    delta_y:{p50:median(dys),p95:dys[Math.floor((dys.length-1)*.95)]??0,max:Math.max(0,...dys)},
    min_spacing:minSpacing,diameter:D,board_width:w,ema_seconds:emaSeconds,
    rails:channels.map(s=>({note:s.reason.note_index,gap:s.reason.gap,t0:s.t0,t1:s.t1,p0:s.p0,p1:s.p1,length_widths:s.arcLength/w}))};
  const silence=(plan.rests||[]).map(r=>({t0:r.t??r.onset_sec,t1:(r.t??r.onset_sec)+(r.dur??r.dur_sec)}));
  return {format:'ball3d-spatial-v1',seed:S.seed,duration:plan.duration,contacts,boards,segments,channels,
    groups:[{index:0,members:contacts.map(n=>n.note_index)}],pad,route:contacts.map(n=>({t:n.t,p:n.p})),
    silence,
    audit:{forced:0,clearance_fails:clearanceFails,min_clearance:minClearance,clearance_scope:'sampled_128/static_oriented_planks',
      failures,plank_overlaps:overlaps,min_contact_spacing:minSpacing,required_contact_spacing:2*w,plank_gap_min:minSpacing-w,
      flights:segments.filter(s=>s.kind==='flight').length,chutes:channels.length,spatial:stats,
      tracks:{delta0,gap_threshold:threshold,rejected_unsafe:rejectedRails,long:0,glissando:0,gap:channels.length,total_notes:notes.length,carried_notes:0,ratio:0,
        longest_widths:Math.max(0,...channels.map(s=>s.arcLength/w)),rest_overlaps:channels.filter(s=>silence.some(r=>r.t0<s.t1&&r.t1>s.t0)).length,shortened:0}}};
}
