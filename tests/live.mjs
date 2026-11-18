// Optional live smoke test: read-only official fare requests; never places orders.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {today,addDays} from '../fares.mjs';
const {chromium}=await import(process.env.PW_MODULE_PATH || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),profile=await mkdtemp(join(tmpdir(),'fare-live-test-'));
const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',executablePath:process.env.PW_CHROMIUM_EXECUTABLE_PATH || undefined,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
try {
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker',{timeout:15000});
  const page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`);
  const day=addDays(today(),20);
  const results=await page.evaluate(async day=>{
    const {FareClient}=await import('./fares.mjs'),controller=new AbortController(),client=new FareClient(controller.signal),results=[];
    const timer=setTimeout(()=>controller.abort(),150000);
    try {
      for(const [origin,destination,provider] of [['CBR','SYD','flixbus'],['ABX','MEL','flixbus'],['BNE','SYD','flixbus'],['CBR','SYD','train'],['BNE','SYD','train']]) {
        const job={day,origin,destination,provider};
        try{const rows=await client.search(job);results.push({...job,status:'ok',count:rows.length,lowest:rows.length?Math.min(...rows.map(r=>r.price_aud)):null});}
        catch(e){results.push({...job,status:'error',error:e.message});}
      }
    }finally{clearTimeout(timer);await client.close();}
    return results;
  },day);
  console.log(JSON.stringify(results,null,2));
  if(results.some(r=>r.status==='error'))process.exitCode=1;
}finally{await context.close();await rm(profile,{recursive:true,force:true});}
