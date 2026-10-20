/** Spatial apex-constrained course, with the prior one-gravity mode retained. */
import { classifyRails, railProfile, solveEnergyRail, railPoint, railTangent, railUAtTime } from './expressive_rails.mjs';
import { buildSpatialCourse, spatialRailPoint, spatialRailTangent, spatialRailNormal, spatialRailUAtTime } from './spatial_course.mjs';
import { buildWallCourse } from './wall_course.mjs';
import { buildLayeredCourse } from './layered_course.mjs';
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mix=(a,b,u)=>a.map((x,k)=>x+(b[k]-x)*u);
export const courseKey=config=>JSON.stringify([config.physics,config.tracks,config.spatial,config.boards.sideDiameters,config.boards.rodLengthWidths,
  config.spatial?.enabled?[config.camera,config.ball.screenWidth]:null,
  config.spatial?.wallMounted?[config.boards.maxTilt,config.boards.dampingRatio,config.boards.angularFrequency,config.boards.hitWindow]:null]);
export const channelCenter=(s,u)=>s.spatial?spatialRailPoint(s,u):railPoint(s,u);
export function channelNormal(seg,u) {
  if(seg.spatial)return spatialRailNormal(seg,u);
  const [x,y]=railTangent(seg,u);return [-y,x,0];
}
export function transitionPoint(seg,u) {
  const age=clamp(u)*(seg.t1-seg.t0);
  if(seg.kind==='ride')return seg.spatial?spatialRailPoint(seg,seg.edge||seg.decelerating?spatialRailUAtTime(seg,age):clamp(u)):railPoint(seg,railUAtTime(seg,age));
  if(seg.kind==='hold')return seg.p0.slice();
  return seg.p0.map((x,k)=>x+seg.v0[k]*age-(k===1?.5*seg.g*age*age:0));
}
export function transitionVelocity(seg,u) {
  if(seg.kind==='hold')return [0,0,0];
  if(seg.kind==='ride') {
    if(seg.spatial) {
      const age=clamp(u)*seg.duration,along=spatialRailUAtTime(seg,age);
      const speed=seg.edge?Math.sqrt(seg.entrySpeed**2+2*seg.g*(seg.p0[1]-spatialRailPoint(seg,along)[1])):
        seg.decelerating?seg.entrySpeed-seg.deceleration*age:seg.entrySpeed;
      return spatialRailTangent(seg,along).map(x=>x*speed);
    }
    const v=railUAtTime(seg,clamp(u)*seg.duration),p=railPoint(seg,v);
    const speed=Math.sqrt(seg.entrySpeed**2-2*seg.g*(p[1]-seg.p0[1]));
    return railTangent(seg,v).map(x=>x*speed);
  }
  return [seg.v0[0],seg.v0[1]-seg.g*clamp(u)*(seg.t1-seg.t0),seg.v0[2]];
}
export function segmentAt(layout,t) {
  let lo=0,hi=layout.segments.length;
  while(lo<hi){const m=(lo+hi)>>1;if(layout.segments[m].t1<t)lo=m+1;else hi=m;}
  return layout.segments[Math.min(lo,layout.segments.length-1)];
}
export function sampleBall(layout,t) {
  const seg=segmentAt(layout,t);
  return seg?transitionPoint(seg,(t-seg.t0)/(seg.t1-seg.t0)):layout.pad.ball_pos.slice();
}
export function sampleVelocity(layout,t) {
  const seg=segmentAt(layout,t);
  return seg?transitionVelocity(seg,(t-seg.t0)/(seg.t1-seg.t0)):[0,0,0];
}
export function supportAt(layout,t) {
  const seg=segmentAt(layout,t);
  if(!seg)return layout.pad.ball_pos.slice();
  return seg.kind==='ride'?sampleBall(layout,t):mix(seg.p0,seg.p1,clamp((t-seg.t0)/(seg.t1-seg.t0)));
}
export function createGravityKit(base,config) {
  const key=courseKey(config);
  if(base.gravityKey===key)return base;
  return {...base,gravityKey:key,G:config.physics.gravity,G_VEC:[0,-config.physics.gravity,0],
    buildLayout:(plan,{onProgress}={})=>buildGravityLayout(plan,base,config,onProgress),sampleBall,sampleVelocity,
    channelCenter,channelNormal,transitionPoint,transitionVelocity,supportAt};
}
export function buildGravityLayout(plan,kit,config,onProgress) {
  if(config.spatial?.enabled && config.spatial.wallMounted)return (config.spatial.layeredPhrases?buildLayeredCourse:buildWallCourse)(plan,kit,config,onProgress);
  if(config.spatial?.enabled)return buildSpatialCourse(plan,kit,config,[],onProgress);
  const P=config.physics,T=config.tracks,R=kit.BALL_R,w=2*R*config.boards.sideDiameters,pitch=P.spacingWidths*w;
  const notes=plan.landings||[],classification=classifyRails(plan,T);
  const candidates=new Map(classification.groups.map(g=>[g.first,g]));
  const contacts=notes.map((n,i)=>({...n,note_index:i,p:null,group:0}));
  const segments=[],channels=[],boards=[],groups=[],rejected=[];
  const pad={ball_pos:[-pitch,R,0],pos:[-pitch,0,0],top_y:0};
  const flight=(p0,p1,t0,t1)=>{
    const dt=t1-t0;
    return {kind:'flight',p0:p0.slice(),p1:p1.slice(),t0,t1,g:P.gravity,
      v0:p0.map((x,k)=>(p1[k]-x)/dt+(k===1?.5*P.gravity*dt:0))};
  };
  let groupIndex=0;
  if(contacts.length) {
    contacts[0].p=[0,R,0];
    const first=contacts[0],dt=Math.min(first.t,P.leadFlight),start=first.t-dt;
    pad.ball_pos=[-pitch,R+.5*P.gravity*dt*dt,0];
    if(start>0)segments.push({kind:'hold',p0:pad.ball_pos.slice(),p1:pad.ball_pos.slice(),t0:0,t1:start});
    if(dt>0)segments.push(flight(pad.ball_pos,first.p,start,first.t));
    for(let i=0;i<contacts.length;) {
      onProgress?.({stage:"排列木板",percent:85*i/contacts.length,completed:i,total:contacts.length});
      const a=contacts[i],candidate=candidates.get(i),incoming=segments.at(-1);
      a.group=groupIndex;
      let end=a.p.slice(),endTime=a.t,last=i;
      if(candidate) {
        const target=candidate.targetEnd-a.t;
        // Contact absorbs normal velocity, preserving its entry-tangent projection.
        const velocity=incoming?transitionVelocity(incoming,1):[0,0,0];
        const rail=target>0 && candidate.targetEnd>notes[candidate.last].t+1e-9
          ?solveEnergyRail({p0:a.p,entrySpeed:Math.abs(velocity[0]),target,
            profile:railProfile(candidate,notes,plan),width:w,g:P.gravity,rules:T,type:candidate.type}):null;
        if(rail && a.t+rail.duration>notes[candidate.last].t+1e-9) {
          Object.assign(rail,{t0:a.t,t1:a.t+rail.duration,reason:{type:candidate.type,trigger:candidate.type,note_index:i},
            note_indices:candidate.note_indices,soundingEnd:candidate.soundingEnd,
            visibleFrom:candidate.visibleFrom,visibleUntil:candidate.visibleUntil,
            entryVelocity:velocity,entryNormalEnergyLoss:velocity[1]**2+velocity[2]**2,model_reversed:false});
          rail.y_lo=Math.min(...rail.table.map(v=>railPoint(rail,v.u)[1]));
          rail.y_hi=Math.max(...rail.table.map(v=>railPoint(rail,v.u)[1]));
          rail.beads=candidate.note_indices.map(index=>({note_index:index,t:notes[index].t,u:railUAtTime(rail,notes[index].t-a.t)}));
          segments.push(rail);channels.push(rail);
          last=candidate.last;end=rail.p1.slice();endTime=rail.t1;
          for(const j of candidate.note_indices) {
            contacts[j].p=transitionPoint(rail,(notes[j].t-a.t)/rail.duration);
            contacts[j].track=candidate.type;contacts[j].group=groupIndex;
          }
          groupIndex++;
        } else rejected.push({type:candidate.type,note_indices:candidate.note_indices,
          reason:rail?'shortened_rail_cannot_cover_all_onsets':'no_feasible_sounding_window_or_entry_speed'});
      }
      const next=contacts[last+1];
      if(next) {
        const dt=next.t-endTime;
        // Monotonic X prevents same-column row changes through earlier planks.
        next.p=[end[0]+pitch,end[1]-Math.min(P.descentWidths*w,P.gravity*dt*dt/8),0];
        segments.push(flight(end,next.p,endTime,next.t));
        if(classification.silence.some(r=>r.t0<next.t&&r.t1>a.t))groupIndex++;
      } else if(plan.duration>endTime) {
        const dt=plan.duration-endTime;
        const finish=[end[0]+pitch,end[1]-Math.min(P.descentWidths*w,P.gravity*dt*dt/8),0];
        segments.push(flight(end,finish,endTime,plan.duration));
      }
      i=last+1;
    }
    for(const event of contacts) {
      if(event.track)continue;
      const incoming=segments.find(s=>Math.abs(s.t1-event.t)<1e-8),outgoing=segments.find(s=>Math.abs(s.t0-event.t)<1e-8);
      const vin=incoming?transitionVelocity(incoming,1):[0,0,0],vout=outgoing?transitionVelocity(outgoing,0):[0,0,0];
      const impulse=vout.map((x,k)=>x-vin[k]),length=Math.hypot(...impulse)||1;
      const horizontal=[impulse[0]/length,0,impulse[2]/length],h=Math.hypot(horizontal[0],horizontal[2]);
      const index=boards.length,contact=[event.p[0],event.p[1]-R,0];
      boards.push({...event,index,i:index,ball_pos:event.p.slice(),contact,pos:[contact[0],contact[1]-kit.BOARD_H/2,0],
        top_y:contact[1],off:0,tilt:0,palette:kit.paletteIndexFor(event.n),tilt_axis:h>1e-10?[horizontal[2]/h,0,-horizontal[0]/h]:[1,0,0],
        hits:[{t:event.t,scale:h}],collision:{v_in:vin,v_out:vout,impulse_horizontal:horizontal}});
    }
  }
  for(const contact of contacts) {
    let group=groups.find(g=>g.index===contact.group);
    if(!group){group={index:contact.group,members:[]};groups.push(group);}
    group.members.push(contact.note_index);
  }
  const anchors=contacts.filter((n,i)=>!n.track||candidates.has(i));
  const distances=anchors.slice(1).map((b,i)=>Math.hypot(...b.p.map((x,k)=>x-anchors[i].p[k])));
  let overlaps=0;
  for(let i=0;i<boards.length;i++)for(let j=0;j<i;j++)
    if(Math.abs(boards[i].pos[0]-boards[j].pos[0])<w-1e-9&&Math.abs(boards[i].pos[1]-boards[j].pos[1])<kit.BOARD_H)overlaps++;
  onProgress?.({stage:"检查球路",percent:95});
  let minClearance=Infinity,clearanceFails=0;
  for(const seg of segments)if(seg.kind!=='hold')for(let i=0;i<=256;i++) {
    const p=transitionPoint(seg,i/256);
    for(const b of boards) {
      const center=[b.contact[0],b.contact[1]-kit.BOARD_H/2,.004-w/2];
      const d=Math.hypot(...p.map((x,k)=>Math.max(0,Math.abs(x-center[k])-[w/2,kit.BOARD_H/2,w/2][k])));
      minClearance=Math.min(minClearance,d);if(d<R-1e-6)clearanceFails++;
    }
  }
  const carried=new Set(channels.flatMap(s=>s.note_indices));
  const restOverlaps=channels.filter(s=>classification.silence.some(r=>r.t0<s.t1-1e-8&&r.t1>s.t0+1e-8)).length;
  return {format:'ball3d-gravity-v2',seed:kit.layoutSeed(plan),duration:plan.duration,gravity:P.gravity,
    contacts,boards,channels,segments,groups,pad,silence:classification.silence,route:contacts.map(n=>({t:n.t,p:n.p.slice()})),
    audit:{forced:0,clearance_fails:clearanceFails,min_clearance:Number.isFinite(minClearance)?minClearance:null,
      clearance_scope:'full_path/static_planks',plank_overlaps:overlaps,chutes:channels.length,
      min_contact_spacing:distances.length?Math.min(...distances):null,required_contact_spacing:2*w,
      contact_spacing_scope:'boards_and_track_entries; glissando_beads_are_not_landings',
      plank_gap_min:distances.length?Math.min(...distances)-w:null,flights:segments.filter(s=>s.kind==='flight').length,
      tracks:{delta0:classification.delta0,long_threshold:classification.threshold,
        long:channels.filter(s=>s.reason.type==='long').length,glissando:channels.filter(s=>s.reason.type==='glissando').length,
        carried_notes:carried.size,total_notes:notes.length,ratio:notes.length?carried.size/notes.length:0,
        longest_widths:Math.max(0,...channels.map(s=>s.arcLength/w)),rest_overlaps:restOverlaps,
        shortened:channels.filter(s=>s.shortened).length,rejected}}};
}
