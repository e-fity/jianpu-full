/** Fixed-gravity flights, an uphill catch, and supported roll-off around the rail ends. */
const quadrature=[[.1834346424956498,.362683783378362],[.525532409916329,.3137066458778873],
  [.796666477413627,.2223810344533745],[.9602898564975363,.1012285362903763]];

function rollOff(entrySpeed,incline,g,radius) {
  const angle0=-incline,cos0=Math.cos(angle0),cos1=(entrySpeed**2/(g*radius)+2*cos0)/3;
  // The ball must cross the uppermost point and remain supported at entry.
  if(entrySpeed**2<=2*g*radius*(1-cos0)||cos1>=cos0)return null;
  const angle1=Math.acos(cos1),speed=angle=>Math.sqrt(entrySpeed**2+2*g*radius*(cos0-Math.cos(angle)));
  const timeTable=[{angle:angle0,time:0}];
  let duration=0;
  for(let i=1;i<=128;i++) {
    const a=angle0+(angle1-angle0)*(i-1)/128,b=angle0+(angle1-angle0)*i/128,half=(b-a)/2,mid=(a+b)/2;
    duration+=half*radius*quadrature.reduce((sum,[x,w])=>sum+w*(1/speed(mid-half*x)+1/speed(mid+half*x)),0);
    timeTable.push({angle:b,time:duration});
  }
  return {angle0,angle1,duration,timeTable,entrySpeed,exitSpeed:speed(angle1),edgeRadius:radius,
    arcLength:radius*(angle1-angle0)};
}

function flight(p0,p1,t0,t1,v0,g) {
  const peak=v0[1]/g,apex=peak>0&&peak<t1-t0?p0[1]+v0[1]**2/(2*g):Math.max(p0[1],p1[1]);
  return {kind:'flight',p0:p0.slice(),p1:p1.slice(),t0,t1,g,v0,apex};
}

/** Yield physical four-part passages. Height-limited candidates are filtered before truncation. */
export function* proposeDecelerationPassages(a,b,{g,width,ballRadius=width/2.1,boardIncoming,boardOutgoing,maxTilt=25,maxRise=Infinity,accept}) {
  const gap=b.t-a.t,dx=b.p[0]-a.p[0],dy=b.p[1]-a.p[1],sign=Math.sign(dx);
  if(!sign||Math.abs(b.p[2]-a.p[2])>1e-9)return;
  const tubeRadius=.035*2*ballRadius,spacing=.135*2*ballRadius;
  const radius=Math.sqrt((ballRadius+tubeRadius)**2-spacing**2),candidates=[];
  const bounded=Number.isFinite(maxRise);
  const timesIn=bounded?[.15,.2,.25,.3,.35,.4,.45,.5,.6]:[.5,.4,.6,.3,.7,.8,.2,1];
  const timesOut=bounded?[.2,.25,.3,.35,.4,.45,.5,.6,.7]:[.6,.5,.4,.3,.2,.7,.8,1];
  const inclines=bounded?[.001,.003,.01,.03,.1,.25,.5,.75,1,2,3,5]:[.5,.25,.75,1,2,3];
  const endSpeeds=bounded?[.005,.01,.02,.03,.05,.08,.12,.18,.25,.4,.65,.9,1.2,1.6,2,3]:[.05,.08,.12,.18,.25,.4,.65,.9];
  for(const degrees of inclines)for(const endSpeed of endSpeeds) {
    const incline=degrees*Math.PI/180,s=Math.sin(incline),c=Math.cos(incline);
    const template=rollOff(endSpeed,incline,g,radius);
    if(!template)continue;
    const edgeDx=radius*(Math.sin(template.angle1)-Math.sin(template.angle0));
    const edgeDy=radius*(Math.cos(template.angle1)-Math.cos(template.angle0));
    const exiting=[sign*template.exitSpeed*Math.cos(template.angle1),-template.exitSpeed*Math.sin(template.angle1),0];
    for(const tin of timesIn)for(const tout of timesOut) {
      const duration=gap-tin-tout-template.duration;
      if(duration<.2)continue;
      const entrySpeed=endSpeed+g*s*duration,arcLength=(entrySpeed+endSpeed)*duration/2;
      if(arcLength<width||arcLength>(bounded?100:4)*width)continue;
      const vertical=(dy+g*tin*tin/2-arcLength*s-edgeDy-exiting[1]*tout+g*tout*tout/2)/tin;
      const horizontal=(entrySpeed-(vertical-g*tin)*s)/c;
      const tangent=[sign*c,s,0],normal=[-sign*s,c,0],incoming=[sign*horizontal,vertical-g*tin,0];
      const normalSpeed=incoming[0]*normal[0]+incoming[1]*normal[1];
      if(horizontal<=0||vertical<=0||normalSpeed>=0)continue;
      const shiftX=sign*(horizontal*tin+arcLength*c+edgeDx)+exiting[0]*tout-dx;
      if(Math.abs(shiftX)>(bounded?4:.8))continue;
      const point=[a.p[0]+sign*horizontal*tin,a.p[1]+vertical*tin-g*tin*tin/2,a.p[2]];
      const end=point.map((x,k)=>x+tangent[k]*arcLength),t0=a.t+tin,t1=t0+duration;
      const captured=tangent.map(x=>x*entrySpeed),energyLoss=normalSpeed**2/2;
      const rail={kind:'ride',spatial:true,straight:true,decelerating:true,p0:point,p1:end,t0,t1,duration,g,
        angle0:-sign*Math.PI/2,sweep:0,arcLength,entrySpeed,exitSpeed:endSpeed,deceleration:g*s,tangent,normal,
        normalAcceleration:g*c,incline,shortened:false,
        capture:{v_in:incoming,v_out:captured,normal_speed:normalSpeed,energy_loss:energyLoss}};
      const center=end.map((x,k)=>x-radius*normal[k]);
      const leaving=[center[0]+sign*radius*Math.sin(template.angle1),center[1]+radius*Math.cos(template.angle1),center[2]];
      const edge={kind:'ride',spatial:true,edge:true,...template,sign,g,center,p0:end.slice(),p1:leaving,
        t0:t1,t1:t1+template.duration};
      const target=[b.p[0]+shiftX,b.p[1],b.p[2]];
      const passage=[flight(a.p,point,a.t,t0,[sign*horizontal,vertical,0],g),rail,edge,
        flight(leaving,target,edge.t1,b.t,exiting,g)];
      passage.shiftX=shiftX;
      const top=p=>p.apex-p.p0[1];
      if(Math.max(top(passage[0]),top(passage[3]))>maxRise+1e-9)continue;
      const contact=(vin,vout)=>{
        if(!vin||!vout)return true;
        const normal=vout.map((x,k)=>x-vin[k]),length=Math.hypot(...normal);
        if(!length)return true;
        const dot=v=>v.reduce((s,x,k)=>s+x*normal[k]/length,0);
        return normal[1]/length>=Math.cos(maxTilt*Math.PI/180)-1e-9&&dot(vin)<=1e-9&&dot(vout)>=-1e-9;
      };
      const arrival=[exiting[0],exiting[1]-g*tout,exiting[2]];
      if(!contact(boardIncoming,passage[0].v0)||!contact(arrival,boardOutgoing))continue;
      if(accept&&!accept(passage))continue;
      candidates.push(passage);
    }
  }
  // Keep timing choices diverse so entity checks can reject a blocked approach
  // without spending all 32 attempts on the same flight and nearby inclines.
  const selected=[];
  for(let bin=0;bin<8;bin++) {
    const group=candidates.filter(p=>Math.min(7,Math.floor(Math.abs(p.shiftX)*10))===bin);
    const score=p=>Math.abs(p[0].t1-p[0].t0-.5)+Math.abs(p[3].t1-p[3].t0-.6)+
      .15*Math.abs(p[1].incline*180/Math.PI-.5)+.1*Math.abs(p[1].exitSpeed-.08);
    group.sort((a,b)=>score(a)-score(b)||Math.abs(a.shiftX)-Math.abs(b.shiftX));
    const timings=new Set();
    for(const p of group) {
      const key=`${(p[0].t1-p[0].t0).toFixed(3)}:${(p[3].t1-p[3].t0).toFixed(3)}`;
      if(timings.has(key))continue;
      timings.add(key);selected.push(p);
      if(timings.size===4)break;
    }
  }
  // Runtime rounding must not reorder equivalent shifts ahead of their timing preference.
  selected.sort((a,b)=>Math.round(Math.abs(a.shiftX)*1e9)-Math.round(Math.abs(b.shiftX)*1e9));
  if(bounded)yield* candidates.sort((a,b)=>Math.abs(a.shiftX)-Math.abs(b.shiftX)).slice(0,128);
  else yield* selected;
}
