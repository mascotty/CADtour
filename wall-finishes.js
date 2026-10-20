/* Saved finish IDs are independent of texture paths and renderer settings. */
globalThis.WALL_FINISHES = Object.freeze({
  plain: {name:'纯色墙面', english:'Plain wall',colour:'#f4f1eb'},
  wallpaper001b: {
    name:'白色颗粒墙纸', english:'White textured wallpaper',
    root:'assets/materials/wallpaper-001b/web/', tileSize:1, normalStrength:.3,colour:'#ffffff'
  }
});
function wallFinishFields(e){
  const id=Object.hasOwn(WALL_FINISHES,e.wallFinish)?e.wallFinish:'plain', textured=id!=='plain';
  const colourId=e.type==='wall'?'archColor':'archWallColor',colour=e.type==='wall'?e.color:e.wallColor;
  return `<div style="grid-column:1/-1"><h3>${tr(e.type==='wall'?'墙面材质':'墙体部分材质','Wall finish')}</h3>
      <input id="archWallFinish" type="hidden" value="${id}">
      <div class="mats" id="archWallFinishCards">${Object.entries(WALL_FINISHES).map(([key,f])=>`<button type="button" class="mat ${id===key?'on':''}" data-wall-finish="${key}" aria-pressed="${id===key}"><i style="background-color:${f.colour};${f.root?`background-image:url('${f.root}Color.jpg');background-size:cover;`:''}"></i><span>${tr(f.name,f.english)}</span></button>`).join('')}</div>
      <div class="form" style="margin-top:10px"><label>${tr('自定义颜色','Custom colour')}<input id="${colourId}" type="color" value="${colour||WALL_FINISHES[id].colour}"></label></div>
      <button type="button" class="btn" id="archWallColourReset">${tr('使用材料原色','Use original material colour')}</button>
    </div>
    <div id="archFinishSettings" style="grid-column:1/-1;display:${textured?'block':'none'}">
      <label>${tr('纹理重复尺寸（m）','Texture repeat size (m)')}<input id="archWallTextureSize" type="number" min="0.1" max="10" step="0.1" value="${e.wallTextureSize??1}"></label>
      <label>${tr('凹凸强度（0–1）','Normal strength (0–1)')}<input id="archWallNormalStrength" type="number" min="0" max="1" step="0.05" value="${e.wallNormalStrength??.3}"></label>
      <p class="muted">${tr('尺寸越小，纹理越密。颜色会叠加到贴图上，设为白色可保留贴图原色。只影响实体墙面，不影响玻璃和边框。','Smaller sizes repeat more often. White keeps the original texture colour. Glass and frames are unchanged.')}</p>
    </div><p class="muted" style="grid-column:1/-1;margin:0">${e.id?tr('点击材质即生效。仅修改此构件的实体墙面。','Choose a finish to apply it immediately to this piece’s solid wall surfaces.'):tr('材质用于接下来绘制的构件。','This finish applies to the next pieces you draw.')}</p>`;
}
function bindWallFinish(onChange,type){
  const input=document.querySelector('#archWallFinish');if(!input)return;
  const colourKey=type==='wall'?'color':'wallColor',colourInput=document.querySelector(type==='wall'?'#archColor':'#archWallColor');
  document.querySelectorAll('#archWallFinishCards [data-wall-finish]').forEach(button=>button.onclick=()=>{
    const id=button.dataset.wallFinish;input.value=id;
    document.querySelector('#archFinishSettings').style.display=id==='plain'?'none':'block';
    document.querySelectorAll('#archWallFinishCards [data-wall-finish]').forEach(card=>{card.classList.toggle('on',card===button);card.setAttribute('aria-pressed',String(card===button));});
    colourInput.value=WALL_FINISHES[id].colour;
    onChange?.({wallFinish:id,[colourKey]:colourInput.value});
  });
  colourInput.onchange=()=>onChange?.({[colourKey]:colourInput.value});
  document.querySelector('#archWallColourReset').onclick=()=>{colourInput.value=WALL_FINISHES[input.value].colour;onChange?.({[colourKey]:colourInput.value});};
  for(const [id,key,min,max] of [['archWallTextureSize','wallTextureSize',.1,10],['archWallNormalStrength','wallNormalStrength',0,1]]){
    document.getElementById(id).onchange=event=>{
      const value=Number(event.target.value);
      if(!Number.isFinite(value)||value<min||value>max)return toast(tr('纹理尺寸应为 0.1–10 m，凹凸强度应为 0–1。','Texture size must be 0.1–10 m and normal strength 0–1.'));
      onChange?.({[key]:value});
    };
  }
}
function applyWallFinish(e,patch){
  const current=getArchitecture(e.id);if(!current||current.hidden)return;
  if(Object.entries(patch).every(([key,value])=>current[key]===value))return;
  // Material clicks do not apply or discard geometry values being edited.
  const pending=Array.from(document.querySelectorAll('#panel input,#panel select'),field=>[field.id,field.value]);
  mutate(()=>{
    if(current.source==='added')Object.assign(state.architecture.added.find(item=>item.id===e.id),patch);
    else state.architecture.overrides[e.id]={...state.architecture.overrides[e.id],...patch};
  });
  const draft={...e,...patch};
  document.querySelector('#panel').innerHTML=architecturePanel(draft);bindArchitecturePanel(draft);
  const changed=new Set(Object.keys(patch).map(key=>({wallFinish:'archWallFinish',color:'archColor',wallColor:'archWallColor',wallTextureSize:'archWallTextureSize',wallNormalStrength:'archWallNormalStrength',skirtingHeight:'archSkirtingHeight',skirtingColor:'archSkirtingColor'})[key]));
  for(const [id,value] of pending)if(!changed.has(id)){const field=document.getElementById(id);if(field)field.value=value;}
}
