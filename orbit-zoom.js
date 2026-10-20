/* Normalize wheel devices and ease camera distance without changing orbit/pan. */
export function wheelZoomDelta(event,pageHeight){
  if(!Number.isFinite(event.deltaY))return 0;
  const unit=event.deltaMode===1?16:event.deltaMode===2?Math.max(1,pageHeight):1;
  return Math.max(-240,Math.min(240,event.deltaY*unit));
}
export function orbitZoomLimits(width,height){
  const diagonal=Math.hypot(width,height)/1000;
  return {min:.75,max:Math.max(45,diagonal*2.5),far:Math.max(300,diagonal*3.5+10)};
}
export function smoothOrbitWheel(controls,camera,canvas,{enabled,onInput}){
  let goal=null,lastSign=0;
  const reset=()=>{goal=null;lastSign=0;};
  const wheel=event=>{
    if(!enabled()||!controls.enableZoom)return;
    event.preventDefault();event.stopImmediatePropagation();
    const delta=wheelZoomDelta(event,canvas.clientHeight);if(!delta)return;
    onInput();
    const distance=camera.position.distanceTo(controls.target),sign=Math.sign(delta);
    // A direction change responds immediately rather than finishing old input.
    if(goal===null||sign!==lastSign)goal=distance;
    goal=Math.max(controls.minDistance,Math.min(controls.maxDistance,goal*Math.exp(delta*.00035)));
    lastSign=sign;
  };
  canvas.addEventListener('wheel',wheel,{capture:true,passive:false});
  canvas.addEventListener('pointerdown',reset,{capture:true});
  return {
    reset,
    update(dt){
      if(!enabled()){reset();return;}
      if(goal===null)return;
      const direction=camera.position.clone().sub(controls.target),distance=direction.length();
      if(distance<1e-6){reset();return;}
      goal=Math.max(controls.minDistance,Math.min(controls.maxDistance,goal));
      const alpha=1-Math.exp(-Math.max(0,dt)/.085);
      let next=Math.exp(Math.log(distance)+(Math.log(goal)-Math.log(distance))*alpha);
      if(Math.abs(next-goal)<Math.max(.0001,goal*.00005)){next=goal;goal=null;}
      camera.position.copy(controls.target).addScaledVector(direction,next/distance);
    },
    dispose(){canvas.removeEventListener('wheel',wheel,true);canvas.removeEventListener('pointerdown',reset,true);reset();}
  };
}
