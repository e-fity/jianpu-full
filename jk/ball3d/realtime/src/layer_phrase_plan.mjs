import {seededRandom} from './spatial_course.mjs';

/** Partition every note into short layers, favouring musical phrase endings. */
export function planLayerPhrases(plan,seed,options={}) {
  const notes=plan.landings||[],count=notes.length;
  if(!count)return [];
  const random=seededRandom(seed^0x71a9),cuts=[];
  const gaps=notes.slice(1).map((n,i)=>n.t-notes[i].t).filter(x=>x>0).sort((a,b)=>a-b);
  const typical=gaps[Math.floor(gaps.length/2)]||60/(plan.tempo_qpm||120);
  const boundary=Array(count+1).fill(0);
  for(let i=1;i<count;i++) {
    const a=notes[i-1],b=notes[i],gap=b.t-a.t;
    const rest=(plan.rests||[]).some(r=>r.dur_sec>0&&r.onset_sec<b.t-1e-7&&r.onset_sec+r.dur_sec>a.t+1e-7);
    boundary[i]=Math.min(2,Math.max(0,gap/typical-1)*.8)+
      (rest?2.5:0)+(/[，。！？；：,.!?;:]\s*$/u.test(a.lyric||'')?2:0);
  }
  if(count<4)cuts.push([0,count-1]);
  else {
    const cost=Array(count+1).fill(Infinity),previous=Array(count+1).fill(-1);
    cost[0]=0;
    for(let end=4;end<=count;end++)for(let size=4;size<=8;size++) {
      const start=end-size;
      if(start<0||!Number.isFinite(cost[start]))continue;
      const value=cost[start]+.5+.14*(size-6)**2+random()*.5-boundary[end];
      if(value<cost[end]){cost[end]=value;previous[end]=start;}
    }
    for(let end=count;end>0;end=previous[end])cuts.push([previous[end],end-1]);
    cuts.reverse();
  }
  const direction=random()<.5?-1:1;
  const groups=cuts.map(([start,end],index)=>({index,start,end,direction:direction*(index%2?-1:1),level:false,
    rebound_starts:[],fast_rebound:false}));
  const levelRandom=seededRandom(seed^0x29c1),wait=Math.max(4,options.levelPhraseGap??4);
  const maxNotes=Math.min(6,options.levelMaxNotes??6),budget=Math.floor(.2*(count-1));
  const quality=groups.map(g=>{
    const row=notes.slice(g.start,g.end+1),intervals=row.slice(1).map((n,i)=>n.t-row[i].t);
    const average=intervals.reduce((a,b)=>a+b,0)/intervals.length||1;
    const spread=Math.sqrt(intervals.reduce((a,b)=>a+(b-average)**2,0)/intervals.length)/average;
    const repeated=row.slice(1).filter((n,i)=>n.midi===row[i].midi).length/intervals.length;
    return 2*repeated+1/(1+4*spread)+levelRandom()*.08;
  });
  let next=wait,used=0;
  while(next<groups.length) {
    const candidates=groups.slice(next,next+3).filter(g=>{
      if(g.start===0||g.end===count-1||g.end-g.start+1>maxNotes||used+g.end-g.start>budget)return false;
      const row=notes.slice(g.start-1,g.end+2),intervals=row.slice(1).map((n,i)=>n.t-row[i].t);
      const shortest=Math.min(...intervals);
      return shortest>0&&Math.max(...intervals)/shortest<=2.4;
    });
    if(!candidates.length){next++;continue;}
    const chosen=candidates.reduce((best,g)=>quality[g.index]>quality[best.index]?g:best);
    chosen.level=true;used+=chosen.end-chosen.start;
    next=chosen.index+1+wait;
  }
  const intervals=notes.slice(1).map((n,i)=>n.t-notes[i].t),fastThreshold=Math.min(.3,1.1*typical);
  const reboundCandidates=g=>{
    const candidates=[];
    for(let p=g.start+1;p+1<g.end;p++) {
      if(p<2||p+3>=count)continue;
      const row=intervals.slice(p-2,p+3),shortest=Math.min(...row);
      if(shortest>0&&Math.max(...row)<=2.4*shortest+1e-7)candidates.push(p);
    }
    return candidates;
  };
  const fastRandom=seededRandom(seed^0x6ab3);
  let fastNext=3;
  for(const g of groups) {
    if(g.index<fastNext||g.level||groups[g.index-1]?.level||groups[g.index+1]?.level)continue;
    const run=intervals.slice(g.start,g.end),shortest=Math.min(...run);
    if(run.length===7&&shortest>0&&Math.max(...run)<=2.4*shortest+1e-7&&
      run.filter(dt=>dt<=fastThreshold+1e-7).length>=3) {
      g.rebound_starts=[g.start+1,g.start+3,g.start+5];
      g.rebound_start=g.rebound_starts[0];g.fast_rebound=true;
      fastNext=g.index+3;continue;
    }
    const candidates=reboundCandidates(g).filter(p=>intervals[p]<=fastThreshold+1e-7&&
      intervals.slice(p-2,p+3).filter(dt=>dt<=fastThreshold+1e-7).length>=3);
    if(!candidates.length)continue;
    const doubles=candidates.filter(p=>p+3<g.end&&candidates.includes(p+2)&&intervals[p+1]<=fastThreshold+1e-7);
    const pairCount=doubles.length&&fastRandom()<.75?2:1,choices=pairCount===2?doubles:candidates;
    const p=choices[Math.floor(fastRandom()*choices.length)];
    g.rebound_starts=pairCount===2?[p,p+2]:[p];g.rebound_start=p;g.fast_rebound=true;
    fastNext=g.index+2+Math.floor(fastRandom()*2);
  }
  const reboundRandom=seededRandom(seed^0x49e7);
  let reboundNext=3+Math.floor(reboundRandom()*3);
  for(const g of groups) {
    if(g.index<reboundNext||g.level||g.fast_rebound||groups[g.index-1]?.level||groups[g.index+1]?.level||
      groups[g.index-1]?.fast_rebound||groups[g.index+1]?.fast_rebound)continue;
    const candidates=reboundCandidates(g);
    if(!candidates.length)continue;
    g.rebound_start=candidates[Math.floor(reboundRandom()*candidates.length)];
    g.rebound_starts=[g.rebound_start];
    reboundNext=g.index+4+Math.floor(reboundRandom()*3);
  }
  // Vary only ordinary descents after horizontal and rebound passages are fixed.
  const middle=(gaps.length-1)/2,median=gaps.length?(gaps[Math.floor(middle)]+gaps[Math.ceil(middle)])/2:typical;
  const descentRandom=seededRandom(seed^0x318d),railGap=Math.max(1,3.5*median);
  for(let i=0;i+1<groups.length;i++) {
    const a=groups[i],b=groups[i+1];
    if(a.level||b.level||a.rebound_starts.length||b.rebound_starts.length||boundary[b.start]>=2)continue;
    if(intervals.slice(a.start,b.end).some(dt=>dt>=railGap))continue;
    const total=b.end-a.start+1,low=Math.max(4,total-8),high=Math.min(8,total-4);
    if(high-low<3)continue;
    const size=descentRandom()<.5?low:high,cut=a.start+size;
    if(boundary.slice(Math.min(b.start,cut),Math.max(b.start,cut)+1).some(value=>value>=2))continue;
    a.end=cut-1;b.start=cut;
    i++;
  }
  return groups;
}
