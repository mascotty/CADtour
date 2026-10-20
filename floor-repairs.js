/* Demolished footprints become editable floors without changing CAD rooms. */
function normalizeFloorRepairs(value){
  const clean=input=>{
    const out={};
    if(typeof input?.source==='string'&&/^(room|zone):[\w-]+$/.test(input.source))out.source=input.source;
    if(Object.hasOwn(MATS,input?.mat||''))out.mat=input.mat;
    if(/^#[\da-f]{6}$/i.test(input?.color||''))out.color=input.color;
    return out;
  };
  const overrides={};
  for(const [id,item] of Object.entries(value?.overrides||{}))if(/^rp[\w-]+$/.test(id))overrides[id]=clean(item);
  const seen=new Set(),removed=(Array.isArray(value?.removed)?value.removed:[]).flatMap(item=>{
    const poly=item?.poly;
    if(!/^rp[\w-]+$/.test(item?.id||'')||seen.has(item.id)||!Array.isArray(poly)||poly.length<3||poly.length>128||poly.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v)||Math.abs(v)>1e7))||floorRingArea(poly)<.01)return [];
    seen.add(item.id);return [{id:item.id,poly:poly.map(p=>p.slice())}];
  });
  return {overrides,removed};
}
function floorFootprint(e){
  const r=e.rect;return e.oriented?.poly||[[r[0],r[1]],[r[2],r[1]],[r[2],r[3]],[r[0],r[3]]];
}
function rememberRemovedFloor(e,removed=e){
  // Hidden CAD roots already provide a stable, backwards-compatible footprint.
  if(e.source==='cad')return;
  const root=/^[wg]\d+$/.test(e.originId||'')&&getArchitecture(e.originId);
  if(root?.hidden&&!polygonClipping.difference([floorFootprint(removed)],[floorFootprint(root)]).length)return;
  state.floorRepairs.removed.push({id:'rp'+uid(),poly:floorFootprint(removed).map(p=>p.slice())});
}
function floorPolygonsTouch(a,b,tolerance=2,overlap=true){
  const distance=(p,a,b)=>{
    const dx=b[0]-a[0],dy=b[1]-a[1],n=dx*dx+dy*dy,t=n?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/n)):0;
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
  };
  const ba=bbox(a),bb=bbox(b);
  if(ba[2]+tolerance<bb[0]||bb[2]+tolerance<ba[0]||ba[3]+tolerance<bb[1]||bb[3]+tolerance<ba[1])return false;
  if(overlap&&polygonClipping.intersection([a],[b]).length)return true;
  for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)if(distance(a[i],b[j],b[(j+1)%b.length])<=tolerance||distance(b[j],a[i],a[(i+1)%a.length])<=tolerance)return true;
  return false;
}
function narrowFloorPocket(ring){
  if(floorRingArea(ring)>3e6)return false;
  // Measure across the pocket, including diagonal CAD wall faces.
  const b=bbox(ring);if(Math.min(b[2]-b[0],b[3]-b[1])<=600)return true;
  for(let i=0;i<ring.length;i++){
    const a=ring[i],c=ring[(i+1)%ring.length],dx=c[0]-a[0],dy=c[1]-a[1],length=Math.hypot(dx,dy);
    if(length<.01)continue;
    const projections=ring.map(p=>(-dy*(p[0]-a[0])+dx*(p[1]-a[1]))/length);
    if(Math.max(...projections)-Math.min(...projections)<=600)return true;
  }
  return false;
}
function floorRepairRegions(baseRegions,allowed){
  const entries=architectureEntries(true),active=entries.filter(e=>!e.hidden),definitions=[];
  const rootEntries=entries.filter(e=>e.source==='cad');
  for(const root of rootEntries.filter(e=>e.hidden)){
    let poly=[[floorFootprint(root)]];
    const fragments=active.filter(e=>e.originId===root.id).map(e=>[floorFootprint(e)]);
    if(fragments.length)poly=polygonClipping.difference(poly,...fragments);
    if(poly.length)definitions.push({id:'rp'+root.id,poly});
  }
  definitions.push(...(state.floorRepairs?.removed||[]).map(e=>({id:e.id,poly:[[e.poly]]})));
  if(!definitions.length)return [];
  const originalDoors=originalDoorEntries().map(e=>[floorFootprint(e)]);
  // A narrow CAD pocket can remain white beside a deleted wall (the supplied
  // drawing has a 4090 x 390 mm pocket). Only closed pockets up to 600 mm wide
  // and 3 m² are eligible, and only when directly opened by this demolition.
  const original=[...ROOMS.filter(r=>r.counted!==false).map(roomFloorPolygon),...rootEntries.map(e=>[floorFootprint(e)]),...originalDoors];
  const originalUnion=original.length?polygonClipping.union(...original):[];
  const pockets=originalUnion.flatMap(p=>p.slice(1)).filter(narrowFloorPocket);
  const blockers=[...active.map(e=>[floorFootprint(e)]),...doorEntries().filter(e=>!e.inactive&&(!e.hidden||e.closed)).map(e=>[floorFootprint(e)]),...ROOMS.filter(r=>r.counted===false).map(roomFloorPolygon)];
  let occupied=allowed;
  const repairs=[];
  for(const definition of definitions){
    const extra=pockets.filter(p=>definition.poly.some(part=>floorPolygonsTouch(part[0],p)));
    let poly=extra.length?polygonClipping.union(definition.poly,...extra.map(p=>[p])):definition.poly;
    if(occupied.length||blockers.length)poly=polygonClipping.difference(poly,...(occupied.length?[occupied]:[]),...blockers);
    if(!poly.length||floorMultiArea(poly)<1e-8)continue;
    const candidates=baseRegions.filter(r=>r.poly.some(p=>poly.some(q=>polygonClipping.intersection([p],[q]).length||p.some(a=>q.some(b=>floorPolygonsTouch(a,b,2,false)))))).map(r=>({source:r.kind+':'+r.id,name:r.name||roomState(ROOMS.find(room=>room.id===r.id)).name,mat:r.mat,color:r.color||null}));
    if(!candidates.length)continue;
    const settings=state.floorRepairs?.overrides[definition.id]||{},source=candidates.find(c=>c.source===settings.source)||candidates[0];
    const repair={id:definition.id,kind:'repair',name:tr('拆墙补地面','Restored floor'),poly,candidates,source:source.source,mat:settings.mat||source.mat,color:settings.color||source.color,custom:!!(settings.mat||settings.color)};
    repairs.push(repair);occupied=occupied.length?polygonClipping.union(occupied,poly):poly;
  }
  return repairs;
}
function getFloorRepair(id){return floorRenderRegions().repairs.find(r=>r.id===id);}
function floorRepairPanel(repair){
  return `<section><h3>${tr('拆墙补地面','Restored floor')}</h3>
    <p>${tr('这是拆除构件后自动补齐的地面。原有房间边界和地面分区保持不变。','This floor fills the demolished footprint. Existing rooms and zones retain their boundaries.')}</p>
    <label>${tr('沿用哪侧地面','Inherit adjacent floor')}<select id="repairSource">${repair.candidates.map(c=>`<option value="${c.source}" ${c.source===repair.source?'selected':''}>${esc(c.name)} · ${nm(MATS[c.mat].name)}</option>`).join('')}</select></label>
    <div class="fields"><label>${tr('地面材质','Material')}<select id="repairMat">${Object.entries(MATS).map(([id,m])=>`<option value="${id}" ${id===repair.mat?'selected':''}>${nm(m.name)}</option>`).join('')}</select></label>
    <label>${tr('自定义颜色','Custom colour')}<input type="color" id="repairColor" value="${repair.color||MATS[repair.mat].sw}"></label></div>
    <p>${tr('补齐面积','Restored area')}：${fmt(floorMultiArea(repair.poly))} m²</p>
    <div class="actions"><button class="btn primary" id="repairApply">${tr('应用自定义材质','Apply custom style')}</button><button class="btn" id="repairInherit">${tr('跟随相邻地面','Follow adjacent floor')}</button><button class="btn" id="repairDone">${tr('完成','Done')}</button></div></section>`;
}
function bindFloorRepairPanel(repair){
  const inherit=()=>mutate(()=>{state.floorRepairs.overrides[repair.id]={source:$('#repairSource').value};});
  $('#repairSource').onchange=inherit;
  $('#repairInherit').onclick=inherit;
  $('#repairMat').onchange=()=>{$('#repairColor').value=MATS[$('#repairMat').value].sw;};
  $('#repairApply').onclick=()=>mutate(()=>{state.floorRepairs.overrides[repair.id]={source:$('#repairSource').value,mat:$('#repairMat').value,color:$('#repairColor').value};});
  $('#repairDone').onclick=()=>select(null);
}
function floorRepairsOverview(){
  const repairs=floorRenderRegions().repairs;
  return repairs.length?`<section><h3>${tr('拆墙补地面','Restored floors')}</h3><table>${repairs.map(r=>`<tr class="click" data-floor-repair="${r.id}"><td><span class="sw" style="background:${r.color||MATS[r.mat].sw}"></span>${esc(r.candidates.find(c=>c.source===r.source)?.name||r.name)}</td><td>${fmt(floorMultiArea(r.poly))} m²</td></tr>`).join('')}</table></section>`:'';
}
