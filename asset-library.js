/* User models are registered from one server-owned catalog; plans keep references. */
const AssetLibrary=(()=>{
  const cacheKey='cadtour-open-model-catalog-v1',jobKey='cadtour-open-model-import-job';
  let assets,library,items=[],serverItems=[],dialog,viewer,job,epoch=0,controller;
  const valid=a=>a&&/^user_[a-f0-9]{32}$/.test(a.type)&&a.folder==='user-'+a.type.slice(5)&&typeof a.name==='string'&&a.name.length>0&&a.name.length<=80&&typeof a.category==='string'&&a.category.length<=40&&['width','height','depth'].every(k=>Number.isFinite(a[k])&&a[k]>=.001&&a[k]<=100);
  function installRefs(list){
    if(!assets||!Array.isArray(list))return;
    for(const a of list.filter(valid)){
      assets[a.type]={url:`assets/models/${a.folder}/model.glb`,thumbnail:`assets/models/${a.folder}/preview.png`,colourMaterials:[],colourAllMaterials:true,note:['导入模型保留原材质；白色不额外染色。网页使用简化模型，Cycles 使用完整 blend。','Imported original materials; white adds no tint. Cycles uses the full blend model.']};
      const category='导入素材 · '+a.category;let group=library.find(c=>c.cat===category);if(!group){group={cat:category,items:[]};library.unshift(group);}
      const old=group.items.findIndex(i=>i[0]===a.type),entry=[a.type,a.name,Math.max(1,Math.round(a.width*1000)),Math.max(1,Math.round(a.depth*1000)),'#ffffff'];
      if(old>=0)group.items[old]=entry;else group.items.push(entry);
      const at=items.findIndex(i=>i.type===a.type);if(at>=0)items[at]=a;else items.push(a);
    }
  }
  function restore(a,l){assets=a;library=l;try{installRefs(JSON.parse(localStorage.getItem(cacheKey)||'[]'));}catch{}}
  function references(plan){const used=new Set([...(plan.furniture||[]).map(f=>f.type),...(plan.wallDecor||[]).filter(d=>d.kind==='model').map(d=>d.modelType)]);return items.filter(i=>used.has(i.type)).map(i=>({...i}));}
  async function request(path,method='GET',body,signal){
    const response=await fetch('/api/assets/'+path,{method,headers:{'Content-Type':'application/json','X-CADtour':'1'},body:body===undefined?undefined:JSON.stringify(body),signal});
    const data=await response.json().catch(()=>null);if(!response.ok||!data)throw new Error(data?.error||'素材导入需要本地 Blender 服务，请用 render_server.py 启动或重启项目。');return data;
  }
  async function refresh(){
    const data=await request('catalog');serverItems=data.items.filter(valid);const changed=serverItems.some(i=>!assets[i.type]);installRefs(serverItems);try{localStorage.setItem(cacheKey,JSON.stringify(serverItems));}catch{}buildLib();if(changed)window.View3D?.refreshAssets();return serverItems;
  }
  function ensure(){
    if(dialog)return;
    const style=document.createElement('style');style.textContent='#assetDialog{width:min(900px,94vw);max-height:90vh;border:1px solid #ddd1c2;border-radius:12px;padding:20px;color:#302d29}#assetDialog::backdrop{background:#0008}#assetDialog .asset-columns{display:grid;grid-template-columns:1.2fr 1fr;gap:18px}#assetDialog canvas{display:block;width:100%;height:330px;background:#f2eee8;border-radius:8px}#assetDialog .asset-warnings{color:#92612a;font-size:12px;max-height:150px;overflow:auto}#assetDialog .asset-error{color:#ad3023;white-space:pre-wrap}#assetDialog input[type=file]{width:100%}@media(max-width:650px){#assetDialog .asset-columns{grid-template-columns:1fr}#assetDialog canvas{height:240px}}';document.head.append(style);
    dialog=document.createElement('dialog');dialog.id='assetDialog';document.body.append(dialog);
    dialog.addEventListener('close',()=>{epoch++;viewer?.dispose();viewer=null;controller?.abort();controller=null;});
  }
  function header(){return '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">导入模型素材</h2><button class="btn" id="assetClose">关闭</button></div>';}
  function bindClose(){document.getElementById('assetClose').onclick=()=>dialog.close();}
  function form(error=''){
    viewer?.dispose();viewer=null;
    dialog.innerHTML=header()+`<p class="muted">上传一个模型及其贴图，系统会生成网页预览和 Cycles 渲染文件。</p><div class="form"><label class="full">模型文件／贴图压缩包<input type="file" id="assetFiles" multiple accept=".blend,.fbx,.glb,.zip,.png,.jpg,.jpeg,.tga,.tif,.tiff,.bmp,.webp,.exr,.hdr"></label><label>模型名称<input id="assetName" maxlength="80" placeholder="例如：接待台"></label><label>分类<input id="assetCategory" maxlength="40" value="其他" list="assetCategories"><datalist id="assetCategories"><option>牙科诊疗</option><option>桌椅家具</option><option>灯具装饰</option><option>其他</option></datalist></label><label>导入时水平转向<select id="assetYaw">${[0,90,180,270].map(a=>`<option value="${a}">${a}°</option>`).join('')}</select></label></div><p class="muted">支持 BLEND、FBX、GLB，或包含一个模型的 ZIP；也可同时选择 FBX 和贴图 ZIP。总大小最多 256 MB。整个文件的网格会作为一个素材，请先清理不需要的物品。BLEND 建议先打包资源。</p><p class="asset-error" id="assetError">${esc(error)}</p><p id="assetStatus"></p><div class="actions"><button class="btn primary" id="assetPrepare">生成预览</button></div><p class="muted">当前本机素材库：${serverItems.length} 个导入模型。入库前可校正尺寸，复杂材质需核对预览。</p>`;
    bindClose();document.getElementById('assetFiles').onchange=e=>{if(!document.getElementById('assetName').value)document.getElementById('assetName').value=e.target.files[0]?.name.replace(/\.[^.]+$/,'')||'';};
    document.getElementById('assetPrepare').onclick=upload;
    const cancel=document.createElement('button');cancel.className='btn';cancel.id='assetCancel';cancel.textContent='取消导入';cancel.hidden=true;document.getElementById('assetPrepare').after(cancel);
    cancel.onclick=async()=>{epoch++;controller?.abort();if(job){try{await request('imports/'+job.id,'DELETE');}catch{}}localStorage.removeItem(jobKey);job=null;form();};
  }
  async function poll(token){
    const identifier=job.id;
    while(dialog.open&&token===epoch){
      const next=await request('imports/'+identifier);
      if(token!==epoch||!dialog.open)return;
      job=next;
      if(job.state==='ready'){await preview(token);return;}
      if(job.state==='failed'||job.state==='cancelled')throw new Error(job.error||'导入已取消，请重新上传。');
      document.getElementById('assetStatus').textContent=job.stage||'正在转换…';await new Promise(resolve=>setTimeout(resolve,1200));
    }
  }
  async function upload(){
    const files=[...document.getElementById('assetFiles').files],name=document.getElementById('assetName').value.trim(),category=document.getElementById('assetCategory').value.trim(),yaw=Number(document.getElementById('assetYaw').value),token=epoch;
    const error=document.getElementById('assetError'),status=document.getElementById('assetStatus'),button=document.getElementById('assetPrepare');
    if(!name||!category||!files.length){error.textContent='请选择文件并填写名称、分类。';return;}
    if(files.length>16||files.reduce((n,f)=>n+f.size,0)>256*1024*1024){error.textContent='每次最多 16 个文件，总大小不超过 256 MB。';return;}
    button.disabled=true;document.getElementById('assetCancel').hidden=false;error.textContent='';controller=new AbortController();
    try{
      const created=await request('imports','POST',{name,category,yaw},controller.signal);if(token!==epoch||!dialog.open)return;job=created;localStorage.setItem(jobKey,job.id);
      for(let i=0;i<files.length;i++){
        status.textContent=`上传 ${i+1}/${files.length}：${files[i].name}`;
        const response=await fetch(`/api/assets/imports/${job.id}/files?name=${encodeURIComponent(files[i].name)}`,{method:'PUT',headers:{'X-CADtour':'1'},body:files[i],signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'文件上传失败');
        if(token!==epoch||!dialog.open)return;
      }
      const prepared=await request('imports/'+job.id+'/prepare','POST',{});if(token!==epoch||!dialog.open)return;job=prepared;status.textContent=job.stage;await poll(token);
    }catch(e){if(token===epoch&&dialog.open){error.textContent=e.message;button.disabled=false;}}
  }
  async function preview(token){
    const current=job,m=job.manifest;
    dialog.innerHTML=header()+`<p class="muted">旋转预览，确认材质和朝向。校正宽度会按比例调整宽、深、高。</p><div class="asset-columns"><canvas id="assetPreview"></canvas><div class="form"><label class="full">模型名称<input id="assetName" maxlength="80" value="${esc(job.name)}"></label><label class="full">分类<input id="assetCategory" maxlength="40" value="${esc(job.category)}"></label><label>校正宽度（mm）<input id="assetWidth" type="number" min="1" max="100000" value="${Math.round(m.width*1000)}"></label><div><p id="assetDimensions"></p><small class="muted">原始 ${m.sourcePolygons.toLocaleString()} 面<br>网页 ${m.webPolygons.toLocaleString()} 面</small></div><div class="asset-warnings full" style="grid-column:1/-1">${(m.warnings||[]).map(w=>`<p>${esc(w)}</p>`).join('')}</div></div></div><p class="asset-error" id="assetError"></p><div class="actions"><button class="btn primary" id="assetPublish" disabled>加入素材库</button><button class="btn" id="assetDiscard">取消本次导入</button></div>`;
    bindClose();const update=()=>{const scale=Number(document.getElementById('assetWidth').value)/1000/m.width;document.getElementById('assetDimensions').textContent=`深 ${Math.round(m.depth*scale*1000)} × 高 ${Math.round(m.height*scale*1000)} mm`;};document.getElementById('assetWidth').oninput=update;update();
    document.getElementById('assetDiscard').onclick=async()=>{await request('imports/'+job.id,'DELETE');localStorage.removeItem(jobKey);job=null;form();};
    document.getElementById('assetPublish').onclick=async()=>{
      const button=document.getElementById('assetPublish');button.disabled=true;
      try{const result=await request('imports/'+current.id+'/publish','POST',{name:document.getElementById('assetName').value.trim(),category:document.getElementById('assetCategory').value.trim(),yaw:current.yaw,widthMm:Number(document.getElementById('assetWidth').value)});installRefs([result.item]);await refresh();if(localStorage.getItem(jobKey)===current.id)localStorage.removeItem(jobKey);if(token===epoch&&dialog.open)dialog.close();toast('已加入素材库，可从左侧拖入房间。');}
      catch(e){if(token===epoch&&dialog.open){document.getElementById('assetError').textContent=e.message;button.disabled=false;}}
    };
    try{if(!window.View3D?.previewAsset)throw new Error('三维模块尚未加载完成，请稍后重新打开导入窗口。');const result=await window.View3D.previewAsset(document.getElementById('assetPreview'),job.model);if(token!==epoch||!dialog.open){result.dispose();return;}viewer=result;document.getElementById('assetPublish').disabled=false;}
    catch(e){if(token===epoch&&dialog.open)document.getElementById('assetError').textContent='预览失败：'+e.message;}
  }
  async function open(){
    ensure();if(dialog.open)return;const token=++epoch;form();dialog.showModal();
    try{await refresh();if(token!==epoch||!dialog.open)return;const previous=localStorage.getItem(jobKey);if(previous){const next=await request('imports/'+previous);if(token!==epoch||!dialog.open)return;job=next;if(job.state==='ready')return preview(token);if(job.state==='converting'){document.getElementById('assetStatus').textContent=job.stage;document.getElementById('assetPrepare').disabled=true;document.getElementById('assetCancel').hidden=false;return await poll(token);}localStorage.removeItem(jobKey);}}
    catch(e){if(token===epoch&&dialog.open)document.getElementById('assetError').textContent=e.message;}
  }
  const api={restore,installRefs,references,refresh,open,ready:Promise.resolve(),hasServerAsset:type=>serverItems.some(i=>i.type===type)};
  api.start=()=>{document.getElementById('importAsset').onclick=open;api.ready=refresh().catch(()=>null);};
  return api;
})();
