import test from 'node:test';
import assert from 'node:assert/strict';
import {CITIES,makeJobs,parseFlix,parseTrain,filterRows,csv,addDays,validDay,FLIX_IDS,bookingURL} from '../fares.mjs';
import {jobKey,emptySelection,selectDay,calendarLeg,legRows,hydrateCache,remember,createSnapshot,pendingJobs,migrateSnapshot,monthCells,shiftMonth} from '../planner.mjs';
const config={origin:'MEL',destination:'SYD',tripType:'oneway',provider:'both',start:'2030-01-30',end:'2030-02-02'};
const jobs=c=>makeJobs(c,'2030-01-01');
const job={day:config.start,origin:'MEL',destination:'SYD',provider:'flixbus'};
const fare={provider:'FlixBus',direction:'MEL→SYD',date:config.start,price_aud:30,departure:'2030-01-30T12:00:00+11:00',arrival:'2030-01-31T01:00:00+11:00',duration_minutes:780,transfers:0,from_station:'Southern Cross',to_station:'Central',checked_at:'2029-12-01T00:00:00Z'};
test('five cities generate directional jobs for both providers',()=>{
  assert.equal(CITIES.length,5);
  for(const from of CITIES) for(const to of CITIES.filter(c=>c!==from)) {
    const result=jobs({...config,origin:from.id,destination:to.id});assert.equal(result.length,8);
    assert.ok(result.every(j=>j.origin===from.id && j.destination===to.id));
  }
});
test('roundtrip covers both directions and inclusive dates across months',()=>{
  const result=jobs({...config,tripType:'roundtrip'});assert.equal(result.length,16);
  assert.equal(result.filter(j=>j.origin==='SYD').length,8);assert.equal(result.at(-1).day,'2030-02-02');
});
test('reject same city, unknown city, invalid range and over 180 days',()=>{
  for(const overrides of [{destination:'MEL'},{origin:'BAD'},{start:'2029-12-01'},{end:'2030-01-01'},{end:'2031-01-01'},{tripType:'both'},{provider:'invalid'}]) assert.throws(()=>jobs({...config,...overrides}));
  assert.equal(validDay('2030-02-30'),false);assert.equal(addDays('2032-02-28',1),'2032-02-29');
});
test('cache isolates route, date and provider',()=>{
  const cache=hydrateCache(null,null);remember(cache,job,[fare],'2029-12-01T00:00:00Z');
  const s=createSnapshot(config,jobs(config),cache);assert.equal(s.queries.length,1);assert.equal(s.rows.length,1);assert.equal(pendingJobs(s).length,7);
  assert.notEqual(jobKey(job),jobKey({...job,origin:'SYD',destination:'MEL'}));assert.notEqual(jobKey(job),jobKey({...job,provider:'train'}));
  assert.equal(createSnapshot({...config,origin:'CBR'},jobs({...config,origin:'CBR'}),cache).queries.length,0);
});
test('successful empty response remains cached',()=>{
  const cache=hydrateCache(null,null);remember(cache,job,[]);const s=createSnapshot(config,[job],cache);
  assert.equal(s.queries[0].fares,0);assert.equal(pendingJobs(s).length,0);
});
test('overlapping and non-contiguous ranges load all hits without re-query',()=>{
  const all=jobs(config),cache=hydrateCache(null,null);remember(cache,all[0],[]);remember(cache,all[3],[]);remember(cache,all[7],[]);
  const s=createSnapshot(config,all,cache);assert.deepEqual(pendingJobs(s),[all[1],all[2],all[4],all[5],all[6]]);
  assert.equal(createSnapshot(config,all,cache,true).queries.length,0);
});
test('v1 snapshot migration preserves both directions and caches only successes',()=>{
  const old={version:1,config:{start:config.start,end:config.end,direction:'both',provider:'both'},jobs:[job],rows:[fare],queries:[{...job,status:'ok'}, {...job,day:'2030-01-31',status:'error'}],startedAt:fare.checked_at};
  const s=migrateSnapshot(old),cache=hydrateCache(null,s);assert.equal(s.config.tripType,'roundtrip');assert.equal(s.config.origin,'MEL');
  assert.equal(Object.keys(cache.entries).length,1);assert.equal(cache.entries[jobKey(job)].rows.length,1);
  old.config.direction='syd-mel';assert.equal(migrateSnapshot(old).config.origin,'SYD');
});
test('oneway permits repeated date changes',()=>{
  let s=selectDay(emptySelection(),'2030-01-30','oneway');s=selectDay(s,'2030-02-02','oneway');assert.deepEqual(s,{outbound:'2030-02-02',inbound:null});
});
test('roundtrip flips calendar after first click, locks after second and resets',()=>{
  const c={...config,tripType:'roundtrip'};let s=emptySelection();assert.equal(calendarLeg(c,s),'outbound');
  s=selectDay(s,'2030-01-30',c.tripType);assert.equal(calendarLeg(c,s),'inbound');
  assert.equal(selectDay(s,'2030-01-29',c.tripType),s);
  s=selectDay(s,'2030-02-02',c.tripType);assert.equal(selectDay(s,'2030-02-03',c.tripType),s);
  assert.equal(calendarLeg(c,emptySelection()),'outbound');
});
test('same-day return is selectable',()=>{let s=selectDay(emptySelection(),'2030-01-30','roundtrip');s=selectDay(s,'2030-01-30','roundtrip');assert.equal(s.inbound,s.outbound);});
test('calendar handles leap years, Monday alignment and December rollover',()=>{
  const cells=monthCells('2024-02');assert.equal(cells[3],'2024-02-01');assert.equal(cells.filter(Boolean).length,29);assert.equal(cells.length%7,0);
  assert.equal(shiftMonth('2030-12',1),'2031-01');assert.equal(shiftMonth('2031-01',-1),'2030-12');
});
test('filters and both legs retain numeric ascending price order',()=>{
  const rows=filterRows([{...fare,price_aud:100},{...fare,price_aud:9},{...fare,price_aud:20,direction:'SYD→MEL'},{...fare,price_aud:2,transfers:1}],{direct:true});
  assert.deepEqual(legRows(rows,config,'outbound',config.start).map(r=>r.price_aud),[9,100]);
  assert.deepEqual(legRows(rows,config,'inbound',config.start).map(r=>r.price_aud),[20]);
  assert.equal(filterRows([{...fare,from_station:'Sydney Airport'}],{central:true}).length,0);
});
function flixFixture(){return {success:true,trips:[{departure_city_id:FLIX_IDS.MEL,arrival_city_id:FLIX_IDS.SYD,results:{a:{status:'available',available:{seats:1},price:{total:25,total_with_platform_fee:30},departure:{date:fare.departure,station_id:'a'},arrival:{date:fare.arrival,station_id:'b'},legs:[{means_of_transport:'bus'}]}}}],stations:{a:{name:'Melbourne'},b:{name:'Sydney'}}};}
test('FlixBus preserves total with platform fee and validates route',()=>{
  const data=flixFixture();assert.equal(parseFlix(data,job)[0].price_aud,30);
  assert.throws(()=>parseFlix(data,{...job,origin:'CBR'}));
});
test('FlixBus missing required fee is an error, not empty inventory',()=>{
  const data=flixFixture();delete data.trips[0].results.a.price.total_with_platform_fee;data.platform_fee_in_price_required=true;assert.throws(()=>parseFlix(data,job),/平台费/);
});
test('TrainLink validates new-city route and adult offers',()=>{
  const data={trips:[{origin:{id:'CBR',name:'Canberra'},destination:{id:'SYD',name:'Sydney'},departureISODateTime:fare.departure,arrivalISODateTime:fare.arrival,legs:[{service:{mode:'REGIONAL TRAIN'}}],offers:{adult:[{minimumAvailability:2,isAccommodationTypeSleeper:false,travelClassDescription:'Economy',price:34},{minimumAvailability:2,isAccommodationTypeSleeper:true,price:99}]}}]};
  assert.equal(parseTrain(data,{...job,origin:'CBR'})[0].price_aud,34);assert.throws(()=>parseTrain(data,job));
});
test('new-city booking links preserve selected route',()=>{
  assert.match(bookingURL('FlixBus','CBR','ABX',config.start),new RegExp(FLIX_IDS.CBR));assert.match(bookingURL('NSW TrainLink','CBR','BNE',config.start),/BNE/);
});
test('CSV uses quoted fields and neutralizes spreadsheet formulas',()=>{
  const result=csv([{...fare,from_station:'=danger()'}]);assert.ok(result.startsWith('\ufeff'));assert.ok(result.includes('"\'=danger()"'));
});
