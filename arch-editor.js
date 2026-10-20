/* CAD geometry stays unchanged. Manual architecture edits are saved with the plan. */
function normalizeArchitecture(value){
  const clean = input => {
    const out = {};
    if (['wall','glass','window'].includes(input?.type)) out.type = input.type;
    if (Object.hasOwn(WALL_FINISHES,input?.wallFinish)) out.wallFinish=input.wallFinish;
    for (const [key,min,max] of [['wallTextureSize',.1,10],['wallNormalStrength',0,1]])
      if(typeof input?.[key]==='number'&&Number.isFinite(input[key]))out[key]=Math.max(min,Math.min(max,input[key]));
    for (const [key, min, max] of [['height',.1,10], ['thickness',5,1000], ['sill',0,9], ['baseHeight',0,10], ['topWallHeight',0,10], ['wallThickness',20,1000], ['skirtingHeight',0,1000]])
      if (typeof input?.[key] === 'number' && Number.isFinite(input[key])) out[key] = Math.max(min, Math.min(max, input[key]));
    for (const key of ['color','frameColor','wallColor','skirtingColor']) if (/^#[0-9a-f]{6}$/i.test(input?.[key] || '')) out[key] = input[key];
    if (typeof input?.hidden === 'boolean') out.hidden = input.hidden;
    if (typeof input?.split === 'boolean') out.split = input.split;
    if (typeof input?.horizontal === 'boolean') out.horizontal = input.horizontal;
    if (/^(?:[wg]\d+|a[\w-]+)$/.test(input?.originId || '')) out.originId = input.originId;
    if (['n','e','b','low'].includes(input?.structural)) out.structural = input.structural;
    const line=input?.oriented?.line;
    if(Array.isArray(line)&&line.length===2&&line.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>Number.isFinite(v)&&Math.abs(v)<1e7))&&Math.hypot(line[1][0]-line[0][0],line[1][1]-line[0][1])>.01)
      out.oriented={line:line.map(p=>p.slice())};
    return out;
  };
  const overrides = {};
  for (const [id, settings] of Object.entries(value?.overrides || {}))
    if (/^[wg]\d+$/.test(id)) overrides[id] = clean(settings);
  const seen = new Set();
  const added = (Array.isArray(value?.added) ? value.added : []).flatMap(item => {
    if (!/^a[\w-]+$/.test(item?.id || '') || seen.has(item.id) || !validArchRect(item.rect)) return [];
    seen.add(item.id);
    const settings = clean(item);
    return [{...settings, id:item.id, rect:item.rect.slice(0,4), type:settings.type || 'wall'}];
  });
  return {overrides, added};
}
function validArchRect(r){
  return Array.isArray(r) && r.length >= 4 && r.slice(0,4).every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7) && r[2] > r[0] && r[3] > r[1];
}
function archRectThickness(rect, thickness, horizontal=rect[2]-rect[0]>=rect[3]-rect[1]){
  const [x0,y0,x1,y1] = rect, hz = horizontal;
  return hz ? [x0,(y0+y1-thickness)/2,x1,(y0+y1+thickness)/2] : [(x0+x1-thickness)/2,y0,(x0+x1+thickness)/2,y1];
}
function glassWallParts(e){
  const base = Math.min(Math.max(0,e.baseHeight || 0),Math.max(0,e.height-.1));
  const head = Math.min(Math.max(0,e.topWallHeight || 0),Math.max(0,e.height-base-.1));
  return {base,head,glassTop:e.height-head};
}
function architectureFootprintThickness(e){
  return e.type === 'glass' && ((e.baseHeight || 0) > 0 || (e.topWallHeight || 0) > 0) ? Math.max(e.thickness,e.wallThickness || 120) : e.thickness;
}
function architectureEntries(includeHidden = false){
  const edits = state.architecture || {overrides:{},added:[]}, entries = [], seenWindows = new Set();
  WALLS.forEach((r,i) => {if(validArchRect(r))entries.push({id:'w'+i, rect:r.slice(0,4), oriented:r[5], type:'wall', structural:r[4], height:r[4] === 'low' ? 1 : undefined, source:'cad'});});
  WINS.forEach((r,i) => {
    // Collapsed CAD outlines have no selectable footprint. Do not expand a
    // zero-area symbol into a full-height window frame in the 3D scene.
    if(!validArchRect(r))return;
    const key = r.slice(0,4).map(v => Math.round(v*1000)/1000).join(',');
    if (seenWindows.has(key)) return;
    seenWindows.add(key);
    entries.push({id:'g'+i, rect:r.slice(0,4), oriented:r[5], type:'window', sill:i === 0 ? 1.4 : i >= 6 ? .45 : .9, height:2.4, source:'cad'});
  });
  entries.push(...edits.added.map(item => ({...item, source:'added'})));
  return entries.map(base => {
    const settings = edits.overrides[base.id] || {}, e = {...base,...settings};
    e.horizontal=e.horizontal??(e.rect[2]-e.rect[0]>=e.rect[3]-e.rect[1]);
    if (settings.type && settings.type !== base.type && settings.height === undefined) e.height = undefined;
    e.height = Math.min(state.heights.ceiling, e.height ?? state.heights.ceiling);
    e.sill = e.type === 'window' ? Math.min(e.sill ?? .9, e.height) : 0;
    e.thickness = e.thickness ?? (e.type === 'glass' ? 10 : e.oriented?.thickness ?? Math.min(e.rect[2]-e.rect[0], e.rect[3]-e.rect[1]));
    if (e.type === 'glass'){
      const parts = glassWallParts(e); e.baseHeight = parts.base; e.topWallHeight = parts.head;
      e.wallThickness = e.wallThickness || 120; e.wallColor = e.wallColor || '#f4f1eb';
    }
    if(e.oriented){const [a,b]=e.oriented.line,r=cadOrientedRect({x1:a[0],y1:a[1],x2:b[0],y2:b[1]},architectureFootprintThickness(e),e.structural);e.rect=r.slice(0,4);e.oriented=r[5];}
    else e.rect = archRectThickness(e.rect, architectureFootprintThickness(e),e.horizontal);
    e.color = e.color || (e.type === 'wall' ? '#f4f1eb' : '#cfe6ef');
    e.frameColor = e.frameColor || '#5d6166';
    e.skirtingHeight = e.skirtingHeight ?? 120;
    e.skirtingColor = e.skirtingColor || '#8b7f6e';
    e.hidden = !!e.hidden || state.demolished.includes(e.id);
    return e;
  }).filter(e => includeHidden || !e.hidden);
}
function getArchitecture(id){ return architectureEntries(true).find(e => e.id === id); }
function architectureLabel(type){ return ({wall:tr('普通墙体','Solid wall'),glass:tr('玻璃隔断','Glass partition'),window:tr('窗户','Window')})[type]; }
function architectureInputFields(e, coordinates = false){
  const r = e.rect, hz = e.horizontal ?? (r && r[2]-r[0] >= r[3]-r[1]);
  return `<div class="fields">${wallFinishFields(e)}
    <div style="grid-column:1/-1"><h3>${tr('踢脚线','Skirting')}</h3><div class="fields"><label>${tr('踢脚线高度（mm）','Skirting height (mm)')}<input id="archSkirtingHeight" type="number" min="0" max="1000" step="10" value="${e.skirtingHeight??120}"></label><label>${tr('踢脚线颜色','Skirting colour')}<input id="archSkirtingColor" type="color" value="${e.skirtingColor||'#8b7f6e'}"></label></div><p class="muted" style="margin:4px 0">${tr('高度设为 0 可隐藏。仅作用于本构件底部的实体墙面，不超过实体墙高。','Set height to 0 to hide. Applies to this piece’s solid base, clipped to its wall height.')}</p></div>
    <label>${tr(e.type === 'glass' ? '总高度（m）' : '高度（m）',e.type === 'glass' ? 'Total height (m)' : 'Height (m)')}<input id="archHeight" type="number" min="0.1" max="${state.heights.ceiling}" step="0.1" value="${e.height}"></label>
    <label>${tr(e.type === 'glass' ? '玻璃厚度（mm）' : '厚度（mm）',e.type === 'glass' ? 'Glass thickness (mm)' : 'Thickness (mm)')}<input id="archThickness" type="number" min="5" max="1000" step="5" value="${e.thickness}"></label>
    ${e.type!=='wall'?`<label>${tr('玻璃颜色','Glass tint')}<input id="archColor" type="color" value="${e.color}"></label>`:''}
    ${e.type !== 'wall' ? `<label>${tr('边框颜色','Frame colour')}<input id="archFrameColor" type="color" value="${e.frameColor || '#5d6166'}"></label>` : ''}
    ${e.type === 'glass' ? `<label style="grid-column:1/-1">${tr('玻璃结构','Glass structure')}<select id="archGlassStructure"><option value="plain" ${!(e.baseHeight || e.topWallHeight) ? 'selected' : ''}>${tr('纯玻璃隔断','Glass only')}</option><option value="wall" ${e.baseHeight || e.topWallHeight ? 'selected' : ''}>${tr('带墙体的玻璃隔断','Glass with walls')}</option></select></label>
    <label>${tr('下方墙高（m）','Base wall height (m)')}<input id="archBaseHeight" type="number" min="0" max="${e.height}" step="0.1" value="${e.baseHeight || 0}"></label>
    <label>${tr('上方墙高（m）','Top wall height (m)')}<input id="archTopWallHeight" type="number" min="0" max="${e.height}" step="0.1" value="${e.topWallHeight || 0}"></label>
    <label>${tr('墙体厚度（mm）','Wall thickness (mm)')}<input id="archWallThickness" type="number" min="20" max="1000" step="10" value="${e.wallThickness || 120}"></label>
    <p class="muted" style="grid-column:1/-1;margin:0">${tr('总高度包含墙体和玻璃。上下墙高设为 0 表示不加墙；只需顶部墙梁时，将下方墙高设为 0。','Total height includes glass and walls. Use 0 to omit a wall; set the base to 0 for a top wall only.')}</p>` : ''}
    ${e.type === 'window' ? `<label>${tr('窗台高度（m）','Sill height (m)')}<input id="archSill" type="number" min="0" max="${e.height}" step="0.1" value="${e.sill}"></label>` : ''}
    ${coordinates ? `<label>${tr('中心 X（mm）','Centre X (mm)')}<input id="archX" type="number" step="10" value="${(r[0]+r[2])/2}"></label>
    <label>${tr('中心 Y（mm）','Centre Y (mm)')}<input id="archY" type="number" step="10" value="${(r[1]+r[3])/2}"></label>
    <label>${tr('长度（mm）','Length (mm)')}<input id="archLength" type="number" min="100" step="10" value="${hz ? r[2]-r[0] : r[3]-r[1]}"></label>` : ''}
  </div>`;
}
function readArchitectureFields(type){
  const height = Number($('#archHeight').value), thickness = Number($('#archThickness').value), sill = Number($('#archSill')?.value || 0);
  if (!Number.isFinite(height) || height < .1 || height > state.heights.ceiling || !Number.isFinite(thickness) || thickness < 5 || thickness > 1000 || sill < 0 || (type === 'window' && sill >= height)) {
    toast(tr('请检查高度、厚度和窗台高度；构件不能超过层高。','Check height, thickness and sill; height cannot exceed the ceiling.')); return null;
  }
  const settings = {type,height,thickness,sill,color:$('#archColor').value,frameColor:$('#archFrameColor')?.value || '#5d6166'};
  const wallFinish=$('#archWallFinish')?.value||'plain', wallTextureSize=Number($('#archWallTextureSize')?.value??1),wallNormalStrength=Number($('#archWallNormalStrength')?.value??.3);
  if(!Object.hasOwn(WALL_FINISHES,wallFinish)||![wallTextureSize,wallNormalStrength].every(Number.isFinite)||wallTextureSize<.1||wallTextureSize>10||wallNormalStrength<0||wallNormalStrength>1){
    toast(tr('纹理尺寸应为 0.1–10 m，凹凸强度应为 0–1。','Texture size must be 0.1–10 m and normal strength 0–1.'));return null;
  }
  Object.assign(settings,{wallFinish,wallTextureSize,wallNormalStrength});
  const skirtingHeight=Number($('#archSkirtingHeight').value),skirtingColor=$('#archSkirtingColor').value;
  if(!$('#archSkirtingHeight').value.trim()||!Number.isFinite(skirtingHeight)||skirtingHeight<0||skirtingHeight>1000||!/^#[\da-f]{6}$/i.test(skirtingColor)){
    toast(tr('踢脚线高度应为 0–1000 mm，请检查颜色。','Skirting height must be 0–1000 mm; check its colour.'));return null;
  }
  Object.assign(settings,{skirtingHeight,skirtingColor});
  if(type==='window')settings.wallColor=$('#archWallColor').value;
  if (type === 'glass'){
    const baseHeight = Number($('#archBaseHeight').value), topWallHeight = Number($('#archTopWallHeight').value), wallThickness = Number($('#archWallThickness').value);
    if (![baseHeight,topWallHeight,wallThickness].every(Number.isFinite) || baseHeight < 0 || topWallHeight < 0 || baseHeight+topWallHeight > height-.1+1e-6 || wallThickness < 20 || wallThickness > 1000){
      toast(tr('上下墙高之和必须小于总高度，至少保留 0.1 m 玻璃；请检查墙体厚度。','Leave at least 0.1 m of glass between the walls, and check wall thickness.')); return null;
    }
    Object.assign(settings,{baseHeight,topWallHeight,wallThickness,wallColor:$('#archWallColor').value});
  }
  return settings;
}
function bindGlassStructure(onChange){
  const select = $('#archGlassStructure'); if (!select) return;
  select.onchange = () => {
    const wall = select.value === 'wall', height = Number($('#archHeight').value);
    const preset = Math.min(.3,Math.max(0,(height-.1)/3));
    $('#archBaseHeight').value = wall ? Number(preset.toFixed(2)) : 0;
    $('#archTopWallHeight').value = wall ? Number(preset.toFixed(2)) : 0;
    const values = readArchitectureFields('glass'); if (values && onChange) onChange(values);
  };
  for (const id of ['#archBaseHeight','#archTopWallHeight']) $(id).addEventListener('change',() => {select.value=Number($('#archBaseHeight').value)+Number($('#archTopWallHeight').value)>0 ? 'wall' : 'plain';});
}
function constructionPanel(){
  const e = ui.archDraft;
  return `<section><h3>${tr('新增','Add')} ${architectureLabel(e.type)}</h3>
    <p>${tr('在平面图上依次点击起点、终点，或按住拖动。自动保持水平或垂直；Esc 取消当前线段。','Click the start and end on the plan, or drag. Lines stay horizontal or vertical; Esc cancels the segment.')}</p>
    ${architectureInputFields(e)}
    <p class="muted">${tr('参数更改后应用于接下来画出的墙段。房间名称、地板范围和面积暂不重新划分。','These settings apply to the next segment. Room names, flooring boundaries and areas keep their original values.')}</p>
    <div class="actions"><button class="btn primary" id="archDraw">${tr('开始绘制','Start drawing')}</button>
    <button class="btn" id="archDone">${tr('结束绘制','Finish drawing')}</button></div></section>`;
}
function bindConstructionPanel(){
  bindWallFinish(()=>{const values=readArchitectureFields(ui.archDraft.type);if(values)ui.archDraft=values;},ui.archDraft.type);
  $('#panel').querySelectorAll('input').forEach(input => input.onchange = () => { const values = readArchitectureFields(ui.archDraft.type); if (values) { ui.archDraft = values; renderMeasure(); } });
  bindGlassStructure(values => {ui.archDraft=values;renderMeasure();});
  $('#archDraw').onclick = () => closeDrawers();
  $('#archDone').onclick = () => { setTool('select'); closeDrawers(); };
}
function architecturePanel(e){
  const types = e.id.startsWith('g') || e.originId?.startsWith('g') || e.type==='window' ? ['window','wall','glass'] : ['wall','glass'];
  return `<section><h3>${architectureLabel(e.type)} <small>${tr(e.source === 'added' ? '手动新增' : '原始布局', e.source === 'added' ? 'Added manually' : 'Original layout')}</small></h3>
    <label>${tr('构件类型','Type')}<select id="archType">${types.map(type => `<option value="${type}" ${type === e.type ? 'selected' : ''}>${architectureLabel(type)}</option>`).join('')}</select></label>
    ${wallDecorSection(e)}
    ${architectureInputFields(e, e.source === 'added'&&!e.oriented)}
    <div class="actions"><button class="btn primary" id="archApply">${tr('应用修改','Apply changes')}</button>
    <button class="btn danger" id="archRemove">${tr(e.hidden ? '恢复' : '删除／拆除', e.hidden ? 'Restore' : 'Remove')}</button>
    <button class="btn" id="archPartial" ${e.hidden?'disabled':''}>${tr('局部拆除','Remove part')}</button>
    ${e.source !== 'added' ? `<button class="btn" id="archReset">${tr('恢复原始构件','Reset to original')}</button>` : ''}</div>
    <p class="muted">${tr('修改会同步到 3D 和渲染。房间名称、地板范围和面积暂不重新划分。','Changes appear in 3D and renders. Room names, flooring boundaries and areas keep their original values.')}</p>
    <button class="btn" id="archClose">${tr('完成','Done')}</button></section>`;
}
function bindArchitecturePanel(e){
  bindWallDecorSection(e);
  bindWallFinish(patch=>applyWallFinish(e,patch),e.type);
  $('#archSkirtingHeight').onchange=event=>{
    const value=Number(event.target.value);if(!event.target.value.trim()||!Number.isFinite(value)||value<0||value>1000)return toast(tr('踢脚线高度应为 0–1000 mm。','Skirting height must be 0–1000 mm.'));
    applyWallFinish(e,{skirtingHeight:value});
  };
  $('#archSkirtingColor').onchange=event=>applyWallFinish(e,{skirtingColor:event.target.value});
  $('#archClose').onclick = () => { select(null); closeDrawers(); };
  bindGlassStructure();
  $('#archType').onchange = event => {
    const type = event.target.value;
    const draft = {...e,type, thickness:type === 'glass' ? 10 : type === 'wall' ? Math.max(120,e.thickness) : e.thickness, height:type === 'window' ? Math.min(2.4,state.heights.ceiling) : state.heights.ceiling, sill:type === 'window' ? .9 : 0, color:type === 'wall' ? '#f4f1eb' : '#cfe6ef'};
    $('#panel').innerHTML = architecturePanel(draft); bindArchitecturePanel(draft);
  };
  $('#archApply').onclick = () => {
    const settings = readArchitectureFields($('#archType').value); if (!settings) return;
    let rect;
    if (e.source === 'added'&&!e.oriented){
      const x = Number($('#archX').value), y = Number($('#archY').value), length = Number($('#archLength').value), hz = e.horizontal;
      rect = hz ? [x-length/2,y-settings.thickness/2,x+length/2,y+settings.thickness/2] : [x-settings.thickness/2,y-length/2,x+settings.thickness/2,y+length/2];
      const existingTip=e.originId&&Math.abs(length-(hz?e.rect[2]-e.rect[0]:e.rect[3]-e.rect[1]))<.01;
      if (!validArchRect(rect) || (!existingTip&&(length < 100 || length <= architectureFootprintThickness(settings)))) return toast(tr('长度至少 100 mm，且必须大于构件厚度；请检查位置。','Use a length of at least 100 mm, greater than the piece thickness; check the position.'));
      if (sameArchitectureSpan(rect,e.id)) return toast(tr('这里已有重合墙段，请修改已有构件。','A coincident segment already exists; edit it instead.'));
    }
    mutate(() => {
      if (e.source === 'added') Object.assign(state.architecture.added.find(item => item.id === e.id),settings,rect?{rect}:{});
      else state.architecture.overrides[e.id] = {...state.architecture.overrides[e.id],...settings};
    });
  };
  $('#archRemove').onclick = () => removeArchitecture(e.id);
  $('#archPartial').onclick = () => startPartialDemolition(e.id);
  if ($('#archReset')) $('#archReset').onclick = () => mutate(() => { delete state.architecture.overrides[e.id]; state.demolished = state.demolished.filter(id => id !== e.id); });
}
function removeArchitecture(id){
  const e = getArchitecture(id); if (!e || e.hidden) return;
  if (e.source === 'added') { ui.sel = null; mutate(() => {rememberRemovedFloor(e);state.architecture.added = state.architecture.added.filter(item => item.id !== id);}); return; }
  if (id.startsWith('w')) return toggleWall(id);
  mutate(() => state.architecture.overrides[id] = {...state.architecture.overrides[id],hidden:true});
}
function isConstructionTool(){return ['addwall','addglass','adddoor'].includes(ui.tool);}
function addConstructionSegment(a,b){return ui.tool==='adddoor'?addDoorSegment(a,b):addArchitectureSegment(a,b);}
function sameArchitectureSpan(rect, exceptId){
  const span = r => {
    const hz = r[2]-r[0] >= r[3]-r[1];
    return hz ? [1,r[0],r[2],(r[1]+r[3])/2] : [0,r[1],r[3],(r[0]+r[2])/2];
  };
  const a = span(rect);
  return architectureEntries().some(e => e.id !== exceptId && span(e.rect).every((v,i) => Math.abs(v-a[i]) < (i === 0 ? .1 : 1)));
}
function constructionPoint(p){
  const q = {x:Math.round(p.x/10)*10,y:Math.round(p.y/10)*10};
  // Prefer the closest centreline as well as faces, so redrawing a glass pane
  // does not snap to its face and accidentally create a parallel duplicate.
  if (ui.layers.wallSnap){
    let dx = 8/view.s, dy = dx;
    for (const r of snapRects()){
      for (const x of [(r[0]+r[2])/2,r[0],r[2]]) if (Math.abs(x-p.x) < dx){dx=Math.abs(x-p.x);q.x=x;}
      for (const y of [(r[1]+r[3])/2,r[1],r[3]]) if (Math.abs(y-p.y) < dy){dy=Math.abs(y-p.y);q.y=y;}
    }
  }
  if (ui.dA){ if (Math.abs(q.x-ui.dA.x) >= Math.abs(q.y-ui.dA.y)) q.y = ui.dA.y; else q.x = ui.dA.x; }
  return q;
}
function addArchitectureSegment(a,b){
  const settings = readArchitectureFields(ui.archDraft.type); if (!settings) return false;
  ui.archDraft = settings;
  const t = settings.thickness;
  const length = Math.hypot(b.x-a.x,b.y-a.y);
  if (length < 100 || length <= architectureFootprintThickness(settings)) { toast(tr('墙段长度至少 100 mm，且必须大于构件厚度','Use a segment at least 100 mm long, greater than the piece thickness')); return false; }
  const rect = a.y === b.y ? [Math.min(a.x,b.x),(a.y+b.y-t)/2,Math.max(a.x,b.x),(a.y+b.y+t)/2] : [(a.x+b.x-t)/2,Math.min(a.y,b.y),(a.x+b.x+t)/2,Math.max(a.y,b.y)];
  if (!validArchRect(rect)) return false;
  if (sameArchitectureSpan(rect)) { toast(tr('这里已有重合墙段，请选中它修改类型。','A coincident segment already exists; select it to change its type.')); return false; }
  mutate(() => state.architecture.added.push({...settings,id:'a'+uid(),rect}));
  toast(tr('已添加，可继续绘制或点击“结束绘制”','Added. Continue drawing or choose Finish drawing.')); return true;
}
function constructionPreview(){
  if (!ui.dA || !ui.dCur) return '';
  const a = ui.dA, b = ui.dCur, length = Math.hypot(b.x-a.x,b.y-a.y), door=ui.tool==='adddoor', col = door?'#8b7f6e':ui.archDraft.type === 'glass' ? '#4f7394' : '#b5653a';
  return `<g pointer-events="none"><line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${col}" stroke-width="${Math.max(door?120:architectureFootprintThickness(ui.archDraft),2/view.s)}" opacity=".6"/>
    <circle cx="${a.x}" cy="${a.y}" r="${4/view.s}" fill="${col}"/>
    <text x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-12/view.s}" font-size="${12/view.s}" text-anchor="middle" fill="${col}" stroke="#fff" stroke-width="${3/view.s}" paint-order="stroke">${Math.round(length)} mm</text></g>`;
}
