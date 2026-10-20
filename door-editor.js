/* Door edits are independent of the source CAD; openings are shared by 2D/3D. */
function normalizeDoorEdits(value){
  const clean=input=>{
    const out={};
    if(['swing','sliding','opening'].includes(input?.kind))out.kind=input.kind;
    if(['solid','glass'].includes(input?.material))out.material=input.material;
    if(['start','end'].includes(input?.hinge))out.hinge=input.hinge;
    if(['positive','negative'].includes(input?.side))out.side=input.side;
    if(typeof input?.name==='string')out.name=input.name.slice(0,80);
    if(validArchRect(input?.rect))out.rect=input.rect.slice(0,4);
    if(typeof input?.height==='number'&&Number.isFinite(input.height))out.height=Math.max(.5,Math.min(10,input.height));
    for(const key of ['color','frameColor'])if(/^#[\da-f]{6}$/i.test(input?.[key]||''))out[key]=input[key];
    for(const key of ['hidden','closed','open'])if(typeof input?.[key]==='boolean')out[key]=input[key];
    if(Array.isArray(input?.removedHostIds))out.removedHostIds=[...new Set(input.removedHostIds.filter(id=>/^(?:[wg]\d+|a[\w-]+)$/.test(id)))].slice(0,1000);
    if(/^(?:[wg]\d+|a[\w-]+)$/.test(input?.hostId||''))out.hostId=input.hostId;
    return out;
  };
  const overrides={};for(const [id,item] of Object.entries(value?.overrides||{}))if(/^[ds]\d+$/.test(id))overrides[id]=clean(item);
  const seen=new Set(),added=(Array.isArray(value?.added)?value.added:[]).slice(0,500).flatMap(item=>{
    if(!/^nd[\w-]+$/.test(item?.id||'')||seen.has(item.id)||!validArchRect(item.rect))return [];
    seen.add(item.id);return [{...clean(item),id:item.id}];
  });return {overrides,added};
}
let doorGeometryCache={state:null,height:null,entries:null};
function invalidateDoorGeometry(){doorGeometryCache.entries=null;}
function originalDoorEntries(){
  return [...DOORS.map((d,i)=>{
    const hz=d.rect[2]-d.rect[0]>=d.rect[3]-d.rect[1];
    return {id:'d'+i,name:d.name||'平开门',kind:'swing',material:'solid',rect:d.rect.slice(),height:2.1,hinge:d.c[hz?0:1]>=0?'start':'end',side:d.o[hz?1:0]>=0?'positive':'negative',color:d.entry?'#6b4f3a':'#efe6d8',frameColor:'#8b7f6e',open:true,source:'cad'};
  }),...SLIDES.map((d,i)=>({id:'s'+i,name:'推拉门',kind:'sliding',material:'glass',rect:d.rect.slice(),height:d.v?2.4:2.1,hinge:'start',side:'positive',color:'#cfe6ef',frameColor:'#5d6166',open:false,source:'cad'}))];
}
function doorEntries(){
  if(doorGeometryCache.entries&&doorGeometryCache.state===state&&doorGeometryCache.height===state.heights.ceiling)return doorGeometryCache.entries;
  const edits=state.doorEdits||{overrides:{},added:[]},hosts=new Map(architectureEntries(true).map(e=>[e.id,e]));
  const entries=[...originalDoorEntries(),...edits.added.map(d=>({...d,source:'added'}))].map(base=>{
    const e={kind:'swing',material:'solid',hinge:'start',side:'positive',color:'#efe6d8',frameColor:'#8b7f6e',open:false,...base,...edits.overrides[base.id]};
    e.height=Math.min(state.heights.ceiling,e.height||2.1);e.horizontal=e.rect[2]-e.rect[0]>=e.rect[3]-e.rect[1];
    e.width=e.horizontal?e.rect[2]-e.rect[0]:e.rect[3]-e.rect[1];e.thickness=e.horizontal?e.rect[3]-e.rect[1]:e.rect[2]-e.rect[0];
    const host=e.hostId&&hosts.get(e.hostId);
    e.inactive=!!e.hostId&&(!host||host.hidden||Math.min(e.rect[2],host.rect[2])-Math.max(e.rect[0],host.rect[0])<=0||Math.min(e.rect[3],host.rect[3])-Math.max(e.rect[1],host.rect[1])<=0);
    // Some CAD doors overlap a wall/window instead of carrying a host ID.
    // Only a host covering the door's centre counts; adjoining wall ends do not.
    if(!e.hostId&&e.source==='cad'){
      const supports=[...hosts.values()].filter(h=>(h.source==='cad'||h.originId)&&doorHostCoversCentre(e,h));
      if(supports.length&&supports.every(h=>h.hidden))e.inactive=true;
    }
    if(host&&!e.inactive){e.height=Math.min(e.height,host.height);e.thickness=Math.max(e.thickness,architectureFootprintThickness(host));}
    e.hidden=!!e.hidden;e.closed=!!e.closed;
    e.removalHostIds=e.hidden&&!e.closed?doorRemovalHosts(e,true):[];
    const [x0,y0,x1,y1]=e.rect;
    e.h=e.horizontal?[e.hinge==='start'?x0:x1,(y0+y1)/2]:[(x0+x1)/2,e.hinge==='start'?y0:y1];
    e.c=e.horizontal?[e.hinge==='start'?1:-1,0]:[0,e.hinge==='start'?1:-1];
    e.o=e.horizontal?[0,e.side==='positive'?1:-1]:[e.side==='positive'?1:-1,0];
    return e;
  });
  doorGeometryCache={state,height:state.heights.ceiling,entries};return entries;
}
function getDoor(id){return doorEntries().find(e=>e.id===id);}
function doorOpenings(){return doorEntries().filter(e=>!e.closed&&!e.inactive);}
function doorHostCoversCentre(door,host){
  if(host.oriented||(host.horizontal??(host.rect[2]-host.rect[0]>=host.rect[3]-host.rect[1]))!==door.horizontal)return false;
  const axis=door.horizontal?0:1,other=1-axis,r=door.rect,h=host.rect,mid=(r[axis]+r[axis+2])/2,cross=(r[other]+r[other+2])/2;
  return mid>h[axis]&&mid<h[axis+2]&&cross>=h[other]-2&&cross<=h[other+2]+2;
}
function doorRemovalHosts(e,legacy=false){
  if(e.removedHostIds)return e.removedHostIds;
  return architectureEntries().filter(h=>(!legacy||h.source==='cad'||h.originId||h.id===e.hostId)&&!h.oriented&&
    (h.horizontal??(h.rect[2]-h.rect[0]>=h.rect[3]-h.rect[1]))===e.horizontal&&
    Math.min(h.rect[2],e.rect[2])>Math.max(h.rect[0],e.rect[0])&&Math.min(h.rect[3],e.rect[3])>Math.max(h.rect[1],e.rect[1])).map(h=>h.id);
}
function rectDifference(rect,cut){
  const x0=Math.max(rect[0],cut[0]),y0=Math.max(rect[1],cut[1]),x1=Math.min(rect[2],cut[2]),y1=Math.min(rect[3],cut[3]);
  if(x1<=x0||y1<=y0)return [rect];
  return [[rect[0],rect[1],x0,rect[3]],[x1,rect[1],rect[2],rect[3]],[x0,rect[1],x1,y0],[x0,y1,x1,rect[3]]].filter(validArchRect);
}
function doorInfills(){
  const entries=architectureEntries(true),active=entries.filter(e=>!e.hidden),occupied=active.map(e=>e.rect),result=[];
  // A moved CAD door normally fills its old opening. Never refill a span
  // explicitly removed by splitting its source wall/window.
  const removed=[];
  for(const root of entries.filter(e=>e.source==='cad'&&e.hidden&&e.split&&!e.oriented)){
    let gaps=[root.rect];
    for(const piece of active.filter(e=>e.originId===root.id))gaps=gaps.flatMap(r=>rectDifference(r,piece.rect));
    removed.push(...gaps);
  }
  for(const door of originalDoorEntries()){
    const current=getDoor(door.id);
    if(!current||current.inactive||(current.hidden&&!current.closed))continue;
    let remaining=[door.rect];
    for(const r of [...occupied,...removed,...result.map(p=>p.rect)])remaining=remaining.flatMap(piece=>rectDifference(piece,r));
    result.push(...remaining.map(rect=>({id:door.id,rect})));
  }return result;
}
function doorInfillRects(){return doorInfills().map(p=>p.rect);}
function doorSegments(rect,bottom,top,horizontal=rect[2]-rect[0]>=rect[3]-rect[1],architectureId=null){
  if(top-bottom<=.001)return [];
  let pieces=[{rect,bottom,top}];if(typeof buildingOrientedArchitecture!=='undefined'&&buildingOrientedArchitecture)return pieces;
  const axis=horizontal?0:1,other=1-axis;
  for(const door of doorOpenings()){
    if(door.horizontal!==horizontal)continue;
    // A demolished door may leave a passage in its existing host, but must
    // never cut a newly drawn replacement wall or generate its own geometry.
    if(door.hidden&&!door.removalHostIds.includes(architectureId?.replace(/:(?:base|top)$/,'')))continue;
    pieces=pieces.flatMap(piece=>{
      const r=piece.rect,d=door.rect;
      if(d[other+2]<=r[other]||d[other]>=r[other+2]||door.height<=piece.bottom)return [piece];
      const start=Math.max(r[axis],d[axis]),end=Math.min(r[axis+2],d[axis+2]);if(end-start<=.01)return [piece];
      const out=[],left=r.slice(),right=r.slice(),middle=r.slice();left[axis+2]=start;right[axis]=end;middle[axis]=start;middle[axis+2]=end;
      if(validArchRect(left))out.push({...piece,rect:left});if(validArchRect(right))out.push({...piece,rect:right});
      if(piece.top>door.height)out.push({rect:middle,bottom:Math.max(piece.bottom,door.height),top:piece.top});
      return out;
    });
  }return pieces;
}
function doorPlacement(rect,height,exceptId=null){
  const horizontal=rect[2]-rect[0]>=rect[3]-rect[1],axis=horizontal?0:1,other=1-axis,centre=(rect[other]+rect[other+2])/2;
  const outline=[[rect[0],rect[1]],[rect[2],rect[1]],[rect[2],rect[3]],[rect[0],rect[3]]];
  if(architectureEntries().some(e=>e.oriented&&Math.min(rect[2],e.rect[2])>Math.max(rect[0],e.rect[0])&&Math.min(rect[3],e.rect[3])>Math.max(rect[1],e.rect[1])&&polygonClipping.intersection([outline],[e.oriented.poly]).length))
    return {error:tr('斜向构件暂不支持开门洞，请沿水平／垂直构件或在空白处绘制。','Slanted openings are not supported yet; draw along horizontal/vertical pieces or in open space.')};
  const hosts=architectureEntries().filter(e=>!e.oriented&&(e.horizontal??(e.rect[2]-e.rect[0]>=e.rect[3]-e.rect[1]))===horizontal&&centre>=e.rect[other]-2&&centre<=e.rect[other+2]+2&&e.rect[axis+2]>rect[axis]&&e.rect[axis]<rect[axis+2]);
  if(doorOpenings().some(e=>!e.hidden&&e.id!==exceptId&&Math.min(e.rect[2],rect[2])-Math.max(e.rect[0],rect[0])>1&&Math.min(e.rect[3],rect[3])-Math.max(e.rect[1],rect[1])>1))return {error:tr('这里已有门洞，请选择已有门修改。','An opening already exists here; edit that door.')};
  const supports=[...hosts.map(e=>e.rect),...originalDoorEntries().filter(e=>(e.horizontal??(e.rect[2]-e.rect[0]>=e.rect[3]-e.rect[1]))===horizontal&&centre>=e.rect[other]-2&&centre<=e.rect[other+2]+2).map(e=>e.rect)];
  let covered=rect[axis];for(const interval of supports.map(r=>[r[axis],r[axis+2]]).sort((a,b)=>a[0]-b[0])){if(interval[0]>covered+2)break;if(interval[1]>covered)covered=interval[1];}
  if(hosts.some(e=>e.height<height-.001))return {error:tr('门高不能超过所在墙体或玻璃隔断的高度。','Door height cannot exceed the host wall or partition.')};
  const host=hosts.find(e=>e.rect[axis]<= (rect[axis]+rect[axis+2])/2&&e.rect[axis+2]>= (rect[axis]+rect[axis+2])/2)||hosts[0];
  // A freely drawn door needs no host. Associate it only when the entire
  // span is supported, retaining the existing host-removal behaviour there.
  return {hostId:covered>=rect[axis+2]-2?host?.id:undefined};
}
function doorFields(e,position=false){
  const r=e.rect||[0,0,e.width||900,e.thickness||120],horizontal=e.horizontal??(r[2]-r[0]>=r[3]-r[1]);
  return `<div class="fields">
    <label style="grid-column:1/-1">${tr('门名称','Door name')}<input id="doorName" maxlength="80" value="${esc(e.name||'门')}"></label>
    <label>${tr('门类型','Door type')}<select id="doorKind">${[['swing','平开门','Swing door'],['sliding','推拉门','Sliding door'],['opening','仅门洞','Opening only']].map(([v,zh,en])=>`<option value="${v}" ${e.kind===v?'selected':''}>${tr(zh,en)}</option>`).join('')}</select></label>
    <label>${tr('门板材质','Door panel')}<select id="doorMaterial"><option value="solid" ${e.material!=='glass'?'selected':''}>${tr('实心门板','Solid panel')}</option><option value="glass" ${e.material==='glass'?'selected':''}>${tr('玻璃门板','Glass panel')}</option></select></label>
    <label>${tr('洞口宽度（mm）','Opening width (mm)')}<input id="doorWidth" type="number" min="300" max="8000" step="10" value="${e.width||Math.max(r[2]-r[0],r[3]-r[1])}"></label>
    <label>${tr('门高（m）','Door height (m)')}<input id="doorHeight" type="number" min="0.5" max="${state.heights.ceiling}" step="0.1" value="${e.height}"></label>
    <label>${tr('门板颜色','Panel colour')}<input id="doorColor" type="color" value="${e.color}"></label>
    <label>${tr('门框颜色','Frame colour')}<input id="doorFrameColor" type="color" value="${e.frameColor}"></label>
    <label>${tr('铰链位置','Hinge')}<select id="doorHinge"><option value="start" ${e.hinge!=='end'?'selected':''}>${tr('起点侧（左／上）','Start (left / top)')}</option><option value="end" ${e.hinge==='end'?'selected':''}>${tr('终点侧（右／下）','End (right / bottom)')}</option></select></label>
    <label>${tr('打开方向','Opening direction')}<select id="doorSide"><option value="positive" ${e.side!=='negative'?'selected':''}>${tr('下侧／右侧','Bottom / right')}</option><option value="negative" ${e.side==='negative'?'selected':''}>${tr('上侧／左侧','Top / left')}</option></select></label>
    <label style="grid-column:1/-1"><input id="doorOpen" type="checkbox" ${e.open?'checked':''}> ${tr('初始打开','Initially open')}</label>
    ${position?`<label>${tr('中心 X（mm）','Centre X (mm)')}<input id="doorX" type="number" step="10" value="${(r[0]+r[2])/2}"></label><label>${tr('中心 Y（mm）','Centre Y (mm)')}<input id="doorY" type="number" step="10" value="${(r[1]+r[3])/2}"></label><label>${tr('门洞朝向','Orientation')}<select id="doorOrientation"><option value="horizontal" ${horizontal?'selected':''}>${tr('水平','Horizontal')}</option><option value="vertical" ${!horizontal?'selected':''}>${tr('垂直','Vertical')}</option></select></label>`:''}
  </div>`;
}
function readDoorFields(drawnWidth){
  const width=drawnWidth??Number($('#doorWidth').value),height=Number($('#doorHeight').value);
  if(!Number.isFinite(width)||width<300||width>8000||!Number.isFinite(height)||height<.5||height>state.heights.ceiling){toast(tr('请检查门宽和门高，门不能超过层高。','Check opening width and height; height cannot exceed the ceiling.'));return null;}
  return {name:$('#doorName').value.trim()||'门',kind:$('#doorKind').value,material:$('#doorMaterial').value,width,height,hinge:$('#doorHinge').value,side:$('#doorSide').value,color:$('#doorColor').value,frameColor:$('#doorFrameColor').value,open:$('#doorOpen').checked};
}
function doorAddPanel(){return `<section><h3>${tr('新增门','Add door')}</h3>${doorFields(ui.doorDraft)}<p>${tr('点击起点、终点或按住拖动绘制门，线段长度就是门宽，自动保持水平或垂直。可在空白处绘制；与墙体或玻璃隔断重合时自动开洞。Esc 或右键取消当前线段，添加后可在属性中精确调整门宽。','Click two points or drag to draw a door. The horizontal or vertical line sets its width. Draw in open space or across a wall/glass partition to create an opening. Esc or right-click cancels; edit exact dimensions afterward.')}</p><div class="actions"><button class="btn primary" id="doorDraw">${tr('开始绘制','Start drawing')}</button><button class="btn" id="doorDone">${tr('结束绘制','Finish drawing')}</button></div></section>`;}
function bindDoorAdd(){
  $('#panel').querySelectorAll('input,select').forEach(input=>input.addEventListener('change',()=>{const fields=readDoorFields();if(fields)ui.doorDraft=fields;}));
  $('#doorDraw').onclick=()=>closeDrawers();
  $('#doorDone').onclick=()=>{setTool('select');closeDrawers();};
}
function addDoorSegment(a,b){
  const length=Math.round(Math.hypot(b.x-a.x,b.y-a.y));
  const settings=readDoorFields(length);if(!settings)return false;
  const horizontal=a.y===b.y,centre=horizontal?(a.x+b.x)/2:(a.y+b.y)/2,mid=horizontal?a.y:a.x;
  const rectFor=t=>horizontal?[centre-length/2,mid-t/2,centre+length/2,mid+t/2]:[mid-t/2,centre-length/2,mid+t/2,centre+length/2];
  const initial=rectFor(120),placement=doorPlacement(initial,settings.height);if(placement.error){toast(placement.error);return false;}
  const host=placement.hostId&&getArchitecture(placement.hostId);
  const rect=rectFor(host?Math.max(60,architectureFootprintThickness(host)+4):120);
  ui.doorDraft=settings;
  const id='nd'+uid(),{width,...savedSettings}=settings;mutate(()=>state.doorEdits.added.push({...savedSettings,...placement,id,rect}));
  toast(tr('门已添加，可继续绘制或点“结束绘制”。','Door added. Continue drawing or finish drawing.'));return true;
}
function updateDoor(id,settings){
  const e=getDoor(id);if(!e)return;
  settings={...settings};delete settings.width;
  mutate(()=>{if(e.source==='added')Object.assign(state.doorEdits.added.find(d=>d.id===id),settings);else state.doorEdits.overrides[id]={...state.doorEdits.overrides[id],...settings};});
}
function toggleDoorRemoval(id){const e=getDoor(id);if(e&&(!e.hidden||e.closed))updateDoor(id,{hidden:!e.hidden,closed:false,removedHostIds:doorRemovalHosts({...e,removedHostIds:undefined})});}
function doorPanel(e){return `<section><h3>${esc(e.name)} <small>${tr(e.source==='added'?'手动新增':'原始门洞',e.source==='added'?'Added':'Original opening')}</small></h3>
  ${doorFields(e,true)}<p>${tr(e.inactive?'所在墙体已拆除，门随之隐藏。':e.closed?'门洞已封闭。':e.hidden?'门已拆除，洞口保留。':'修改同步到平面图、三维和渲染。',e.inactive?'Hidden because its host was removed.':e.closed?'Opening sealed.':e.hidden?'Door removed; opening retained.':'Changes update 2D, 3D and rendering.')}</p>
  <div class="actions"><button class="btn primary" id="doorApply">${tr('应用修改','Apply')}</button><button class="btn danger" id="doorRemove">${tr(e.hidden?'恢复门':'拆除门（留洞）',e.hidden?'Restore door':'Remove door (keep opening)')}</button><button class="btn" id="doorSeal">${tr(e.closed?'重新打开门洞':'封闭门洞',e.closed?'Reopen opening':'Seal opening')}</button>
  ${e.source==='added'?`<button class="btn danger" id="doorDelete">${tr('撤回开洞并删除','Delete and undo opening')}</button>`:`<button class="btn" id="doorReset">${tr('恢复原始门','Reset original door')}</button>`}</div></section>`;}
function bindDoorPanel(e){
  $('#doorApply').onclick=()=>{
    const settings=readDoorFields();if(!settings)return;
    const x=Number($('#doorX').value),y=Number($('#doorY').value),horizontal=$('#doorOrientation').value==='horizontal',t=e.thickness;
    const rect=horizontal?[x-settings.width/2,y-t/2,x+settings.width/2,y+t/2]:[x-t/2,y-settings.width/2,x+t/2,y+settings.width/2];
    if(!validArchRect(rect))return toast(tr('请检查门的位置。','Check the door position.'));
    const placement=doorPlacement(rect,settings.height,e.id);if(placement.error)return toast(placement.error);
    updateDoor(e.id,{...settings,...placement,rect,hidden:false,closed:false});
  };
  $('#doorRemove').onclick=()=>toggleDoorRemoval(e.id);
  $('#doorSeal').onclick=()=>updateDoor(e.id,{closed:!e.closed,hidden:!e.closed});
  if($('#doorReset'))$('#doorReset').onclick=()=>mutate(()=>{delete state.doorEdits.overrides[e.id];});
  if($('#doorDelete'))$('#doorDelete').onclick=()=>{ui.sel=null;mutate(()=>{state.doorEdits.added=state.doorEdits.added.filter(d=>d.id!==e.id);});};
}
function doorSvg(e){
  if(e.hidden||e.closed||e.inactive)return '';
  const [x0,y0,x1,y1]=e.rect,hidden=e.hidden||e.closed||e.inactive,col=hidden?'#c65b3a':e.frameColor,L=e.width,T=35;
  let symbol='';
  if(!hidden&&e.kind==='swing'){
    const [hx,hy]=e.h,ox=hx+e.o[0]*L,oy=hy+e.o[1]*L,cx=hx+e.c[0]*L,cy=hy+e.c[1]*L,sweep=e.o[0]*e.c[1]-e.o[1]*e.c[0]>0?1:0;
    symbol=`<polygon points="${hx},${hy} ${ox},${oy} ${ox+e.c[0]*T},${oy+e.c[1]*T} ${hx+e.c[0]*T},${hy+e.c[1]*T}" fill="${e.material==='glass'?'#cfe6ef':e.color}" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/><path d="M${ox} ${oy}A${L} ${L} 0 0 ${sweep} ${cx} ${cy}" fill="none" stroke="${col}" stroke-dasharray="5 3" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }else if(!hidden&&e.kind==='sliding'){
    symbol=e.horizontal?`<rect x="${x0}" y="${(y0+y1)/2-40}" width="${L*.55}" height="35" fill="${e.color}"/><rect x="${x1-L*.55}" y="${(y0+y1)/2+5}" width="${L*.55}" height="35" fill="${e.color}"/>`:`<rect x="${(x0+x1)/2-40}" y="${y0}" width="35" height="${L*.55}" fill="${e.color}"/><rect x="${(x0+x1)/2+5}" y="${y1-L*.55}" width="35" height="${L*.55}" fill="${e.color}"/>`;
  }
  return `<g class="door-item" data-door="${e.id}"><title>${esc(e.name)} · ${tr(e.closed?'门洞已封闭':e.hidden?'门已拆除，保留洞口':'可编辑门',e.closed?'Sealed':e.hidden?'Removed; opening kept':'Editable door')}</title><rect x="${x0}" y="${y0}" width="${x1-x0}" height="${y1-y0}" fill="${hidden?'rgba(198,91,58,.1)':'rgba(220,209,185,.4)'}" stroke="${col}" stroke-width="1" ${hidden?'stroke-dasharray="5 3"':''} vector-effect="non-scaling-stroke"/>${symbol}</g>`;
}
