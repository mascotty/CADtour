/* Wall-relative artwork and lettering. Image bytes live outside undo snapshots. */
const WALL_DECOR_FONTS={yahei:{name:'微软雅黑',css:'"Microsoft YaHei",sans-serif'},hei:{name:'黑体',css:'SimHei,sans-serif'},song:{name:'宋体',css:'SimSun,serif'}};
function wallModelChoices(){return [['wall-tv','挂墙电视'],['wall-mirror','挂墙镜面'],...Object.keys(FURNITURE_ASSETS).map(type=>[type,LIB.flatMap(c=>c.items).find(i=>i[0]===type)?.[1]||type])];}
const WallDecorAssets=(()=>{
  let database;const cache=new Map();
  const open=()=>database||(database=new Promise((resolve,reject)=>{const r=indexedDB.open('cadtour-wall-images',1);r.onupgradeneeded=()=>r.result.createObjectStore('images');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('无法打开本地图片存储'));}));
  async function put(key,data){
    if(!/^wi[\w-]{1,80}$/.test(key)||!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(data)||data.length>3000000)throw new Error('图片数据无效或过大');
    const db=await open();await new Promise((resolve,reject)=>{const tx=db.transaction('images','readwrite');tx.objectStore('images').put(data,key);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error('本地图片保存失败，请检查浏览器存储空间'));});cache.set(key,data);
  }
  async function get(key){
    if(cache.has(key))return cache.get(key);const db=await open();
    const data=await new Promise((resolve,reject)=>{const r=db.transaction('images').objectStore('images').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('读取墙面图片失败'));});
    if(!data)throw new Error('缺少墙面图片，请重新上传或导入包含图片的方案');cache.set(key,data);return data;
  }
  async function portable(plan){const out=JSON.parse(JSON.stringify(plan));out.assetReferences=AssetLibrary.references(plan);out.wallDecorAssets={};for(const key of new Set((out.wallDecor||[]).filter(d=>d.kind==='image').map(d=>d.imageKey)))out.wallDecorAssets[key]=await get(key);return out;}
  async function ingest(plan){
    AssetLibrary.installRefs(plan.assetReferences);
    const keys=new Set(normalizeWallDecor(plan.wallDecor).filter(d=>d.kind==='image').map(d=>d.imageKey));
    for(const key of keys){if(plan.wallDecorAssets?.[key])await put(key,plan.wallDecorAssets[key]);else await get(key);}
    delete plan.wallDecorAssets;return plan;
  }
  return {put,get,portable,ingest};
})();
function wallTextSize(text,font,fontSize){
  const ctx=document.createElement('canvas').getContext('2d');ctx.font=`100px ${WALL_DECOR_FONTS[font]?.css||WALL_DECOR_FONTS.yahei.css}`;
  const lines=String(text).split('\n');return {w:Math.max(1,...lines.map(line=>ctx.measureText(line).width))/100*fontSize+fontSize*.2,h:lines.length*fontSize*1.25+fontSize*.2};
}
function normalizeWallDecor(value){
  const ids=new Set();return (Array.isArray(value)?value:[]).slice(0,200).flatMap(input=>{
    if(!/^wd[\w-]{1,80}$/.test(input?.id||'')||ids.has(input.id)||!/^(?:[wg]\d+|a[\w-]+)$/.test(input.hostId||'')||!['image','text','model'].includes(input.kind))return [];
    const d={id:input.id,hostId:input.hostId,kind:input.kind,name:String(input.name||'').slice(0,80),side:input.side===-1?-1:1};
    for(const [key,fallback,min,max] of [['u',.5,0,1],['bottom',1000,0,10000],['rotation',0,-180,180],['offset',8,2,100],['w',600,10,20000],['h',400,10,10000],['fontSize',120,10,2000]])d[key]=typeof input[key]==='number'&&Number.isFinite(input[key])?Math.max(min,Math.min(max,input[key])):fallback;
    d.frame=!!input.frame;d.frameColor=/^#[\da-f]{6}$/i.test(input.frameColor||'')?input.frameColor:'#61584b';
    if(d.kind==='image'){
      if(!/^wi[\w-]{1,80}$/.test(input.imageKey||''))return [];
      d.imageKey=input.imageKey;d.ratio=Number.isFinite(input.ratio)&&input.ratio>0?input.ratio:d.w/d.h;
    }else if(d.kind==='text'){
      d.text=String(input.text??'诊室名称').replace(/\r/g,'').slice(0,500).split('\n').slice(0,10).join('\n');d.font=Object.hasOwn(WALL_DECOR_FONTS,input.font)?input.font:'yahei';d.color=/^#[\da-f]{6}$/i.test(input.color||'')?input.color:'#333333';
      d.textMode=input.textMode==='solid'?'solid':'flat';
      d.textDepth=Number.isFinite(input.textDepth)?Math.max(1,Math.min(200,input.textDepth)):20;
      d.textBevel=Math.max(0,Math.min(5,d.textDepth/3,d.fontSize/200,Number.isFinite(input.textBevel)?input.textBevel:.3));
      d.textFinish=input.textFinish==='metal'?'metal':'paint';
      Object.assign(d,wallTextSize(d.text,d.font,d.fontSize));d.frame=false;
    }
    else{if(!['wall-tv','wall-mirror'].includes(input.modelType)&&!Object.hasOwn(FURNITURE_ASSETS,input.modelType)&&!/^user_[a-f0-9]{32}$/.test(input.modelType))return [];d.modelType=input.modelType;d.depth=Number.isFinite(input.depth)?Math.max(10,Math.min(5000,input.depth)):80;d.facing=[0,90,180,270].includes(input.facing)?input.facing:input.flip?180:0;d.color=/^#[\da-f]{6}$/i.test(input.color||'')?input.color:'#ffffff';d.frame=false;}
    ids.add(d.id);return [d];
  });
}
function getWallDecor(id){return (state.wallDecor||[]).find(d=>d.id===id);}
function wallSolidBands(e){
  if(e.type==='wall')return [[0,e.height*1000]];
  if(e.type==='window')return [[0,e.sill*1000],[e.height*1000,state.heights.ceiling*1000]].filter(([a,b])=>b-a>1);
  const p=glassWallParts(e);return [[0,p.base*1000],[p.glassTop*1000,e.height*1000]].filter(([a,b])=>b-a>1);
}
function wallDecorLayout(d,host=getArchitecture(d.hostId)){
  if(!host||host.hidden)return null;
  const [a,b]=architectureLine(host),length=architectureLineLength(host),tx=(b[0]-a[0])/length,ty=(b[1]-a[1])/length;
  const angle=d.rotation*Math.PI/180,border=d.frame?40:0,halfW=(Math.abs((d.w+border)*Math.cos(angle))+Math.abs((d.h+border)*Math.sin(angle)))/2,halfH=(Math.abs((d.w+border)*Math.sin(angle))+Math.abs((d.h+border)*Math.cos(angle)))/2;
  const along=d.u*length,cy=d.bottom+d.h/2,bottom=cy-halfH,top=cy+halfH;
  let valid=along-halfW>=-.01&&along+halfW<=length+.01&&wallSolidBands(host).some(([lo,hi])=>bottom>=lo-.01&&top<=hi+.01);
  if(valid&&!host.oriented){
    const axis=host.horizontal?0:1,start=a[axis]+along-halfW,end=a[axis]+along+halfW;
    valid=doorSegments(host.rect,bottom/1000,top/1000,host.horizontal,host.id).some(piece=>piece.rect[axis]<=start+.01&&piece.rect[axis+2]>=end-.01&&piece.bottom*1000<=bottom+.01&&piece.top*1000>=top-.01);
  }
  const nx=-ty*d.side,ny=tx*d.side,distance=architectureFootprintThickness(host)/2+d.offset;
  return {host,length,along,halfW,bottom,top,valid,tx,ty,nx,ny,x:a[0]+tx*along+nx*distance,y:a[1]+ty*along+ny*distance,cy};
}
function reconcileWallDecor(){const hosts=new Set(architectureEntries().map(e=>e.id));state.wallDecor=(state.wallDecor||[]).filter(d=>hosts.has(d.hostId));}
function rehostWallDecor(host,kept){
  state.wallDecor=(state.wallDecor||[]).flatMap(d=>{
    if(d.hostId!==host.id)return [d];const layout=wallDecorLayout(d,host);if(!layout)return [];
    for(const piece of kept){const [a]=architectureLine(piece),[origin,end]=architectureLine(host),len=architectureLineLength(host),start=((a[0]-origin[0])*(end[0]-origin[0])+(a[1]-origin[1])*(end[1]-origin[1]))/len,size=architectureLineLength(piece);
      if(layout.along-layout.halfW>=start-.01&&layout.along+layout.halfW<=start+size+.01)return [{...d,hostId:piece.id,u:(layout.along-start)/size}];}
    return [];
  });
}
function wallDecorSection(e){
  const items=(state.wallDecor||[]).filter(d=>d.hostId===e.id),available=wallSolidBands(e).length>0;
  return `<div style="margin:12px 0"><h3>${tr('墙面布置','Wall artwork')}</h3><div class="actions"><button class="btn" id="wallAddImage" ${available?'':'disabled'}>${tr('添加图片','Add image')}</button><button class="btn" id="wallAddText" ${available?'':'disabled'}>${tr('添加文字','Add text')}</button><button class="btn" id="wallAddModel" ${available?'':'disabled'}>${tr('添加挂墙模型','Add wall model')}</button></div>
    ${!available?`<p class="muted">${tr('此构件没有实体墙面。','This piece has no solid wall surface.')}</p>`:''}
    ${items.length?`<table>${items.map(d=>`<tr class="click" data-wall-decor-edit="${d.id}"><td>${esc(d.name||d.text||tr('墙面图片','Wall image'))}</td><td class="r muted">${wallDecorLayout(d)?.valid?tr('编辑','Edit'):tr('位置需调整','Adjust position')}</td></tr>`).join('')}</table>`:''}</div>`;
}
function bindWallDecorSection(e){
  $('#wallAddImage').onclick=()=>wallDecorUpload(e.id);
  $('#wallAddText').onclick=()=>addWallDecor(e.id,'text');
  $('#wallAddModel').onclick=()=>addWallDecor(e.id,'model',{modelType:'wall-tv'});
  document.querySelectorAll('[data-wall-decor-edit]').forEach(b=>b.onclick=()=>select({kind:'walldecor',id:b.dataset.wallDecorEdit}));
}
async function prepareWallImage(file){
  if(!file||!['image/png','image/jpeg'].includes(file.type))throw new Error('请上传 JPG 或 PNG 图片');
  if(file.size>20*1024*1024)throw new Error('图片超过 20 MB，请先缩小图片');
  const bitmap=await createImageBitmap(file);if(!bitmap.width||!bitmap.height)throw new Error('无法读取图片尺寸');
  const ratio=bitmap.width/bitmap.height;let scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height)),data;
  do{const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);data=canvas.toDataURL(file.type,.9);scale*=.75;}while(data.length>2800000&&scale>.03);
  bitmap.close();const key='wi'+crypto.randomUUID();await WallDecorAssets.put(key,data);return {imageKey:key,ratio,name:file.name.replace(/\.[^.]+$/,'').slice(0,80)};
}
function wallDecorUpload(hostId,replaceId=null){
  const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg';
  input.onchange=async()=>{try{const file=input.files[0];if(!file)return;const asset=await prepareWallImage(file);
    if(replaceId){const old=getWallDecor(replaceId);if(!old)return;const next={...old,...asset,h:old.w/asset.ratio};if(!wallDecorLayout(next)?.valid)throw new Error('新图片超出墙面范围，请先缩小原图片尺寸');mutate(()=>Object.assign(old,next));}
    else addWallDecor(hostId,'image',asset);
  }catch(error){toast(error.message||'图片读取失败');}};input.click();
}
function addWallDecor(hostId,kind,asset={}){
  const host=getArchitecture(hostId);if(!host||host.hidden)return;
  const band=wallSolidBands(host).sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]))[0];if(!band)return toast(tr('请选择有实体墙面的构件。','Choose a solid wall surface.'));
  const len=architectureLineLength(host),available=band[1]-band[0];
  let d={id:'wd'+uid(),hostId,kind,side:ui.wallDecorSide||1,u:.5,bottom:band[0],rotation:0,offset:8,...asset};
  if(kind==='image'){d.w=Math.min(1000,len*.65,available*.65*d.ratio);d.h=d.w/d.ratio;}
  else if(kind==='text'){d.font='yahei';d.fontSize=Math.max(10,Math.min(120,len/5,available/3));d.text='诊室名称';d.name='墙面文字';d.color='#333333';}
  else{d.name='挂墙模型';d.w=Math.min(1000,len*.6,available*.8);d.h=d.w*.5625;d.depth=80;d.color='#ffffff';}
  d=normalizeWallDecor([d])[0];if(!d)return;
  let found=false;
  for(const u of [.5,.25,.75,.1,.9]){d.u=u;for(const bottom of [band[0]+(available-d.h)/2,band[1]-d.h-30,band[0]+30]){d.bottom=Math.max(0,bottom);if(wallDecorLayout(d)?.valid){found=true;break;}}if(found)break;}
  if(!found)return toast(tr('墙面可用范围不足，或被门窗洞口占用。','Not enough solid wall space, or an opening occupies it.'));
  ui.sel={kind:'walldecor',id:d.id};mutate(()=>state.wallDecor.push(d));drawer('panel',true);
}
function wallTextAppearanceFields(d){
  return `<label class="full">${tr('文字效果','Text effect')}<select id="decorTextMode"><option value="flat" ${d.textMode==='solid'?'':'selected'}>${tr('平面文字','Flat lettering')}</option><option value="solid" ${d.textMode==='solid'?'selected':''}>${tr('立体文字','3D lettering')}</option></select></label>
    <div id="decorSolidFields" style="display:${d.textMode==='solid'?'contents':'none'}"><label>${tr('文字厚度（mm）','Text depth (mm)')}<input id="decorTextDepth" type="number" min="1" max="200" step="1" value="${d.textDepth}"></label><label>${tr('边缘倒角（mm）','Edge bevel (mm)')}<input id="decorTextBevel" type="number" min="0" max="5" step="0.05" value="${d.textBevel}"></label><label class="full">${tr('文字材质','Letter finish')}<select id="decorTextFinish"><option value="paint" ${d.textFinish==='metal'?'':'selected'}>${tr('漆面','Painted')}</option><option value="metal" ${d.textFinish==='metal'?'selected':''}>${tr('金属','Metal')}</option></select></label><p class="muted full" style="grid-column:1/-1">${tr('按字体轮廓生成实体，自动同步效果图。单组最多 120 个非空白字符；细字体建议减少倒角或设为 0。','Creates solid glyphs for web and renders. Up to 120 visible characters; use a small or zero bevel for thin fonts.')}</p></div>`;
}
function wallDecorContentFields(d){
  if(d.kind==='text')return `<label class="full">${tr('文字内容（支持换行）','Text (multiple lines supported)')}<textarea id="decorText" rows="3" maxlength="500" style="width:100%;resize:vertical">${esc(d.text)}</textarea></label><label>${tr('字体','Font')}<select id="decorFont">${Object.entries(WALL_DECOR_FONTS).map(([key,f])=>`<option value="${key}" ${d.font===key?'selected':''}>${f.name}</option>`).join('')}</select></label><label>${tr('字号（mm）','Letter size (mm)')}<input id="decorFontSize" type="number" min="10" max="2000" step="10" value="${d.fontSize}"></label><label>${tr('文字颜色','Text colour')}<input id="decorColor" type="color" value="${d.color}"></label>${wallTextAppearanceFields(d)}`;
  const sizeFields=`<label>${tr('宽度（mm）','Width (mm)')}<input id="decorWidth" type="number" min="10" max="20000" value="${Math.round(d.w)}"></label><label>${tr('高度（mm）','Height (mm)')}<input id="decorHeight" type="number" min="10" max="10000" value="${Math.round(d.h)}"></label>`;
  if(d.kind==='model')return `<label class="full">${tr('模型','Model')}<select id="decorModelType">${wallModelChoices().map(([type,name])=>`<option value="${type}" ${d.modelType===type?'selected':''}>${esc(name)}</option>`).join('')}</select></label>${sizeFields}<label>${tr('厚度（mm）','Depth (mm)')}<input id="decorDepth" type="number" min="10" max="5000" value="${Math.round(d.depth)}"></label><label>${tr('模型颜色','Model tint')}<input id="decorColor" type="color" value="${d.color}"></label><label class="full">${tr('模型朝向','Model facing')}<select id="decorFacing">${[0,90,180,270].map(a=>`<option value="${a}" ${d.facing===a?'selected':''}>${a}°</option>`).join('')}</select></label><p class="muted full" style="grid-column:1/-1">${tr('模型侧对墙面时可转向 90°。更换模型或朝向时按原比例更新高度和厚度。白色保留原材质。','Turn a sideways model by 90°. Model or facing changes update height and depth proportionally. White keeps original materials.')}</p>`;
  return `<div class="full" style="grid-column:1/-1"><img id="decorPreview" alt="${esc(d.name)}" style="max-width:100%;max-height:140px;object-fit:contain"><button class="btn" id="decorReplace">${tr('替换图片','Replace image')}</button></div>${sizeFields}<label class="full" style="flex-direction:row"><input type="checkbox" id="decorRatio" checked style="width:auto">${tr('保持图片比例','Keep aspect ratio')}</label><label class="full" style="flex-direction:row"><input type="checkbox" id="decorFrame" ${d.frame?'checked':''} style="width:auto">${tr('添加画框','Add frame')}</label><label>${tr('画框颜色','Frame colour')}<input type="color" id="decorFrameColor" value="${d.frameColor}"></label>`;
}
function wallDecorPanel(d){
  const host=getArchitecture(d.hostId),layout=wallDecorLayout(d),length=layout?.length||0;
  return `<section><h3>${tr(d.kind==='image'?'墙面图片':d.kind==='text'?'墙面文字':'挂墙模型',d.kind==='image'?'Wall image':d.kind==='text'?'Wall text':'Wall model')}</h3>
    ${!layout?.valid?`<p style="color:#b52b1b">${tr('当前位置超出实体墙面或落在门窗洞口，调整后才会显示。','The item lies outside the solid wall or over an opening; adjust it to display.')}</p>`:''}
    <div class="form"><label class="full">${tr('名称','Name')}<input id="decorName" value="${esc(d.name)}"></label>
    ${wallDecorContentFields(d)}
    <label>${tr('距墙起点（mm）','From wall start (mm)')}<input id="decorAlong" type="number" min="0" max="${length}" value="${Math.round(d.u*length)}"></label>
    <label>${tr('底部离地（mm）','Bottom above floor (mm)')}<input id="decorBottom" type="number" min="0" max="10000" value="${Math.round(d.bottom)}"></label>
    <label>${tr('墙面方向','Wall side')}<select id="decorSide"><option value="1" ${d.side===1?'selected':''}>${tr('正面','Front')}</option><option value="-1" ${d.side===-1?'selected':''}>${tr('反面','Back')}</option></select></label>
    <label>${tr('墙面内旋转（°）','Rotation on wall (°)')}<input id="decorRotation" type="number" min="-180" max="180" value="${d.rotation}"></label>
    <label>${tr('距墙面（mm）','Gap from wall (mm)')}<input id="decorOffset" type="number" min="2" max="100" value="${d.offset}"></label></div>
    <p class="muted">${tr('位置随墙体移动。仅放置在实体墙面，内容会同步到效果图。','Follows the wall. Place on solid surfaces; contents appear in renders.')}</p>
    <div class="actions"><button class="btn primary" id="decorApply">${tr('应用修改','Apply changes')}</button><button class="btn danger" id="decorDelete">${tr('删除','Delete')}</button><button class="btn" id="decorBack">${tr('返回墙体','Back to wall')}</button></div></section>`;
}
function bindWallDecorPanel(d){
  if(d.kind==='text')$('#decorTextMode').onchange=()=>{$('#decorSolidFields').style.display=$('#decorTextMode').value==='solid'?'contents':'none';};
  if(d.kind==='image'){
    WallDecorAssets.get(d.imageKey).then(src=>{if(ui.sel?.id===d.id&&$('#decorPreview'))$('#decorPreview').src=src;}).catch(error=>toast(error.message));
    $('#decorReplace').onclick=()=>wallDecorUpload(d.hostId,d.id);
    $('#decorWidth').onchange=()=>{if($('#decorRatio').checked)$('#decorHeight').value=Math.round(Number($('#decorWidth').value)/d.ratio);};
    $('#decorHeight').onchange=()=>{if($('#decorRatio').checked)$('#decorWidth').value=Math.round(Number($('#decorHeight').value)*d.ratio);};
  }
  if(d.kind==='model')$('#decorModelType').onchange=$('#decorFacing').onchange=async()=>{
    const type=$('#decorModelType').value,facing=Number($('#decorFacing').value);$('#decorApply').disabled=true;
    try{const size=await window.View3D.wallModelSize(type);if(ui.sel?.id!==d.id||$('#decorModelType')?.value!==type||Number($('#decorFacing')?.value)!==facing)return;if(facing%180)[size[0],size[2]]=[size[2],size[0]];const scale=Number($('#decorWidth').value)/size[0];$('#decorHeight').value=Math.max(10,Math.round(size[1]*scale));$('#decorDepth').value=Math.max(10,Math.round(size[2]*scale));$('#decorName').value=wallModelChoices().find(([key])=>key===type)?.[1]||type;}
    catch(error){toast(error.message||tr('模型加载失败','Model failed to load'));}
    finally{if(ui.sel?.id===d.id&&$('#decorApply'))$('#decorApply').disabled=false;}
  };
  $('#decorApply').onclick=async()=>{
    const layout=wallDecorLayout(d),length=layout?.length;if(!length)return;
    const patch={...d,name:$('#decorName').value.trim().slice(0,80)};
    const values={u:Number($('#decorAlong').value)/length,bottom:Number($('#decorBottom').value),side:Number($('#decorSide').value),rotation:Number($('#decorRotation').value),offset:Number($('#decorOffset').value)};
    if(d.kind==='text')Object.assign(values,{fontSize:Number($('#decorFontSize').value),textDepth:Number($('#decorTextDepth').value),textBevel:Number($('#decorTextBevel').value)});else Object.assign(values,{w:Number($('#decorWidth').value),h:Number($('#decorHeight').value)});
    if(d.kind==='model')values.depth=Number($('#decorDepth').value);
    if(!Object.values(values).every(Number.isFinite)||values.u<0||values.u>1||values.bottom<0||Math.abs(values.rotation)>180||values.offset<2||values.offset>100||values.fontSize<10||values.fontSize>2000||values.w<10||values.w>20000||values.h<10||values.h>10000)return toast(tr('请检查尺寸、离地高度和位置。','Check size, height and position.'));
    Object.assign(patch,values);
    if(values.depth<10||values.depth>5000)return toast(tr('模型厚度应为 10–5000 mm。','Model depth must be 10–5000 mm.'));
    if(d.kind==='text'){
      Object.assign(patch,{text:$('#decorText').value,font:$('#decorFont').value,color:$('#decorColor').value,textMode:$('#decorTextMode').value,textFinish:$('#decorTextFinish').value});
      if(patch.textMode==='solid'&&(values.textDepth<1||values.textDepth>200||values.textBevel<0||values.textBevel>Math.min(5,values.textDepth/3,values.fontSize/200)))return toast(tr('请检查厚度与倒角。倒角不能超过字号的 1/200、厚度的 1/3 或 5 mm。','Check depth and bevel. Bevel must not exceed letter size / 200, depth / 3, or 5 mm.'));
    }
    else if(d.kind==='image')Object.assign(patch,{frame:$('#decorFrame').checked,frameColor:$('#decorFrameColor').value});
    else Object.assign(patch,{modelType:$('#decorModelType').value,facing:Number($('#decorFacing').value),color:$('#decorColor').value});
    const next=normalizeWallDecor([patch])[0];if(!next||!wallDecorLayout(next)?.valid)return toast(tr('内容必须完整放在实体墙面内，不能跨过门窗洞口。','Keep the whole item on a solid wall, away from openings.'));
    if(next.kind==='text'&&next.textMode==='solid'){
      const button=$('#decorApply');button.disabled=true;
      try{if(!window.View3D?.prepareSolidWallText)throw new Error('三维模块尚未准备好，请稍后再试。');await window.View3D.prepareSolidWallText(next);}
      catch(error){toast(error.message||'立体文字生成失败');return;}
      finally{if(button.isConnected)button.disabled=false;}
      if(getWallDecor(d.id)!==d)return;
      // Recheck openings if the wall was edited while curves were being loaded.
      if(!wallDecorLayout(next)?.valid)return toast(tr('墙面已变化，请重新调整文字位置。','The wall changed; adjust the text position.'));
    }
    mutate(()=>Object.assign(d,next));
  };
  $('#decorDelete').onclick=()=>deleteWallDecor(d.id);
  $('#decorBack').onclick=()=>select({kind:'arch',id:d.hostId});
}
function deleteWallDecor(id){ui.sel=null;mutate(()=>state.wallDecor=state.wallDecor.filter(d=>d.id!==id));}
function renderWallDecorPlan(){
  $('#gWallDecor').innerHTML=(state.wallDecor||[]).map(d=>{
    const p=wallDecorLayout(d);if(!p?.valid)return '';const half=d.w/2,n=Math.max(18,2/view.s),points=[[-half,-n],[half,-n],[half,n],[-half,n]].map(([a,b])=>[p.x+p.tx*a+p.nx*b,p.y+p.ty*a+p.ny*b].join(',')).join(' '),selected=ui.sel?.kind==='walldecor'&&ui.sel.id===d.id;
    return `<g data-wall-decor="${d.id}" style="cursor:pointer"><title>${esc(d.name||d.text)}</title><polygon points="${points}" fill="${selected?'#b5653a':'#477e86'}" stroke="transparent" stroke-width="${8/view.s}"/><text x="${p.x}" y="${p.y}" font-size="${10/view.s}" fill="white" text-anchor="middle" dominant-baseline="central" pointer-events="none">${tr(d.kind==='image'?'图':d.kind==='text'?'文':'物',d.kind==='image'?'Img':d.kind==='text'?'Txt':'Obj')}</text></g>`;
  }).join('');
}
