/** Seeded downward wall course using the original plank proportions. */
import { Vector3, Quaternion, CatmullRomCurve3, Ray, Box3, Sphere } from 'three';
import source from '../../assets/reference_planks/model_check.json' with {type:'json'};
import { apexFlight, seededRandom, spatialPoint, boardPose, spatialRailPoint, spatialRailTangent } from './spatial_course.mjs';
import { boardSpring } from './presentation.mjs';
import { hull, intersects, clipScreen, rectangle } from './screen_geometry.mjs';
import { wallSlideClear } from './reference_geometry.mjs';

const profile=source.boards.find(b=>b.name==='Plank_02_Ivory').dimensions_m;
export function referencePlankSize(width) {
  return [width,width*profile[2]/profile[0],width*profile[1]/profile[0]];
}
export const NOTE_LIGHTS=['#ff2028','#ff810d','#ffdf18','#39e651','#16e5dd','#2465ff','#aa38ff'];
export function notePulse(t,onset) {
  const age=t-onset;
  return age<0||age>2?0:Math.min(1,age/.05)*Math.exp(-Math.max(0,age-.05)/.6);
}
export const wallSwing=(t,board,config)=>Math.max(0,boardSpring(t,board.hits,config));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const distance=(a,b)=>Math.hypot(...a.map((x,k)=>x-b[k]));
const median=a=>a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:0;
const velocity=(s,end)=>s?.kind==='flight'?[s.v0[0],s.v0[1]-(end?s.g*(s.t1-s.t0):0),s.v0[2]]:
  s?.kind==='ride'?spatialRailTangent(s,end?1:0).map(x=>x*s.entrySpeed):[0,0,0];

/** A frictionless normal impulse must explain the change in flight velocity. */
export function steeringPose(board,vin,vout,R,wallZ) {
  const normal=new Vector3(...vout).sub(new Vector3(...vin)).normalize();
  if(normal.lengthSq()===0)normal.set(0,1,0);
  const level=board.level_group!=null,flat=Math.hypot(normal.x,normal.z)<1e-9&&normal.y>0;
  if(level&&flat)normal.set(0,1,0);
  const q=new Quaternion().setFromUnitVectors(new Vector3(0,1,0),normal);
  const long=new Vector3(0,0,1).applyQuaternion(q),[w,h,depth]=board.size;
  const contact=new Vector3(...board.p).addScaledVector(normal,-R);
  const pos=contact.clone().addScaledVector(normal,-h/2);
  // Slide the slab along its own face: keep the rear in the wall and the
  // sphere exactly tangent to the real top surface, even with a depth tilt.
  const rearCenterZ=wallZ+long.z*(depth/2-.015*w);
  const along=(pos.z-rearCenterZ)/long.z;
  pos.addScaledVector(long,-along);
  const pivot=pos.clone().addScaledVector(normal,-h/2).addScaledVector(long,-depth/2+.15*w);
  return {...board,quaternion:q.toArray(),tilt:level&&!flat||Math.abs(along)>depth/2?Infinity:Math.acos(clamp(normal.y,-1,1)),
    contact:contact.toArray(),pos:pos.toArray(),pivot:pivot.toArray(),top_y:contact.y,
    tilt_axis:board.accent_group!==undefined?new Vector3(1,0,0).applyQuaternion(q).toArray():board.tilt_axis,
    collision:{v_in:vin,v_out:vout,normal:normal.toArray()}};
}

export function plankCorners(board,angle=0) {
  const pose=boardPose(board,board.size[1],angle),q=pose.quaternion,center=pose.center;
  return Array.from({length:8},(_,i)=>{
    const p=new Vector3((i&1?1:-1)*board.size[0]/2,(i&2?1:-1)*board.size[1]/2,(i&4?1:-1)*board.size[2]/2).applyQuaternion(q).add(center);
    return p.toArray();
  });
}

/** Check the swept sphere against the same moving slabs that the renderer uses. */
export function passageClear(segment,boards,R,config,samples=128) {
  let min=Infinity;
  const upper=segment.kind==='flight'?segment.apex:segment.p0[1];
  const lower=Math.min(segment.p0[1],segment.p1[1]);
  const nearby=boards.filter(b=>b.pos[1]>=lower-R-.25 && b.pos[1]<=upper+R+.25);
  for(let j=0;j<=samples;j++) {
    const t=segment.t0+(segment.t1-segment.t0)*j/samples,p=new Vector3(...spatialPoint(segment,j/samples));
    for(const b of nearby) {
      const angle=Math.min(wallSwing(t,b,config.boards),config.boards.maxTilt*Math.PI/180);
      const pose=boardPose(b,b.size[1],angle),local=p.clone().sub(pose.center).applyQuaternion(pose.quaternion.invert());
      const d=Math.hypot(...b.size.map((size,k)=>Math.max(0,Math.abs(local.getComponent(k))-size/2)));
      min=Math.min(min,d);
      if(d<R-1e-6)return {ok:false,min,board:b.index,t};
    }
  }
  return {ok:true,min};
}

/** Select rare repeated-pitch passages after several complete descending phrases. */
export function planLevelGroups(plan,phrases,config) {
  const notes=plan.landings||[],random=seededRandom(config.seed^0x19e7),groups=[];
  const pause=()=>config.levelPhraseGap-1+Math.floor(random()*3);
  let wait=pause(),nextPhrase=wait;
  for(let i=2;i<notes.length-3;i++) {
    if(phrases[i].index<nextPhrase)continue;
    let end=i;
    while(end+1<notes.length-1&&end-i+1<config.levelMaxNotes&&
      notes[end+1].midi===notes[i].midi&&notes[end+1].t-notes[end].t<=1&&
      !(plan.rests||[]).some(r=>r.onset_sec<notes[end+1].t-1e-7&&r.onset_sec+r.dur_sec>notes[end].t+1e-7))end++;
    // A flat row also preserves lateral speed on its entry and exit flights.
    // A long neighbouring gap must not carry that speed far beyond the wall.
    const fits=last=>{
      if(last-i+1<3)return false;
      const gap=Math.min(...notes.slice(i+1,last+1).map((n,k)=>n.t-notes[i+k].t));
      const middle=(notes[i].t+notes[last].t)/2;
      return 2.1*(notes[last].t-notes[i].t)/gap<=10.5+1e-8&&
        [notes[i-1],notes[last+1]].every(n=>Math.abs(2.1*(n.t-middle)/gap)<=10.5+1e-8);
    };
    while(end-i+1>3&&!fits(end))end--;
    if(!fits(end))continue;
    groups.push({start:i,end,direction:phrases[end+1].side,descending_phrases:wait,attempts:0,active:true});
    wait=pause();nextPhrase=phrases[end].index+1+wait;i=end;
  }
  return groups;
}

export function buildWallCourse(plan,kit,config,onProgress) {
  const S=config.spatial,R=kit.BALL_R,D=2*R,w=D*config.boards.sideDiameters;
  const [,H,depth]=referencePlankSize(w),wallZ=-depth+.015*w;
  const random=seededRandom(S.seed),notes=plan.landings||[],contacts=[],boards=[],polygons=[],segments=[],channels=[];
  const maxSteeringTilt=Math.min(15,config.boards.maxTilt)*Math.PI/180;
  const incoming=b=>b.i?apexFlight(boards[b.i-1].p,b.p,boards[b.i-1].t,b.t,D):b.t>0?
    apexFlight([b.p[0],b.p[1]+.5,b.p[2]],b.p,Math.max(0,b.t-config.physics.leadFlight),b.t,D):null;
  const gaps=notes.slice(1).map((n,i)=>n.t-notes[i].t).sort((a,b)=>a-b),delta0=median(gaps),threshold=Math.max(1,3.5*delta0);
  const curve=new CatmullRomCurve3(Array.from({length:Math.max(4,Math.ceil(notes.length/8)+1)},(_,i)=>new Vector3((random()-.5)*3*w,-i*8*S.wallDropWidths*w,0)));
  const [beats=4,unit=4]=String(plan.meter||'4/4').split('/').map(Number);
  // Plan short rhythmic groups before placing individual slabs. A separate
  // seeded stream keeps phrase intent stable when collision search backtracks.
  const phraseRandom=seededRandom(S.seed^0x51a7),phrases=[];
  let phrase=0,side=phraseRandom()<.5?-1:1,phraseStart=0,phraseLength=3+Math.floor(phraseRandom()*3);
  const beatSeconds=60/(plan.tempo_qpm||120);
  for(let i=0;i<notes.length;i++) {
    if(i&&((i-phraseStart>=phraseLength)||notes[i].t-notes[i-1].t>1.5*beatSeconds)) {
      phrase++;side=-side;phraseStart=i;phraseLength=3+Math.floor(phraseRandom()*4);
    }
    const offset=i-phraseStart;
    const plateau=i>0&&notes[i].midi===notes[i-1].midi&&!phrases[i-1].plateau&&
      phraseRandom()<.3;
    phrases.push({index:phrase,side,offset,plateau});
  }
  const levelGroups=planLevelGroups(plan,phrases,S),levelAt=[],levelDepth=new Set();
  for(const p of phrases)p.plateau=false;
  for(const g of levelGroups) {
    for(let i=g.start;i<=g.end;i++){levelAt[i]=g;phrases[i].plateau=i>g.start;}
    for(let i=g.start-3;i<=g.end+3;i++)levelDepth.add(i);
  }
  const groupX=(g,i)=>{
    const gap=Math.min(...notes.slice(g.start+1,g.end+1).map((n,k)=>n.t-notes[g.start+k].t));
    return g.direction*2.1*w/gap*(notes[i].t-(notes[g.start].t+notes[g.end].t)/2);
  };
  const corridorAt=i=>levelGroups.find(g=>g.active&&i>=g.start-1&&i<=g.end+1);
  const levelEntry=i=>levelGroups.find(g=>g.active&&i>=g.start-2&&i<g.start);
  const levelExit=i=>levelGroups.find(g=>g.active&&i>g.end&&i<=g.end+2);
  // Steer on the approach/exit slabs; every slab inside the row stays flat.
  const levelTurn=i=>levelGroups.find(g=>g.active&&(i>=g.start-2&&i<g.start||i>g.end&&i<=g.end+2));
  const steeringLimit=b=>b?.accent_group===undefined?maxSteeringTilt:config.boards.maxTilt*Math.PI/180;
  const xRange=i=>{
    const g=levelGroups.find(g=>g.active&&i>=g.start-3&&i<=g.end+3);
    return g?Math.max(4.2,Math.abs(groupX(g,g.start-1))/w+1.1,Math.abs(groupX(g,g.end+1))/w+1.1):4.2;
  };
  const reservedX=i=>corridorAt(i)?groupX(corridorAt(i),i):null;
  const plannedSide=i=>levelEntry(i)?-levelEntry(i).direction:levelExit(i)?.direction??phrases[i].side;
  const allowedX=(i,x)=>{
    const reserved=reservedX(i);
    return reserved===null?(levelGroups.some(g=>g.active&&(i>=g.start-3&&i<g.start||i>g.end&&i<=g.end+3))||x*plannedSide(i)>=.3*w):Math.abs(x-reserved)<1e-7;
  };
  const emaSeconds=2*beats*4/unit*60/(plan.tempo_qpm||120),cameraTilt=config.camera.downwardTilt*Math.PI/180;
  const tan=Math.tan(config.camera.fov*Math.PI/360),aspect=9/16;
  const viewDepth=R*Math.sqrt(1+(1/(aspect*tan*config.ball.screenWidth))**2),sin=Math.sin(cameraTilt),cos=Math.cos(cameraTilt);
  const yaw=config.camera.yaw*Math.PI/180,sy=Math.sin(yaw),cyaw=Math.cos(yaw);
  const shapes=new WeakMap();
  const shape=board=>{
    if(!shapes.has(board))shapes.set(board,[plankCorners(board),plankCorners(board,board.hits[0].amplitude*.75)]);
    return shapes.get(board);
  };
  // Only retain projections during one candidate row: unchanged nearby boards
  // share their silhouettes across all probes, without growing a song-wide cache.
  let footprints=new WeakMap();
  const project=(points,cx,cy)=>points.map(p=>{
    const rx=p[0]-cx-viewDepth*cos*sy,ry=p[1]-cy-viewDepth*sin,rz=p[2]+.35*w-viewDepth*cos*cyaw;
    const right=rx*cyaw-rz*sy,forward=rx*sy+rz*cyaw,z=-ry*sin-forward*cos;
    return [right/(z*tan*aspect),(ry*cos-forward*sin)/(z*tan)+.24];
  });
  const footprint=(shape,lyric,cx,cy)=>{
    let cache=footprints.get(shape);if(!cache){cache=new Map();footprints.set(shape,cache);}
    const key=`${cx},${cy},${lyric??''}`;if(cache.has(key))return cache.get(key);
    const polygons=shape.map(points=>project(points,cx,cy)),points=polygons.flat();
    if(lyric)for(const poly of polygons) {
      const x=(Math.min(...poly.map(p=>p[0]))+Math.max(...poly.map(p=>p[0])))/2;
      const halfH=30/1280,halfW=halfH*Math.max(64,String(lyric).length*48)/64/aspect;
      const bottom=Math.min(...poly.map(p=>p[1]));points.push(...rectangle(x,bottom-16/1280-halfH,halfW,halfH));
    }
    const outside=[0,1].some(axis=>points.every(p=>p[axis]>1)||points.every(p=>p[axis]<-1));
    const result=outside?[]:clipScreen(hull(points));cache.set(key,result);return result;
  };
  const passageVisible=(flight,near)=>{
    const right=new Vector3(cyaw,0,-sy),up=new Vector3(-sin*sy,cos,-sin*cyaw);
    const samples=Math.max(16,Math.ceil((flight.t1-flight.t0)*24));
    for(let j=0;j<=samples;j++) {
      const t=flight.t0+(flight.t1-flight.t0)*j/samples,ball=new Vector3(...spatialPoint(flight,j/samples)),sphere=new Sphere(ball,R);
      const poses=near.filter(b=>b.pos[1]>ball.y-.3 && b.pos[1]<ball.y+1.6).map(b=>{
        const pose=boardPose(b,b.size[1],wallSwing(t,b,config.boards));
        return {b,...pose,inverse:pose.quaternion.clone().invert(),box:new Box3(new Vector3(...b.size).multiplyScalar(-.5),new Vector3(...b.size).multiplyScalar(.5))};
      });
      for(const cx of [-.12,0,.12])for(const offset of [-.6,0,.6]) {
        const origin=new Vector3(cx+viewDepth*cos*sy,ball.y+offset+viewDepth*sin,-.35*w+viewDepth*cos*cyaw);
        for(const pose of poses) {
          const allowance=pose.b.size[0]/2+R*1.2+Math.abs(ball.x-cx)*pose.b.size[2]/(origin.z-ball.z);
          if(Math.abs(pose.center.x-ball.x)>allowance)continue;
          for(const x of [-.65,0,.65])for(const y of [-.65,0,.65]) {
            const target=ball.clone().addScaledVector(right,x*R).addScaledVector(up,y*R),ray=new Ray(origin,target.sub(origin).normalize());
            const first=ray.intersectSphere(sphere,new Vector3());if(!first)continue;
            const local=new Ray(origin.clone().sub(pose.center).applyQuaternion(pose.inverse),ray.direction.clone().applyQuaternion(pose.inverse));
            const hit=local.intersectBox(pose.box,new Vector3());
            if(hit && hit.distanceTo(local.origin)<first.distanceTo(origin)-1e-5)return false;
          }
        }
      }
    }
    return true;
  };
  const canLeave=(b,flight,near,preferred)=>{
    const next=notes[b.i+1];if(!next)return true;
    const dt=next.t-b.t,timing=clamp(Math.sqrt(dt/(delta0||1)),.85,1.35);
    const vin=velocity(flight,true);
    // The real search can lower the next row for clearance. Reserve that room
    // here too, otherwise a valid same-side turn is repeatedly backtracked.
    const drops=phrases[b.i+1].plateau?[0]:[.2,.6,1,1.5];
    for(const drop of (preferred?[-1,...drops]:drops)) {
      const targetY=drop===-1?preferred.p[1]:phrases[b.i+1].plateau?b.p[1]:b.p[1]-S.wallDropWidths*w*timing-drop*w;
      const others=near.map(shape),views=[];
      for(const offset of [-1,0,1.5,3,4.5,6])for(const cx of [-.15,0,.15]) {
        const cy=targetY-R+offset;
        views.push({cx,cy});
      }
      // Reserve a physically possible following bounce before committing an
      // edge contact, and retain that checked contact for the next search.
      for(const scale of (drop===-1?[preferred.scale]:levelDepth.has(b.i+1)?[1]:[.9+.2*random(),.9,1,1.1]))for(let j=0;j<=(drop===-1||reservedX(b.i+1)!==null?0:12);j++) {
        const p=[drop===-1?preferred.p[0]:reservedX(b.i+1)!==null?reservedX(b.i+1):(j/12-.5)*2*xRange(b.i+1)*w+(random()-.5)*.5*w,targetY,
          wallZ+depth*scale-.015*w-.15*w*scale];
        if(!allowedX(b.i+1,p[0]))continue;
        const outgoing=apexFlight(b.p,p,b.t,next.t,D),pose=steeringPose(b,vin,velocity(outgoing,false),R,wallZ);
        if(pose.tilt>steeringLimit(b))continue;
        const target=steeringPose({...b,p,i:b.i+1,t:next.t,level_group:levelAt[b.i+1]?.active?levelAt[b.i+1].start:null,accent_group:levelTurn(b.i+1)?.start,size:referencePlankSize(w*scale),lyric:next.lyric,
          hits:[{t:next.t,amplitude:6*Math.PI/180/.75,phase:-Math.PI/2}]},[0,-1,0],[0,1,0],R,wallZ);
        const slabs=[...near,pose,target];
        if(!passageClear(outgoing,slabs,R,config,24).ok||flight&&!passageClear(flight,slabs,R,config,24).ok)continue;
        const own=shape(pose),future=shape(target);
        let packed=true;
        for(const view of views) {
          const a=footprint(own,pose.lyric,view.cx,view.cy),z=footprint(future,target.lyric,view.cx,view.cy);
          view.blocked??=others.map((points,k)=>footprint(points,near[k].lyric,view.cx,view.cy));
          if(intersects(a,z,.04)||view.blocked.some(poly=>intersects(a,poly,.02)||intersects(z,poly,.02))){packed=false;break;}
        }
        if(packed&&
          !slabs.some((a,k)=>slabs.slice(0,k).some(z=>(a===pose||a===target||z===pose||z===target)&&
            distance(a.pos,z.pos)<2*Math.max(w,a.size[0],z.size[0])+.015))&&
          passageClear(outgoing,slabs,R,config).ok&&(!flight||passageClear(flight,slabs,R,config).ok)&&
          passageVisible(outgoing,slabs)&&(!flight||passageVisible(flight,slabs))) {
          // Reserve the whole flat passage and its exit, not only one bounce.
          const following=levelAt[b.i+1]?.active?canLeave(target,outgoing,[...near,pose]):null;
          if(levelAt[b.i+1]?.active&&!following)continue;
          return {p,scale,following};
        }
      }
    }
    return false;
  };
  let ema=notes[0]?.midi??60,previousPitch=0,y=0,retries=0;
  const states=[],backtracks=[],rejectedLevels=[],hints=[];
  let furthest=-1,stalled=0,localReplans=0,replans=0;
  for(let i=0;i<notes.length;i++) {
    onProgress?.({stage:"排列木板",percent:85*i/notes.length,completed:i,total:notes.length});
    if(i>furthest){furthest=i;stalled=0;localReplans=0;}
    states[i]={ema,previousPitch,y};
    const hint=hints[i],n=notes[i],randomScale=.9+.2*random();
    const size=referencePlankSize(w*(hint?.scale??(levelDepth.has(i)?1:randomScale)));
    const q=new Quaternion(),normal=new Vector3(0,1,0);
    const amplitude=(3+3*random())*Math.PI/180/.75;
    ema+=(1-Math.exp(-(i?n.t-notes[i-1].t:0)/emaSeconds))*(n.midi-ema);
    const pitch=.10*D*Math.tanh((n.midi-ema)/6);
    const timing=clamp(Math.sqrt((i?n.t-notes[i-1].t:delta0)/(delta0||1)),.85,1.35);
    const descent=S.wallDropWidths*w*timing*(.8+.4*random())+previousPitch-pitch;
    const plateau=phrases[i].plateau;
    if(i)y=plateau?boards.at(-1).p[1]-R:y-descent;
    // Continue from the concrete exit that was checked when the preceding
    // contact was chosen, rather than discarding it and starting over.
    if(hint)y=hint.p[1]-R;
    previousPitch=pitch;
    const ref=curve.getPoint(i/Math.max(1,notes.length-1)).x;
    const motif=phrases[i];
    const level=levelAt[i];
    const desired=reservedX(i)??(levelEntry(i)?groupX(levelEntry(i),levelEntry(i).start-1):levelExit(i)?groupX(levelExit(i),levelExit(i).end+1):clamp(plannedSide(i)*2.35*w+(motif.offset%2?1:-1)*1.1*w+ref*.2+(random()-.5)*.4*w,-4.2*w,4.2*w));
    const event=plan.events?.find(e=>e.kind==='note'&&Math.abs(e.onset_sec-n.t)<1e-7);
    let chosen;
    for(let row=0;row<20&&!chosen;row++) {
      footprints=new WeakMap();
      const near=polygons.slice(-8,-1),views=[];
      for(const offset of [-1,0,1.5,3,4.5,6])for(const cx of [-.15,0,.15]) {
        const cy=y+offset;
        views.push({cx,cy,blocked:near.map((shape,j)=>footprint(shape,boards[boards.length-1-near.length+j].lyric,cx,cy))});
      }
      const candidates=[desired,...Array.from({length:80},()=> (random()-.5)*2*xRange(i)*w)].sort((a,b)=>Math.abs(a-desired)-Math.abs(b-desired));
      if(hint&&row===0)candidates.unshift(hint.p[0]);
      for(const x of candidates) {
        if(!allowedX(i,x))continue;
        const p=[x,y+R,wallZ+size[2]-.015*w-.15*size[0]];
        const contact=new Vector3(...p).addScaledVector(normal,-R),pos=contact.clone().addScaledVector(normal,-size[1]/2);
        pos.z=wallZ+size[2]/2-.015*w;
        const pivot=pos.clone().addScaledVector(normal,-size[1]/2);pivot.z=wallZ+.15*size[0];
        let b={...n,index:i,i,note_index:i,group:0,p,ball_pos:p,contact:contact.toArray(),pos:pos.toArray(),pivot:pivot.toArray(),top_y:contact.y,
          phrase:motif.index,phrase_side:Math.sign(x)||plannedSide(i),level_repeat:plateau,
          level_group:level?.active?level.start:null,accent_group:levelTurn(i)?.start,
          pitch_height:pitch,pitch_ema:ema,lyric:n.lyric??event?.lyric,quaternion:q.toArray(),tilt:0,tilt_axis:[1,0,0],off:0,palette:n.n-1,size,
          hits:[{t:n.t,amplitude,phase:-Math.PI/2}],placement_failed:false};
        const flight=i?apexFlight(boards.at(-1).p,p,boards.at(-1).t,n.t,D):incoming(b);
        const previous=i?steeringPose(boards.at(-1),velocity(incoming(boards.at(-1)),true),velocity(flight,false),R,wallZ):null;
        if(previous?.tilt>steeringLimit(previous))continue;
        if(i===notes.length-1) {
          b=steeringPose(b,velocity(flight,true),[0,0,0],R,wallZ);
          if(b.tilt>maxSteeringTilt)continue;
        }
        const earlier=i?boards.slice(0,-1):[],nearby=[...earlier.slice(-8),...(previous?[previous]:[]),b];
        if(earlier.some(prev=>distance(b.pos,prev.pos)<2*Math.max(w,size[0],prev.size[0])+.015)||
          previous&&(distance(b.pos,previous.pos)<2*Math.max(w,size[0],previous.size[0])+.015||
            earlier.some(prev=>distance(previous.pos,prev.pos)<2*Math.max(w,previous.size[0],prev.size[0])+.015)))continue;
        const polygon=[plankCorners(b),plankCorners(b,amplitude*.75)];
        const previousPolygon=previous?[plankCorners(previous),plankCorners(previous,previous.hits[0].amplitude*.75)]:null;
        let blocked=false;
        // Test perspective from the focus and the upcoming-board region.
        for(const view of views) {
          const poly=footprint(polygon,b.lyric,view.cx,view.cy);
          if(view.blocked.some(other=>intersects(poly,other,.02))){blocked=true;break;}
          if(previousPolygon) {
            const prev=footprint(previousPolygon,previous.lyric,view.cx,view.cy);
            if(intersects(poly,prev,.04)||view.blocked.some(other=>intersects(prev,other,.02))){blocked=true;break;}
          }
        }
        if(blocked)continue;
        if(flight&&(!passageClear(flight,nearby,R,config).ok||!passageVisible(flight,nearby)))continue;
        if(previous) {
          const before=incoming(previous);
          if(before&&(!passageClear(before,nearby,R,config).ok||!passageVisible(before,nearby)))continue;
        }
        const nextHint=canLeave(b,flight,nearby.slice(0,-1),hint?.following);
        if(!nextHint)continue;
        chosen={b,polygon,previous,previousPolygon,nextHint};break;
      }
      if(!chosen&&!plateau)y-=.1*w;
      if(!chosen&&plateau)break;
    }
    if(!chosen) {
      // A greedy contact can leave no room to steer the next bounce at the
      // edge of the wall. Rechoose that contact instead of faking its normal.
      if(i&&retries++<notes.length*8) {
        backtracks[i]=(backtracks[i]||0)+1;
        // Include the first ordinary contact after the shared-depth exit.
        const difficult=levelGroups.find(g=>g.active&&i>=g.start-3&&i<=g.end+4);
        if(difficult&&(backtracks[i]>=12||stalled>=23)) {
          stalled=0;
          // Replan the entry and the whole passage before reducing its length.
          if(difficult.attempts++<2)difficult.direction*=-1;
          else if(difficult.end>difficult.start+2) {
            phrases[difficult.end].plateau=false;levelAt[difficult.end]=null;difficult.end--;difficult.attempts=0;
          } else {
            difficult.active=false;rejectedLevels.push(difficult.start);
            for(let k=difficult.start;k<=difficult.end;k++){phrases[k].plateau=false;levelAt[k]=null;}
          }
          for(let k=difficult.start-3;k<=difficult.end+4;k++)backtracks[k]=0;
          const restart=Math.min(i,Math.max(0,difficult.start-6));
          boards.splice(restart);contacts.splice(restart);polygons.splice(restart);hints.splice(restart);
          ({ema,previousPitch,y}=states[restart]);i=restart-1;continue;
        }
        // Count a stalled region across all its indices. Per-index counters
        // alone miss cycles that keep moving between neighbouring dead ends.
        if(++stalled>=24) {
          if(localReplans++>=3)throw new Error(`Cannot place wall plank ${i}: local search exhausted`);
          const phrase=phrases[Math.max(0,furthest-1)].index;
          const restart=Math.min(i,Math.max(0,phrases.findIndex(p=>p.index===Math.max(0,phrase-1))));
          boards.splice(restart);contacts.splice(restart);polygons.splice(restart);hints.splice(restart);
          ({ema,previousPitch,y}=states[restart]);stalled=0;replans++;
          onProgress?.({stage:"重新规划局部节奏",percent:85*restart/notes.length,completed:restart,total:notes.length});
          i=restart-1;continue;
        }
        const count=Math.min(i,1+Math.floor(backtracks[i]/4)),restart=i-count;
        boards.splice(restart);contacts.splice(restart);polygons.splice(restart);hints.splice(restart);
        ({ema,previousPitch,y}=states[restart]);i=restart-1;continue;
      }
      throw new Error(`Cannot place wall plank ${i} with a safe steering surface`);
    }
    if(chosen.previous) {
      shapes.delete(boards.at(-1));
      Object.assign(boards.at(-1),chosen.previous);polygons[polygons.length-1]=chosen.previousPolygon;
    }
    hints[i+1]=chosen.nextHint;
    boards.push(chosen.b);contacts.push(chosen.b);polygons.push(chosen.polygon);
  }
  onProgress?.({stage:"连接球路",percent:85});
  const padPoint=contacts.length?[contacts[0].p[0],contacts[0].p[1]+.5,contacts[0].p[2]]:[0,R,0];
  const pad={ball_pos:padPoint,pos:[padPoint[0],padPoint[1]-R,padPoint[2]],top_y:padPoint[1]-R};
  const eligible=contacts.slice(0,-1).map((n,i)=>({i,t:n.t,gap:contacts[i+1].t-n.t,
    priority:Number(S.longNoteRails&&n.dur>=Math.max(.5,2*delta0))+Number(S.glissandoRails&&Boolean(n.pitch_bend?.length||n.articulation==='glissando'))}))
    .filter(n=>n.gap>=threshold).sort((a,b)=>b.priority-a.priority||a.t-b.t);
  const selected=[],rejected=[];
  for(const candidate of eligible)if(selected.length<S.maxRails&&selected.every(n=>Math.abs(n.t-candidate.t)>=8))selected.push(candidate);
  if(contacts.length) {
    const first=contacts[0],start=Math.max(0,first.t-config.physics.leadFlight);
    if(start)segments.push({kind:'hold',p0:padPoint,p1:padPoint,t0:0,t1:start});
    if(first.t>start)segments.push(apexFlight(padPoint,first.p,start,first.t,D));
    for(let i=0;i<contacts.length-1;i++) {
      onProgress?.({stage:"连接球路",percent:85+5*i/(contacts.length-1),completed:i,total:contacts.length-1});
      const a=contacts[i],b=contacts[i+1],gap=b.t-a.t;
      let rail;
      if(selected.some(n=>n.i===i)) {
        const fly=Math.max(.25,gap*.25),duration=gap-2*fly,sweep=.7,arcLength=2.6*w;
        const heading=Math.atan2(b.p[2]-a.p[2],b.p[0]-a.p[0]);
        const tangent=[Math.cos(heading),0,Math.sin(heading)],radius=arcLength/sweep;
        const sign=Math.cos(heading)>=0?1:-1,angle0=heading-sign*Math.PI/2;
        const entrySpeed=arcLength/duration,entry=a.p.map((x,k)=>k===1?(a.p[1]+b.p[1])/2:x+tangent[k]*entrySpeed*fly);
        const candidate={kind:'ride',spatial:true,center:[entry[0]-radius*Math.cos(angle0),entry[1],entry[2]-radius*Math.sin(angle0)],
          radius,angle0,sweep:sign*sweep,t0:a.t+fly,t1:b.t-fly,duration,g:config.physics.gravity,arcLength,entrySpeed,
          note_indices:[],beads:[],visibleFrom:a.t,visibleUntil:b.t,reason:{type:'gap',note_index:i,gap},shortened:false};
        candidate.p0=spatialRailPoint(candidate,0);candidate.p1=spatialRailPoint(candidate,1);
        const passage=[apexFlight(a.p,candidate.p0,a.t,candidate.t0,D),candidate,apexFlight(candidate.p1,b.p,candidate.t1,b.t,D)];
        const after=contacts[i+2]?apexFlight(b.p,contacts[i+2].p,b.t,contacts[i+2].t,D):null;
        const steeredA=steeringPose(a,velocity(segments.at(-1),true),velocity(passage[0],false),R,wallZ);
        const steeredB=steeringPose(b,velocity(passage[2],true),velocity(after,false),R,wallZ);
        const adjusted=boards.map(board=>board===a?steeredA:board===b?steeredB:board);
        const checks=[segments.at(-1),...passage,...(after?[after]:[])].filter(s=>s&&s.kind!=='hold');
        const packed=[steeredA,steeredB].every(changed=>{
          const near=adjusted.filter(board=>board.i!==changed.i&&Math.abs(board.i-changed.i)<=8);
          if(near.some(board=>distance(board.pos,changed.pos)<2*Math.max(w,board.size[0],changed.size[0])+.015))return false;
          const shape=board=>[plankCorners(board),plankCorners(board,board.hits[0].amplitude*.75)];
          const own=shape(changed),others=near.map(shape);
          for(const offset of [-1,0,1.5,3,4.5,6])for(const cx of [-.15,0,.15]) {
            const cy=changed.p[1]-R+offset,poly=footprint(own,changed.lyric,cx,cy);
            if(others.some((points,j)=>intersects(poly,footprint(points,near[j].lyric,cx,cy),.02)))return false;
          }
          return true;
        });
        if(steeredA.tilt<=maxSteeringTilt&&steeredB.tilt<=maxSteeringTilt&&
          packed&&wallSlideClear(candidate,checks,{BALL_R:R,channelCenter:spatialRailPoint,transitionPoint:spatialPoint},wallZ,w)&&
          checks.every(s=>passageClear(s,adjusted,R,config).ok&&passageVisible(s,adjusted))) {
          Object.assign(a,steeredA);Object.assign(b,steeredB);
          rail=candidate;segments.push(...passage);channels.push(rail);
        }
        else rejected.push(i);
      }
      if(!rail)segments.push(apexFlight(a.p,b.p,a.t,b.t,D));
    }
    const last=contacts.at(-1);if(last.t<plan.duration)segments.push({kind:'hold',p0:last.p,p1:last.p,t0:last.t,t1:plan.duration});
  }
  // Keep depth travel smooth so accent tilts come from lateral impulses,
  // without alternating between stretched and edge-on plank projections.
  const turnRandom=seededRandom(S.seed^0x7a31),accentLimit=config.boards.maxTilt*Math.PI/180;
  onProgress?.({stage:"调整转折",percent:90});
  let nextTurnPhrase=2,lastTurn=-20;
  for(let i=5;i<boards.length-5;i++) {
    onProgress?.({stage:"调整转折",percent:90+5*(i-5)/(boards.length-10)});
    const motif=phrases[i];
    if(motif.index===phrases[i-1].index||motif.index<nextTurnPhrase||i-lastTurn<12||
      boards.slice(i-4,i+6).some(b=>b.level_group!=null)||channels.some(s=>
        s.visibleFrom<boards[i+4].t&&s.visibleUntil>boards[i-4].t))continue;
    let chosen;
    for(const blend of [1,.75,.5])for(const shift of [0,.75*w,1.5*w,2.5*w,3.5*w,-.75*w,-1.5*w,-2.5*w]) {
      if(chosen)break;
      const points=new Map();
      for(let j=-3;j<=3;j++) {
        const b=boards[i+j],p=b.p.slice(),a=boards[i-4],z=boards[i+4],u=(b.t-a.t)/(z.t-a.t);
        p[2]+=(a.p[2]+u*(z.p[2]-a.p[2])-p[2])*blend;
        if(!j)p[0]=motif.side*clamp(Math.abs(p[0])+shift,.3*w,5*w);
        points.set(b.t,p);
      }
      const candidateSegments=segments.map(s=>s.kind==='flight'&&(points.has(s.t0)||points.has(s.t1))?
        apexFlight(points.get(s.t0)||s.p0,points.get(s.t1)||s.p1,s.t0,s.t1,D):s);
      const changed=boards.slice(i-4,i+5).map(b=>{
        const p=points.get(b.t)||b.p;
        return steeringPose({...b,p,ball_pos:p,accent_group:i,surface_accent:b.i===i},
          velocity(candidateSegments.find(s=>Math.abs(s.t1-b.t)<1e-8),true),
          velocity(candidateSegments.find(s=>Math.abs(s.t0-b.t)<1e-8),false),R,wallZ);
      });
      const center=changed[4],normal=center.collision.normal;
      if(center.tilt<25*Math.PI/180||Math.abs(normal[0])<Math.sin(23*Math.PI/180)||
        changed.some(b=>b.tilt>accentLimit||Math.abs(Math.atan2(b.collision.normal[2],b.collision.normal[1]))>8*Math.PI/180)||
        ![changed[3],changed[5]].some(b=>b.collision.normal[0]*normal[0]<-.03))continue;
      const adjusted=boards.map(b=>changed.find(p=>p.i===b.i)||b);
      if(changed.some(b=>adjusted.some(a=>a.i!==b.i&&
        distance(a.pos,b.pos)<2*Math.max(w,a.size[0],b.size[0])+.015)))continue;
      let packed=true;
      for(const b of changed) {
        const own=shape(b),near=adjusted.filter(a=>a.i!==b.i&&Math.abs(a.i-b.i)<=8),others=near.map(shape);
        const lengths=own.map(corners=>{
          const ends=[0,4].map(start=>[0,1,2].map(k=>corners.slice(start,start+4).reduce((s,p)=>s+p[k],0)/4));
          const center=ends[0].map((x,k)=>(x+ends[1][k])/2);
          return [ends,[-1,1].map(sign=>[center[0],center[1],center[2]+sign*b.size[2]/2])];
        });
        for(const offset of [-1,0,1.5,3,4.5,6])for(const cx of [-.15,0,.15]) {
          const cy=b.p[1]-R+offset,poly=footprint(own,b.lyric,cx,cy);
          for(const pair of lengths) {
            const [sloped,flat]=pair.map(ends=>{const p=project(ends,cx,cy);return Math.hypot(p[1][0]-p[0][0],p[1][1]-p[0][1]);});
            if(sloped<.75*flat||sloped>1.35*flat)packed=false;
          }
          if(others.some((points,j)=>intersects(poly,footprint(points,near[j].lyric,cx,cy),.005)))packed=false;
        }
        if(!packed)break;
      }
      if(!packed)continue;
      const checks=candidateSegments.filter(s=>s.kind!=='hold'&&s.t1>=boards[i-5].t&&s.t0<=boards[i+5].t);
      if(channels.some(rail=>!wallSlideClear(rail,checks,
        {BALL_R:R,channelCenter:spatialRailPoint,transitionPoint:spatialPoint},wallZ,w))||
        checks.some(s=>!passageClear(s,adjusted,R,config).ok||!passageVisible(s,adjusted)))continue;
      chosen={changed,candidateSegments};
    }
    if(!chosen)continue;
    for(const b of chosen.changed){shapes.delete(boards[b.i]);Object.assign(boards[b.i],b);}
    segments.splice(0,segments.length,...chosen.candidateSegments);
    lastTurn=i;nextTurnPhrase=motif.index+7+Math.floor(turnRandom()*3);
  }
  let minSpacing=Infinity,minClearance=Infinity,overlaps=0;
  let maxImpulseError=0;
  const failures=[];
  for(const b of boards) {
    const vin=velocity(segments.find(s=>Math.abs(s.t1-b.t)<1e-8),true),vout=velocity(segments.find(s=>Math.abs(s.t0-b.t)<1e-8),false);
    const normal=new Vector3(0,1,0).applyQuaternion(new Quaternion(...b.quaternion));
    const error=new Vector3(...vout).sub(new Vector3(...vin)).cross(normal).length();
    maxImpulseError=Math.max(maxImpulseError,error);
    if(error>1e-8||b.tilt>(b.accent_group===undefined?maxSteeringTilt:accentLimit))failures.push({kind:'steering',board:b.i,error});
  }
  for(let i=0;i<boards.length;i++)for(let j=0;j<i;j++) {
    const d=distance(boards[i].pos,boards[j].pos);minSpacing=Math.min(minSpacing,d);
    if(d<2*Math.max(boards[i].size[0],boards[j].size[0]))overlaps++;
  }
  for(const [i,s] of segments.entries())if(s.kind!=='hold') {
    onProgress?.({stage:"检查球路",percent:95+4*i/segments.length,completed:i,total:segments.length});
    const result=passageClear(s,boards,R,config);
    minClearance=Math.min(minClearance,result.min);
    if(!result.ok)failures.push(result);
  }
  const dy=boards.slice(1).map((b,i)=>Math.abs(b.top_y-boards[i].top_y)).sort((a,b)=>a-b);
  const silence=(plan.rests||[]).map(r=>({t0:r.onset_sec,t1:r.onset_sec+r.dur_sec}));
  return {format:'ball3d-wall-v1',seed:S.seed,wallZ,duration:plan.duration,contacts,boards,segments,channels,pad,
    groups:[{index:0,members:contacts.map(n=>n.note_index)}],route:contacts.map(n=>({t:n.t,p:n.p})),
    silence,
    audit:{forced:0,clearance_fails:failures.length,min_clearance:minClearance,failures,plank_overlaps:overlaps,
      min_contact_spacing:minSpacing,required_contact_spacing:2*w,plank_gap_min:minSpacing-w,flights:segments.filter(s=>s.kind==='flight').length,chutes:channels.length,
      spatial:{mode:'wall-downward',height_range:boards.length?[boards.at(-1).top_y,boards[0].top_y]:[0,0],
        baseline_drop:S.wallDropWidths*w,max_pitch_offset:Math.max(0,...contacts.map(n=>Math.abs(n.pitch_height))),
        max_height_residual:Math.max(0,...dy.map(d=>Math.abs(d-S.wallDropWidths*w))),
        delta_y:{p50:median(dy),p95:dy[Math.floor((dy.length-1)*.95)]??0,max:Math.max(0,...dy)},
        min_spacing:minSpacing,diameter:D,board_width:w,board_size:[w,H,depth],ema_seconds:emaSeconds,
        steering:{max_tilt_degrees:Math.max(0,...boards.map(b=>b.tilt*180/Math.PI)),max_impulse_error:maxImpulseError,retries,local_replans:replans},
        phrasing:{groups:new Set(boards.map(b=>b.phrase)).size,
          same_side_jumps:boards.slice(1).filter((b,i)=>b.p[0]*boards[i].p[0]>0).length,
          local_opposite_tilts:boards.slice(1).filter((b,i)=>b.phrase===boards[i].phrase&&b.collision.normal[0]*boards[i].collision.normal[0]<0).length,
          level_repeats:boards.filter(b=>b.level_repeat).length,rejected_level_pairs:rejectedLevels,
          level_groups:levelGroups.filter(g=>g.active).map(g=>({start:g.start,end:g.end,
            t0:boards[g.start].t,t1:boards[g.end].t,descending_phrases:g.descending_phrases,
            direction:g.direction,attempts:g.attempts})),
          reverse_boards:boards.filter(b=>b.surface_accent).length,
          inclined_boards:boards.filter(b=>b.tilt>maxSteeringTilt).length},
        rails:channels.map(s=>({t:s.t0,end:s.t1,gap:s.reason.gap,length_widths:s.arcLength/w,flight_in:s.t0-s.visibleFrom,flight_out:s.visibleUntil-s.t1})),
        strictly_descending:boards.every((b,i)=>!i||b.top_y<boards[i-1].top_y),
        source_model:'reference_planks/reference_planks.blend:Plank_02_Ivory',source_dimensions:profile},
      tracks:{delta0,gap_threshold:threshold,rejected_unsafe:rejected,long:0,glissando:0,gap:channels.length,total_notes:notes.length,
        carried_notes:0,ratio:0,longest_widths:Math.max(0,...channels.map(s=>s.arcLength/w)),
        rest_overlaps:channels.filter(s=>silence.some(r=>r.t0<s.t1&&r.t1>s.t0)).length,shortened:0}}};
}
