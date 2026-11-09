// Real Chromium extension E2E against a synthetic ChatGPT-shaped page, never a real account.
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

const temporary=await mkdtemp(path.join(tmpdir(),'vignet-browser-'));
const extension=path.join(temporary,'extension');
const bridge=new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(resolve=>bridge.once('listening',resolve));
bridge.on('connection',ws=>ws.on('message',raw=>{const message=JSON.parse(String(raw));if(message.type==='hello')ws.send(JSON.stringify({type:'welcome',deviceId:message.deviceId}));}));
let context;
try {
  await cp('dist/extension',extension,{recursive:true});
  // Redirect only the disposable test extension's default transport to the test fixture.
  const background=path.join(extension,'background.js');
  await writeFile(background,(await readFile(background,'utf8')).replaceAll('ws://127.0.0.1:8788/extension',`ws://127.0.0.1:${bridge.address().port}/extension`));
  context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  console.log('Browser started, extension worker:',worker.url());
  const extensionId=new URL(worker.url()).host;
  await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title>Vignet synthetic ChatGPT fixture</title></head><body><h1>Synthetic Chat A</h1><button id="fixture-button">Clickable page</button></body></html>'}));
  const chat=await context.newPage();await chat.goto('https://chatgpt.com/c/chat-a');
  const ui=await context.newPage();ui.on('pageerror',error=>console.error('UI page error:',error.message));await ui.goto(`chrome-extension://${extensionId}/ui/index.html`);
  try {await ui.locator('#assets .card').first().waitFor({timeout:15000});}
  catch(error){console.error('UI diagnostic:',await ui.locator('body').innerText());console.error('Worker diagnostic:',await worker.evaluate(()=>({runtime:chrome.runtime.id})));throw error;}
  async function command(command,args={}) {
    const result=await ui.evaluate(({command,args})=>Promise.race([chrome.runtime.sendMessage({type:'VIGNET_UI',command,args}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Background command timeout')),12000))]),{command,args});
    assert.equal(result.ok,true,`${command}: ${JSON.stringify(result)}`);return result;
  }
  async function contexts() {return (await command('get_contexts')).contexts;}
  await ui.waitForFunction(()=>document.querySelector('#target option[value]:not([value=""])'));
  const tabId=(await contexts()).find(c=>c.url.includes('chat-a')).tabId;
  const target={tabId};
  const assetsBefore=(await command('list_assets')).assets;
  assert.deepEqual(assetsBefore.map(asset=>asset.id),['builtin.vignette']);
  await ui.locator('#file').setInputFiles(path.resolve('dist/packages/rain.vignet'));
  await ui.locator('#review:not([hidden])').waitFor();
  assert.equal((await command('list_assets')).assets.length,1,'import review must not install');
  await ui.locator('#review input[type=checkbox]').evaluateAll(boxes=>boxes.forEach(box=>box.checked=true));
  await ui.getByRole('button',{name:'Подтвердить установку',exact:true}).click();
  await ui.locator('#review').waitFor({state:'hidden'});
  assert.equal((await command('list_assets')).assets.length,2);
  assert.equal(await chat.locator('[data-vignet-instance]').count(),0,'installation must not launch scripts');
  const vignette=await command('run_asset',{assetId:'builtin.vignette',parameters:{enabled:true,color:'#ff0000',opacity:0.7,innerRadius:40},scope:'current_chat',target});
  assert.equal(vignette.status,'running');
  assert.equal(await chat.locator(`#vignet-${vignette.instanceId}`).count(),1);
  await command('stop_asset',{instanceId:vignette.instanceId});
  console.log('PASS real Chromium: UI review/consent/install + IndexedDB + legacy-compatible vignette mount/stop');

  const settings=await context.newPage();await settings.goto('chrome://extensions');
  const scriptAccess=await settings.evaluate(async id=>{
    try {
      await chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});
      await chrome.developerPrivate.updateExtensionConfiguration({extensionId:id,userScriptsAccess:true});
      return {ok:true};
    }catch(error){return {ok:false,error:error.message};}
  },extensionId);
  console.log('Allow User Scripts setup:',JSON.stringify(scriptAccess));
  await settings.close();
  const availability=await worker.evaluate(async()=>{try{return {available:Boolean(chrome.userScripts?.execute),scripts:await chrome.userScripts.getScripts()};}catch(error){return {available:false,error:error.message};}});
  if(!availability.available)throw new Error(`Browser JS scenario blocked: ${JSON.stringify(availability)}`);
  console.log('PASS real Chromium: Allow User Scripts enabled');
  const rain=await command('run_asset',{assetId:'community.rain',parameters:{intensity:80,sound:false},scope:'current_chat',target});
  assert.equal(rain.status,'running');
  await chat.locator(`[data-vignet-instance="${rain.instanceId}"]`).waitFor();
  const rainHost=chat.locator(`[data-vignet-instance="${rain.instanceId}"]`);
  assert.equal(await rainHost.locator('.rain i').count(),112);
  await command('update_asset_instance',{instanceId:rain.instanceId,parameters:{intensity:60}});
  assert.equal(await rainHost.locator('.rain i').count(),84,'update must replace rather than accumulate particles');
  assert.equal(await rainHost.count(),1,'update must not duplicate host');
  async function resourceUrl() {
    const results=await worker.evaluate(async({tabId,instanceId})=>chrome.userScripts.execute({target:{tabId,frameIds:[0]},world:'USER_SCRIPT',worldId:`vignet-${instanceId.replace(/[^a-zA-Z0-9-]/g,'-')}`,js:[{code:`globalThis.__vignetInstances.get(${JSON.stringify(instanceId)}).context.resource('media/drop.webp')`}] }),{tabId,instanceId:rain.instanceId});
    return results[0].result;
  }
  const blobUrl=await resourceUrl();
  assert.match(blobUrl,/^blob:/,'runtime SDK must resolve local media to Blob URL');
  assert.equal(await chat.evaluate(async url=>{try{return (await fetch(url)).ok;}catch{return false;}},blobUrl),true);
  const themeBytes=Array.from(await readFile('dist/packages/example-theme.vignet'));
  await command('install_package',{bytes:themeBytes,confirmed:true,grantedPermissions:['dom_overlay'],replace:false});
  const theme=await command('run_asset',{assetId:'example.theme',parameters:{},scope:'global',target});
  assert.equal(await chat.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(20, 35, 48)');
  const media=(await command('dashboard')).media;
  assert.equal(media.filter(resource=>resource.owners?.includes('community.rain')&&resource.owners?.includes('example.theme')).length,2,'shared MP3/WebP physically deduplicated');
  await chat.evaluate(()=>history.pushState({},'','/c/chat-b'));
  await rainHost.waitFor({state:'detached'});
  assert.equal(await chat.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(20, 35, 48)','global theme survives A → B');
  await chat.evaluate(()=>history.pushState({},'','/c/chat-a'));
  await rainHost.waitFor();assert.equal(await rainHost.locator('.rain i').count(),84);
  console.log('PASS real Chromium: live Rain update, media URL resolution/dedup, A/B cleanup+restore and persistent global CSS');
  await chat.reload();await rainHost.waitFor();assert.equal(await rainHost.locator('.rain i').count(),84);
  for(const ws of bridge.clients)ws.close();
  assert.equal(await rainHost.locator('.rain i').count(),84,'Bridge disconnect must not stop running effect');
  const beforeStopUrl=await resourceUrl();
  await command('stop_asset',{instanceId:rain.instanceId});
  await rainHost.waitFor({state:'detached'});
  assert.equal(await chat.evaluate(async url=>{try{return (await fetch(url)).ok;}catch{return false;}},beforeStopUrl),false,'stop must revoke managed Blob URL');
  await command('stop_asset',{instanceId:theme.instanceId});
  assert.notEqual(await chat.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(20, 35, 48)');
  await command('delete_asset',{assetId:'community.rain'});
  const remaining=(await command('dashboard')).media;
  assert.equal(remaining.filter(resource=>resource.owners?.includes('example.theme')).length,3,'deleting Rain retains theme and both shared resources');
  console.log('PASS real Chromium: reload restore, disconnected Bridge independence, stop Blob revocation and shared media retention');
  console.log('PASS real Chromium: USER_SCRIPT Rain starts with confirmed execution');
} finally {
  await context?.close();
  for(const ws of bridge.clients)ws.terminate();
  await new Promise(resolve=>bridge.close(resolve));
  await rm(temporary,{recursive:true,force:true});
}
