/** Visual sampling only. No integration, timers or writes to the layout. */
import limits from "../presentation_limits.json" with { type: "json" };
import defaults from "../config.json" with { type: "json" };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** Visibility depends only on the current camera, never on note age/index. */
export function visibleBoards(bounds, frustum) {
  const indices = [];
  for (let index = 0; index < bounds.length; index++) {
    if (frustum.intersectsBox(bounds[index])) indices.push(index);
  }
  return indices;
}
/** Superposed analytic impact response; no state survives a time seek. */
export function boardSpring(t, hits, config) {
  const zeta=config.dampingRatio,omega=config.angularFrequency;
  let angle=0;
  for(const hit of hits){
    const age=t-hit.t;
    if(age<0||age>=config.hitWindow)continue;
    const amplitude=hit.amplitude??hit.scale*config.maxTilt*Math.PI/180;
    angle+=amplitude*Math.exp(-zeta*omega*age)*Math.cos(omega*Math.sqrt(1-zeta*zeta)*age+(hit.phase??0));
  }
  return angle;
}
export function shadowPresentation(ball,support,width,wallZ,config) {
  const height=Math.max(0,ball[1]-support[1]);
  return {height,position:[ball[0]-config.lightOffsetX*height,
    ball[1]-config.baseDistanceWidths*width-config.heightDistance*height,wallZ+.003],
    radius:width*config.radiusWidths+config.heightSpread*height,
    opacity:config.opacity*Math.exp(-config.heightFade*height)};
}
/** Smooth stateless dead zone: small ball excursions never steer the camera. */
export function deadZone(value,width) {
  const excess=Math.max(0,Math.abs(value)-width);
  return excess===0 ? 0 : Math.sign(value)*excess*excess/(excess+width*.5);
}

// C2 positive part: start moving before reaching the screen edge, while
// covering the full required correction once the edge is reached.
function softPositive(value,width) {
  if(value<=-width)return 0;
  if(value>=width)return value;
  const u=value/width;
  return width*(3/16+u/2+3*u*u/8-u**4/16);
}

export function cameraPresentation(sample, duration, t, aspect, radius, config, ahead = [], options = {}) {
  const c = config.camera;
  const smoothWall=config.spatial?.enabled&&config.spatial.wallMounted&&config.spatial.layeredPhrases&&!options.legacyWallFraming;
  const sigmaScale=smoothWall?[.35,.5,1]:[1,1,1];
  const target = [0, 0, 0], trend = [0, 0, 0];
  const weights=[0,0,0],weightedOffset=[0,0,0],weightedSquare=[0,0,0];
  for (let i = 0; i < c.samples; i++) {
    const offset = -c.pastWindow + (c.pastWindow + c.futureWindow) * i / (c.samples - 1);
    const point = sample(clamp(t + offset, 0, duration));
    for (let k = 0; k < 3; k++) {
      const weight = Math.exp(-0.5 * (offset / (c.sigma*sigmaScale[k])) ** 2);
      target[k] += point[k] * weight;
      trend[k] += point[k] * weight * offset;
      weights[k] += weight;
      weightedOffset[k] += weight * offset;
      weightedSquare[k] += weight * offset * offset;
    }
  }
  for (let k = 0; k < 3; k++) {
    const variance = weightedSquare[k] / weights[k] - (weightedOffset[k] / weights[k]) ** 2;
    target[k] /= weights[k];
    trend[k] = (trend[k] / weights[k] - target[k] * weightedOffset[k] / weights[k]) / variance;
  }
  if(config.spatial?.enabled && config.spatial.wallMounted&&!config.spatial.layeredPhrases)target[0]=.12*Math.tanh(target[0]/.12);
  const downwardTilt = c.downwardTilt * Math.PI / 180, yaw = c.yaw * Math.PI / 180;
  const direction = [Math.cos(downwardTilt) * Math.sin(yaw), Math.sin(downwardTilt), Math.cos(downwardTilt) * Math.cos(yaw)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [-Math.sin(downwardTilt) * Math.sin(yaw), Math.cos(downwardTilt), -Math.sin(downwardTilt) * Math.cos(yaw)];
  const dot = (a, b) => a.reduce((sum, x, k) => sum + x * b[k], 0);
  const ball = smoothWall&&options.ballPosition?options.ballPosition:sample(t), tanHalf = Math.tan(c.fov * Math.PI / 360);
  const focal = 1 / (2 * aspect * tanHalf);
  const ballDepth = radius * Math.sqrt(1 + (2 * focal / config.ball.screenWidth) ** 2);
  const side = 2 * radius * config.boards.sideDiameters;
  const spatial=config.spatial?.enabled;
  const depth = spatial ? ballDepth : Math.min(ballDepth, c.maxBoardsAcross * side * focal);
  const distance = depth + (spatial ? 0 : dot(ball.map((x, k) => x - target[k]), direction));
  const position = target.map((x, k) => x + distance * direction[k]);
  const project = point => {
    const relative = point.map((x, k) => x - position[k]);
    const z = -dot(relative, direction);
    return [dot(relative, right) / (z * aspect * tanHalf), dot(relative, up) / (z * tanHalf)];
  };
  const dx = dot(trend, right) / aspect, dy = dot(trend, up);
  const soft = c.directionSoftness;
  const moving = Math.hypot(dx, dy) > 1e-10;
  const desired = [!moving || dx === 0 ? 0 : -2 * c.travelOffset * dx / Math.hypot(dx, soft),
    !moving || dy === 0 ? 0 : -2 * c.travelOffset * dy / Math.hypot(dy, soft)];
  const ballNdc = project(ball);
  if(spatial) {
    const shift=[0,config.spatial.wallMounted?-.24:-.30];
    const protectedBoards=[];
    if(smoothWall) {
      // Follow the continuous route, never a changing prefix of future boards.
      // Use the actual sphere (including jump height) for the soft safety edge.
      const relative=ball.map((x,k)=>x-position[k]),z=-dot(relative,direction),q=z*z-radius*radius;
      for(const [k,axis] of [right,up].entries()) {
        const value=dot(relative,axis),scale=(k===0?aspect:1)*tanHalf;
        const center=value*z/(q*scale),extent=radius*Math.sqrt(value*value+q)/(q*scale);
        const offset=center-shift[k];
        shift[k]+=Math.sign(offset)*softPositive(Math.abs(offset)+extent-(1-2*c.edgeMargin),.1);
      }
    } else if(config.spatial.wallMounted) {
      // Wide level rows keep their scale; move the lens only at the ball edge.
      const relative=ball.map((x,k)=>x-position[k]),z=-dot(relative,direction),x=dot(relative,right);
      const q=z*z-radius*radius,scale=aspect*tanHalf,safe=1-2*c.edgeMargin;
      const center=x*z/(q*scale),extent=radius*Math.sqrt(x*x+q)/(q*scale);
      shift[0]=clamp(0,center+extent-safe,center-extent+safe);
      if(config.spatial.layeredPhrases) {
        let lo=center+extent-safe,hi=center-extent+safe;
        for(const board of ahead) {
          const xs=board.points.map(p=>project(p)[0]);
          lo=Math.max(lo,Math.max(...xs)-safe);hi=Math.min(hi,Math.min(...xs)+safe);
          if(lo>hi)break;
          shift[0]=clamp(shift[0],lo,hi);protectedBoards.push(board.index);
        }
      }
    }
    return {target,lookAt:position.map((x,k)=>x-direction[k]),trend,depth,shift,
      protectedBoards,ballScreen:[(ballNdc[0]-shift[0]+1)/2,(1-ballNdc[1]+shift[1])/2],
      horizontalSpan:depth/focal,boardsAcross:depth/focal/side,position};
  }
  const zones=[c.deadZoneX,c.deadZoneY];
  const shift = ballNdc.map((x,k) => deadZone(x,2*zones[k])-desired[k]);
  // Exact perspective silhouette: an off-axis sphere is not centered on its
  // projected center and can be larger than the usual r / depth estimate.
  const bounds=ballNdc.map((ndc,k)=>{
    const scale=tanHalf*(k===0?aspect:1),offset=ndc*depth*scale,q=depth*depth-radius*radius;
    const center=offset*depth/(q*scale),extent=radius*Math.sqrt(offset*offset+q)/(q*scale);
    return [center-extent,center+extent];
  });
  const ballRect={min:bounds.map(b=>b[0]),max:bounds.map(b=>b[1])};
  const rects = ahead.map(board => {
    const points = board.points.map(project);
    return { min: [0, 1].map(k => Math.min(...points.map(p => p[k]))),
      max: [0, 1].map(k => Math.max(...points.map(p => p[k]))) };
  });
  const safeBall=1-2*c.edgeMargin;
  for(let k=0;k<2;k++)shift[k]=clamp(shift[k],ballRect.max[k]-safeBall,ballRect.min[k]+safeBall);
  let protectedBoards = [];
  // Keep the framing scale; constrain lens shift only when upcoming boards fit.
  // Prefer three in an ordinary group, then two. Rides/group changes pass none.
  for (let count = rects.length; count >= Math.min(2, rects.length) && count > 0; count--) {
    const boxes = [ballRect, ...rects.slice(0, count)], safe = 1 - 2 * c.edgeMargin;
    const lo = [0, 1].map(k => Math.max(...boxes.map(b => b.max[k])) - safe);
    const hi = [0, 1].map(k => Math.min(...boxes.map(b => b.min[k])) + safe);
    if (lo.some((x, k) => x > hi[k])) continue;
    for (let k = 0; k < 2; k++) shift[k] = clamp(shift[k], lo[k], hi[k]);
    protectedBoards = ahead.slice(0, count).map(b => b.index);
    break;
  }
  // A very high future arc can put the Gaussian target behind the camera.
  // Keep the optical direction fixed instead of letting lookAt flip by 180°.
  const lookAt=position.map((x,k)=>x-direction[k]);
  return { target, lookAt, trend, depth, shift, protectedBoards,
    ballScreen: [(ballNdc[0] - shift[0] + 1) / 2, (1 - ballNdc[1] + shift[1]) / 2],
    horizontalSpan: depth / focal, boardsAcross: depth / focal / side, position };
}

export function validatePresentation(config) {
  if (!config || Object.keys(config).sort().join() !== Object.keys(defaults).sort().join())
    throw new Error("config.json: missing or unknown groups");
  for (const [group, fields] of Object.entries(defaults)) {
    if (!config[group] || Object.keys(config[group]).sort().join() !== Object.keys(fields).sort().join())
      throw new Error(`config.json: invalid ${group} fields`);
    for (const [key, fallback] of Object.entries(fields)) {
      const value = config[group][key];
      if (typeof fallback === "number") {
        const [lo, hi] = limits[key];
        if (!Number.isFinite(value) || value < lo || value > hi ||
            (["levelPhraseGap", "levelMaxNotes", "seed", "maxRails", "maxBoardsAcross", "samples", "glissMinNotes", "glissMaxSemitones", "integrationSteps", "solveIterations"].includes(key) && !Number.isInteger(value)))
          throw new Error(`config.json: ${group}.${key} must be in ${lo}..${hi}`);
      } else if ((key.endsWith("Color") && !/^#[0-9a-f]{6}$/i.test(value)) || typeof value !== typeof fallback || (key === "file" && value !== defaults.environment.file)) {
        throw new Error(`config.json: invalid ${group}.${key}`);
      }
    }
  }
  return config;
}
