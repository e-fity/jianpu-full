/** Deterministic music-machine layout. All contacts retain the score onsets. */
export const CYCLE = 10;
export const CYCLE_DROP = 10;
export const BOARD_W = 0.60;
export const BOARD_H = 0.075;
export const BOARD_D = 0.54;
export const BALL_R = 0.25;
export const WALL_Z = -0.8;
export const CAM_Z = 5;
export const CAM_LIFT = 1.8;
export const CAM_LOOKAHEAD = 1.5;
export const CAM_TRACK_DAMP = 0;
export const ORTHO_SCALE = 9.0;
export const CHANNEL_HALFWIDTH = 0.34;
export const CHANNEL_RAIL_H = 0.17;
export const CHANNEL_RAIL_R = 0.022;
export const CHANNEL_SUBDIV = 48;
export const MAX_CHANNELS = 6;
export const BEAD_COUNT = 7;
export const BEAD_R = 0.055;

// Two curved rows separated by diagonal paddles and broad turning chutes.
const LOCAL = [[-1.2,0],[-.4,.10],[.4,.10],[1.2,0],
  [-1.2,3.0],[0,4.15],[1.2,5.3],[-.8,6.8],[0,6.92],[.8,6.8]];
const clamp = u => Math.max(0, Math.min(1,u));
export const smoothstep = u => { const s=clamp(u); return s*s*(3-2*s); };
export const boardLocal = i => ({cycle:Math.floor(i/CYCLE), k:((i%CYCLE)+CYCLE)%CYCLE});
export const boardX = i => i < 0 ? .4 : LOCAL[boardLocal(i).k][0];
export const boardTopY = i => i < 0 ? 1.2 : -CYCLE_DROP*boardLocal(i).cycle-LOCAL[boardLocal(i).k][1];
export const boardZ = () => 0;
export const boardYaw = i => i>=0 && i%10>=4 && i%10<=6 ? [-.6,.65,-.45][i%10-4] : Math.sin(i*1.7)*.15;
export const restPosition = i => [boardX(i),boardTopY(i)+BALL_R,0];
export const channelIsAt = i => i >= 0 && [3,9].includes(i%CYCLE);
export const boardMidi = (plan,i) => i<0 ? plan.ref_midi : plan.boards[i].midi;
export function woodSegments(plan) {
  const hits=plan.landings ?? [];
  if (!hits.length) return [{kind:'hold',t0:0,t1:plan.duration,from:-1,to:-1}];
  const result=[];
  const add=(from,to,t0,t1) => result.push({kind:from===to?'hold':channelIsAt(from)?'channel':'hop',
    from,to,t0,t1,departure:t0+(t1-t0)*.8});
  if (hits[0].t>0) add(-1,0,0,hits[0].t);
  for(let i=0;i<hits.length-1;i++) add(i,i+1,hits[i].t,hits[i+1].t);
  add(hits.length-1,hits.length-1,hits.at(-1).t,Math.max(plan.duration,hits.at(-1).t));
  return result;
}
export function segmentIndexAt(segments,t) {
  if (!segments.length) return -1;
  for(let i=0;i<segments.length;i++) if(t<=segments[i].t1) return i;
  return segments.length-1;
}
const mix=(a,b,u)=>a.map((v,i)=>v+(b[i]-v)*u);
function hop(a,b,u,lift) {
  const p=mix(a,b,u); p[1]+=4*lift*u*(1-u); return p;
}
/** Centre of a broad S-shaped open chute; parameter is local to the chute. */
export function channelCenterPoint(seg,u) {
  const a=restPosition(seg.from),b=restPosition(seg.to),s=clamp(u),v=1-s;
  const points=[[a[0]+.65,a[1]-.6,.12],[a[0]+.7,a[1]-1.65,.12],
    [b[0]+.05,b[1]+1.7,.12],[b[0],b[1]+.65,.12]];
  return points[0].map((_,i)=>v*v*v*points[0][i]+3*v*v*s*points[1][i]+3*v*s*s*points[2][i]+s*s*s*points[3][i]);
}
/** Upward surface normal in the wall plane; the trough is wide along Z. */
export function channelNormal(seg,u) {
  const a=channelCenterPoint(seg,Math.max(0,u-.0001)),b=channelCenterPoint(seg,Math.min(1,u+.0001));
  const dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy);
  return [dy/l,-dx/l,0];
}
export function channelFloorPoint(seg,u) {
  const p=channelCenterPoint(seg,u),n=channelNormal(seg,u);
  return p.map((v,i)=>v-BALL_R*n[i]);
}
export function channelCross(seg,u) {
  const floor=channelFloorPoint(seg,u),normal=channelNormal(seg,u);
  return {floor,normal,
    left:[floor[0],floor[1],floor[2]-CHANNEL_HALFWIDTH],
    right:[floor[0],floor[1],floor[2]+CHANNEL_HALFWIDTH]};
}
export function transitionPoint(seg,u) {
  u=clamp(u);
  const a=restPosition(seg.from),b=restPosition(seg.to);
  if(seg.kind==='hold') return a;
  if(seg.kind==='channel') {
    if(u<.25) return hop(a,channelCenterPoint(seg,0),u/.25,.85);
    if(u<=.8) return channelCenterPoint(seg,(u-.25)/.55);
    return hop(channelCenterPoint(seg,1),b,(u-.8)/.2,.12);
  }
  // Sufficient lift clears the departure board before the descent crosses it.
  return hop(a,b,u,Math.max(.32,Math.abs(b[1]-a[1])*(Math.abs(b[0]-a[0])>=1.5?.45:Math.abs(b[0]-a[0])>=1.1?.5:.9)));
}
export function sampleWoodBall(segments,t) {
  const index=segmentIndexAt(segments,t);
  if(index<0) return restPosition(-1);
  const s=segments[index];
  return transitionPoint(s,s.t1>s.t0?(t-s.t0)/(s.t1-s.t0):0);
}
export function sampleWoodTrack(segments,t) {
  const index=segmentIndexAt(segments,t);
  if(index<0) return restPosition(-1);
  const s=segments[index],u=s.t1>s.t0?smoothstep((t-s.t0)/(s.t1-s.t0)):0;
  return mix(restPosition(s.from),restPosition(s.to),u);
}
export function woodCameraPlacement(track) {
  return {location:[0,track[1]+CAM_LIFT,CAM_Z],target:[0,track[1]-CAM_LOOKAHEAD,WALL_Z]};
}
export function boardSpan(count) {
  const points=Array.from({length:count+1},(_,i)=>restPosition(i-1));
  return {x0:Math.min(...points.map(p=>p[0])),x1:Math.max(...points.map(p=>p[0])),
    y0:Math.min(...points.map(p=>p[1]))-BALL_R,y1:Math.max(...points.map(p=>p[1]))};
}
/** Spatial visibility, independent of tempo: no time-window scenery popping. */
export function channelsNear(segments,trackY) {
  return segments.filter(s=>s.kind==='channel' &&
    boardTopY(s.from)>=trackY-8 && boardTopY(s.to)<=trackY+8).map(seg=>({seg}));
}
export function tiltAngle(age) {
  return age>0&&age<.8 ? .14*Math.exp(-age/.22)*Math.sin(age*20) : 0;
}

