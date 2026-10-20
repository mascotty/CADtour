/* Browser-only DXF expansion, architectural inference and enclosed floor regions.
   INSERT/LWPOLYLINE group codes follow Autodesk's DXF reference. */
function parseCadDxf(text){
  const lines=text.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n'),records=[];let rec;
  for(let i=0;i+1<lines.length;i+=2){const code=lines[i].trim(),value=lines[i+1].trim();if(code==='0'){if(rec)records.push(rec);rec={type:value,tags:[]};}else if(rec)rec.tags.push([code,value]);}
  if(rec)records.push(rec);
  const tag=(e,c,def='')=>e.tags.find(t=>t[0]===String(c))?.[1]??def,num=(e,c,def=0)=>Number(tag(e,c,def));
  const blocks=new Map(),entities=[],hasSections=records.some(r=>r.type==='SECTION');let section='',block=null;
  for(let i=0;i<records.length;i++){
    const e=records[i];if(e.type==='SECTION'){section=tag(e,2);continue;}if(e.type==='ENDSEC'){section='';continue;}
    if(section==='BLOCKS'){
      if(e.type==='BLOCK'){block={name:tag(e,2),base:[num(e,10),num(e,20)],entities:[]};blocks.set(block.name,block);}
      else if(e.type==='ENDBLK')block=null;else if(block)block.entities.push(e);
    }else if(section==='ENTITIES'||(!section&&!hasSections))entities.push(e);
  }
  const out=[],texts=[],diagnostics={blocks:blocks.size,expandedInserts:0,missingBlocks:[],cyclicBlocks:[],unsupported:{},skippedPaper:0};
  const mul=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const apply=(m,p)=>[m[0]*p[0]+m[2]*p[1]+m[4],m[1]*p[0]+m[3]*p[1]+m[5]],identity=[1,0,0,1,0,0];
  const emit=(a,b,m,meta)=>{a=apply(m,a);b=apply(m,b);if(a.concat(b).every(Number.isFinite)&&Math.hypot(b[0]-a[0],b[1]-a[1])>1e-6){if(out.length>=200000)throw new Error('cad-too-large');out.push({...meta,x1:a[0],y1:a[1],x2:b[0],y2:b[1]});}};
  const arc=(centre,r,a,sweep,m,meta)=>{const n=Math.min(256,Math.max(4,Math.ceil(Math.abs(sweep)/(Math.PI/24))));for(let i=0;i<n;i++){const p=a+sweep*i/n,q=a+sweep*(i+1)/n;emit([centre[0]+Math.cos(p)*r,centre[1]+Math.sin(p)*r],[centre[0]+Math.cos(q)*r,centre[1]+Math.sin(q)*r],m,{...meta,curve:true,arcCenter:apply(m,centre),arcRadius:r*Math.hypot(m[0],m[1]),arcSweep:sweep});}};
  const walk=(items,parent=identity,inherited='',stack=[],path='model')=>{
    for(let index=0;index<items.length;index++){
      const e=items[index],ownLayer=tag(e,8),layer=(!ownLayer||ownLayer==='0')&&inherited?inherited:ownLayer;
      if(num(e,67)===1){diagnostics.skippedPaper++;continue;}
      if(num(e,60)===1)continue;
      const id=path+'/'+(tag(e,5)||index),meta={layer,entityType:e.type,entityId:id,blockName:stack.at(-1)||''};
      let m=parent;if(['INSERT','LWPOLYLINE','POLYLINE','ARC','CIRCLE','TEXT','ATTRIB'].includes(e.type)&&num(e,230,1)<0)m=mul(parent,[-1,0,0,1,0,0]);
      if(e.type==='INSERT'){
        const name=tag(e,2),b=blocks.get(name);if(!b){diagnostics.missingBlocks.push(name);continue;}if(stack.includes(name)||stack.length>=16){diagnostics.cyclicBlocks.push(name);continue;}
        const angle=num(e,50)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),sx=num(e,41,1),sy=num(e,42,1),columns=Math.min(100,Math.max(1,num(e,70,1))),rows=Math.min(100,Math.max(1,num(e,71,1)));
        for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
          const tx=num(e,10)+c*col*num(e,44)-s*row*num(e,45),ty=num(e,20)+s*col*num(e,44)+c*row*num(e,45);
          const transform=[c*sx,s*sx,-s*sy,c*sy,tx-c*sx*b.base[0]+s*sy*b.base[1],ty-s*sx*b.base[0]-c*sy*b.base[1]];
          diagnostics.expandedInserts++;walk(b.entities,mul(m,transform),layer,stack.concat(name),id+':'+col+','+row);
        }continue;
      }
      if(e.type==='LINE'){emit([num(e,10),num(e,20)],[num(e,11),num(e,21)],m,meta);continue;}
      if(e.type==='LWPOLYLINE'||e.type==='POLYLINE'){
        const points=[];
        if(e.type==='LWPOLYLINE'){for(const [code,value]of e.tags){if(code==='10')points.push({x:Number(value),y:0,bulge:0});else if(code==='20'&&points.length)points.at(-1).y=Number(value);else if(code==='42'&&points.length)points.at(-1).bulge=Number(value);}}
        else{while(items[index+1]?.type==='VERTEX'){const v=items[++index];points.push({x:num(v,10),y:num(v,20),bulge:num(v,42)});}if(items[index+1]?.type==='SEQEND')index++;}
        const closed=(num(e,70)&1)!==0,world=points.map(p=>apply(m,[p.x,p.y]));
        const bounds=world.length?[Math.min(...world.map(p=>p[0])),Math.min(...world.map(p=>p[1])),Math.max(...world.map(p=>p[0])),Math.max(...world.map(p=>p[1]))]:null;
        for(let j=0;j<points.length-(closed?0:1);j++){
          const a=points[j],b=points[(j+1)%points.length],extra={...meta,closed,polyBounds:bounds};
          if(Math.abs(a.bulge)<1e-9)emit([a.x,a.y],[b.x,b.y],m,extra);
          else{const dx=b.x-a.x,dy=b.y-a.y,chord=Math.hypot(dx,dy),offset=(1-a.bulge*a.bulge)/(4*a.bulge),centre=[(a.x+b.x)/2-dy*offset,(a.y+b.y)/2+dx*offset],r=chord*(1+a.bulge*a.bulge)/(4*Math.abs(a.bulge));arc(centre,r,Math.atan2(a.y-centre[1],a.x-centre[0]),4*Math.atan(a.bulge),m,extra);}
        }continue;
      }
      if(e.type==='ARC'||e.type==='CIRCLE'){
        const a=e.type==='CIRCLE'?0:num(e,50)*Math.PI/180,b=e.type==='CIRCLE'?Math.PI*2:num(e,51)*Math.PI/180;let sweep=b-a;if(sweep<=0)sweep+=Math.PI*2;
        arc([num(e,10),num(e,20)],num(e,40),a,sweep,m,meta);continue;
      }
      if(e.type==='ELLIPSE'){
        const start=num(e,41),end=num(e,42,Math.PI*2),ratio=num(e,40,1),cx=num(e,10),cy=num(e,20),ax=num(e,11),ay=num(e,21),n=48;
        for(let j=0;j<n;j++){const at=t=>[cx+ax*Math.cos(t)-ay*ratio*Math.sin(t),cy+ay*Math.cos(t)+ax*ratio*Math.sin(t)];emit(at(start+(end-start)*j/n),at(start+(end-start)*(j+1)/n),parent,{...meta,curve:true});}continue;
      }
      if(['TEXT','MTEXT','ATTRIB'].includes(e.type)){
        const raw=e.tags.filter(t=>t[0]==='1'||t[0]==='3').map(t=>t[1]).join('').replace(/\\U\+([\da-f]{4})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))),value=cleanDxfText(raw);
        const aligned=e.type==='TEXT'&&(num(e,72)!==0||num(e,73)!==0)&&tag(e,11)!=='',p=apply(m,[num(e,aligned?11:10),num(e,aligned?21:20)]);
        if(value&&p.every(Number.isFinite))texts.push({x:p[0],y:p[1],text:value,layer,h:num(e,40)*Math.hypot(m[2],m[3])});continue;
      }
      if(!['SEQEND','ATTDEF','ENDBLK','EOF','POINT','DIMENSION','LEADER','HATCH','SOLID','SPLINE'].includes(e.type))diagnostics.unsupported[e.type]=(diagnostics.unsupported[e.type]||0)+1;
    }
  };
  walk(entities);out.texts=texts;out.diagnostics=diagnostics;
  const unit=text.match(/\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(\d+)/);out.unitScale=({1:25.4,2:304.8,4:1,5:10,6:1000})[Number(unit?.[1])];return out;
}

function cadDefaultRole(layer){
  const named=layerKind(layer);if(named!=='ignore')return named;
  if(/家具|furn|chair|table|洁具|植物|plant|灯|dim|text|note|标注|文字|stair|楼梯|beam|梁|格栅|楼板|轴|设备|equip|图框|frame|看线|轮廓|铝板|石材|引线|管|pipe|人$|卫生间洁具|^EVTR$|开启扇/i.test(layer))return 'ignore';
  return 'auto';
}
function cadSegmentRole(s,roles){const role=roles?.[s.layer||'(无图层)']??cadDefaultRole(s.layer||'');if(role==='ignore')return role;return s.symbolKind|| (role==='auto'?(s.autoKind||'ignore'):role);}
function inferCadArchitecture(all,roles){
  const segs=all.map(s=>({...s,autoKind:undefined,symbolKind:undefined})),candidates=[];
  const arcs=new Map();for(const s of segs)if(s.entityType==='ARC'&&s.arcRadius>=450&&s.arcRadius<=2000&&Math.abs(s.arcSweep)>=Math.PI/6&&Math.abs(s.arcSweep)<=Math.PI*.65&&roles[s.layer]!=='ignore')arcs.set(s.entityId,s);
  for(const a of arcs.values()){
    const leaves=segs.filter(s=>!s.curve&&s.layer===a.layer&&Math.abs(Math.hypot(s.x2-s.x1,s.y2-s.y1)-a.arcRadius)<140&&[[s.x1,s.y1],[s.x2,s.y2]].some(p=>Math.hypot(p[0]-a.arcCenter[0],p[1]-a.arcCenter[1])<140));
    if(leaves.length){for(const s of leaves)s.symbolKind='door';for(const s of segs)if(s.entityId===a.entityId)s.symbolKind='door';}
  }
  const blockBounds=new Map();for(const s of segs)if(s.blockName){const id=s.entityId.split(':')[0],b=blockBounds.get(id)||[Infinity,Infinity,-Infinity,-Infinity];b[0]=Math.min(b[0],s.x1,s.x2);b[1]=Math.min(b[1],s.y1,s.y2);b[2]=Math.max(b[2],s.x1,s.x2);b[3]=Math.max(b[3],s.y1,s.y2);blockBounds.set(id,b);}
  for(let i=0;i<segs.length;i++){
    const s=segs[i],role=roles[s.layer||'(无图层)'];if(role!=='auto')continue;
    const blockRole=layerKind(s.blockName||'');if(blockRole!=='ignore'){s.autoKind=blockRole;continue;}
    if(s.blockName){const b=blockBounds.get(s.entityId.split(':')[0]);if(b&&Math.max(b[2]-b[0],b[3]-b[1])<3500)continue;}
    if(s.curve||/家具|furn|chair|table|洁具|植物|plant|灯|图框|frame/i.test(s.blockName||''))continue;
    const dx=Math.abs(s.x2-s.x1),dy=Math.abs(s.y2-s.y1),length=Math.hypot(dx,dy);if(length<650)continue;
    const hz=dy<=Math.max(15,dx*.005),vt=dx<=Math.max(15,dy*.005);if(!hz&&!vt)continue;
    candidates.push({s,i,hz,c:hz?(s.y1+s.y2)/2:(s.x1+s.x2)/2,start:hz?Math.min(s.x1,s.x2):Math.min(s.y1,s.y2),end:hz?Math.max(s.x1,s.x2):Math.max(s.y1,s.y2)});
  }
  const pairs=[];
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
    const a=candidates[i],b=candidates[j];if(a.hz!==b.hz||a.s.layer!==b.s.layer)continue;
    const gap=Math.abs(a.c-b.c),overlap=Math.min(a.end,b.end)-Math.max(a.start,b.start),short=Math.min(a.end-a.start,b.end-b.start);
    if(gap>=70&&gap<=360&&overlap>=650&&overlap>=short*.55)pairs.push({a,b,start:Math.max(a.start,b.start),end:Math.min(a.end,b.end),c:(a.c+b.c)/2});
  }
  // Paired wall faces must form a junction or meet existing architecture.
  const known=segs.filter(s=>['wall','bearing','window'].includes(cadSegmentRole(s,roles))),near=(x,y,s,pad=260)=>{
    const dx=s.x2-s.x1,dy=s.y2-s.y1,t=Math.max(0,Math.min(1,((x-s.x1)*dx+(y-s.y1)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(x-s.x1-t*dx,y-s.y1-t*dy)<=pad;
  };
  for(const p of pairs){
    const ends=p.a.hz?[[p.start,p.c],[p.end,p.c]]:[[p.c,p.start],[p.c,p.end]];
    const joined=p.end-p.start>=2500||ends.some(([x,y])=>known.some(s=>near(x,y,s))||pairs.some(q=>q!==p&&q.a.hz!==p.a.hz&&near(x,y,{x1:q.a.hz?q.start:q.c,y1:q.a.hz?q.c:q.start,x2:q.a.hz?q.end:q.c,y2:q.a.hz?q.c:q.end})));
    if(joined){p.a.s.autoKind='wall';p.b.s.autoKind='wall';}
  }
  // Recover short straight returns of an accepted closed wall polyline.
  const wallIds=new Set(segs.filter(s=>s.autoKind==='wall'&&(s.closed||!s.blockName&&s.entityType==='LWPOLYLINE')).map(s=>s.entityId));
  for(const s of segs)if(wallIds.has(s.entityId)&&!s.curve&&roles[s.layer||'(无图层)']==='auto')s.autoKind='wall';
  const accepted=segs.filter(s=>['wall','bearing','window'].includes(cadSegmentRole(s,roles)));
  for(let pass=0;pass<3;pass++)for(const a of candidates)if(!a.s.autoKind&&a.end-a.start>=800){
    const ends=a.hz?[[a.start,a.c],[a.end,a.c]]:[[a.c,a.start],[a.c,a.end]];
    const connected=ends.map(([x,y])=>accepted.some(s=>near(x,y,s,180)));
    if(connected.every(Boolean)||(!a.s.blockName&&a.end-a.start>=2000&&connected.some(Boolean))){a.s.autoKind='wall';accepted.push(a.s);}
  }
  const outlines=new Set(segs.filter(s=>s.autoKind==='wall'&&!s.blockName&&s.entityType==='LWPOLYLINE').map(s=>s.entityId));
  for(const s of segs)if(outlines.has(s.entityId)&&!s.curve&&roles[s.layer||'(无图层)']==='auto')s.autoKind='wall';
  // Rail layers can continue an exterior curtain wall. Require both parallel
  // direction and an adjoining end; stair rails elsewhere stay unclassified.
  const facade=segs.filter(s=>cadSegmentRole(s,roles)==='window'&&!s.curve&&Math.hypot(s.x2-s.x1,s.y2-s.y1)>=2000);
  for(const s of segs)if(roles[s.layer]==='auto'&&/rail|栏杆/i.test(s.layer)&&!s.curve&&Math.hypot(s.x2-s.x1,s.y2-s.y1)>=2000){
    const dx=s.x2-s.x1,dy=s.y2-s.y1,len=Math.hypot(dx,dy);
    if(facade.some(f=>{const fx=f.x2-f.x1,fy=f.y2-f.y1,fl=Math.hypot(fx,fy);return Math.abs(dx*fy-dy*fx)/(len*fl)<.025&&[[s.x1,s.y1],[s.x2,s.y2]].some(p=>[[f.x1,f.y1],[f.x2,f.y2]].some(q=>Math.hypot(p[0]-q[0],p[1]-q[1])<800));}))s.autoKind='window';
  }
  for(const s of segs)if(!s.autoKind&&roles[s.layer]==='auto'&&!s.blockName&&!s.curve&&Math.hypot(s.x2-s.x1,s.y2-s.y1)>=800&&[[s.x1,s.y1],[s.x2,s.y2]].every(([x,y])=>accepted.some(a=>near(x,y,a,180))))s.autoKind='wall';
  segs.texts=all.texts||[];segs.diagnostics=all.diagnostics;return segs;
}

function consolidateCadWalls(rects){
  const out=[];
  for(const r of rects){
    const hz=r[6]??r[2]-r[0]>=r[3]-r[1],axis=hz?0:1,other=1-axis,c=(r[other]+r[other+2])/2;
    const match=!r[5]&&out.find(a=>!a[5]&&a[4]===r[4]&&(a[6]??a[2]-a[0]>=a[3]-a[1])===hz&&Math.abs((a[other]+a[other+2])/2-c)<=35&&Math.min(a[axis+2],r[axis+2])-Math.max(a[axis],r[axis])>=-10);
    if(match){match[axis]=Math.min(match[axis],r[axis]);match[axis+2]=Math.max(match[axis+2],r[axis+2]);}else out.push(r.slice());
  }return out;
}
function buildCadWallBodies(segments,roles,defaultThickness){
  const columns=new Map(),lines=[];
  const axes=segments.filter(s=>!s.curve&&['wall','bearing'].includes(cadSegmentRole(s,roles))&&(Math.abs(s.x2-s.x1)<=50||Math.abs(s.y2-s.y1)<=50)&&Math.hypot(s.x2-s.x1,s.y2-s.y1)>=400);
  const connected=(p,s)=>{const dx=s.x2-s.x1,dy=s.y2-s.y1,u=Math.max(0,Math.min(1,((p[0]-s.x1)*dx+(p[1]-s.y1)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p[0]-s.x1-u*dx,p[1]-s.y1-u*dy)<220;};
  for(const s of segments){const role=cadSegmentRole(s,roles);if(!['wall','bearing'].includes(role))continue;
    if(role==='bearing'&&s.closed){if(!columns.has(s.entityId))columns.set(s.entityId,[]);columns.get(s.entityId).push(s);continue;}
    if(s.curve)continue;const dx=Math.abs(s.x2-s.x1),dy=Math.abs(s.y2-s.y1),hz=dy<=50,vt=dx<=50;if(!hz&&!vt){if(Math.hypot(dx,dy)>=1500||(Math.hypot(dx,dy)>=300&&[[s.x1,s.y1],[s.x2,s.y2]].every(p=>axes.some(a=>connected(p,a)))))lines.push({diagonal:s});continue;}
    lines.push({hz,c:hz?(s.y1+s.y2)/2:(s.x1+s.x2)/2,start:hz?Math.min(s.x1,s.x2):Math.min(s.y1,s.y2),end:hz?Math.max(s.x1,s.x2):Math.max(s.y1,s.y2),kind:role==='bearing'?'b':'n',layer:s.layer,covered:[]});
  }
  const bodies=lines.filter(a=>a.diagonal).map(a=>cadOrientedRect(a.diagonal,defaultThickness,cadSegmentRole(a.diagonal,roles)==='bearing'?'b':'n'));
  for(let i=lines.length-1;i>=0;i--)if(lines[i].diagonal)lines.splice(i,1);
  for(const group of columns.values()){
    const x=group.flatMap(s=>[s.x1,s.x2]),y=group.flatMap(s=>[s.y1,s.y2]),r=[Math.min(...x),Math.min(...y),Math.max(...x),Math.max(...y),'b'];
    if(Math.min(r[2]-r[0],r[3]-r[1])>=100&&Math.max(r[2]-r[0],r[3]-r[1])<=2500)bodies.push(r);
    else for(const s of group){const r=rectFromSeg(s,defaultThickness,roles);if(r)bodies.push(r);}
  }
  const pairs=[];
  for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
    const a=lines[i],b=lines[j];if(a.hz!==b.hz||a.kind!==b.kind||a.layer!==b.layer)continue;const gap=Math.abs(a.c-b.c),start=Math.max(a.start,b.start),end=Math.min(a.end,b.end),length=end-start;
    if(gap>=70&&gap<=360&&length>=300&&length>=Math.min(a.end-a.start,b.end-b.start)*.5)pairs.push({a,b,start,end,gap,score:length/(1+Math.abs(a.start-b.start)/1000+Math.abs(a.end-b.end)/1000)});
  }
  const remaining=(a,start,end)=>{let intervals=[[start,end]];for(const [lo,hi]of a.covered)intervals=intervals.flatMap(([s,e])=>[[s,Math.min(e,lo)],[Math.max(s,hi),e]].filter(([a,b])=>b-a>=20));return intervals;};
  pairs.sort((a,b)=>b.score-a.score);
  for(const p of pairs){const intervals=remaining(p.a,p.start,p.end).flatMap(([s,e])=>remaining(p.b,s,e));for(const [start,end]of intervals){const lo=Math.min(p.a.c,p.b.c),hi=Math.max(p.a.c,p.b.c);bodies.push(p.a.hz?[start,lo,end,hi,p.a.kind,null,true]:[lo,start,hi,end,p.a.kind,null,false]);p.a.covered.push([start,end]);p.b.covered.push([start,end]);}}
  for(const a of lines)for(const [start,end]of remaining(a,a.start,a.end)){const t=defaultThickness/2;bodies.push(a.hz?[start,a.c-t,end,a.c+t,a.kind,null,true]:[a.c-t,start,a.c+t,end,a.kind,null,false]);}
  return consolidateCadWalls(bodies);
}
function mergeCadWindows(rects){
  const oriented=mergeCadOrientedRects(rects.filter(r=>r[5]));rects=rects.filter(r=>!r[5]);
  const out=[];for(const r of rects){const hz=r[2]-r[0]>=r[3]-r[1],axis=hz?0:1,other=1-axis;
    const a=out.find(a=>(a[2]-a[0]>=a[3]-a[1])===hz&&Math.abs((a[other]+a[other+2]-r[other]-r[other+2])/2)<=220&&Math.min(a[axis+2],r[axis+2])-Math.max(a[axis],r[axis])>=Math.min(a[axis+2]-a[axis],r[axis+2]-r[axis])*.6);
    if(a){for(const k of [0,1])a[k]=Math.min(a[k],r[k]);for(const k of [2,3])a[k]=Math.max(a[k],r[k]);}else out.push(r.slice());
  }return out.concat(oriented);
}
function cadOrientedRect(s,thickness,kind){
  const line=[[s.x1,s.y1],[s.x2,s.y2]],dx=s.x2-s.x1,dy=s.y2-s.y1,len=Math.hypot(dx,dy),ox=-dy/len*thickness/2,oy=dx/len*thickness/2;
  const poly=[[s.x1+ox,s.y1+oy],[s.x2+ox,s.y2+oy],[s.x2-ox,s.y2-oy],[s.x1-ox,s.y1-oy]];
  return [Math.min(...poly.map(p=>p[0])),Math.min(...poly.map(p=>p[1])),Math.max(...poly.map(p=>p[0])),Math.max(...poly.map(p=>p[1])),kind,{line,thickness,poly}];
}
function mergeCadOrientedRects(rects){
  const out=[];for(const r of rects){const [p,q]=r[5].line,dx=q[0]-p[0],dy=q[1]-p[1],len=Math.hypot(dx,dy),ux=dx/len,uy=dy/len;
    const a=out.find(a=>{const [b,c]=a[5].line,bl=Math.hypot(c[0]-b[0],c[1]-b[1]);const offset=Math.abs((b[0]-p[0])*uy-(b[1]-p[1])*ux),start=(b[0]-p[0])*ux+(b[1]-p[1])*uy,end=(c[0]-p[0])*ux+(c[1]-p[1])*uy;return Math.abs((c[0]-b[0])*uy-(c[1]-b[1])*ux)/bl<.025&&offset<220&&Math.min(len,Math.max(start,end))-Math.max(0,Math.min(start,end))>=Math.min(len,bl)*.6;});
    if(a){const pts=a[5].line.concat(r[5].line),ts=pts.map(b=>(b[0]-p[0])*ux+(b[1]-p[1])*uy),lo=Math.min(...ts),hi=Math.max(...ts);Object.assign(a,cadOrientedRect({x1:p[0]+lo*ux,y1:p[1]+lo*uy,x2:p[0]+hi*ux,y2:p[1]+hi*uy},Math.max(a[5].thickness,r[5].thickness),a[4]));}else out.push(r.slice());
  }return out;
}
function cadDoorsFromPorts(ports,segments){
  const doors=[],slides=[],chosen=[];
  for(const port of ports.filter(p=>p.evidence).sort((a,b)=>Math.abs(a.rect[2]-a.rect[0])+Math.abs(a.rect[3]-a.rect[1])-Math.abs(b.rect[2]-b.rect[0])-Math.abs(b.rect[3]-b.rect[1]))){
    const r=port.rect,hz=port.horizontal,width=hz?r[2]-r[0]:r[3]-r[1];if(width<500||width>2400)continue;
    if(chosen.some(a=>rectOverlapArea(a,r)>Math.min((a[2]-a[0])*(a[3]-a[1]),(r[2]-r[0])*(r[3]-r[1]))*.2))continue;
    const near=segments.filter(s=>Math.min(s.x1,s.x2)<r[2]+width&&Math.max(s.x1,s.x2)>r[0]-width&&Math.min(s.y1,s.y2)<r[3]+width&&Math.max(s.y1,s.y2)>r[1]-width);
    chosen.push(r);if(near.some(s=>s.curve))doors.push({name:'CAD 平开门 '+(doors.length+1),rect:r,h:hz?[r[0],(r[1]+r[3])/2]:[(r[0]+r[2])/2,r[1]],c:hz?[1,0]:[0,1],o:hz?[0,1]:[1,0],len:width});
    else slides.push({rect:r,v:!hz});
  }return {doors,slides};
}
function cadRoomBarriers(walls,wins,doorSegments,thickness){
  const barriers=walls.concat(wins).map(r=>r.slice()),ports=[];
  const outer=[Math.min(...barriers.map(r=>r[0])),Math.min(...barriers.map(r=>r[1])),Math.max(...barriers.map(r=>r[2])),Math.max(...barriers.map(r=>r[3]))];
  const axisInfo=(r,hz=r[6]??r[2]-r[0]>=r[3]-r[1])=>({r,hz,axis:hz?0:1,other:hz?1:0,c:hz?(r[1]+r[3])/2:(r[0]+r[2])/2,start:hz?r[0]:r[1],end:hz?r[2]:r[3]});
  const runs=barriers.filter(r=>!r[5]).map(r=>axisInfo(r)).filter(a=>a.end-a.start>=50),used=new Set();
  for(let i=0;i<runs.length;i++)for(let j=i+1;j<runs.length;j++){
    let a=runs[i],b=runs[j];if(a.hz!==b.hz||Math.abs(a.c-b.c)>Math.max(80,thickness*.6))continue;if(a.start>b.start)[a,b]=[b,a];
    const gap=b.start-a.end;if(gap<40||gap>3600)continue;
    const c=(a.c+b.c)/2,x=a.hz?(a.end+b.start)/2:c,y=a.hz?c:(a.end+b.start)/2;
    if(runs.some(q=>q!==a&&q!==b&&q.hz===a.hz&&q.end-q.start>=400&&Math.abs(q.c-c)<=Math.max(80,thickness*.6)&&Math.min(q.end,b.start)-Math.max(q.start,a.end)>Math.max(150,gap*.3)))continue;
    const evidence=doorSegments.some(s=>Math.min(s.x1,s.x2)<=x+gap*.65&&Math.max(s.x1,s.x2)>=x-gap*.65&&Math.min(s.y1,s.y2)<=y+gap*.65&&Math.max(s.y1,s.y2)>=y-gap*.65);
    if((a.end-a.start<400||b.end-b.start<400)&&(!evidence||gap<400))continue;
    const exterior=Math.min(Math.abs(c-outer[a.other]),Math.abs(c-outer[a.other+2]))<=Math.max(350,(outer[a.other+2]-outer[a.other])*.07);
    if(gap>1300&&!evidence&&!exterior)continue;if(gap>2200&&!exterior)continue;
    const key=[a.hz,Math.round(c/100),Math.round(a.end/100),Math.round(b.start/100)].join(',');if(used.has(key))continue;used.add(key);
    const t=Math.max(thickness,Math.abs(a.c-b.c)+thickness),r=a.hz?[a.end,c-t/2,b.start,c+t/2]:[c-t/2,a.end,c+t/2,b.start];
    barriers.push(r);if(gap>=500)ports.push({rect:r,horizontal:a.hz,evidence});
  }
  // Small drafting gaps at right-angle wall junctions must not leak to outside.
  for(const a of runs)for(const b of runs){
    if(a.hz===b.hz)continue;
    const cross=a.hz?[b.c,a.c]:[a.c,b.c],at=cross[a.axis],bt=cross[b.axis];
    if(bt<b.start-100||bt>b.end+100)continue;
    for(const end of [a.start,a.end])if(Math.abs(at-end)>10&&Math.abs(at-end)<=180){const c=a.c,t=thickness*.6;barriers.push(a.hz?[Math.min(end,at),c-t,Math.max(end,at),c+t]:[c-t,Math.min(end,at),c+t,Math.max(end,at)]);}
  }
  for(const r of walls.concat(wins).filter(r=>r[5]))for(const p of r[5].line){
    let closest=null;
    for(const b of walls.concat(wins)){if(b===r)continue;if(b[5]){const [a,c]=r[5].line,[d,e]=b[5].line;if(Math.abs((c[0]-a[0])*(e[1]-d[1])-(c[1]-a[1])*(e[0]-d[0]))/(Math.hypot(c[0]-a[0],c[1]-a[1])*Math.hypot(e[0]-d[0],e[1]-d[1]))<.05)continue;}const poly=b[5]?.poly||R(...b.slice(0,4));for(let i=0;i<poly.length;i++){const a=poly[i],c=poly[(i+1)%poly.length],dx=c[0]-a[0],dy=c[1]-a[1],u=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1))),q=[a[0]+u*dx,a[1]+u*dy],d=Math.hypot(q[0]-p[0],q[1]-p[1]);if(d>10&&d<=250&&(!closest||d<closest.d))closest={q,d};}}
    if(closest)barriers.push(cadOrientedRect({x1:p[0],y1:p[1],x2:closest.q[0],y2:closest.q[1]},thickness,'closure'));
  }
  return {barriers,ports};
}
function enclosedCadRooms(barriers,texts=[]){return polygonCadRooms(barriers,texts);}
function polygonCadRooms(barriers,texts){
  if(barriers.length<4)return {rooms:[],warnings:['没有足够的围护边界']};
  const x0=Math.min(...barriers.map(r=>r[0]))-500,y0=Math.min(...barriers.map(r=>r[1]))-500,x1=Math.max(...barriers.map(r=>r[2]))+500,y1=Math.max(...barriers.map(r=>r[3]))+500;
  const polygons=barriers.filter(r=>r[2]>r[0]&&r[3]>r[1]).map(r=>[r[5]?.poly||R(...r.slice(0,4))]);
  const free=polygonClipping.difference([R(x0,y0,x1,y1)],polygonClipping.union(...polygons));
  const rooms=[];
  for(const polygon of free){const poly=polygon[0].slice(0,-1),holes=polygon.slice(1).map(h=>h.slice(0,-1)),b=bbox(poly),area=floorRingArea(poly)-holes.reduce((a,h)=>a+floorRingArea(h),0);
    if(b[0]<=x0+1||b[1]<=y0+1||b[2]>=x1-1||b[3]>=y1-1||Math.min(b[2]-b[0],b[3]-b[1])<500||area<500000)continue;
    const inside=t=>pointInPoly(t,poly)&&!holes.some(h=>pointInPoly(t,h)),label=texts.find(t=>textLooksLikeRoomName(t.text)&&inside(t));
    let at=label?[label.x,label.y]:[(b[0]+b[2])/2,(b[1]+b[3])/2];
    if(!inside({x:at[0],y:at[1]})){
      outer:for(let y=1;y<20;y++)for(let x=1;x<20;x++){const p={x:b[0]+(b[2]-b[0])*x/20,y:b[1]+(b[3]-b[1])*y/20};if(inside(p)){at=[p.x,p.y];break outer;}}
    }
    rooms.push({poly,holes,at,mat:'tile800'});
  }
  rooms.sort((a,b)=>bbox(a.poly)[1]-bbox(b.poly)[1]||bbox(a.poly)[0]-bbox(b.poly)[0]);
  return {rooms:rooms.map((r,i)=>({...r,id:'cadroom'+(i+1),name:'CAD 房间 '+(i+1)})),warnings:[],method:'polygon'};
}
function recognizeCadRooms(boundary,texts){
  let result=enclosedCadRooms(boundary.barriers,texts);
  const roomTexts=texts.filter(t=>textLooksLikeRoomName(t.text)),missing=roomTexts.filter(t=>!result.rooms.some(r=>pointInPoly(t,r.poly)&&!r.holes.some(h=>pointInPoly(t,h))));
  if(missing.length&&missing.length>=roomTexts.length*.15){
    const b=boundary.barriers,x0=Math.min(...b.map(r=>r[0])),y0=Math.min(...b.map(r=>r[1])),x1=Math.max(...b.map(r=>r[2])),y1=Math.max(...b.map(r=>r[3])),w=x1-x0,h=y1-y0;
    const long=b.filter(r=>Math.max(r[2]-r[0],r[3]-r[1])>=1000),tol=Math.max(400,Math.min(w,h)*.08);
    const coverage=(vertical,value)=>{const spans=long.filter(r=>vertical?r[3]-r[1]>r[2]-r[0]&&Math.abs((r[0]+r[2])/2-value)<tol:r[2]-r[0]>r[3]-r[1]&&Math.abs((r[1]+r[3])/2-value)<tol).map(r=>vertical?[r[1],r[3]]:[r[0],r[2]]).sort((a,b)=>a[0]-b[0]);let length=0,last=-Infinity;for(const [a,b]of spans){length+=Math.max(0,b-Math.max(a,last));last=Math.max(last,b);}return length/(vertical?h:w);};
    const support=[coverage(true,x0),coverage(true,x1),coverage(false,y0),coverage(false,y1)];
    result.outlineSupport=support;
    if(support.filter(v=>v>.25).length>=3&&support.reduce((a,b)=>a+b,0)>=1.8){
      const shell=[[x0-2,y0-2,x1+2,y0],[x0-2,y1,x1+2,y1+2],[x0-2,y0,x0,y1],[x1,y0,x1+2,y1]];
      const enclosed=enclosedCadRooms(b.concat(shell),texts);
      const total=rooms=>rooms.reduce((sum,r)=>sum+floorRingArea(r.poly)-r.holes.reduce((a,h)=>a+floorRingArea(h),0),0);
      if(total(enclosed.rooms)>total(result.rooms)*1.01){result=enclosed;result.outlineInferred=true;result.outlineSupport=support;result.warnings.push('外围护线存在开口，地面外边界已根据外围墙线补齐；请核对入口与开放区域');}
    }
  }return result;
}
