/* Partial removal creates independently editable pieces; source CAD stays intact. */
function architectureLine(e){
  if(e.oriented)return e.oriented.line;
  const [x0,y0,x1,y1]=e.rect;
  return e.horizontal?[[x0,(y0+y1)/2],[x1,(y0+y1)/2]]:[[(x0+x1)/2,y0],[(x0+x1)/2,y1]];
}
function architectureLineLength(e){const [a,b]=architectureLine(e);return Math.hypot(b[0]-a[0],b[1]-a[1]);}
function partialRemovalAllowed(e){return !!e&&!e.hidden;}
function projectArchitecturePoint(e,p){
  const [a,b]=architectureLine(e),dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
  let distance=((p.x-a[0])*dx+(p.y-a[1])*dy)/length;
  distance=Math.max(0,Math.min(length,Math.round(distance/10)*10));
  // Snap to endpoints and intersecting walls without allowing off-axis points.
  let best=8/view.s;
  const candidates=[0,length];
  for(const other of architectureEntries()){
    if(other.id===e.id)continue;
    const [c,d]=architectureLine(other),ox=d[0]-c[0],oy=d[1]-c[1],cross=dx*oy-dy*ox;
    if(Math.abs(cross)<.001)continue;
    const u=((c[0]-a[0])*oy-(c[1]-a[1])*ox)/cross,v=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/cross;
    if(u>=0&&u<=1&&v>=-.01&&v<=1.01)candidates.push(u*length);
  }
  for(const value of candidates)if(Math.abs(value-distance)<best){best=Math.abs(value-distance);distance=value;}
  return {x:a[0]+dx*distance/length,y:a[1]+dy*distance/length,distance};
}
function architectureSlice(e,start,end){
  const [a,b]=architectureLine(e),length=architectureLineLength(e),at=t=>[a[0]+(b[0]-a[0])*t/length,a[1]+(b[1]-a[1])*t/length],p=at(start),q=at(end),t=architectureFootprintThickness(e);
  if(e.oriented){const r=cadOrientedRect({x1:p[0],y1:p[1],x2:q[0],y2:q[1]},t,e.structural);return {rect:r.slice(0,4),oriented:r[5]};}
  return {rect:e.horizontal?[p[0],p[1]-t/2,q[0],q[1]+t/2]:[p[0]-t/2,p[1],q[0]+t/2,q[1]]};
}
async function startPartialDemolition(id){
  const e=getArchitecture(id);if(!partialRemovalAllowed(e))return toast(tr('此构件已不存在，请重新选择。','This piece is no longer available; select another.'));
  if(is3D())await setView('2d');
  select({kind:'arch',id});setTool('partialdemolish');closeDrawers();
}
function partialDemolitionPanel(){
  const e=getArchitecture(ui.partialTarget),a=ui.partialA,b=ui.partialB,length=a&&b?Math.abs(a.distance-b.distance):0;
  return `<section><h3>${tr('局部拆除','Remove part')}</h3><p>${e?architectureLabel(e.type):tr('请先点击要拆除的墙体或玻璃。','Choose a wall or glass piece first.')}</p>
    <p>${tr('在构件上点击起点和终点，或拖动选取范围。只拆除标红部分，两侧保留，可分别选择修改。','Click two points or drag along the piece. Only the red span is removed; the remaining pieces can be edited separately.')}</p>
    <p>${tr('选取长度','Selected length')}：<b id="partialLength">${Math.round(length)} mm</b></p>
    <p>${tr('至少选择 100 mm。拆除会同步清除该段边框、踢脚线和碰撞；范围内的门会一并拆除。','Select at least 100 mm. Frames, skirting, collisions and intersecting doors are removed together.')}</p>
    <div class="actions"><button class="btn danger" id="partialApply" ${length<100?'disabled':''}>${tr('拆除选中部分','Remove selected part')}</button>
    <button class="btn" id="partialChoose">${tr('重新选择构件','Choose another piece')}</button><button class="btn" id="partialCancel">${tr('取消','Cancel')}</button></div></section>`;
}
function bindPartialDemolition(){
  $('#partialApply').onclick=applyPartialDemolition;
  $('#partialChoose').onclick=()=>{ui.partialTarget=null;ui.partialA=ui.partialB=ui.partialCur=null;ui.sel=null;renderMeasure();renderSel();renderPanel();};
  $('#partialCancel').onclick=()=>{setTool('select');select(null);};
}
function partialDemolitionDown(p,event){
  let e=getArchitecture(ui.partialTarget);
  if(!partialRemovalAllowed(e)){
    e=getArchitecture(event.target.closest('[data-arch]')?.dataset.arch);
    if(!e)return;
    if(!partialRemovalAllowed(e))return;
    ui.partialTarget=e.id;ui.sel={kind:'arch',id:e.id};
  }
  const q=projectArchitecturePoint(e,p);
  if(!ui.partialA||ui.partialB){
    ui.partialA=q;ui.partialB=null;ui.partialCur=q;
    drag={kind:'partialdemolish',sx:event.clientX,sy:event.clientY,moved:false};svg.setPointerCapture(event.pointerId);
  }else{ui.partialB=q;ui.partialCur=null;}
  renderMeasure();renderSel();renderPanel();
  if(ui.partialB)drawer('panel',true);
}
function partialDemolitionPreview(){
  if(ui.tool!=='partialdemolish'||!ui.partialA)return '';
  const e=getArchitecture(ui.partialTarget),a=ui.partialA,b=ui.partialB||ui.partialCur||a;if(!e)return '';
  const t=Math.max(architectureFootprintThickness(e),4/view.s);
  return `<g pointer-events="none"><line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#d64b35" stroke-width="${t}" opacity=".75"/>
    <circle cx="${a.x}" cy="${a.y}" r="${4/view.s}" fill="#d64b35"/><circle cx="${b.x}" cy="${b.y}" r="${4/view.s}" fill="#d64b35"/>
    <text x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-14/view.s}" font-size="${12/view.s}" text-anchor="middle" fill="#b52b1b" stroke="#fff" stroke-width="${3/view.s}" paint-order="stroke">${Math.round(Math.abs(a.distance-b.distance))} mm</text></g>`;
}
function applyPartialDemolition(){
  const e=getArchitecture(ui.partialTarget),a=ui.partialA,b=ui.partialB;
  if(!partialRemovalAllowed(e)||!a||!b)return false;
  const length=architectureLineLength(e),start=Math.max(0,Math.min(a.distance,b.distance)),end=Math.min(length,Math.max(a.distance,b.distance));
  if(!Number.isFinite(start)||!Number.isFinite(end))return false;
  if(end-start<100-.001){toast(tr('局部拆除长度至少为 100 mm。','Select at least 100 mm.'));return false;}
  const kept=[[0,start],[end,length]].filter(([s,t])=>t-s>.01).map(([s,t])=>{
    const fragment={id:'a'+uid(),originId:e.originId||e.id,type:e.type,horizontal:e.horizontal,...architectureSlice(e,s,t)};
    for(const key of ['height','thickness','sill','baseHeight','topWallHeight','wallThickness','color','frameColor','wallColor','structural','wallFinish','wallTextureSize','wallNormalStrength','skirtingHeight','skirtingColor'])if(e[key]!==undefined)fragment[key]=e[key];
    return fragment;
  });
  const removed=architectureSlice(e,start,end),beforeDoors=doorEntries().map(d=>({...d}));
  const overlap=(d,p)=>{
    const r=d.rect,q=p.rect;if(Math.min(r[2],q[2])<=Math.max(r[0],q[0])||Math.min(r[3],q[3])<=Math.max(r[1],q[1]))return false;
    if(!p.oriented)return true;
    return polygonClipping.intersection([[[r[0],r[1]],[r[2],r[1]],[r[2],r[3]],[r[0],r[3]]]],[p.oriented.poly]).length>0;
  };
  ui.sel=null;ui.partialTarget=null;ui.partialA=ui.partialB=ui.partialCur=null;
  mutate(()=>{
    rememberRemovedFloor(e,removed);
    if(e.source==='added')state.architecture.added=state.architecture.added.filter(p=>p.id!==e.id);
    else state.architecture.overrides[e.id]={...state.architecture.overrides[e.id],hidden:true,split:true};
    state.architecture.added.push(...kept);
    rehostWallDecor(e,kept);
    for(const d of beforeDoors){
      const patch={};
      if(!d.inactive&&overlap(d,removed))Object.assign(patch,{hidden:true,closed:false,removedHostIds:kept.filter(p=>overlap(d,p)).map(p=>p.id)});
      else if(d.hostId===e.id){const host=kept.find(p=>overlap(d,p));if(host)patch.hostId=host.id;else Object.assign(patch,{hidden:true,closed:false});}
      if(d.removalHostIds?.includes(e.id)&&!patch.removedHostIds)patch.removedHostIds=[...d.removalHostIds.filter(id=>id!==e.id),...kept.filter(p=>overlap(d,p)).map(p=>p.id)];
      if(!Object.keys(patch).length)continue;
      if(d.source==='added')Object.assign(state.doorEdits.added.find(p=>p.id===d.id),patch);
      else state.doorEdits.overrides[d.id]={...state.doorEdits.overrides[d.id],...patch};
    }
  });
  setTool('select');closeDrawers();toast(tr('选中部分已拆除，两侧可分别编辑；可撤销恢复。','Selected part removed. Edit the remaining pieces separately; Undo restores.'));return true;
}
