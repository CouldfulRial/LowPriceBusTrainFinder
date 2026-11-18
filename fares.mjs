// IDs verified against official FlixBus city pages and TrainLink's station list.
export const CITIES = [
  {id:'MEL',name:'墨尔本',english:'Melbourne',flix:'49547acb-d244-4d85-b25e-d04dee11a6e7'},
  {id:'SYD',name:'悉尼',english:'Sydney',flix:'faf6f1bd-c7bc-42a0-95fb-d9f475c451e1'},
  {id:'CBR',name:'堪培拉',english:'Canberra',flix:'193dee8c-884e-4641-b453-fc18d4aabd7f'},
  {id:'ABX',name:'奥尔伯里',english:'Albury',flix:'e41a3e7b-8351-41f2-bca2-aadc12da7cb6'},
  {id:'BNE',name:'布里斯班',english:'Brisbane',flix:'02ef5aa0-0b8a-47aa-865e-4ce65ce6a973'},
];
export const FLIX_IDS = Object.fromEntries(CITIES.map(c=>[c.id,c.flix]));
export const cityName = id => CITIES.find(c=>c.id===id)?.name || id;
export const TRAIN_HOME = 'https://transportnsw.info/regional-travel/booking';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function today() {
  const parts = new Intl.DateTimeFormat('en', {timeZone: 'Australia/Sydney', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date());
  const get = key => parts.find(p => p.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
export function validDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && addDays(day, 0) === day;
}
export function makeJobs(config, currentDay = today()) {
  if (!validDay(config.start) || !validDay(config.end)) throw Error('请输入有效的起止日期。');
  const days = Math.round((Date.parse(config.end) - Date.parse(config.start)) / 86400000) + 1;
  if (config.start < currentDay || days < 1 || days > 180) throw Error('请选择从今天起、长度为 1–180 天的日期范围。');
  if (!Object.hasOwn(FLIX_IDS,config.origin) || !Object.hasOwn(FLIX_IDS,config.destination) || config.origin===config.destination) throw Error('请选择不同的出发地和目的地。');
  if (!['oneway','roundtrip'].includes(config.tripType) || !['both','flixbus','train'].includes(config.provider)) throw Error('行程类型或运营商无效。');
  const directions = [[config.origin,config.destination]];
  if(config.tripType==='roundtrip') directions.push([config.destination,config.origin]);
  const providers = config.provider === 'both' ? ['flixbus','train'] : [config.provider];
  return Array.from({length:days}, (_,i) => addDays(config.start,i)).flatMap(day => directions.flatMap(([origin,destination]) => providers.map(provider => ({day,origin,destination,provider}))));
}
export function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('官网返回了无效金额，未纳入比价。');
  return Math.round(value * 100) / 100;
}
export function bookingURL(provider, origin, destination, day) {
  if (provider === 'FlixBus') return 'https://shop.flixbus.com.au/search?' + new URLSearchParams({departureCity:FLIX_IDS[origin], arrivalCity:FLIX_IDS[destination], rideDate:day.split('-').reverse().join('.'), adult:'1', currency:'AUD', sortBy:'order_by.price.asc'});
  return 'https://transportnsw.info/regional-travel/passenger-types?' + new URLSearchParams({'$':'numAdults:1', departing:day, 'destination$value':destination, returning:';;', 'tripDates$type':'oneWay', 'tripPlans@$origin$value':origin});
}
function row(provider, job, departure, arrival, fields) {
  const start = Date.parse(departure), end = Date.parse(arrival);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Error('官网返回了无效班次时间。');
  if (departure.slice(0,10) !== job.day) return null;
  return {provider, direction:`${job.origin}→${job.destination}`, date:job.day, departure, arrival,
    duration_minutes:Math.round((end-start)/60000), checked_at:new Date().toISOString(),
    booking_url:bookingURL(provider,job.origin,job.destination,job.day), ...fields};
}
export function parseFlix(data, job) {
  if (data.success === false || !Array.isArray(data.trips)) throw Error('FlixBus 未返回有效查询结果，可能需要验证或已改版。');
  const rows = [];
  for (const group of data.trips) {
    if (group.departure_city_id !== FLIX_IDS[job.origin] || group.arrival_city_id !== FLIX_IDS[job.destination]) throw Error('FlixBus 返回了不同路线。');
    for (const trip of Object.values(group.results)) {
      if (trip.status !== 'available' || !(trip.available.seats >= 1)) continue;
      const base = money(trip.price.total);
      const includesFee = Object.hasOwn(trip.price, 'total_with_platform_fee');
      if (!includesFee && (data.platform_fee_in_price_required || data.global_platform_fees?.length)) throw Error('FlixBus 未返回含平台费总价，无法可靠比价。');
      const result = row('FlixBus', job, trip.departure.date, trip.arrival.date, {
        from_station:data.stations[trip.departure.station_id].name, to_station:data.stations[trip.arrival.station_id].name,
        mode:[...new Set(trip.legs.map(l=>l.means_of_transport))].join(' + '), transfers:Math.max(0,trip.legs.length-1), fare:'Adult',
        price_aud:money(includesFee ? trip.price.total_with_platform_fee : base), base_price_aud:base,
        fee_note:includesFee ? '含平台费；不含可选加购' : '官网报价；不含可选加购'});
      if (result) rows.push(result);
    }
  }
  return rows;
}
export function decodeTrain(text) {
  const records = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]+):(.*)$/);
    if (m) { try { records[m[1]] = JSON.parse(m[2]); } catch {} }
  }
  function resolve(value, depth=0) {
    if (depth > 50) throw Error('火车返回数据包含循环引用。');
    if (typeof value === 'string') {
      if (value === '$undefined') return null;
      if (value.startsWith('$$')) return value.slice(1);
      const m = value.match(/^\$@?([0-9a-f]+)((?::[^:]+)*)$/);
      if (m) {
        let target = records[m[1]];
        for (const key of m[2].split(':').slice(1)) {
          if (typeof target === 'string') target = resolve(target, depth+1);
          if (target == null || !Object.hasOwn(target,key)) throw Error('火车数据引用格式已变化。');
          target = target[key];
        }
        return resolve(target,depth+1);
      }
    }
    if (Array.isArray(value)) return value.map(v=>resolve(v,depth+1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v,depth+1)]));
    return value;
  }
  const data = resolve(records['0']?.a);
  if (!data || !Array.isArray(data.trips) || data.error) throw Error('NSW TrainLink 查询失败、需要验证，或网页格式已变化。');
  return data;
}
export function parseTrain(data, job) {
  const rows = [];
  for (const trip of data.trips) {
    if (trip.origin.id !== job.origin || trip.destination.id !== job.destination) throw Error('NSW TrainLink 返回了不同路线。');
    for (const offers of Object.values(trip.offers)) for (const offer of offers) {
      if (!(offer.minimumAvailability >= 1) || offer.isAccommodationTypeSleeper) continue;
      const result = row('NSW TrainLink',job,trip.departureISODateTime,trip.arrivalISODateTime,{
        from_station:trip.origin.name,to_station:trip.destination.name,
        mode:[...new Set(trip.legs.map(l=>l.service.mode))].join(' + '), transfers:Math.max(0,trip.legs.length-1),
        fare:offer.travelClassDescription, price_aud:money(offer.price), base_price_aud:money(offer.price), fee_note:'普通成人官网票价'});
      if (result) rows.push(result);
    }
  }
  return rows;
}
export function filterRows(rows, filters={}) {
  return rows.filter(r => (!filters.direct || r.transfers===0) && (!filters.central || !/airport/i.test(r.from_station+r.to_station)) &&
    (filters.max === '' || filters.max == null || r.price_aud <= Number(filters.max))).sort((a,b)=>a.price_aud-b.price_aud || a.departure.localeCompare(b.departure) || a.duration_minutes-b.duration_minutes);
}
export function csv(rows) {
  const fields = ['provider','direction','departure','arrival','from_station','to_station','mode','transfers','fare','price_aud','base_price_aud','fee_note','checked_at','booking_url'];
  const escape = v => '"' + String(v ?? '').replace(/^[=+\-@]/,"'$&").replaceAll('"','""') + '"';
  return '\ufeff' + [fields,...rows.map(r=>fields.map(k=>r[k]))].map(r=>r.map(escape).join(',')).join('\r\n');
}

export class FareClient {
  constructor(signal) { this.signal=signal; this.last=0; this.trainTab=null; this.action=null; }
  async throttle() {
    this.signal.throwIfAborted();
    await sleep(Math.max(0,1100-(Date.now()-this.last)));
    this.signal.throwIfAborted(); this.last=Date.now();
  }
  async get(url) {
    await this.throttle();
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal.addEventListener('abort',abort,{once:true});
    const timer = setTimeout(abort,40000);
    try {
      const response = await fetch(url,{credentials:'omit',signal:controller.signal});
      if (response.status !== 200) throw Error(`HTTP ${response.status}，查询未完成。`);
      return await response.text();
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort',abort); }
  }
  async setupTrain() {
    const page = await this.get(TRAIN_HOME);
    const scripts = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m=>m[1]).reverse();
    for (const path of scripts) {
      if (!path.startsWith('/_next/') || /polyfills|webpack|layout/.test(path)) continue;
      const source = await this.get('https://transportnsw.info'+path);
      const match = source.match(/createServerReference\)\("([0-9a-f]+)"[^;]{0,250}?"getTrips"/);
      if (match) {this.action=match[1]; break;}
    }
    if (!this.action) throw Error('找不到火车查询接口，官网可能已改版。');
    const owner = await chrome.tabs.getCurrent();
    const tab = await chrome.tabs.create({url:TRAIN_HOME,active:false});
    this.trainTab=tab.id;
    await chrome.storage.session.set({trainHelper:{owner:owner.id,tab:tab.id}});
    const deadline=Date.now()+45000;
    while (Date.now()<deadline) {
      this.signal.throwIfAborted();
      const status=await chrome.tabs.get(tab.id);
      if (status.status==='complete') return;
      await sleep(400);
    }
    throw Error('NSW TrainLink 官网加载超时。');
  }
  async search(job) {
    if (job.provider === 'flixbus') {
      const params = new URLSearchParams({from_city_id:FLIX_IDS[job.origin],to_city_id:FLIX_IDS[job.destination],departure_date:job.day.split('-').reverse().join('.'),products:'{"adult":1}',currency:'AUD',locale:'en_AU',search_by:'cities',include_after_midnight_rides:'0',disable_distribusion_trips:'0',disable_global_trips:'0',disable_trips:'[]'});
      return parseFlix(JSON.parse(await this.get('https://global.api.flixbus.com/search/service/v4/search?'+params)),job);
    }
    if (!this.trainTab) await this.setupTrain();
    await this.throttle();
    const criteria={id:crypto.randomUUID(),origin:job.origin,destination:job.destination,departingDateTime:job.day+'T00:00:00',passengers:[{externalRef:'adult-1',age:30}]};
    // Same-origin read-only action: browser provides the correct Origin header.
    // The remote JavaScript is inspected as text above; it is never evaluated.
    const results=await chrome.scripting.executeScript({target:{tabId:this.trainTab},args:[this.action,criteria],func:async (action,criteria)=>{
      if(location.origin!=='https://transportnsw.info') return {error:'官网标签页已导航到其他站点。'};
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),40000);
      try {
        const response=await fetch('/regional-travel/booking',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'text/plain;charset=UTF-8','Accept':'text/x-component','Next-Action':action},body:JSON.stringify([criteria]),signal:controller.signal});
        if(response.status!==200) return {error:`NSW TrainLink HTTP ${response.status}`};
        return {text:await response.text()};
      } catch(e) { return {error:String(e.message)}; } finally {clearTimeout(timer);}
    }});
    this.signal.throwIfAborted();
    const result=results[0]?.result;
    if(!result || result.error) throw Error(result?.error || '无法读取火车官网响应。');
    return parseTrain(decodeTrain(result.text),job);
  }
  async close() {
    const id=this.trainTab;this.trainTab=null;
    if(id) {try{await chrome.tabs.remove(id);}catch{} await chrome.storage.session.remove('trainHelper');}
  }
}
