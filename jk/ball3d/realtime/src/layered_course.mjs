/** Irregular downward wall phrases with flat shelves and opposed rebounds. */
import {Vector3,Quaternion} from 'three';
import {apexFlight,seededRandom,spatialPoint,spatialRailPoint} from './spatial_course.mjs';
import {referencePlankSize,steeringPose,passageClear,plankCorners} from './wall_course.mjs';
import {wallSlideClear} from './reference_geometry.mjs';
import {proposeDecelerationPassages} from './deceleration_rail.mjs';
import {planLayerPhrases} from './layer_phrase_plan.mjs';
import {cameraPresentation} from './presentation.mjs';
import {hull,intersects,clipScreen,rectangle} from './screen_geometry.mjs';
import {lyricMetrics} from './lyric_style.mjs';

const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
const speed=(s,end)=>s?.kind==='flight'?[s.v0[0],s.v0[1]-(end?s.g*(s.t1-s.t0):0),s.v0[2]]:[0,0,0];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

export function buildLayeredCourse(plan,kit,config,onProgress) {
  const notes=plan.landings||[],R=kit.BALL_R,D=2*R,w=D*config.boards.sideDiameters;
  const size=referencePlankSize(w),wallZ=-size[2]+.015*w,z=wallZ+size[2]-.165*w;
  const random=seededRandom(config.spatial.seed^0x37ad);
  const groups=planLayerPhrases(plan,config.spatial.seed,config.spatial);
  const count=notes.length,owner=Array(count),dt=notes.slice(1).map((n,i)=>n.t-notes[i].t);
  const drops=[],desired=[],locked=Array(dt.length).fill(false),response=Array(count).fill(1);
  // Start phrase turns closer; the clearance pass adds room where needed.
  const rowGap=Math.max(4.8*w,size[2]*.95)*config.spatial.wallDropWidths/2;
  const pairAt=Array(count).fill(null);
  for(const g of groups)for(const p of g.rebound_starts||[])pairAt[p]=pairAt[p+1]=p;
  const fastAt=i=>pairAt[i]!=null&&owner[i]?.fast_rebound;
  const limitAt=i=>Math.min(pairAt[i]!=null?35:25,config.boards.maxTilt)*Math.PI/180;
  const poseBoard=(b,vin,vout)=>{
    const pose=steeringPose(b,vin,vout,R,wallZ);
    // Keep the planned top height while the actual flight determines the face.
    const normal=new Vector3(...pose.collision.normal),right=new Vector3(1,0,0).applyQuaternion(new Quaternion(...pose.quaternion));
    const dy=b.layer_y-pose.pos[1]-size[1]/2*normal.y;
    const shift=Math.abs(right.y)>1e-9?dy/right.y:0;
    pose.pos=pose.pos.map((x,k)=>x+right.getComponent(k)*shift);
    pose.pivot=pose.pivot.map((x,k)=>x+right.getComponent(k)*shift);
    pose.top_y=b.layer_y;pose.face_shift=shift;
    pose.hits=[{t:b.t,amplitude:b.ordinary_flat?0:response[b.i]*Math.max(0,Math.min(3*Math.PI/180,limitAt(b.i)-pose.tilt)),phase:-Math.PI/2}];
    return pose;
  };
  for(const g of groups)for(let i=g.start;i<=g.end;i++)owner[i]=g;
  const varied=(low,high,previous)=>{
    for(let j=0;j<32;j++) {
      const value=low+(high-low)*random();
      if(!previous||Math.abs(value-previous)/Math.max(value,previous)>.2)return value;
    }
    return previous<(low+high)/2?high:low;
  };
  for(let e=0;e<dt.length;e++) {
    const g=owner[e],next=owner[e+1],internal=g===next;
    drops[e]=internal&&g.level?0:internal?varied(1.2*w*config.spatial.wallDropWidths,2.3*w*config.spatial.wallDropWidths,drops[e-1]):rowGap*(1+random()*.35);
    desired[e]=g.direction*varied(2.4*w,4.8*w,e?Math.abs(desired[e-1]*dt[e-1]):0)/dt[e];
  }
  for(const g of groups) {
    const spans=g.level?[[g.start-1,g.end]]:(g.rebound_starts||[]).map(p=>[p-1,p+1]);
    for(const [start,end] of spans)for(let e=start;e<=end;e++)locked[e]=true;
  }
  const intervals=dt.slice().sort((a,b)=>a-b),middle=(intervals.length-1)/2;
  const delta0=intervals.length?(intervals[Math.floor(middle)]+intervals[Math.ceil(middle)])/2:0;
  const threshold=Math.max(1,3.5*delta0),turn=Array(count).fill(false),edgeSign=dt.map((_,e)=>owner[e].direction);
  // Open ordinary descents without changing special passages or long-gap rails.
  for(let e=0;e<dt.length;e++) {
    const g=owner[e];
    if(g!==owner[e+1]||g.level||g.rebound_starts.length||locked[e]||dt[e]>=threshold)continue;
    drops[e]*=.85;
  }
  if(count)turn[0]=turn[count-1]=true;
  for(const g of groups) {
    if(!g.level)turn[g.start]=true;
    else {
      turn[g.start-1]=true;
      for(let i=g.start;i<=g.end;i++)turn[i]=false;
      for(let e=g.start-1;e<=g.end;e++)edgeSign[e]=g.direction;
    }
    for(const p of g.rebound_starts||[])edgeSign[p]=-g.direction;
  }
  // Slow long gaps independently, without changing the flat shelf entry speed.
  for(let e=0;e<dt.length;e++)if(dt[e]>=threshold&&!locked[e])turn[e]=turn[e+1]=true;
  for(const g of groups)if(!g.level&&dt[g.start]>=.8&&!locked[g.start]&&
      dt[g.start]>2.4*Math.min(...dt.slice(g.start,g.end+1)))turn[g.start+1]=true;
  // Slow long phrase exits while retaining mostly horizontal ordinary shelves.
  const ordinary=notes.map((_,i)=>i).filter(i=>pairAt[i]==null&&!owner[i].level);
  let turnBudget=Math.floor(.4*ordinary.length)-ordinary.filter(i=>turn[i]).length;
  for(const g of groups.slice().sort((a,b)=>(dt[b.end]||0)-(dt[a.end]||0))) {
    if(turnBudget>0&&!turn[g.end]&&!g.level&&dt[g.end]>=.8&&!locked[g.end]&&
      dt[g.end]>2.4*Math.min(...dt.slice(g.start,g.end))) {
      turn[g.end]=true;turnBudget--;
    }
  }
  const parent=dt.map((_,e)=>e),find=e=>parent[e]===e?e:parent[e]=find(parent[e]);
  for(let i=1;i<count-1;i++)if(!turn[i])parent[find(i)]=find(i-1);
  const blocks=[],edgeBlock=dt.map((_,e)=>{
    const root=find(e);let b=blocks.find(b=>b.root===root);
    if(!b){b={root,edges:[],minimum:0,value:0};blocks.push(b);}
    b.edges.push(e);return b;
  });
  const compact=new Set(groups.flatMap(g=>(g.rebound_starts||[]).flatMap(p=>[p,p+1])));
  let boards=[],segments=[],pad,attempt=0,failures=[];
  const projectedConflicts=()=>{
    const aspect=9/16,tan=Math.tan(config.camera.fov*Math.PI/360),yaw=config.camera.yaw*Math.PI/180,tilt=config.camera.downwardTilt*Math.PI/180;
    const direction=[Math.cos(tilt)*Math.sin(yaw),Math.sin(tilt),Math.cos(tilt)*Math.cos(yaw)];
    const right=[Math.cos(yaw),0,-Math.sin(yaw)],up=[-Math.sin(tilt)*Math.sin(yaw),Math.cos(tilt),-Math.sin(tilt)*Math.cos(yaw)];
    const dot=(a,b)=>a.reduce((s,x,k)=>s+x*b[k],0),conflicts=new Map();
    const corners=boards.map(b=>[...plankCorners(b),...plankCorners(b,b.hits[0].amplitude)]);
    const support=t=>{
      let lo=0,hi=segments.length;
      while(lo<hi){const m=(lo+hi)>>1;if(segments[m].t1<t)lo=m+1;else hi=m;}
      const s=segments[Math.min(lo,segments.length-1)];
      if(!s)return pad.ball_pos;
      const u=clamp((t-s.t0)/(s.t1-s.t0),0,1);
      if(s.kind==='ride')return spatialPoint(s,u);
      return s.p0.map((x,k)=>x+(s.p1[k]-x)*u);
    };
    for(const s of segments)for(let j=0,samples=Math.max(4,Math.ceil((s.t1-s.t0)*8));j<samples;j++) {
      const t=s.t0+(s.t1-s.t0)*j/samples;
      let first=boards.findIndex(b=>b.t>t);if(first<0)first=count;
      const ahead=boards.slice(first,first+10).map(b=>({index:b.i,points:corners[b.i]}));
      // Reserve board and lyric spacing in the same smooth view as the render.
      const view=cameraPresentation(support,plan.duration,t,aspect,R,config,ahead,{ballPosition:spatialPoint(s,j/samples)});
      const visible=[];
      for(let i=Math.max(0,first-8);i<Math.min(count,first+10);i++) {
        const points=corners[i].map(p=>{
          const relative=p.map((x,k)=>x-view.position[k]),depth=-dot(relative,direction);
          return depth>R?[dot(relative,right)/(depth*aspect*tan)-view.shift[0],dot(relative,up)/(depth*tan)-view.shift[1]]:null;
        });
        if(points.some(p=>!p))continue;
        const slab=clipScreen(hull(points));if(slab.length<3)continue;
        const minX=Math.min(...points.map(p=>p[0])),maxX=Math.max(...points.map(p=>p[0])),bottom=Math.min(...points.map(p=>p[1]));
        const lyric=boards[i].lyric,metrics=lyricMetrics(lyric||'',aspect);
        const label=lyric?clipScreen(rectangle((minX+maxX)/2,bottom-metrics.gap-metrics.halfH,metrics.halfW,metrics.halfH)):[];
        for(const a of visible)if(intersects(slab,a.slab,.004)||intersects(label,a.slab,.004)||intersects(slab,a.label,.004)||intersects(label,a.label,.004))
          conflicts.set(`${a.i}:${i}`,{kind:'projected',board:i,other:a.i});
        visible.push({i,slab,label});
      }
    }
    // A fast crossing can pass a previous lyric between the ordinary samples.
    // Reserve space in the fixed course using the actual smooth camera.
    for(const s of segments) {
      if(!boards.some(b=>b.fast_rebound&&Math.abs(b.t-s.t0)<1e-8))continue;
      for(let j=0,samples=Math.max(16,Math.ceil((s.t1-s.t0)*60));j<samples;j++) {
        const t=s.t0+(s.t1-s.t0)*j/samples,ball=spatialPoint(s,j/samples);
        const view=cameraPresentation(support,plan.duration,t,aspect,R,config,[],{ballPosition:ball});
        const relative=ball.map((x,k)=>x-view.position[k]),depth=-dot(relative,direction);
        if(depth<=R)continue;
        const bounds=[right,up].map((axis,k)=>{
          const offset=dot(relative,axis),scale=tan*(k===0?aspect:1),q=depth*depth-R*R;
          const center=offset*depth/(q*scale)-view.shift[k],extent=R*Math.sqrt(offset*offset+q)/(q*scale);
          return [center-extent,center+extent];
        });
        const ballPolygon=Array.from({length:32},(_,i)=>bounds.map((b,k)=>(b[0]+b[1])/2+(b[1]-b[0])/2*(k===0?Math.cos:Math.sin)(i*Math.PI/16)));
        let first=boards.findIndex(b=>b.t>t);if(first<0)first=count;
        const previous=Math.max(0,first-1);
        for(let i=Math.max(0,first-4);i<Math.min(count,first+4);i++) {
          if(i===previous||!boards[i].lyric)continue;
          const points=corners[i].map(p=>{
            const relative=p.map((x,k)=>x-view.position[k]),depth=-dot(relative,direction);
            return depth>R?[dot(relative,right)/(depth*aspect*tan)-view.shift[0],dot(relative,up)/(depth*tan)-view.shift[1]]:null;
          });
          if(points.some(p=>!p))continue;
          const x=(Math.min(...points.map(p=>p[0]))+Math.max(...points.map(p=>p[0])))/2,bottom=Math.min(...points.map(p=>p[1]));
          const {halfH,halfW,gap}=lyricMetrics(boards[i].lyric,aspect);
          if(intersects(rectangle(x,bottom-gap-halfH,halfW,halfH),ballPolygon,.004)) {
            const other=Math.min(i,previous),board=Math.max(i,previous);
            conflicts.set(`${other}:${board}`,{kind:'projected',board,other});
          }
        }
      }
    }
    return [...conflicts.values()];
  };
  const build=()=>{
    boards=[];segments=[];
    const py=[R],vx=desired.slice();
    for(let e=0;e<dt.length;e++)py.push(py.at(-1)-drops[e]);
    const flights=dt.map((_,e)=>apexFlight([0,py[e],z],[0,py[e+1],z],notes[e].t,notes[e+1].t,D));
    const lead=count&&notes[0].t>0?apexFlight([0,py[0]+.5,z],[0,py[0],z],Math.max(0,notes[0].t-config.physics.leadFlight),notes[0].t,D):null;
    const impulse=i=>speed(flights[i],false)[1]-speed(i?flights[i-1]:lead,true)[1];
    for(const g of groups){g.y=py[g.start]-R;g.up=false;g.shape='line';g.adaptive_rebound=g.rebound_start!=null;}
    // Flat boards preserve one horizontal speed. Rebounds change only its
    // sign; their actual normals follow the impulse, with 35 degrees a limit.
    for(const b of blocks) {
      const gaps=b.edges.map(e=>dt[e]).sort((a,b)=>a-b),median=gaps[Math.floor(gaps.length/2)];
      const level=b.edges.some(e=>owner[e].level||owner[e+1].level);
      b.low=Math.max(b.minimum,level?2.2*w/gaps[0]:0,...b.edges.map(e=>{
        const s=flights[e],start=2*s.v0[1]/s.g;
        const end=Math.min(dt[e],(s.v0[1]+Math.sqrt(s.v0[1]**2+2*s.g*(2*R+size[1])))/s.g);
        let minimum=0;
        for(let j=0;j<=64;j++) {
          const age=start+(end-start)*j/64,y=R+s.v0[1]*age-.5*s.g*age*age;
          const dy=Math.max(0,y,-size[1]-y);
          if(dy<R)minimum=Math.max(minimum,(w/2+Math.sqrt(R*R-dy*dy))/age);
        }
        return minimum*1.02;
      }));
      b.high=Math.min(Infinity,...b.edges.filter(e=>compact.has(e)).map(e=>5*w/dt[e]));
      const ordinary=b.edges.every(e=>!locked[e]&&dt[e]<threshold&&
        !owner[e].level&&!owner[e+1].level&&!owner[e].rebound_starts.length&&!owner[e+1].rebound_starts.length);
      b.value=Math.max(b.low,Math.min((ordinary?1.15:1)*2.4*w/median,b.high));
    }
    // Project whole speed blocks into the normal cone; changing one flight
    // alone would tilt an ordinary board or separate a rebound from its exit.
    for(let pass=0;pass<96;pass++) {
      let changed=false;
      for(let i=0;i<count;i++) {
        const incoming=i?edgeBlock[i-1]:null,outgoing=i<count-1?edgeBlock[i]:null;
        const a=i?edgeSign[i-1]:0,b=i<count-1?edgeSign[i]:0;
        const bound=impulse(i)*Math.tan(limitAt(i))*.97,delta=b*(outgoing?.value||0)-a*(incoming?.value||0);
        if(Math.abs(delta)<=bound+1e-9)continue;
        const correction=Math.abs(delta)-bound,sign=Math.sign(delta);
        if(incoming===outgoing) {
          const previous=incoming.value;
          incoming.value=Math.max(incoming.low,incoming.value-correction/Math.abs(b-a));
          changed||=Math.abs(previous-incoming.value)>1e-10;
        } else for(const [block,gradient] of [[incoming,-a*sign],[outgoing,b*sign]])if(block) {
          const previous=block.value;
          block.value=clamp(block.value-correction*gradient/2,block.low,Math.max(block.low,block.high));
          changed||=Math.abs(previous-block.value)>1e-10;
        }
      }
      if(!changed)break;
    }
    for(let e=0;e<dt.length;e++)vx[e]=edgeSign[e]*edgeBlock[e].value;
    let x=0;
    for(const g of groups) {
      for(let i=g.start;i<=g.end;i++) {
        if(i)x+=vx[i-1]*dt[i-1];
        const n=notes[i],event=plan.events?.find(e=>e.kind==='note'&&Math.abs(e.onset_sec-n.t)<1e-7);
        const y=py[i]-R,p=[x,py[i],z];
        boards.push({...n,index:i,i,note_index:i,group:g.index,phrase:g.index,phrase_side:Math.sign(x)||1,
          layer_group:g.index,layer_y:y,level_group:g.level?g.index:null,level_repeat:!!g.level&&i>g.start,
          rebound_pair:pairAt[i],fast_rebound:!!fastAt(i),
          ordinary_flat:!turn[i]&&pairAt[i]==null,turn:turn[i],
          p,ball_pos:p,size:size.slice(),lyric:n.lyric??event?.lyric,tilt_axis:[0,0,1],off:0,palette:n.n-1,
          hits:[],placement_failed:false});
      }
    }
    const first=boards[0],padPoint=first?[first.p[0],first.p[1]+.5,z]:[0,R,z];
    pad={ball_pos:padPoint,pos:[padPoint[0],padPoint[1]-R,z],top_y:padPoint[1]-R};
    if(first) {
      const start=Math.max(0,first.t-config.physics.leadFlight);
      if(start)segments.push({kind:'hold',p0:padPoint,p1:padPoint,t0:0,t1:start});
      if(first.t>start)segments.push(apexFlight(padPoint,first.p,start,first.t,D));
      for(let i=1;i<boards.length;i++)segments.push(apexFlight(boards[i-1].p,boards[i].p,boards[i-1].t,boards[i].t,D));
      const last=boards.at(-1);
      if(last.t<plan.duration)segments.push({kind:'hold',p0:last.p,p1:last.p,t0:last.t,t1:plan.duration});
    }
    boards=boards.map(b=>{
      const before=segments.find(s=>Math.abs(s.t1-b.t)<1e-8),after=segments.find(s=>Math.abs(s.t0-b.t)<1e-8);
      return poseBoard(b,speed(before,true),speed(after,false));
    });
  };
  // Bounded whole-course passes replace the old note-by-note backtracking.
  for(attempt=0;attempt<32;attempt++) {
    onProgress?.({stage:'排列木板',percent:10+attempt*2,completed:Math.min(count,attempt*8),total:count});
    build();failures=[];
    for(const block of blocks)if(block.value>block.high+1e-8)
      failures.push({kind:'compact',board:block.edges.find(e=>compact.has(e)),speed:block.value,limit:block.high});
    for(const b of boards)if(b.tilt>limitAt(b.i)+1e-8||Math.abs(b.face_shift)>w*.45)
      failures.push({kind:'steering',board:b.i,tilt:b.tilt*180/Math.PI});
    for(let i=1;i<count;i++)for(let j=Math.max(0,i-8);j<i;j++)if(distance(boards[i].pos,boards[j].pos)<2*w)
      failures.push({kind:'spacing',board:i,other:j});
    if(!failures.length)for(const s of segments)if(s.kind==='flight') {
      const result=passageClear(s,boards,R,config,64);
      if(!result.ok)failures.push({...result,kind:'passage',source:boards.find(b=>Math.abs(b.t-s.t0)<1e-8)?.i});
    }
    if(!failures.length)failures.push(...projectedConflicts());
    if(!failures.length)break;
    let changed=false;
    for(const f of failures) {
      if(f.kind==='passage'&&f.board===f.source&&edgeBlock[f.source]) {
        const block=edgeBlock[f.source],minimum=block.value*1.15;
        if(minimum<=block.high){block.minimum=Math.max(block.minimum,minimum);changed=true;continue;}
      }
      const edges=(f.kind==='projected'?Array.from({length:f.board-f.other},(_,j)=>f.other+j):[f.board-1,f.board])
        .filter(e=>e>=0&&e<drops.length&&drops[e]>0&&drops[e]<14*w);
      const e=edges.sort((a,b)=>dt[a]-dt[b])[0];
      if(e!=null){drops[e]=Math.min(14*w,drops[e]*1.2);changed=true;}
      if(f.kind==='passage'&&response[f.board]){response[f.board]=0;changed=true;}
    }
    if(!changed)break;
  }
  if(failures.length||attempt===32)throw new Error(`Layered phrase cannot connect safely: ${JSON.stringify(failures[0]||{kind:'spacing'})}`);
  const channels=[],rejected=[];
  const railKit={BALL_R:R,channelCenter:spatialRailPoint,transitionPoint:spatialPoint};
  function* railPassages(a,b,gap) {
    let attempts=0;
    for(const passage of proposeDecelerationPassages(a,b,{g:config.physics.gravity,width:w,ballRadius:R})) {
      if(attempts++===32)break;
      yield passage;
    }
    for(const fraction of [.25,.3,.2,.35])for(const height of [.5,.35,.65]) {
      const fly=Math.max(.25,gap*fraction),duration=gap-2*fly,entrySpeed=Math.abs(b.p[0]-a.p[0])/gap;
      const arcLength=entrySpeed*duration,sign=Math.sign(b.p[0]-a.p[0]);
      if(duration<=0||arcLength<1.2*w||arcLength>4*w)continue;
      const y=a.p[1]+height*(b.p[1]-a.p[1]);
      const rail={kind:'ride',spatial:true,straight:true,p0:[a.p[0]+sign*entrySpeed*fly,y,z],
        p1:[b.p[0]-sign*entrySpeed*fly,y,z],angle0:-sign*Math.PI/2,sweep:0,
        t0:a.t+fly,t1:b.t-fly,duration,g:config.physics.gravity,arcLength,entrySpeed,shortened:false};
      yield [apexFlight(a.p,rail.p0,a.t,rail.t0,D),rail,apexFlight(rail.p1,b.p,rail.t1,b.t,D)];
    }
  }
  for(let i=0;i<count-1&&config.spatial.maxRails>0;i++) {
    const a=boards[i],b=boards[i+1],gap=b.t-a.t;
    // Wide crossings need support even after the optional long-gap rail quota.
    const wide=gap>=1&&Math.abs(b.p[0]-a.p[0])>6*w;
    const optional=channels.filter(s=>!s.reason.wide).length;
    if(wide&&channels.length-optional>=Math.min(3,config.spatial.maxRails))continue;
    if(!wide&&(gap<threshold||optional>=Math.min(3,config.spatial.maxRails)))continue;
    if(channels.some(s=>wide?a.t<s.visibleUntil+.5:a.t-s.visibleFrom<8))continue;
    if(locked[i-1]||locked[i]||locked[i+1])continue;
    const at=segments.findIndex(s=>s.kind==='flight'&&s.t0===a.t&&s.t1===b.t);
    let accepted=false;
    for(const passage of railPassages(a,b,gap)) {
      if(accepted)break;
      const rail=passage[1];
      Object.assign(rail,{note_indices:[],beads:[],visibleFrom:a.t,visibleUntil:b.t,reason:{type:'gap',note_index:i,gap,wide}});
      for(const [j,s] of passage.entries())if(j!==1)s.reason={type:'gap',leg:s.edge?'edge':j===0?'entry':'exit',decelerating:!!rail.decelerating};
      const shift=passage.shiftX||0,move=p=>[p[0]+shift,p[1],p[2]];
      if(rail.decelerating)rail.layoutShiftX=shift;
      const moveBoard=p=>({...p,...Object.fromEntries(['p','ball_pos','pos','pivot','contact'].map(key=>[key,move(p[key])]))});
      const target=shift?moveBoard(b):b;
      const changed=[poseBoard({...a,ordinary_flat:false,rail_connector:true},speed(segments[at-1],true),speed(passage[0],false)),
        poseBoard({...target,ordinary_flat:false,rail_connector:true},speed(passage.at(-1),true),speed(segments[at+1],false))];
      if(changed.some(p=>p.tilt>limitAt(p.i)+1e-8||Math.abs(p.face_shift)>.38*w))continue;
      const oldBoards=boards,oldSegments=segments;
      boards=boards.map(p=>changed.find(q=>q.i===p.i)||(shift&&p.i>i?moveBoard(p):p));
      const suffix=segments.slice(at+1).map(s=>shift?{...s,p0:move(s.p0),p1:move(s.p1)}:s);
      segments=[...segments.slice(0,at),...passage,...suffix];
      const near=segments.filter(s=>s.kind!=='hold'&&s.t1>=a.t-2&&s.t0<=b.t+2);
      const spaced=changed.every(p=>boards.every(q=>q.i===p.i||distance(p.pos,q.pos)>=2*w));
      const safe=spaced&&near.every(s=>passageClear(s,boards,R,config).ok)&&
        [...channels,rail].every(s=>wallSlideClear(s,segments.filter(p=>p.kind!=='hold'),railKit,wallZ,w));
      if(safe&&!projectedConflicts().length){channels.push(rail);accepted=true;}
      else {boards=oldBoards;segments=oldSegments;}
    }
    if(!accepted)rejected.push(i);
  }
  let minSpacing=Infinity,minClearance=Infinity,maxImpulseError=0;
  onProgress?.({stage:'排列木板',percent:80,completed:boards.length,total:boards.length});
  for(let i=0;i<boards.length;i++)for(let j=0;j<i;j++)minSpacing=Math.min(minSpacing,distance(boards[i].pos,boards[j].pos));
  for(const [i,s] of segments.entries())if(s.kind!=='hold') {
    onProgress?.({stage:'检查球路',percent:85+14*i/segments.length,completed:i,total:segments.length});
    const result=passageClear(s,boards,R,config);
    minClearance=Math.min(minClearance,result.min);
    if(!result.ok)failures.push(result);
  }
  for(const b of boards)maxImpulseError=Math.max(maxImpulseError,new Vector3(...b.collision.v_out).sub(new Vector3(...b.collision.v_in)).cross(new Vector3(...b.collision.normal)).length());
  const ys=boards.map(b=>b.top_y),dy=boards.slice(1).map((b,i)=>Math.abs(b.top_y-boards[i].top_y)).sort((a,b)=>a-b);
  const phraseGroups=groups.map(({index,start,end,y,direction,shape,up,level,rebound_start,rebound_starts,fast_rebound,adaptive_rebound})=>{
    const heights=boards.slice(start,end+1).map(b=>b.pos[1]+size[1]/2*b.collision.normal[1]);
    return {index,start,end,y,direction,shape,up,level:!!level,rebound_start,rebound_starts,fast_rebound,adaptive_rebound:!!adaptive_rebound,t0:notes[start].t,t1:notes[end].t,
      top_y_start:heights[0],top_y_end:heights.at(-1),
      top_y_range:[Math.min(...heights),Math.max(...heights)]};
  });
  const levelSteps=boards.slice(1).filter((b,i)=>Math.abs(b.top_y-boards[i].top_y)<1e-9).length;
  const descendingSteps=boards.slice(1).filter((b,i)=>b.top_y<boards[i].top_y-1e-9).length;
  const silence=(plan.rests||[]).map(r=>({t0:r.onset_sec,t1:r.onset_sec+r.dur_sec}));
  return {format:'ball3d-wall-v1',seed:config.spatial.seed,wallZ,duration:plan.duration,contacts:boards,boards,segments,channels,pad,
    groups:groups.map(g=>({index:g.index,members:boards.slice(g.start,g.end+1).map(b=>b.i)})),route:boards.map(b=>({t:b.t,p:b.p})),
    silence,
    audit:{forced:0,clearance_fails:failures.length,min_clearance:Number.isFinite(minClearance)?minClearance:null,failures,
      plank_overlaps:minSpacing<2*w?1:0,min_contact_spacing:Number.isFinite(minSpacing)?minSpacing:null,required_contact_spacing:2*w,
      plank_gap_min:Number.isFinite(minSpacing)?minSpacing-w:null,flights:segments.filter(s=>s.kind==='flight').length,chutes:channels.length,
      spatial:{mode:'wall-phrase-layers',height_range:ys.length?[Math.min(...ys),Math.max(...ys)]:[0,0],diameter:D,board_width:w,board_size:size,
        min_spacing:Number.isFinite(minSpacing)?minSpacing:null,source_model:'reference_planks/reference_planks.blend:Plank_02_Ivory',
        layer_max_height_error:Math.max(0,...boards.map(b=>Math.abs(b.pos[1]+size[1]/2*b.collision.normal[1]-b.layer_y))),
        baseline_drop:rowGap,delta_y:{p50:dy[Math.floor(dy.length/2)]??0,p95:dy[Math.floor(dy.length*.95)]??0,max:Math.max(0,...dy)},
        steering:{max_tilt_degrees:Math.max(0,...boards.map(b=>b.tilt*180/Math.PI)),max_impulse_error:maxImpulseError,retries:attempt,local_replans:0},
        phrasing:{groups:groups.length,phrase_groups:phraseGroups,level_groups:phraseGroups.filter(g=>g.level),
          rebound_pairs:groups.flatMap(g=>(g.rebound_starts||[]).map(p=>[p,p+1])),
          fast_rebound_pairs:groups.filter(g=>g.fast_rebound).flatMap(g=>g.rebound_starts.map(p=>[p,p+1])),
          level_steps:levelSteps,descending_steps:descendingSteps,level_repeats:levelSteps,
          same_side_jumps:boards.slice(1).filter((b,i)=>b.p[0]*boards[i].p[0]>0).length,
          local_opposite_tilts:boards.slice(1).filter((b,i)=>b.group===boards[i].group&&b.collision.normal[0]*boards[i].collision.normal[0]<0).length,
          reverse_boards:0,inclined_boards:boards.filter(b=>b.tilt>15*Math.PI/180).length},
        rails:channels.map(s=>({t:s.t0,end:s.t1,gap:s.reason.gap,length_widths:s.arcLength/w,
          flight_in:s.t0-s.visibleFrom,flight_out:s.visibleUntil-s.t1}))},
      tracks:{delta0,gap_threshold:threshold,long:0,glissando:0,gap:channels.length,total_notes:notes.length,carried_notes:0,ratio:0,
        decelerating:channels.filter(s=>s.decelerating).length,
        longest_widths:Math.max(0,...channels.map(s=>s.arcLength/w)),
        rest_overlaps:channels.filter(s=>silence.some(r=>r.t0<s.t1&&r.t1>s.t0)).length,shortened:0,rejected_unsafe:rejected}}};
}
