import * as THREE from 'three';

// Cache curves, rather than complete meshes: every instance owns its geometry.
const outlines=new Map();
const textBuilders=new WeakMap();
export async function prepareSolidWallText(d){
  if(!d.text.trim())throw new Error('请输入需要生成的立体文字。');
  if(Array.from(d.text).filter(c=>!c.match(/\s/u)).length>120)throw new Error('单组立体文字最多 120 个非空白字符；长段落可使用平面文字。');
  const key=JSON.stringify([d.font,Array.from(new Set(d.text.replace(/\n/g,'').replace(/\t/g,'    '))).sort().join('')]);
  if(!outlines.has(key)){
    const pending=fetch('/api/wall-text/outlines',{method:'POST',headers:{'Content-Type':'application/json','X-CADtour':'1'},body:JSON.stringify({font:d.font,text:d.text}),signal:AbortSignal.timeout(20000)})
      .then(async response=>{
        const data=await response.json().catch(()=>null);
        if(!response.ok||!data?.glyphs)throw new Error(data?.error||`立体文字字体接口未返回有效字形（HTTP ${response.status}）。请确认当前网页由 render_server.py 提供；服务恢复后可直接重试渲染。`);
        return data;
      }).catch(error=>{outlines.delete(key);throw error;});
    // Limit curve storage during long editing sessions.
    if(outlines.size>=64)outlines.delete(outlines.keys().next().value);
    outlines.set(key,pending);
  }
  return outlines.get(key);
}

function contains(points,p){
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i],b=points[j];
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}
function contourShapes(paths){
  // Fonts may list a counter before its outline (SimSun), and characters such
  // as 回 contain islands inside holes. Assign each contour to its smallest
  // enclosing contour instead of relying on order or a single winding rule.
  const contours=paths.map(path=>{const points=path.getPoints(12);return {path,points,area:Math.abs(THREE.ShapeUtils.area(points)),parent:null,shape:null};}).filter(c=>c.area>1e-14);
  for(const c of contours)for(const p of contours)if(p.area>c.area+1e-14&&(!c.parent||p.area<c.parent.area)&&contains(p.points,c.points[0]))c.parent=p;
  const depth=c=>c.parent?depth(c.parent)+1:0,shapes=[];
  for(const c of contours)if(depth(c)%2===0){c.shape=new THREE.Shape();c.shape.curves=c.path.curves;shapes.push(c.shape);}
  for(const c of contours)if(depth(c)%2===1)c.parent.shape.holes.push(c.path);
  return shapes;
}
function shapesForText(d,data){
  const shapes=[],unit=d.fontSize/1000/data.resolution;
  d.text.replace(/\t/g,'    ').split('\n').forEach((line,row)=>{
    const width=Array.from(line).reduce((n,char)=>n+data.glyphs[char].advance*unit,0);
    let x=-width/2;const y=-row*d.fontSize/1000*1.25;
    for(const char of line){
      const glyph=data.glyphs[char],path=new THREE.ShapePath();
      for(const contour of glyph.paths)for(const [command,...points] of contour){
        const p=points.map((value,i)=>value*unit+(i%2?y:x));
        if(command==='M')path.moveTo(...p);
        else if(command==='L')path.lineTo(...p);
        else if(command==='Q')path.quadraticCurveTo(...p);
        else if(command==='C')path.bezierCurveTo(...p);
        else if(command==='Z')path.currentPath.closePath();
      }
      if(glyph.paths.length)shapes.push(...contourShapes(path.subPaths));
      x+=glyph.advance*unit;
    }
  });
  return shapes;
}

export function buildSolidWallText(root,d,parent,{envMap,envIntensity}){
  // Keep recovery callbacks out of exported userData. A temporary service error
  // must not permanently prevent this scene from rendering after recovery.
  textBuilders.set(root,()=>buildSolidWallText(root,d,parent,{envMap,envIntensity}));
  delete root.userData.solidTextError;
  root.userData.solidTextReady=false;
  root.userData.solidTextLoading=prepareSolidWallText(d).then(data=>{
    if(root.parent!==parent)return;
    const depth=d.textDepth/1000,bevel=d.textBevel/1000;
    const geometry=new THREE.ExtrudeGeometry(shapesForText(d,data),{
      depth:depth-2*bevel,steps:1,curveSegments:6,
      bevelEnabled:bevel>0,bevelThickness:bevel,bevelSize:bevel,bevelSegments:2
    });
    geometry.computeBoundingBox();const bounds=geometry.boundingBox,size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
    if(size.x<=0||size.y<=0){geometry.dispose();throw new Error('文字中没有可生成的可见字形。');}
    // Retain the existing conservative wall footprint, including padding.
    const fit=Math.min(1,(d.w-d.fontSize*.1)/1000/size.x,(d.h-d.fontSize*.1)/1000/size.y);
    geometry.translate(-center.x,-center.y,bevel);geometry.scale(fit,fit,1);geometry.computeBoundingBox();geometry.computeBoundingSphere();
    const material=new THREE.MeshStandardMaterial({color:d.color,metalness:d.textFinish==='metal'?.9:0,roughness:d.textFinish==='metal'?.24:.4,envMap,envMapIntensity:envIntensity});
    material.userData={instanceMaterial:true,renderRole:'wall-decoration-text-3d'};
    const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=mesh.receiveShadow=true;
    mesh.userData={renderRole:'wall-decoration-text-3d',wallDecorId:d.id,wallDecorKind:'text',wallDecorHostId:d.hostId};
    root.add(mesh);root.userData.solidTextReady=true;
  }).catch(error=>{root.userData.solidTextError=error;if(root.parent===parent)toast(error.message||'立体文字生成失败');});
}

export async function readySolidWallTexts(group){
  const items=[];group.traverse(o=>{if(o.userData.solidTextLoading)items.push(o);});
  await Promise.all(items.map(o=>o.userData.solidTextLoading));
  const retry=items.filter(o=>o.userData.solidTextError&&textBuilders.has(o));
  for(const o of retry)textBuilders.get(o)();
  await Promise.all(retry.map(o=>o.userData.solidTextLoading));
  for(const o of items)if(o.userData.solidTextError||!o.userData.solidTextReady)throw o.userData.solidTextError||new Error('立体文字仍在生成，请稍后再试。');
}
