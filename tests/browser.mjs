import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {addDays,today,FLIX_IDS} from '../fares.mjs';
import {shiftMonth} from '../planner.mjs';
const {chromium}=await import(process.env.PW_MODULE_PATH || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),profile=await mkdtemp(join(tmpdir(),'fare-calendar-test-'));
const output=resolve(root,'test-results');await mkdir(output,{recursive:true});
const context=await chromium.launchPersistentContext(profile,{
  headless:true,channel:'chromium',executablePath:process.env.PW_CHROMIUM_EXECUTABLE_PATH || undefined,
  args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`],viewport:{width:1440,height:1100}
});
try {
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host,page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let requests=0,failDay=null,delay=0;
  await context.route('https://global.api.flixbus.com/**',async route=>{
    requests++;const params=new URL(route.request().url()).searchParams;
    const day=params.get('departure_date').split('.').reverse().join('-');
    if(delay) await new Promise(r=>setTimeout(r,delay));
    if(day===failDay) {await route.fulfill({status:503,body:'Temporary error'});return;}
    const from=params.get('from_city_id'),to=params.get('to_city_id');
    const reverse=from===FLIX_IDS.SYD;
    const prices=reverse?[77,19,42]:[68,12,35];
    const data={success:true,stations:{a:{name:'Central'},b:{name:'City Station'}},trips:[{departure_city_id:from,arrival_city_id:to,results:Object.fromEntries(prices.map((price,i)=>[String(i),{status:'available',available:{seats:5},price:{total:price,total_with_platform_fee:price+1},departure:{date:`${day}T${String(i+7).padStart(2,'0')}:00:00+11:00`,station_id:'a'},arrival:{date:`${day}T${String(i+10).padStart(2,'0')}:00:00+11:00`,station_id:'b'},legs:[{means_of_transport:'bus'}]}]))}]};
    // One successfully queried date has no departures.
    if(day.endsWith('-28')) data.trips[0].results={};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(`chrome-extension://${id}/app.html`);
  await page.waitForFunction(()=>document.querySelector('#origin').options.length===5);
  const start=shiftMonth(today().slice(0,7),1)+'-27',end=addDays(start,7);
  async function setRange(a,b) {await page.locator('#start').fill(a);await page.locator('#end').fill(b);}
  async function scan() {await page.locator('#search').click();await page.waitForFunction(()=>/^(查询完成|查询结束)/.test(document.querySelector('#status').textContent));}
  await page.locator('#provider').selectOption('flixbus');await setRange(start,end);await scan();
  assert.equal(requests,8);assert.equal(await page.locator('#calendar').isVisible(),true);
  await page.locator(`[data-day="${start}"]`).click();
  assert.deepEqual(await page.locator('.fare-price').allTextContents(),['$13.00','$36.00','$69.00']);
  await page.locator(`[data-day="${addDays(start,1)}"]`).click();assert.equal(await page.locator('.fare-card').count(),0);
  assert.match(await page.locator('.column-status').textContent(),/已查无票/);
  await scan();assert.equal(requests,8,'repeated query must use cache including empty dates');
  assert.match(await page.locator('#progress-note').textContent(),/复用缓存 8 项/);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#progress-count').textContent==='8 / 8');
  await page.locator('#tripType').selectOption('roundtrip');await scan();assert.equal(requests,16,'roundtrip requests only missing reverse leg');
  await page.locator(`[data-day="${start}"]`).click();assert.match(await page.locator('#leg-label').textContent(),/返程价格/);
  assert.match(await page.locator(`[data-day="${start}"] .day-price`).textContent(),/20.00/);
  await page.locator('#next-month').click();await page.locator(`[data-day="${end}"]`).click();
  assert.deepEqual(await page.locator('[data-leg="inbound"] .fare-price').allTextContents(),['$20.00','$43.00','$78.00']);
  assert.equal(await page.locator('button.day:enabled').count(),0,'third click is blocked');
  await page.screenshot({path:join(output,'roundtrip-desktop.png'),fullPage:true});
  await page.reload();await page.waitForFunction(()=>document.querySelector('#selection-hint').textContent.includes('选择已锁定'));
  assert.equal(await page.locator('button.day:enabled').count(),0);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'roundtrip-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile layout must not overflow');
  await page.locator('#reset-selection').click();assert.match(await page.locator('#leg-label').textContent(),/去程价格/);
  await page.locator('#prev-month').click();await page.locator(`[data-day="${addDays(start,2)}"]`).click();
  assert.equal(await page.locator(`[data-day="${start}"]`).isDisabled(),true,'return cannot precede outbound');
  await page.locator(`[data-day="${addDays(start,2)}"]`).click();assert.match(await page.locator('#selection-hint').textContent(),/选择已锁定/);
  await page.locator('#max').fill('15');assert.equal(await page.locator('[data-leg="outbound"] .fare-card').count(),1);assert.equal(await page.locator('[data-leg="inbound"] .fare-card').count(),0);
  await page.locator('#max').fill('');
  // New city, explicit refresh, error retry and successful-cache isolation.
  await page.locator('#origin').selectOption('CBR');await page.locator('#destination').selectOption('ABX');await page.locator('#tripType').selectOption('oneway');await setRange(start,start);await scan();assert.equal(requests,17);
  await page.locator('#refresh').check();await scan();assert.equal(requests,18);
  failDay=start;await page.locator('#refresh').check();await scan();assert.equal(requests,19);assert.equal(await page.locator('#retry').isVisible(),true);
  failDay=null;await scan();assert.equal(requests,20,'failed refresh must not restore old cached result');
  failDay=start;await page.locator('#refresh').check();await scan();failDay=null;
  await page.locator('#retry').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('查询完成'));assert.equal(requests,22);
  // Pause during a delayed response; resume fills only the remaining jobs.
  await setRange(addDays(end,1),addDays(end,3));delay=1500;
  await page.locator('#search').click();await page.waitForFunction(()=>document.querySelector('#stop').hidden===false);
  await page.locator('#stop').click();await page.waitForFunction(()=>document.querySelector('#resume').hidden===false);
  delay=0;await page.reload();await page.waitForFunction(()=>document.querySelector('#resume').hidden===false);
  await page.locator('#resume').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('查询完成'));
  assert.equal(await page.locator('#progress-count').textContent(),'3 / 3');
  // Cached route survives querying another route.
  await page.locator('#origin').selectOption('MEL');await page.locator('#destination').selectOption('SYD');await setRange(start,end);const before=requests;await scan();assert.equal(requests,before);
  assert.deepEqual(errors,[]);
  const saved=await page.evaluate(async()=>await chrome.storage.local.get(['snapshot','fareCache']));
  assert.equal(saved.snapshot.version,2);assert.ok(Object.keys(saved.fareCache.entries).length>=19);
  console.log('PASS: actual MV3 extension, route selection, cache/no-ticket reuse, reload, two-leg sorting/lock/reset, cross-month/same-day selection, filters, refresh/error retry, pause/resume and mobile overflow.');
  console.log(`Mock requests: ${requests}. Screenshots: ${output}`);
} finally {await context.close();await rm(profile,{recursive:true,force:true});}
