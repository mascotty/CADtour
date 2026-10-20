import * as THREE from 'three';

export function makeDoor(e,{wx,wz,mat,glass,metal},top,previous){
  const objects=[],height=Math.min(e.height,top),L=e.width/1000,t=e.thickness/1000;
  if(e.closed||e.hidden||e.inactive||height<=.001)return {objects,controller:null};
  const frameMaterial=mat(e.frameColor,{roughness:.4});
  const box=(w,h,d,material,x=0,y=0,z=0,role='frame')=>{
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.position.set(x,y+h/2,z);
    mesh.castShadow=mesh.receiveShadow=true;mesh.userData={renderRole:role,doorId:e.id};return mesh;
  };
  const cx=wx((e.rect[0]+e.rect[2])/2),cz=wz((e.rect[1]+e.rect[3])/2),frame=new THREE.Group();
  frame.userData.doorId=e.id;frame.position.set(cx,0,cz);frame.rotation.y=e.horizontal?0:-Math.PI/2;
  for(const x of [-L/2+.0175,L/2-.0175])frame.add(box(.035,height,t+.014,frameMaterial,x));
  if(top>=e.height)frame.add(box(L,.035,t+.014,frameMaterial,0,height-.035));
  objects.push(frame);
  if(e.kind==='opening')return {objects,controller:null};
  const bodyMaterial=e.material==='glass'?glass.clone():mat(e.color,{roughness:.48});
  if(e.material==='glass'){bodyMaterial.color.set(e.color);bodyMaterial.userData={instanceMaterial:true,renderRole:'glass'};}
  const panel=(width,panelHeight)=>{
    const group=new THREE.Group();group.userData.doorId=e.id;
    const thick=e.material==='glass'?.01:.038;
    if(e.material==='glass'){
      group.add(box(Math.max(.05,width-.065),Math.max(.05,panelHeight-.07),thick,bodyMaterial,0,.035,0,'glass'));
      for(const x of [-width/2+.015,width/2-.015])group.add(box(.03,panelHeight,.026,frameMaterial,x));
      for(const y of [0,panelHeight-.03])group.add(box(width,.03,.026,frameMaterial,0,y));
    }else group.add(box(width,panelHeight,thick,bodyMaterial,0,0,0,'door'));
    const handle=box(.12,.018,.028,metal,width/2-.09,Math.min(1,panelHeight-.12),thick/2+.025,'door-hardware');group.add(handle);
    return group;
  };
  const controller={id:e.id,kind:e.kind,width:L,open:previous?.initialOpen===e.open?previous.open:e.open,initialOpen:e.open,cur:0};
  if(e.kind==='swing'){
    const width=Math.max(.1,L-.08),pivot=new THREE.Group(),leaf=panel(width,Math.max(.1,height-.05));
    const hinge=[wx(e.h[0])+e.c[0]*.04,wz(e.h[1])+e.c[1]*.04];
    pivot.position.set(hinge[0],.01,hinge[1]);leaf.position.x=width/2;pivot.add(leaf);pivot.userData.doorId=e.id;
    controller.pivot=pivot;controller.a0=Math.atan2(-e.c[1],e.c[0]);controller.a1=Math.atan2(-e.o[1],e.o[0]);
    const diff=controller.a1-controller.a0;if(diff>Math.PI)controller.a1-=Math.PI*2;else if(diff< -Math.PI)controller.a1+=Math.PI*2;
    controller.cur=controller.open?controller.a1:controller.a0;
    controller.update=dt=>{controller.cur+=((controller.open?controller.a1:controller.a0)-controller.cur)*Math.min(1,dt*8);pivot.rotation.y=controller.cur;};
    controller.segments=()=>[[pivot.position.x,pivot.position.z,pivot.position.x+Math.cos(controller.cur)*width,pivot.position.z-Math.sin(controller.cur)*width]];
    controller.update(0);objects.push(pivot);
  }else{
    const group=new THREE.Group(),width=L*.55,panels=[];group.position.set(cx,.01,cz);group.rotation.y=e.horizontal?0:-Math.PI/2;group.userData.doorId=e.id;
    for(const side of [-1,1]){const leaf=panel(width,Math.max(.1,height-.055));leaf.position.set(side*(L-width)/2,0,side*.025);group.add(leaf);panels.push({leaf,side});}
    controller.pivot=group;controller.cur=controller.open?1:0;
    controller.update=dt=>{controller.cur+=((controller.open?1:0)-controller.cur)*Math.min(1,dt*8);for(const {leaf,side} of panels)leaf.position.x=side<0?-(L-width)/2+controller.cur*(L-width):(L-width)/2;};
    controller.segments=()=>{group.updateMatrixWorld(true);return panels.map(({leaf})=>{const a=new THREE.Vector3(-width/2,0,0).applyMatrix4(leaf.matrixWorld),b=new THREE.Vector3(width/2,0,0).applyMatrix4(leaf.matrixWorld);return [a.x,a.z,b.x,b.z];});};
    controller.update(0);objects.push(group);
  }
  for(const root of objects)root.traverse(o=>{if(o.isMesh)o.userData.door=controller;});
  return {objects,controller};
}
