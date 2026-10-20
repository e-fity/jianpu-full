/** Sounding-time classification and energy-integrated rails, independent of rendering. */
const EPS = 1e-9;
const clamp = x => Math.max(0, Math.min(1, x));
export const noteDuration = (note, plan) => note.duration_sec ?? note.dur ?? note.q * 60 / (plan.tempo_qpm || 60);

export function classifyRails(plan, rules) {
  const notes = plan.landings || [];
  const gaps = notes.slice(1).map((n, i) => n.t - notes[i].t).filter(x => x > 0).sort((a,b) => a-b);
  const middle = Math.floor(gaps.length / 2);
  const delta0 = gaps.length ? (gaps[middle] + gaps[Math.floor((gaps.length-1)/2)]) / 2 : 0;
  const threshold = Math.max(rules.longMedianFactor * delta0, rules.longMinSeconds);
  const rests = (plan.rests || []).map(r => ({t0:r.onset_sec, t1:r.onset_sec + (r.score_dur_sec ?? r.dur_sec)}));
  // A short note-off followed by a later onset is silence too. Explicit score
  // rests take precedence even when an imported note-off extends over them.
  for (let i=0; i<notes.length; i++) {
    const end=notes[i].t+noteDuration(notes[i],plan), next=notes[i+1]?.t ?? plan.duration;
    if(end<next-EPS)rests.push({t0:end,t1:next});
  }
  rests.sort((a,b)=>a.t0-b.t0);
  const silence=[];
  for(const r of rests) {
    if(silence.length && r.t0<=silence.at(-1).t1+EPS)silence.at(-1).t1=Math.max(silence.at(-1).t1,r.t1);
    else silence.push({...r});
  }
  const crossesRest=(a,b)=>silence.some(r=>r.t0<b-EPS&&r.t1>a+EPS);
  const endOfSound=i=>Math.min(notes[i].t+noteDuration(notes[i],plan),
    ...silence.filter(r=>r.t0>=notes[i].t-EPS).map(r=>r.t0));
  const groups=[];
  for(let i=0;i<notes.length;) {
    const a=notes[i], bend=a.pitch_bend?.length || a.articulation==='glissando';
    let end=i;
    if(!bend) {
      let direction=0;
      while(end+1<notes.length) {
        const b=notes[end],c=notes[end+1], step=c.midi-b.midi;
        if(c.pitch_bend?.length || c.articulation==='glissando' || step===0 ||
          Math.abs(step)>rules.glissMaxSemitones+EPS || (direction && Math.sign(step)!==direction) ||
          c.t-b.t>rules.glissMedianFactor*delta0+EPS || crossesRest(b.t,c.t))break;
        direction=Math.sign(step);end++;
      }
      if(end-i+1<rules.glissMinNotes)end=i;
    }
    const type=bend||end>i?'glissando':noteDuration(a,plan)+EPS>=threshold?'long':null;
    if(type) {
      const next=notes[end+1]?.t;
      const soundingEnd=endOfSound(end);
      const t1=Math.min(soundingEnd,next===undefined?soundingEnd:next-rules.minFlightSeconds);
      groups.push({type,first:i,last:end,t0:a.t,targetEnd:t1,soundingEnd,
        note_indices:Array.from({length:end-i+1},(_,k)=>i+k),
        visibleFrom:Math.max(0,...silence.filter(r=>r.t1<=a.t+EPS).map(r=>r.t1)),
        visibleUntil:Math.min(plan.duration,...silence.filter(r=>r.t0>=a.t-EPS).map(r=>r.t0))});
    }
    i=end+1;
  }
  return {delta0,threshold,groups,silence};
}

// A normalized height profile with horizontal tangents at every knot. Pitch
// reversals are retained; its amplitude is the scalar solved by bisection.
export function railProfile(group, notes, plan) {
  const note=notes[group.first];
  let points;
  if(note.pitch_bend?.length) {
    const bend=note.pitch_bend, duration=noteDuration(note,plan);
    points=[{u:0,y:0},...bend.map(p=>({u:p.time_sec/duration,y:p.semitones}))];
    if(bend[0].time_sec===0)points.shift();
    if(points.at(-1).u<1)points.push({u:1,y:points.at(-1).y});
    const first=points[0].y;points=points.map(p=>({...p,y:p.y-first}));
  } else if(group.last>group.first) {
    const span=group.targetEnd-group.t0;
    points=group.note_indices.map(i=>({u:(notes[i].t-group.t0)/span,y:notes[i].midi-note.midi}));
    if(points.at(-1).u<1)points.push({u:1,y:points.at(-1).y});
  } else points=[{u:0,y:0},{u:1,y:group.type==='long'?-1:Math.sign(note.glissando_to_midi-note.midi)}];
  const scale=Math.max(...points.map(p=>Math.abs(p.y)),1);
  return points.map(p=>({u:p.u,y:p.y/scale}));
}
function profileAt(profile,u) {
  let i=1;while(i<profile.length-1 && profile[i].u<u)i++;
  const a=profile[i-1],b=profile[i], span=b.u-a.u;
  const v=span>0?clamp((u-a.u)/span):1;
  return [a.y+(b.y-a.y)*v*v*(3-2*v),span>0?(b.y-a.y)*6*v*(1-v)/span:0];
}
export function railPoint(rail,u) {
  const s=clamp(u),[height]=profileAt(rail.profile,s);
  return [rail.p0[0]+rail.run*s,rail.p0[1]+rail.amplitude*height,rail.p0[2]];
}
export function railTangent(rail,u) {
  const dy=rail.amplitude*profileAt(rail.profile,clamp(u))[1];
  const length=Math.hypot(rail.run,dy);
  return [rail.run/length,dy/length,0];
}
function integrate(rail,steps) {
  const table=[{u:0,t:0,s:0}], speed=u=>{
    const h=railPoint(rail,u)[1]-rail.p0[1];
    const v2=rail.entrySpeed**2-2*rail.g*h;
    return v2>1e-12?Math.sqrt(v2):NaN;
  };
  const integrand=u=>{
    const ds=Math.hypot(rail.run,rail.amplitude*profileAt(rail.profile,u)[1]);
    return [ds/speed(u),ds];
  };
  let previous=integrand(0),time=0,length=0;
  for(let i=1;i<=steps;i++) {
    const u=i/steps,mid=integrand((i-.5)/steps),next=integrand(u);
    time+=(previous[0]+4*mid[0]+next[0])/(6*steps);
    length+=(previous[1]+4*mid[1]+next[1])/(6*steps);
    if(!Number.isFinite(time))return null;
    table.push({u,t:time,s:length});previous=next;
  }
  return {table,duration:time,arcLength:length};
}
export function railUAtTime(rail,age) {
  const table=rail.table,t=Math.max(0,Math.min(rail.duration,age));
  let lo=1,hi=table.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(table[m].t<t)lo=m+1;else hi=m;}
  const a=table[lo-1],b=table[lo];
  return a.u+(b.u-a.u)*(t-a.t)/(b.t-a.t);
}
export function railTimeAtU(rail,u) {
  const v=clamp(u)*(rail.table.length-1),i=Math.min(Math.floor(v),rail.table.length-2);
  const a=rail.table[i],b=rail.table[i+1];
  return a.t+(b.t-a.t)*(v-i);
}

/** Solve geometry, never rescale the physical clock. If unreachable, return
 * the longest feasible passage no longer than the requested duration. */
export function solveEnergyRail({p0,entrySpeed,target,profile,width,g,rules,type}) {
  if(!(target>0 && entrySpeed>1e-8))return null;
  const limit=rules.maxLengthWidths*width;
  const mean=profile.reduce((s,p)=>s+p.y,0),up=mean>0;
  const rail={kind:'ride',p0:p0.slice(),profile,entrySpeed,g,
    run:Math.min(limit*.97,entrySpeed*target*(up?.9:1.1)),amplitude:0};
  const maxY=Math.max(...profile.map(p=>p.y));
  let high=(type==='long'?rules.longSlopeWidths:rules.glissSlopeWidths)*width;
  if(maxY>0)high=Math.min(high,.98*entrySpeed**2/(2*g*maxY));
  const evaluate=a=>{
    const candidate={...rail,amplitude:a},result=integrate(candidate,rules.integrationSteps);
    return result && result.arcLength<=limit+1e-10?{...candidate,...result}:null;
  };
  // First cap amplitude by true arc length, including every pitch reversal.
  let low=0;
  for(let i=0;i<rules.solveIterations;i++) {
    const mid=(low+high)/2;
    if(evaluate(mid))low=mid;else high=mid;
  }
  const ceiling=low;
  let previous=evaluate(0),best=previous?.duration<=target+rules.timeTolerance?previous:null;
  // Mixed pitch-bend profiles need a bracket scan before bisection.
  for(let j=1;j<=32;j++) {
    const current=evaluate(ceiling*j/32);
    if(!current)continue;
    if(current.duration<=target+rules.timeTolerance && (!best||current.duration>best.duration))best=current;
    if(previous && (previous.duration-target)*(current.duration-target)<=0) {
      let a=previous,b=current;
      for(let i=0;i<rules.solveIterations;i++) {
        const mid=evaluate((a.amplitude+b.amplitude)/2);
        if((a.duration-target)*(mid.duration-target)<=0)b=mid;else a=mid;
      }
      best=Math.abs(a.duration-target)<Math.abs(b.duration-target)?a:b;break;
    }
    previous=current;
  }
  if(!best) {
    // Very short requests: shorten the geometry, retaining entry energy.
    let a=0,b=rail.run;
    for(let i=0;i<rules.solveIterations;i++) {
      rail.run=(a+b)/2;
      const candidate=evaluate(ceiling);
      if(candidate && candidate.duration<=target){best=candidate;a=rail.run;}else b=rail.run;
    }
  }
  if(!best)return null;
  best.p1=railPoint(best,1);
  best.requestedDuration=target;
  best.shortened=best.duration<target-rules.timeTolerance;
  return best;
}
