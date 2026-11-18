// Cache identity includes every input that changes the fare request.
export const CACHE_VERSION = 2;
export const jobKey = j => `${j.provider}|${j.origin}|${j.destination}|${j.day}|adult:1|AUD`;
export const emptySelection = () => ({outbound:null, inbound:null});
export function selectDay(selection, day, tripType) {
  if (tripType === 'oneway') return {outbound:day,inbound:null};
  if (selection.inbound) return selection;
  if (!selection.outbound) return {outbound:day,inbound:null};
  if (day < selection.outbound) return selection;
  return {...selection,inbound:day};
}
export const calendarLeg = (config, selection) => config.tripType === 'roundtrip' && selection.outbound ? 'inbound' : 'outbound';
export function legRoute(config, leg) {
  return leg === 'inbound' ? {origin:config.destination,destination:config.origin} : {origin:config.origin,destination:config.destination};
}
export function legRows(rows, config, leg, day) {
  const {origin,destination}=legRoute(config,leg);
  return rows.filter(r=>r.direction===`${origin}→${destination}` && (!day || r.date===day));
}
export function cacheEntry(cache, job) {
  const entry=cache?.entries?.[jobKey(job)];
  return entry?.status==='ok' && Array.isArray(entry.rows) ? entry : null;
}
export function remember(cache, job, rows, checkedAt=new Date().toISOString()) {
  cache.entries[jobKey(job)]={...job,status:'ok',rows,checkedAt};
}
export function migrateSnapshot(old) {
  if (!old) return null;
  if (old.version===2) return {...old,selection:old.selection || emptySelection()};
  const reverse=old.config.direction==='syd-mel';
  return {...old,version:2,config:{start:old.config.start,end:old.config.end,provider:old.config.provider,
    origin:reverse?'SYD':'MEL',destination:reverse?'MEL':'SYD',tripType:old.config.direction==='both'?'roundtrip':'oneway'},selection:emptySelection()};
}
export function hydrateCache(stored, snapshot) {
  const cache=stored?.version===CACHE_VERSION && stored.entries ? stored : {version:CACHE_VERSION,entries:{}};
  // v1 queries used to be discarded on a new scan; recover the remaining snapshot.
  for (const query of snapshot?.queries || []) {
    if(query.status!=='ok' || cacheEntry(cache,query)) continue;
    const provider=query.provider==='flixbus'?'FlixBus':'NSW TrainLink';
    const rows=snapshot.rows.filter(r=>r.provider===provider && r.date===query.day && r.direction===`${query.origin}→${query.destination}`);
    remember(cache,query,rows,query.checkedAt || rows[0]?.checked_at || snapshot.startedAt);
  }
  return cache;
}
export function createSnapshot(config,jobs,cache,refresh=false) {
  const snapshot={version:2,config,jobs,rows:[],queries:[],selection:emptySelection(),startedAt:new Date().toISOString()};
  // Load all hits before requesting missing dates, including non-contiguous ranges.
  if(!refresh) for(const job of jobs) {
    const entry=cacheEntry(cache,job);
    if(!entry) continue;
    snapshot.rows.push(...entry.rows);
    snapshot.queries.push({...job,status:'ok',fares:entry.rows.length,checkedAt:entry.checkedAt,cached:true});
  }
  return snapshot;
}
export function pendingJobs(snapshot) {
  const completed=new Set(snapshot.queries.map(jobKey));
  return snapshot.jobs.filter(j=>!completed.has(jobKey(j)));
}
export function monthCells(month) {
  const first=new Date(`${month}-01T00:00:00Z`);
  const offset=(first.getUTCDay()+6)%7;
  const count=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  return Array.from({length:Math.ceil((offset+count)/7)*7},(_,i)=> i<offset || i>=offset+count ? null : `${month}-${String(i-offset+1).padStart(2,'0')}`);
}
export function shiftMonth(month,delta) {
  const date=new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth()+delta);
  return date.toISOString().slice(0,7);
}
