/** Convex screen silhouettes, clipped to the viewport before overlap tests. */
export function hull(points) {
  const p=points.map(v=>v.slice(0,2)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const half=arr=>{const out=[];for(const q of arr){while(out.length>1&&cross(out.at(-2),out.at(-1),q)<=0)out.pop();out.push(q);}return out;};
  const a=half(p),b=half(p.slice().reverse());a.pop();b.pop();return a.concat(b);
}
export function clipScreen(poly) {
  for(const [axis,sign] of [[0,1],[0,-1],[1,1],[1,-1]]) {
    const out=[];
    for(let i=0;i<poly.length;i++) {
      const a=poly[i],b=poly[(i+1)%poly.length],insideA=sign*a[axis]<=1,insideB=sign*b[axis]<=1;
      if(insideA)out.push(a);
      if(insideA!==insideB){const u=(sign-a[axis])/(b[axis]-a[axis]);out.push(a.map((x,k)=>x+(b[k]-x)*u));}
    }
    poly=out;
  }
  return poly;
}
export function intersects(a,b,padding=0) {
  if(a.length<3||b.length<3)return false;
  for(const poly of [a,b])for(let i=0;i<poly.length;i++) {
    const p=poly[i],q=poly[(i+1)%poly.length],axis=[q[1]-p[1],p[0]-q[0]],length=Math.hypot(...axis);
    let amin=Infinity,amax=-Infinity,bmin=Infinity,bmax=-Infinity;
    for(const v of a){const d=(v[0]*axis[0]+v[1]*axis[1])/length;amin=Math.min(amin,d);amax=Math.max(amax,d);}
    for(const v of b){const d=(v[0]*axis[0]+v[1]*axis[1])/length;bmin=Math.min(bmin,d);bmax=Math.max(bmax,d);}
    if(amax+padding<=bmin+1e-8||bmax+padding<=amin+1e-8)return false;
  }
  return true;
}
export const rectangle=(x,y,w,h)=>[[x-w,y-h],[x+w,y-h],[x+w,y+h],[x-w,y+h]];
