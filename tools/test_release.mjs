// Start python launch.py --no-browser first. From tools/: npm install;
// npx playwright install chromium; node test_release.mjs [--import] [--render].
// Uses private browser storage; optional import writes a named test asset locally.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const tools=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(tools);
const require=createRequire(path.join(process.env.CADTOUR_TEST_RUNTIME||tools,'package.json'));
const {chromium}=require('playwright');
const base=process.env.CADTOUR_TEST_URL||'http://127.0.0.1:4180';
const browser=await chromium.launch({executablePath:process.env.CADTOUR_TEST_BROWSER||undefined,headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[],external=[],failed=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))failed.push([r.status(),r.url()]);});
await page.route('**/*',async route=>{
  const url=route.request().url();
  if(/^https?:/.test(url)&&!url.startsWith(base+'/')){external.push(url);return route.abort();}
  if(url===base+'/'){
    const response=await route.fetch();
    const html=(await response.text()).replace('window.View3D = {enter,',`window.__releaseTest={
      settled:()=>!anim&&grow===1,
      ready:()=>readyFurnitureAssets(),
      fixture:()=>{fly=null;opt.fullWalls=true;opt.cut=H;opt.labels=false;sync(true);showLabels(false);camera.position.set(wx(3400),1.6,wz(4400));orbit.target.set(wx(2200),.5,wz(3000));camera.lookAt(orbit.target);camera.updateMatrixWorld(true);updateCeilingVisibility();renderer.render(scene,camera);},
      export:async()=>{renderPrefs.resolution=512;renderPrefs.quality='standard';const previous=renderSession;renderSession={camera:camera.clone()};try{return await exportCyclesScene(renderSession);}finally{renderSession=previous;}}
    };window.View3D = {enter,`);
    return route.fulfill({response,body:html});
  }
  return route.continue();
});
const id='user_0123456789abcdef0123456789abcdef';
const checks=[];
try{
  await fs.mkdir(path.join(root,'outputs'),{recursive:true});
  await page.goto(base+'/');await page.waitForFunction(()=>!!window.View3D);
  await page.evaluate(()=>AssetLibrary.ready);
  const types=await page.evaluate(()=>LIB.flatMap(g=>g.items.map(i=>i[0])));
  assert.ok(types.includes(id));assert.ok(!types.includes('hertfordchair'));assert.ok(types.includes('chair'));
  await page.locator('[data-view="3d"]').click();
  await page.waitForFunction(()=>window.__releaseTest.settled());await page.evaluate(()=>window.__releaseTest.ready());
  checks.push('Default procedural scene loads without external network requests');
  await page.locator('[data-view="2d"]').click();
  await page.locator('#cadIn').setInputFiles(path.join(root,'examples/demo-office.dxf'));
  await page.waitForFunction(()=>state.cadPlan?.sourceName?.includes('demo-office'));
  const cad=await page.evaluate(()=>({walls:WALLS.length,rooms:ROOMS.length}));
  assert.ok(cad.walls>=4);assert.ok(cad.rooms>=2);
  await page.evaluate(id=>mutate(()=>{state.furniture=[F(id,'Demo Table',2200,3000,800,600,0,'#ffffff')];}),id);
  await page.locator('[data-view="3d"]').click();await page.waitForFunction(()=>window.__releaseTest.settled());
  await page.evaluate(()=>window.__releaseTest.fixture());await page.evaluate(()=>window.__releaseTest.ready());
  const payload=await page.evaluate(()=>window.__releaseTest.export());
  assert.equal(payload.metadata.nativeFurniture.length,1);assert.equal(payload.metadata.nativeFurniture[0].type,id);
  checks.push('Synthetic DXF import, sample GLB placement and native BLEND export metadata');
  await page.screenshot({path:path.join(root,'outputs/release-web.png')});
  const headers={'Content-Type':'application/json','X-CADtour':'1'};
  const font=await fetch(base+'/api/wall-text/outlines',{method:'POST',headers,body:JSON.stringify({font:'yahei',text:'诊室 Demo'})});
  assert.equal(font.status,200);assert.ok((await font.json()).glyphs['诊'].paths.length);
  checks.push('Windows Chinese/English font outline endpoint');
  if(process.argv.includes('--import')){
    const shipped=await fs.readFile(path.join(root,'assets/models/catalog.json'),'utf8');
    await page.evaluate(()=>AssetLibrary.open());
    await page.locator('#assetFiles').setInputFiles(path.join(root,'assets/models','user-'+id.slice(5),'model.glb'));
    await page.locator('#assetName').fill('Release validation table');
    await page.locator('#assetCategory').fill('Validation');
    await page.locator('#assetPrepare').click();
    await page.waitForFunction(()=>document.querySelector('#assetPublish')&&!document.querySelector('#assetPublish').disabled,null,{timeout:180000});
    await page.locator('#assetPublish').click();await page.waitForFunction(()=>!document.querySelector('#assetDialog').open);
    assert.equal(await fs.readFile(path.join(root,'assets/models/catalog.json'),'utf8'),shipped);
    const local=JSON.parse(await fs.readFile(path.join(root,'assets/models/catalog.local.json'),'utf8'));
    assert.ok(local.items.some(i=>i.name==='Release validation table'));
    checks.push('Actual GLB upload, Blender conversion, interactive preview, publish into ignored local catalog');
  }
  if(process.argv.includes('--render')){
    const response=await fetch(base+'/api/cycles/jobs',{method:'POST',headers,body:JSON.stringify(payload)});
    assert.equal(response.status,202);let job=await response.json();
    const until=Date.now()+300000;
    while(!['done','failed','cancelled'].includes(job.state)&&Date.now()<until){await new Promise(r=>setTimeout(r,1500));job=await(await fetch(base+'/api/cycles/jobs/'+job.id)).json();}
    assert.equal(job.state,'done',JSON.stringify(job));
    await fs.writeFile(path.join(root,'outputs/release-cycles.png'),Buffer.from(await(await fetch(base+job.image)).arrayBuffer()));
    await fs.writeFile(path.join(root,'outputs/release-render-job.json'),JSON.stringify(job,null,2));
    checks.push('Real Cycles image and downloadable BLEND scene with native sample table');
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
  const result={passed:true,checks,externalRequests:external.length,pageErrors:errors.length,cad};
  await fs.writeFile(path.join(root,'outputs/release-browser-validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
