import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

export async function previewAsset(canvas,url){
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.toneMapping=THREE.ACESFilmicToneMapping;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1,.001,100000);
  const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;
  const pm=new THREE.PMREMGenerator(renderer),environment=pm.fromScene(new RoomEnvironment(),.04).texture;pm.dispose();scene.environment=environment;
  scene.add(new THREE.HemisphereLight(0xffffff,0x807060,2));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(3,4,5);scene.add(light);
  let frame,model,disposed=false;
  const resources=()=>{const geometries=new Set(),materials=new Set(),textures=new Set();model?.traverse(o=>{if(!o.isMesh)return;geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());};
  const dispose=()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();controls.dispose();resources();environment.dispose();renderer.dispose();};
  const resize=()=>{const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();};
  const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
  try{
    model=(await new GLTFLoader().loadAsync(url)).scene;
    if(!canvas.isConnected){dispose();return {dispose};}
    scene.add(model);const bounds=new THREE.Box3().setFromObject(model),center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),radius=Math.max(size.length()/2,.001);
    controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(1,.7,1.3).normalize().multiplyScalar(radius*3.4));camera.near=Math.max(radius/10000,.00001);camera.far=radius*30+10;camera.updateProjectionMatrix();controls.minDistance=radius*.3;controls.maxDistance=radius*10;
    const tick=()=>{if(disposed)return;controls.update();renderer.render(scene,camera);frame=requestAnimationFrame(tick);};tick();return {dispose,size:size.toArray()};
  }catch(error){dispose();throw error;}
}
