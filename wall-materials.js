import * as THREE from 'three';

const cache=new Map();
function textureSet(id){
  if(cache.has(id))return cache.get(id);
  const definition=globalThis.WALL_FINISHES[id];
  if(!definition?.root)throw new Error('Unknown wall finish: '+id);
  const loader=new THREE.TextureLoader(),entry={textures:{},error:null};
  cache.set(id,entry);
  entry.ready=Promise.all(['Color','Roughness','NormalGL'].map(channel=>new Promise((resolve,reject)=>{
    const texture=loader.load(definition.root+channel+'.jpg',()=>resolve(),undefined,()=>reject(new Error('墙面贴图加载失败：'+channel+'.jpg')));
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
    texture.colorSpace=channel==='Color'?THREE.SRGBColorSpace:THREE.NoColorSpace;
    entry.textures[channel]=texture;
  }))).catch(error=>{entry.error=error;});
  return entry;
}
export function wallFinishMaterial(e,colour){
  if(!globalThis.WALL_FINISHES[e.wallFinish]?.root)return null;
  const textures=textureSet(e.wallFinish).textures,strength=e.wallNormalStrength??.3;
  const material=new THREE.MeshStandardMaterial({color:colour,roughness:1,metalness:0,
    map:textures.Color,roughnessMap:textures.Roughness,normalMap:textures.NormalGL,
    normalScale:new THREE.Vector2(strength,strength)});
  material.userData={instanceMaterial:true,renderRole:'wall',wallFinish:e.wallFinish,
    wallTextureSize:e.wallTextureSize??1,wallNormalStrength:strength,wallTint:colour};
  return material;
}
export async function readyWallFinishes(root){
  const ids=new Set();root.traverse(o=>{
    if(o.isMesh)for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m.userData.wallFinish)ids.add(m.userData.wallFinish);
  });
  for(const id of ids){const entry=textureSet(id);await entry.ready;if(entry.error)throw entry.error;}
}
/* Project in metres after all rotated walls and door cuts have been built.
 * UVs travel with the GLB, so Blender uses exactly the same texture scale. */
export function projectWallFinishUVs(root){
  root.updateMatrixWorld(true);
  const p=new THREE.Vector3(),n=new THREE.Vector3(),tangent=new THREE.Vector3(),normalMatrix=new THREE.Matrix3(),transform=new THREE.Matrix4(),inverseRoot=root.matrixWorld.clone().invert();
  root.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const material=(Array.isArray(mesh.material)?mesh.material:[mesh.material]).find(m=>m.userData.wallFinish);
    if(!material)return;
    const size=material.userData.wallTextureSize,geometry=mesh.geometry,positions=geometry.attributes.position,normals=geometry.attributes.normal;
    const uv=new Float32Array(positions.count*2);transform.multiplyMatrices(inverseRoot,mesh.matrixWorld);normalMatrix.getNormalMatrix(transform);
    for(let i=0;i<positions.count;i++){
      p.fromBufferAttribute(positions,i).applyMatrix4(transform);
      n.fromBufferAttribute(normals,i).applyMatrix3(normalMatrix).normalize();
      if(Math.abs(n.y)>.9){uv[i*2]=p.x/size;uv[i*2+1]=p.z/size;}
      else{tangent.set(n.z,0,-n.x).normalize();uv[i*2]=p.dot(tangent)/size;uv[i*2+1]=p.y/size;}
    }
    geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));
  });
}
