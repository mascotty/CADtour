import * as THREE from 'three';
import {buildSolidWallText,readySolidWallTexts} from './wall-text-3d.js';
export {prepareSolidWallText} from './wall-text-3d.js';
const textures=new Map();
function textureKey(d){return d.kind==='image'?d.imageKey:JSON.stringify([d.text,d.font,d.color,d.w,d.h,d.fontSize]);}
function canvasText(d){
  const scale=Math.min(2048/d.w,2048/d.h,4),canvas=document.createElement('canvas');
  canvas.width=Math.max(8,Math.ceil(d.w*scale));canvas.height=Math.max(8,Math.ceil(d.h*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle=d.color;ctx.font=`${d.fontSize*scale}px ${WALL_DECOR_FONTS[d.font].css}`;ctx.textAlign='center';ctx.textBaseline='middle';
  const lines=d.text.split('\n'),lineHeight=d.fontSize*1.25*scale;
  lines.forEach((line,i)=>ctx.fillText(line,canvas.width/2,canvas.height/2+(i-(lines.length-1)/2)*lineHeight));
  return canvas;
}
function textureFor(d){
  const key=textureKey(d);if(textures.has(key))return textures.get(key).texture;
  const texture=d.kind==='text'?new THREE.CanvasTexture(canvasText(d)):new THREE.Texture();
  texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
  const entry={texture,error:null,disposed:false,ready:Promise.resolve()};textures.set(key,entry);
  if(d.kind==='image')entry.ready=WallDecorAssets.get(d.imageKey).then(data=>new Promise((resolve,reject)=>{
    const image=new Image();image.onload=()=>{if(!entry.disposed){texture.image=image;texture.needsUpdate=true;}resolve();};image.onerror=()=>reject(new Error('墙面图片加载失败'));image.src=data;
  })).catch(error=>{entry.error=error;});
  return texture;
}
function decorTags(d,role){return {renderRole:role,wallDecorId:d.id,wallDecorKind:d.kind,wallDecorHostId:d.hostId};}
function modelMaterial(color,roughness=.5,metalness=0){const m=new THREE.MeshStandardMaterial({color,roughness,metalness});m.userData.instanceMaterial=true;return m;}
function addBuiltinModel(root,d,{envMap,envIntensity}){
  const quarter=d.facing%180,w=(quarter?d.depth:d.w)/1000,h=d.h/1000,depth=(quarter?d.w:d.depth)/1000;
  const shell=new THREE.Mesh(new THREE.BoxGeometry(w,h,depth),modelMaterial(d.modelType==='wall-tv'?'#151719':'#777b7d',.35,.65));
  const pivot=new THREE.Group();pivot.position.z=d.depth/2000;pivot.rotation.y=d.facing*Math.PI/180;root.add(pivot);pivot.add(shell);
  const face=new THREE.Mesh(new THREE.PlaneGeometry(Math.max(.001,w-.024),Math.max(.001,h-.024)),d.modelType==='wall-tv'?modelMaterial('#111b23',.16,.25):modelMaterial('#ffffff',.035,1));
  face.position.z=depth/2+.001;pivot.add(face);
  root.traverse(o=>{if(o.isMesh){o.castShadow=o.receiveShadow=true;o.userData=decorTags(d,'wall-decoration-model');o.material.envMap=envMap;o.material.envMapIntensity=envIntensity;o.material.color.multiply(new THREE.Color(d.color));}});
}
function addNativeModel(root,d,group,{loadModel,configs}){
  const quarter=d.facing%180,size=[(quarter?d.depth:d.w)/1000,d.h/1000,(quarter?d.w:d.depth)/1000];
  const anchor=new THREE.Group();anchor.position.set(0,-d.h/2000,d.depth/2000);anchor.rotation.y=d.facing*Math.PI/180;
  anchor.userData={fid:d.id,assetType:d.modelType,nativeSize:size,nativeColour:d.color,preserveMaterials:d.color.toLowerCase()==='#ffffff',assetLoaded:false};root.add(anchor);
  const ready=loadModel(d.modelType).then(asset=>{
    if(root.parent!==group)return;
    const content=new THREE.Group(),model=asset.template.clone(true),config=configs[d.modelType];model.position.add(asset.offset);
    const tint=m=>{
      const selected=config.colourAllMaterials||(config.colourMaterials||[]).some(name=>config.colourMode==='set'?m.name.startsWith(name):m.name===name);
      if(!selected||anchor.userData.preserveMaterials)return m;
      const copy=m.clone(),colour=new THREE.Color(d.color);if(config.colourMode==='set')copy.color.copy(colour);else copy.color.multiply(colour);copy.userData.instanceMaterial=true;return copy;
    };
    model.traverse(o=>{if(o.isMesh){o.castShadow=o.receiveShadow=true;o.material=Array.isArray(o.material)?o.material.map(tint):tint(o.material);o.userData={...o.userData,...decorTags(d,'wall-decoration-model')};}});
    content.scale.set(size[0]/asset.size.x,size[1]/asset.size.y,size[2]/asset.size.z);content.userData.sharedAsset=true;content.add(model);anchor.add(content);anchor.userData.assetLoaded=true;
  }).catch(error=>{anchor.userData.loadError=error;if(root.parent===group)toast(tr('挂墙模型加载失败，请检查素材文件后刷新。','Wall model failed to load. Check the asset file and refresh.'));});
  anchor.userData.loading=ready;
}
export function buildWallDecor(group,items,options){
  const {wx,wz,cut}=options;
  const used=new Set();
  for(const d of items){
    const p=wallDecorLayout(d);if(!p?.valid||p.top>cut*1000+.01)continue;
    const root=new THREE.Group();root.userData.wallDecorId=d.id;
    root.position.set(wx(p.x),p.cy/1000,wz(p.y));root.rotation.y=Math.atan2(p.nx,p.ny);root.rotateZ(d.rotation*Math.PI/180);
    group.add(root);
    if(d.kind==='text'&&d.textMode==='solid'){
      buildSolidWallText(root,d,group,options);continue;
    }
    if(d.kind==='model'){
      if(['wall-tv','wall-mirror'].includes(d.modelType))addBuiltinModel(root,d,options);else addNativeModel(root,d,group,options);
      continue;
    }
    used.add(textureKey(d));
    const material=new THREE.MeshStandardMaterial({map:textureFor(d),roughness:.75,metalness:0,alphaTest:.05,side:THREE.FrontSide});
    material.userData={instanceMaterial:true,renderRole:'wall-decoration'};
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(d.w/1000,d.h/1000),material);mesh.receiveShadow=true;
    mesh.userData={renderRole:'wall-decoration',wallDecorId:d.id,wallDecorKind:d.kind,wallDecorHostId:d.hostId};root.add(mesh);
    if(d.kind==='image'&&d.frame){
      const w=d.w/1000,h=d.h/1000,t=.02;
      const fm=new THREE.MeshStandardMaterial({color:d.frameColor,roughness:.5});fm.userData={instanceMaterial:true,renderRole:'wall-decoration-frame'};
      for(const [x,y,a,b] of [[0,(h+t)/2,w+2*t,t],[0,-(h+t)/2,w+2*t,t],[(w+t)/2,0,t,h],[-(w+t)/2,0,t,h]]){
        const frame=new THREE.Mesh(new THREE.BoxGeometry(a,b,.02),fm);frame.position.set(x,y,.006);frame.castShadow=frame.receiveShadow=true;frame.userData={renderRole:'wall-decoration-frame',wallDecorId:d.id,wallDecorKind:d.kind,wallDecorHostId:d.hostId};root.add(frame);
      }
    }
  }
  for(const [key,entry] of textures)if(!used.has(key)){entry.disposed=true;entry.texture.dispose();textures.delete(key);}
}
export async function readyWallDecor(group){
  await readySolidWallTexts(group);
  const models=[];group.traverse(o=>{if(o.userData.loading)models.push(o);});
  await Promise.all(models.map(o=>o.userData.loading));
  for(const o of models)if(o.userData.loadError||!o.userData.assetLoaded)throw o.userData.loadError||new Error('挂墙模型尚未准备好，请稍后再试');
  const used=new Set();group.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.map)used.add(m.map);});
  for(const entry of textures.values())if(used.has(entry.texture)){await entry.ready;if(entry.error)throw entry.error;}
}
