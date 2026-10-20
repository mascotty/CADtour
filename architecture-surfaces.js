/* Procedural architectural details use metres and the same footprint as the plan. */
import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

export function makeCeiling(polygons, height, material){
  return polygons.map(polygon => {
    const ringShape = ring => new THREE.Shape(ring.map(([x,z])=>new THREE.Vector2(x,-z)));
    const shape=ringShape(polygon[0]);shape.holes=polygon.slice(1).map(ringShape);
    const geometry=new THREE.ExtrudeGeometry(shape,{depth:.08,bevelEnabled:false,steps:1});
    geometry.rotateX(-Math.PI/2);
    const mesh=new THREE.Mesh(geometry,material);mesh.position.y=height;
    mesh.castShadow=mesh.receiveShadow=true;mesh.userData.renderRole='ceiling';return mesh;
  });
}

function insideRing(x,z,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [a,b]=ring[i],[c,d]=ring[j];
    if((b>z)!==(d>z)&&x<(c-a)*(z-b)/(d-b)+a) inside=!inside;
  }
  return inside;
}
export function insideFootprint(x,z,polygon){
  return insideRing(x,z,polygon[0])&&!polygon.slice(1).some(r=>insideRing(x,z,r));
}
function polygonArea(polygon){
  const area=ring=>Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
  return area(polygon[0])-polygon.slice(1).reduce((sum,r)=>sum+area(r),0);
}
export function ceilingLights(polygons, blockers=[]){
  const result=[];
  for(const polygon of polygons){
    const xs=polygon[0].map(p=>p[0]),zs=polygon[0].map(p=>p[1]);
    const x0=Math.min(...xs),x1=Math.max(...xs),z0=Math.min(...zs),z1=Math.max(...zs);
    // Keep dense grids bounded even for accidentally oversized CAD imports.
    const spacing=Math.max(3,Math.sqrt(polygons.reduce((sum,p)=>sum+polygonArea(p),0)/600));
    const nx=Math.max(1,Math.ceil((x1-x0)/spacing)),nz=Math.max(1,Math.ceil((z1-z0)/spacing));
    const valid=(x,z)=>insideFootprint(x,z,polygon)&&!blockers.some(r=>x>r[0]-.16&&x<r[2]+.16&&z>r[1]-.16&&z<r[3]+.16);
    const candidates=[];
    for(let i=0;i<nx;i++)for(let j=0;j<nz;j++){
      const x=x0+(i+.5)*(x1-x0)/nx,z=z0+(j+.5)*(z1-z0)/nz;
      if(valid(x,z)) candidates.push([x,z]);
    }
    // A concave room's bounding-box centre can lie outside its floor.
    if(!candidates.length){
      search:for(let i=0;i<20;i++)for(let j=0;j<20;j++){
        const x=x0+(i+.5)*(x1-x0)/20,z=z0+(j+.5)*(z1-z0)/20;
        if(valid(x,z)){candidates.push([x,z]);break search;}
      }
    }
    const area=polygonArea(polygon)/Math.max(1,candidates.length);
    for(const [x,z] of candidates) result.push({x,z,area,size:.22});
  }
  return result.slice(0,1000);
}

export function makeWindowDetails({length,height,bottom,thickness,horizontal,cx,cz,id,window},materials,cutBoxes=null){
  const meshes=[],outer=Math.min(.055,length/4,height/4),mullion=Math.min(.04,length/4),depth=Math.max(.07,thickness+.024);
  const divisions=Math.max(1,Math.round(length/.9));
  const part=(w,h,d,x,y,z,material,role)=>{
    if(Math.min(w,h,d)<=0) return;
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(horizontal?w:d,h,horizontal?d:w),material);
    mesh.position.set(cx+(horizontal?x:z),y,cz+(horizontal?z:x));
    mesh.castShadow=mesh.receiveShadow=true;mesh.userData={renderRole:role,architectureDetailId:id};
    meshes.push(...(cutBoxes?cutBoxes(mesh):[mesh]));
  };
  // Aluminium bodies with slightly wider face caps rather than flat dark strips.
  for(let k=0;k<=divisions;k++){
    const edge=k===0||k===divisions,w=edge?outer:mullion,x=-length/2+k*length/divisions;
    part(w,height,depth,x,bottom+height/2,0,materials.frame,'frame');
    for(const sign of [-1,1]) part(w+.008,height,.008,x,bottom+height/2,sign*(depth/2-.004),materials.frame,'frame');
  }
  for(const y of [bottom+outer/2,bottom+height-outer/2]){
    part(length,outer,depth,0,y,0,materials.frame,'frame');
    for(const sign of [-1,1])part(length,outer+.008,.008,0,y,sign*(depth/2-.004),materials.frame,'frame');
  }
  // Rubber seals sit beside each pane, separated from both glass faces.
  const seal=.009,gap=.003;
  for(let k=0;k<divisions;k++){
    const left=-length/2+k*length/divisions+(k===0?outer:mullion)/2;
    const right=-length/2+(k+1)*length/divisions-(k===divisions-1?outer:mullion)/2;
    const low=bottom+outer,high=bottom+height-outer;
    for(const sign of [-1,1]){
      const z=sign*(thickness/2+gap+.002);
      for(const x of [left+seal/2,right-seal/2]) part(seal,high-low,.004,x,(low+high)/2,z,materials.seal,'seal');
      for(const y of [low+seal/2,high-seal/2])part(right-left,seal,.004,(left+right)/2,y,z,materials.seal,'seal');
    }
  }
  if(window&&bottom>.05){
    const sillDepth=Math.max(.18,materials.wallDepth+.06);
    part(length+.07,.025,sillDepth,0,bottom-.0125,0,materials.sill,'sill');
  }
  // Batch details by finish: a long glazed wall needs three draw calls, rather
  // than a separate call for every strip. Glass remains a separate closed mesh.
  const groups=new Map();
  for(const mesh of meshes){
    mesh.updateMatrix();mesh.geometry.applyMatrix4(mesh.matrix);
    const role=mesh.userData.renderRole;
    if(!groups.has(role))groups.set(role,{material:mesh.material,geometries:[]});
    groups.get(role).geometries.push(mesh.geometry);
  }
  return [...groups].map(([role,{material,geometries}])=>{
    const geometry=mergeGeometries(geometries);geometries.forEach(g=>g.dispose());
    const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=mesh.receiveShadow=true;
    mesh.userData={renderRole:role,architectureDetailId:id};return mesh;
  });
}
