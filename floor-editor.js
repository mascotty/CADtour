/* User-painted floor zones are independent of CAD rooms. All visible surfaces
   are clipped once into disjoint polygons shared by SVG, Three.js and Cycles. */
function floorRingArea(ring){
  return Math.abs(ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
}
function floorMultiArea(multi){return multi.reduce((sum,polygon)=>sum+floorRingArea(polygon[0])-polygon.slice(1).reduce((a,ring)=>a+floorRingArea(ring),0),0)/1e6;}
function roomFloorPolygon(room){return [room.poly,...(room.holes||[])];}
function roomArea(room){return floorMultiArea([roomFloorPolygon(room)]);}
function simpleFloorPolygon(poly){
  if (!Array.isArray(poly) || poly.length<3 || poly.length>128 || poly.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e7))) return false;
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const on=(a,b,p)=>Math.abs(cross(a,b,p))<1e-7&&p[0]>=Math.min(a[0],b[0])-1e-7&&p[0]<=Math.max(a[0],b[0])+1e-7&&p[1]>=Math.min(a[1],b[1])-1e-7&&p[1]<=Math.max(a[1],b[1])+1e-7;
  const meets=(a,b,c,d)=>{const x=cross(a,b,c),y=cross(a,b,d),u=cross(c,d,a),v=cross(c,d,b);return (x*y<0&&u*v<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);};
  for(let i=0;i<poly.length;i++){
    const a=poly[i],b=poly[(i+1)%poly.length];if(Math.hypot(a[0]-b[0],a[1]-b[1])<1) return false;
    for(let j=i+1;j<poly.length;j++){
      if(j===i+1||(i===0&&j===poly.length-1)) continue;
      if(meets(a,b,poly[j],poly[(j+1)%poly.length])) return false;
    }
  }
  return floorRingArea(poly)>=10000;
}
function normalizeFloorZones(items){
  const seen=new Set();
  return (Array.isArray(items)?items:[]).flatMap(item=>{
    if(!/^z[\w-]+$/.test(item?.id||'')||seen.has(item.id)||!simpleFloorPolygon(item.poly)) return [];
    seen.add(item.id);
    const mat=Object.hasOwn(MATS,item.mat)?item.mat:'solid';
    const rectangular=item.poly.length===4&&new Set(item.poly.map(p=>p[0])).size===2&&new Set(item.poly.map(p=>p[1])).size===2;
    return [{id:item.id,name:String(item.name||'地面分区').slice(0,80),shape:item.shape==='rect'&&rectangular?'rect':'poly',poly:item.poly.map(p=>p.slice()),scope:item.scope==='drawn'?'drawn':'existing',mat,color:/^#[\da-f]{6}$/i.test(item.color||'')?item.color:MATS[mat].sw}];
  });
}
function floorBaseAllowedPolygons(excludeId=null){
  const polygons=[...ROOMS.filter(r=>r.counted!==false&&r.poly.length>=3).map(roomFloorPolygon),
    ...state.floorZones.filter(z=>z.scope==='drawn'&&z.id!==excludeId).map(z=>[z.poly])];
  return polygons.length?polygonClipping.union(...polygons):[];
}
function floorPaintRegions(allowed,excludeId=null){
  const rooms=ROOMS.filter(r=>r.counted!==false&&r.poly.length>=3),regions=[];
  let occupied=[];
  for(const zone of [...state.floorZones].reverse().filter(z=>z.id!==excludeId)){
    const clipped=allowed.length?polygonClipping.intersection([zone.poly],allowed):[];
    const visible=occupied.length?polygonClipping.difference(clipped,occupied):clipped;
    if(visible.length)regions.push({id:zone.id,kind:'zone',poly:visible,mat:zone.mat,color:zone.color,name:zone.name});
    if(clipped.length)occupied=occupied.length?polygonClipping.union(occupied,clipped):clipped;
  }
  for(const room of [...rooms].reverse()){
    const polygon=roomFloorPolygon(room),visible=occupied.length?polygonClipping.difference(polygon,occupied):[polygon];
    const st=roomState(room),mat=Object.hasOwn(MATS,st.mat)?st.mat:'tile800';
    if(visible.length)regions.push({id:room.id,kind:'room',poly:visible,mat,color:st.color||null,name:st.name});
    occupied=occupied.length?polygonClipping.union(occupied,polygon):[polygon];
  }
  return {regions,occupied};
}
function floorAllowedPolygons(excludeId=null){
  if(!excludeId)return floorRenderRegions().allowed;
  const base=floorBaseAllowedPolygons(excludeId),paint=floorPaintRegions(base,excludeId),repairs=floorRepairRegions(paint.regions,base);
  return repairs.length?polygonClipping.union(...(base.length?[base]:[]),...repairs.map(r=>r.poly)):base;
}
let floorGeometryCache={key:null,regions:[],allowed:[],repairs:[],addedArea:0};
function floorRenderRegions(){
  const key=JSON.stringify([ROOMS.map(r=>[r.id,r.poly,r.holes,r.counted]),state.rooms,state.floorZones,state.floorRepairs,state.architecture,state.demolished,state.doorEdits]);
  if(key===floorGeometryCache.key)return floorGeometryCache;
  const base=floorBaseAllowedPolygons(),basePaint=floorPaintRegions(base),repairs=floorRepairRegions(basePaint.regions,base);
  const allowed=repairs.length?polygonClipping.union(...(base.length?[base]:[]),...repairs.map(r=>r.poly)):base;
  const {regions,occupied}=floorPaintRegions(allowed);
  for(const repair of repairs){const visible=occupied.length?polygonClipping.difference(repair.poly,occupied):repair.poly;if(visible.length)regions.push({...repair,poly:visible});}
  const rooms=ROOMS.filter(r=>r.counted!==false&&r.poly.length>=3),cadFloor=rooms.length?polygonClipping.union(...rooms.map(roomFloorPolygon)):[];
  const addedArea=floorMultiArea(cadFloor.length?polygonClipping.difference(allowed,cadFloor):allowed);
  floorGeometryCache={key,regions:regions.reverse(),allowed,repairs,addedArea};return floorGeometryCache;
}
function floorRepairSelection(repair){
  const [kind,id]=(repair?.source||'').split(':');
  return kind==='room'&&ROOMS.some(r=>r.id===id)?{kind:'room',id}:kind==='zone'&&getFloorZone(id)?{kind:'floorzone',id}:null;
}
let floorDisplayCache={geometry:null,regions:[]};
function floorDisplayRegions(){
  const geometry=floorRenderRegions();if(floorDisplayCache.geometry===geometry)return floorDisplayCache.regions;
  const groups=new Map();
  for(const region of geometry.regions){
    const owner=region.kind==='repair'?floorRepairSelection(region):null;
    const r=owner?{...region,kind:owner.kind==='floorzone'?'zone':'room',id:owner.id}:region;
    const key=JSON.stringify([r.kind,r.id,r.mat,r.color||null]),previous=groups.get(key);
    if(previous)previous.poly=polygonClipping.union(previous.poly,r.poly);
    else groups.set(key,{...r});
  }
  const regions=[...groups.values()];floorDisplayCache={geometry,regions};return regions;
}
function floorZoneArea(id){return floorMultiArea(floorRenderRegions().regions.find(r=>r.kind==='zone'&&r.id===id)?.poly||[]);}
function floorMaterialAreas(){
  const result={};for(const r of floorRenderRegions().regions) result[r.mat]=(result[r.mat]||0)+floorMultiArea(r.poly);
  for(const r of ROOMS.filter(r=>r.counted===false)){const mat=roomState(r).mat;result[mat]=(result[mat]||0)+area(r.poly);}
  return result;
}
function floorSvgPath(multi){return multi.flatMap(poly=>poly.map(ring=>'M'+ring.map(p=>p.join(',')).join('L')+'Z')).join('');}
function floorSvgFill(mat,color){
  if(mat==='solid') return color||MATS.solid.sw;
  if(!color) return `url(#m-${mat})`;
  const id=`floor-${mat}-${color.slice(1)}`;
  if(!document.getElementById(id)){
    const original=document.getElementById('m-'+mat);
    if(!original) return color;
    const pattern=original.cloneNode(true);pattern.id=id;pattern.querySelector('rect')?.setAttribute('fill',color);
    pattern.querySelectorAll('[stroke]').forEach(node=>node.setAttribute('stroke',shade(color,.8)));
    $('#defs').append(pattern);
  }
  return `url(#${id})`;
}
function getFloorZone(id){return state.floorZones.find(zone=>zone.id===id);}
function isFloorTool(){return ui.tool==='floorrect'||ui.tool==='floorpoly';}
function floorPoint(p,shift=false){
  const q={x:Math.round(p.x/10)*10,y:Math.round(p.y/10)*10};
  if(ui.layers.wallSnap){
    let dx=8/view.s,dy=dx;
    const xs=ROOMS.flatMap(r=>r.poly.map(p=>p[0])),ys=ROOMS.flatMap(r=>r.poly.map(p=>p[1]));
    for(const r of snapRects()){xs.push(r[0],r[2]);ys.push(r[1],r[3]);}
    for(const x of xs) if(Math.abs(x-p.x)<dx){dx=Math.abs(x-p.x);q.x=x;}
    for(const y of ys) if(Math.abs(y-p.y)<dy){dy=Math.abs(y-p.y);q.y=y;}
  }
  const a=ui.floorPoints.at(-1);
  if(shift&&ui.tool==='floorpoly'&&a){if(Math.abs(q.x-a.x)>=Math.abs(q.y-a.y)) q.y=a.y;else q.x=a.x;}
  return q;
}
function floorDraftPolygon(){
  const points=ui.floorPoints;
  if(ui.tool==='floorrect'){
    if(!points.length||!ui.floorCur) return [];
    const a=points[0],b=ui.floorCur,x0=Math.min(a.x,b.x),x1=Math.max(a.x,b.x),y0=Math.min(a.y,b.y),y1=Math.max(a.y,b.y);
    return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  }
  return points.map(p=>[p.x,p.y]);
}
function floorStyleFields(style){return `<div class="fields">
  <label style="grid-column:1/-1">${tr('区域名称','Zone name')}<input id="floorName" maxlength="80" value="${esc(style.name)}"></label>
  <label style="grid-column:1/-1">${tr('铺设范围','Floor boundary')}<select id="floorScope"><option value="drawn" ${style.scope==='drawn'?'selected':''}>${tr('按绘制边界铺地（可补漏识别）','Use drawn boundary (fill missing floors)')}</option><option value="existing" ${style.scope!=='drawn'?'selected':''}>${tr('只在已有地面内换材质','Apply only within existing floors')}</option></select></label>
  <label>${tr('地面材质','Material')}<select id="floorMat">${Object.entries(MATS).map(([id,m])=>`<option value="${id}" ${id===style.mat?'selected':''}>${nm(m.name)}</option>`).join('')}</select></label>
  <label>${tr('自定义颜色','Custom colour')}<input id="floorColor" type="color" value="${style.color}"></label></div>`;}
function readFloorStyle(){return {name:$('#floorName').value.trim()||tr('地面分区','Floor zone'),scope:$('#floorScope').value,mat:$('#floorMat').value,color:$('#floorColor').value};}
function bindFloorMaterial(){ $('#floorMat').onchange=()=>{$('#floorColor').value=MATS[$('#floorMat').value].sw;}; }
function floorDrawPanel(){return `<section><h3>${tr('绘制地面分区','Draw floor zone')}</h3>
  <label>${tr('绘制形状','Shape')}<select id="floorShape"><option value="floorrect" ${ui.tool==='floorrect'?'selected':''}>${tr('矩形','Rectangle')}</option><option value="floorpoly" ${ui.tool==='floorpoly'?'selected':''}>${tr('多边形','Polygon')}</option></select></label>
  ${floorStyleFields(ui.floorDraft)}
  <p>${ui.tool==='floorrect'?tr('点击两个对角点，或按住拖动绘制矩形。','Click opposite corners or drag to draw a rectangle.'):tr('依次点击顶点；点击起点、按 Enter 或点“完成此区域”闭合。Backspace 撤回一个顶点。','Click vertices; click the start, press Enter or choose Complete zone to close. Backspace removes the last vertex.')}</p>
  <p class="muted">${tr('“按绘制边界铺地”可在 CAD 漏识别的空白处补地面；“只在已有地面内”会自动裁切。重叠处后创建的区域生效。Esc 取消当前区域。','Use drawn boundary to fill floors missed by CAD detection. Existing-floor mode clips to available floors. Newer zones take priority. Esc cancels the current zone.')}</p>
  <div class="actions"><button class="btn primary" id="floorFinish">${tr('完成此区域','Complete zone')}</button><button class="btn" id="floorStop">${tr('结束绘制','Finish drawing')}</button></div></section>`;}
function bindFloorDrawPanel(){
  bindFloorMaterial();
  $('#floorShape').onchange=()=>{ui.floorDraft=readFloorStyle();setTool($('#floorShape').value);};
  $('#panel').querySelectorAll('input,select').forEach(input=>input.addEventListener('change',()=>{if($('#floorName')) ui.floorDraft=readFloorStyle();}));
  $('#floorFinish').onclick=finishFloorZone;
  $('#floorStop').onclick=()=>setTool('select');
}
function finishFloorZone(){
  const poly=floorDraftPolygon();
  if(!simpleFloorPolygon(poly)){toast(tr('区域至少需要三个顶点，边界不能交叉，面积至少 0.01 m²。','Use at least three vertices, no crossing edges, and an area of at least 0.01 m².'));return false;}
  const style=readFloorStyle(),allowed=floorRenderRegions().allowed;
  if(style.scope==='existing'){
    const clipped=allowed.length?polygonClipping.intersection([poly],allowed):[];
    if(floorMultiArea(clipped)<.01){toast(tr('此处没有已有地面，请切换“按绘制边界铺地”补画地面。','No existing floor here. Choose Use drawn boundary to fill the missing floor.'));return false;}
  }
  const zone={...style,id:'z'+uid(),shape:ui.tool==='floorrect'?'rect':'poly',poly};
  ui.floorPoints=[];ui.floorCur=null;
  mutate(()=>{state.floorZones.push(zone);ui.floorDraft={...style,name:tr(`地面分区 ${state.floorZones.length+1}`,`Floor zone ${state.floorZones.length+1}`)};});
  toast(tr('地面分区已添加，可继续绘制。','Floor zone added; continue drawing.'));return true;
}
function floorPointerDown(p,e){
  const q=floorPoint(p,e.shiftKey);
  if(ui.tool==='floorrect'){
    if(!ui.floorPoints.length){ui.floorPoints=[q];ui.floorCur=q;drag={kind:'floorrect',sx:e.clientX,sy:e.clientY,moved:false};svg.setPointerCapture(e.pointerId);}
    else{ui.floorCur=q;finishFloorZone();}
  }else{
    const first=ui.floorPoints[0],last=ui.floorPoints.at(-1);
    if(first&&ui.floorPoints.length>=3&&Math.hypot(q.x-first.x,q.y-first.y)*view.s<10){finishFloorZone();return;}
    if(!last||Math.hypot(q.x-last.x,q.y-last.y)>1){
      if(ui.floorPoints.length>=128) return toast(tr('最多支持 128 个顶点','Use at most 128 vertices'));
      ui.floorPoints.push(q);
    }
    ui.floorCur=q;
  }
  renderMeasure();
}
function floorPreview(){
  if(!isFloorTool()||!ui.floorPoints.length) return '';
  const poly=ui.tool==='floorrect'?floorDraftPolygon():[...ui.floorPoints.map(p=>[p.x,p.y]),...(ui.floorCur?[[ui.floorCur.x,ui.floorCur.y]]:[])];
  const colour=ui.floorDraft.color;
  return `<g pointer-events="none"><polygon points="${poly.map(p=>p.join(',')).join(' ')}" fill="${colour}" fill-opacity=".35" stroke="#b5653a" stroke-width="1.5" stroke-dasharray="5 3" vector-effect="non-scaling-stroke"/>
    ${ui.floorPoints.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="${4/view.s}" fill="#b5653a"/>`).join('')}</g>`;
}
function floorZonePanel(zone){
  const bounds=bbox(zone.poly);
  return `<section><h3>${tr('地面分区','Floor zone')}</h3>${floorStyleFields(zone)}
    <div class="stats"><div><small>${tr('有效铺设面积','Visible floor area')}</small><span class="big">${fmt(floorZoneArea(zone.id))}</span> m²</div></div>
    ${zone.shape==='rect'?`<div class="fields"><label>${tr('中心 X（mm）','Centre X (mm)')}<input id="floorX" type="number" value="${(bounds[0]+bounds[2])/2}"></label><label>${tr('中心 Y（mm）','Centre Y (mm)')}<input id="floorY" type="number" value="${(bounds[1]+bounds[3])/2}"></label><label>${tr('宽度（mm）','Width (mm)')}<input id="floorW" type="number" min="100" value="${bounds[2]-bounds[0]}"></label><label>${tr('深度（mm）','Depth (mm)')}<input id="floorD" type="number" min="100" value="${bounds[3]-bounds[1]}"></label></div>`:''}
    <p class="muted">${tr('按绘制边界铺地可补上 CAD 漏识别的地面；删除补绘区域后，未识别处会回到空白。移到最上层可覆盖其他分区。','Use drawn boundary to fill floors missed by CAD detection. Deleting a fill leaves unsupported areas empty again. Bring to front to cover other zones.')}</p>
    <div class="actions"><button class="btn primary" id="floorApply">${tr('应用修改','Apply changes')}</button><button class="btn" id="floorFront">${tr('移到最上层','Bring to front')}</button><button class="btn danger" id="floorDelete">${tr('删除区域','Delete zone')}</button><button class="btn" id="floorBack">${tr('完成','Done')}</button></div></section>`;
}
function bindFloorZonePanel(zone){
  bindFloorMaterial();
  $('#floorApply').onclick=()=>{
    const style=readFloorStyle();let poly=zone.poly;
    if(zone.shape==='rect'){
      const x=Number($('#floorX').value),y=Number($('#floorY').value),w=Number($('#floorW').value),d=Number($('#floorD').value);
      poly=[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]];
      if(![x,y,w,d].every(Number.isFinite)||w<100||d<100||!simpleFloorPolygon(poly)) return toast(tr('请检查位置和尺寸，宽深至少 100 mm。','Check position and size; width and depth must be at least 100 mm.'));
    }
    if(style.scope==='existing'){
      const allowed=floorAllowedPolygons(zone.id),clipped=allowed.length?polygonClipping.intersection([poly],allowed):[];
      if(floorMultiArea(clipped)<.01) return toast(tr('此处没有已有地面，请选择“按绘制边界铺地”。','No existing floor here. Choose Use drawn boundary.'));
    }
    mutate(()=>Object.assign(getFloorZone(zone.id),style,{poly}));
  };
  $('#floorFront').onclick=()=>mutate(()=>{state.floorZones=state.floorZones.filter(z=>z.id!==zone.id).concat(getFloorZone(zone.id));});
  $('#floorDelete').onclick=()=>deleteFloorZone(zone.id);
  $('#floorBack').onclick=()=>select(null);
}
function deleteFloorZone(id){ui.sel=null;mutate(()=>state.floorZones=state.floorZones.filter(zone=>zone.id!==id));}
function floorZonesOverview(){return `<section><h3>${tr('手动地面分区','Manual floor zones')}</h3>
  <p>${tr('使用顶部“地面分区”绘制矩形或多边形；CAD 漏识别处可选“按绘制边界铺地”补画。','Use Floor zones to draw rectangles or polygons; choose Use drawn boundary to fill missing floors.')}</p>
  ${floorRenderRegions().addedArea>0?`<p class="muted">${tr('原 CAD 地面范围外已补绘','Added outside the CAD floor boundary')}: ${fmt(floorRenderRegions().addedArea)} m² · ${tr('重叠部分不重复计入','overlaps counted once')}</p>`:''}
  <table>${state.floorZones.map(zone=>`<tr class="click" data-floor-zone="${zone.id}"><td><span class="sw" style="background:${zone.color}"></span>${esc(zone.name)}</td><td class="r">${fmt(floorZoneArea(zone.id))} m²</td></tr>`).join('')||`<tr><td class="muted">${tr('暂无手动分区','No manual zones')}</td></tr>`}</table></section>`;}
