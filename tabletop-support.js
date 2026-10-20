/* Tabletop placement in plan millimetres. Native render uses the resulting
 * world transforms; neither model masters nor CAD geometry are modified. */
(function(root){
  'use strict';
  const rect=[[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]];
  const surfaces={
    // Measured upward-facing worktops, not the lamp / raised reception ledge.
    receptiontable:{height:762,width:1680,depth:971,scaled:true,polygon:[[-.3155,-.2631],[-.3022,-.3186],[-.2701,-.3416],[.4546,-.3416],[.4867,-.3186],[.5,-.2631],[.5,.4215],[.4867,.477],[.4546,.5],[-.2701,.5],[-.3022,.477],[-.3155,.4215]]},
    meetingtableu:{height:750,width:3204,depth:4809,scaled:true,polygon:[[-.4994,-.4981],[-.2185,-.4981],[-.2185,.3129],[.2185,.3129],[.2185,-.4981],[.4994,-.4981],[.4994,.4892],[.4831,.5],[-.4831,.5],[-.4994,.4892]]},
    island:{height:890,polygon:rect}
  };
  const finite=Number.isFinite, clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const elevation=f=>finite(f.elevation)?clamp(f.elevation,0,20000):0;
  const degrees=n=>((n%360)+360)%360;
  const host=f=>!!surfaces[f?.type];
  const item=f=>f?.type==='imaccomputer';
  const enabled=f=>item(f)&&f.tabletopSnap!==false;
  function height(f){
    const s=surfaces[f?.type];if(!s)return 0;
    return finite(f.tabletopHeight)?clamp(f.tabletopHeight,0,20000):s.height*(s.scaled?Math.sqrt(f.w/s.width*f.d/s.depth):1);
  }
  const top=f=>elevation(f)+height(f);
  function local(f,x,y){const a=(f.rot||0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a),dx=x-f.cx,dy=y-f.cy;return [(dx*c+dy*s)/f.w,(-dx*s+dy*c)/f.d];}
  function world(f,u,v){const a=(f.rot||0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return [f.cx+u*f.w*c-v*f.d*s,f.cy+u*f.w*s+v*f.d*c];}
  function contains(f,x,y){
    if(!host(f)||!finite(f.w)||!finite(f.d)||f.w<=0||f.d<=0)return false;
    const [px,py]=local(f,x,y),poly=surfaces[f.type].polygon;let inside=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const [ax,ay]=poly[j],[bx,by]=poly[i],dx=bx-ax,dy=by-ay;
      const t=clamp(((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy),0,1);
      if(Math.hypot(px-ax-t*dx,py-ay-t*dy)<1e-7)return true;
      if((ay>py)!==(by>py)&&px<(bx-ax)*(py-ay)/(by-ay)+ax)inside=!inside;
    }return inside;
  }
  function binding(f,parent,offset=0){
    const [u,v]=local(parent,f.cx,f.cy);
    return {id:parent.id,u,v,rotation:degrees((f.rot||0)-(parent.rot||0)),offset};
  }
  function settle(f,furniture){
    if(!enabled(f)){delete f.support;return;}
    const previous=f.support;
    const candidates=furniture.filter(p=>p.id!==f.id&&host(p)&&top(p)<=20000&&contains(p,f.cx,f.cy));
    // Keep the existing support when surfaces overlap; otherwise choose the top.
    const parent=candidates.find(p=>p.id===previous?.id)||candidates.sort((a,b)=>top(b)-top(a))[0];
    if(!parent){if(previous)f.elevation=0;delete f.support;return;}
    const offset=previous?.id===parent.id&&finite(previous.offset)?previous.offset:0;
    f.support=binding(f,parent,offset);f.elevation=clamp(Math.round(top(parent)+offset),0,20000);
  }
  function sync(furniture){
    const byId=new Map(furniture.map(f=>[f.id,f]));
    for(const f of furniture){
      if(!f.support)continue;
      const b=f.support,p=byId.get(b.id);
      if(!enabled(f)||!p||p.id===f.id||!host(p)||![b.u,b.v,b.rotation,b.offset].every(finite)) {delete f.support;continue;}
      [f.cx,f.cy]=world(p,b.u,b.v);f.rot=degrees((p.rot||0)+b.rotation);
      if(!contains(p,f.cx,f.cy)){delete f.support;continue;}
      f.elevation=clamp(Math.round(top(p)+b.offset),0,20000);
    }
  }
  function reconcile(furniture,before){
    const old=new Map(before.map(f=>[f.id,f]));
    for(const f of furniture){
      if(!item(f))continue;
      const previous=old.get(f.id);
      if(!enabled(f)){delete f.support;continue;}
      const moved=!previous||['cx','cy','rot','w','d'].some(k=>f[k]!==previous[k]);
      const parent=f.support&&furniture.find(p=>p.id===f.support.id&&host(p));
      if(parent&&previous&&f.elevation!==previous.elevation){f.support={...f.support,offset:elevation(f)-top(parent)};}
      if(moved)settle(f,furniture);
    }
    sync(furniture);
  }
  function normalize(furniture){
    for(const f of furniture){
      if(host(f)&&f.tabletopHeight!==undefined){if(finite(f.tabletopHeight))f.tabletopHeight=clamp(f.tabletopHeight,0,20000);else delete f.tabletopHeight;}
      if(f.tabletopSnap!==undefined)f.tabletopSnap=f.tabletopSnap!==false;
    }
    sync(furniture); // Old designs without a support link retain manual heights.
  }
  root.FurnitureSupport={host,item,enabled,height,top,contains,local,world,settle,sync,reconcile,normalize};
})(typeof window==='undefined'?globalThis:window);
