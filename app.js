import {today,addDays,makeJobs,filterRows,csv,FareClient,CITIES,cityName} from './fares.mjs';
import {jobKey,emptySelection,selectDay,calendarLeg,legRoute,legRows,remember,migrateSnapshot,hydrateCache,createSnapshot,pendingJobs,monthCells,shiftMonth} from './planner.mjs';
const $=id=>document.getElementById(id);
const configKeys=['origin','destination','tripType','start','end','provider'];
let snapshot=null, cache=null, controller=null, client=null, running=false, activeJob=null, month=null;
const defaultStart=addDays(today(),1);
function el(tag,text,cls){const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;}
for(const key of ['origin','destination']) for(const city of CITIES) {
  const option=el('option',`${city.name} · ${city.english}`);option.value=city.id;$(key).append(option);
}
$('origin').value='MEL';$('destination').value='SYD';
$('start').value=defaultStart;$('end').value=addDays(defaultStart,29);
$('start').min=today();$('end').min=today();
function notify(text='') {$('notice').textContent=text;$('notice').hidden=!text;}
function filters(){return {max:$('max').value,direct:$('direct').checked,central:$('central').checked};}
function visibleRows(){return filterRows(snapshot?.rows || [],filters());}
function localTime(iso){return `${iso.slice(5,10).replace('-','/')} ${iso.slice(11,16)}`;}
function checkedTime(iso){return iso ? new Date(iso).toLocaleString('zh-CN',{timeZone:'Australia/Sydney',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '旧记录';}
function modeText(mode){return mode.replaceAll('REGIONAL TRAIN','火车').replaceAll('COACH','巴士').replaceAll('bus','巴士');}
function routeText(route){return `${cityName(route.origin)} → ${cityName(route.destination)}`;}
function dayQueries(day,leg) {
  const route=legRoute(snapshot.config,leg);
  const matches=j=>j.day===day && j.origin===route.origin && j.destination===route.destination;
  const jobs=snapshot.jobs.filter(matches), queries=snapshot.queries.filter(matches);
  return {jobs,queries,errors:queries.filter(q=>q.status!=='ok'),pending:jobs.length-queries.length};
}
function dayStatus(day,leg,rows) {
  const {queries,errors,pending}=dayQueries(day,leg);
  const raw=legRows(snapshot.rows,snapshot.config,leg,day);
  const querying=activeJob && activeJob.day===day && activeJob.origin===legRoute(snapshot.config,leg).origin;
  const pieces=[];
  if(querying) pieces.push('查询中');
  else if(pending) pieces.push('待查询');
  if(errors.length) pieces.push(queries.some(q=>q.status==='ok')?'部分失败':'查询失败');
  if(!pending && !errors.length) pieces.push(rows.length ? '已查' : raw.length ? '筛选无匹配' : '已查无票');
  if(queries.some(q=>q.cached)) pieces.push('缓存');
  return {text:pieces.join(' · '),detail:queries.map(q=>`${q.provider==='flixbus'?'FlixBus':'NSW TrainLink'}：${q.status==='ok' ? `${q.cached?'缓存':'已查'} ${checkedTime(q.checkedAt)} · ${q.fares} 条` : q.error}`).join('\n'),hasError:!!errors.length};
}
function fareCard(r) {
  const card=el('article',null,'fare-card');
  const top=el('div',null,'fare-top');top.append(el('strong',`$${r.price_aud.toFixed(2)}`,'fare-price'),el('span',`${r.provider} · ${modeText(r.mode)}`));
  card.append(top,el('strong',`${localTime(r.departure)} → ${localTime(r.arrival)}`,'fare-time'),el('p',`${r.from_station} → ${r.to_station}`),el('p',`${Math.floor(r.duration_minutes/60)}h ${r.duration_minutes%60}m · ${r.transfers===0?'直达':`${r.transfers} 次换乘`} · ${r.fare}`));
  const bottom=el('div',null,'fare-bottom'),note=el('small',`${r.fee_note}\n查询于 ${checkedTime(r.checked_at)}（悉尼时间）`);
  const link=el('a','官网核价 ↗','book');link.href=r.booking_url;link.target='_blank';link.rel='noopener noreferrer';
  bottom.append(note,link);card.append(bottom);return card;
}
function selectionPanel(rows) {
  const panel=el('section',null,'selection-panel');panel.id='selection-panel';panel.setAttribute('aria-label','所选日期班次');
  const selection=snapshot.selection, config=snapshot.config;
  const legs=config.tripType==='roundtrip'?['outbound','inbound']:['outbound'];
  panel.classList.toggle('two-columns',legs.length===2);
  for(const leg of legs) {
    const date=selection[leg],column=el('section',null,'journey-column');column.dataset.leg=leg;
    column.append(el('span',leg==='outbound'?'01 / 去程':'02 / 返程','eyebrow'),el('h3',routeText(legRoute(config,leg))));
    if(!date) {column.append(el('p','在日历中选择返程日期，第二列将在这里展开。','column-empty'));panel.append(column);continue;}
    const fares=legRows(rows,config,leg,date),status=dayStatus(date,leg,fares);
    column.append(el('p',`${date} · ${fares.length} 条 · 价格升序`,'column-date'));
    if(status.text) column.append(el('p',status.text,'column-status'));
    if(!fares.length) column.append(el('p',status.hasError?'该日部分或全部查询失败，可点击“重试失败日期”。':status.text.includes('待查询') || status.text.includes('查询中')?'查询完成后，班次会自动显示在这里。':'该日期暂无符合当前筛选的班次。','column-empty'));
    const list=el('div',null,'fare-list');list.append(...fares.map(fareCard));column.append(list);panel.append(column);
  }
  return panel;
}
function renderCalendar(rows) {
  $('calendar').hidden=!snapshot;$('empty').hidden=!!snapshot;
  if(!snapshot) return;
  const config=snapshot.config,selection=snapshot.selection,leg=calendarLeg(config,selection),roundtrip=config.tripType==='roundtrip';
  month ||= config.start.slice(0,7);
  $('month-label').textContent=`${month.slice(0,4)} 年 ${Number(month.slice(5))} 月`;
  $('prev-month').disabled=month<=config.start.slice(0,7);$('next-month').disabled=month>=config.end.slice(0,7);
  $('leg-label').textContent=`${roundtrip?(leg==='outbound'?'去程':'返程'):'单程'}价格 · ${routeText(legRoute(config,leg))}`;
  $('selection-hint').textContent=!roundtrip ? (selection.outbound?`已选 ${selection.outbound}，可点击其他日期切换。`:'点击日期，展开当日班次。') : selection.inbound ? `已选去程 ${selection.outbound} ／ 返程 ${selection.inbound}。选择已锁定，请重选以修改。` : selection.outbound ? `去程 ${selection.outbound} 已选。现在请选择返程，可选同日或之后。` : '第 1 步：选择去程日期；随后日历将显示返程价格。';
  $('reset-selection').hidden=!selection.outbound;
  const cells=monthCells(month),fragment=document.createDocumentFragment(),anchor=selection.inbound || selection.outbound;
  const anchorIndex=cells.indexOf(anchor),panelAfter=anchorIndex<0 ? cells.length-1 : Math.floor(anchorIndex/7)*7+6;
  for(const [index,day] of cells.entries()) {
    if(!day) fragment.append(el('div',null,'day-blank'));
    else {
      const inRange=day>=config.start && day<=config.end,button=el('button',null,'day');button.type='button';button.dataset.day=day;
      button.append(el('span',String(Number(day.slice(8))),'day-number'));
      const chosenOut=day===selection.outbound,chosenIn=day===selection.inbound;
      if(chosenOut || chosenIn) button.append(el('span',chosenOut && chosenIn?'去 / 返':chosenOut?'去程':'返程','day-chosen'));
      button.classList.toggle('selected-outbound',chosenOut);button.classList.toggle('selected-inbound',chosenIn);
      button.setAttribute('aria-pressed',String(chosenOut || chosenIn));
      button.disabled=!inRange || (roundtrip && (!!selection.inbound || (!!selection.outbound && day<selection.outbound)));
      if(inRange) {
        const fares=legRows(rows,config,leg,day),status=dayStatus(day,leg,fares);
        button.append(el('strong',fares.length?`$${fares[0].price_aud.toFixed(2)}`:'—','day-price'),el('small',status.text,'day-status'));
        button.title=`${day} · ${routeText(legRoute(config,leg))}\n${status.detail || '尚未查询'}`;
        button.setAttribute('aria-label',`${day} ${leg==='inbound'?'返程':'去程'} ${fares.length?`最低 ${fares[0].price_aud.toFixed(2)} 澳元`:'暂无报价'} ${status.text}`);
        button.classList.toggle('has-error',status.hasError);
      } else button.classList.add('out-of-range');
      fragment.append(button);
    }
    if(selection.outbound && index===panelAfter) fragment.append(selectionPanel(rows));
  }
  // Preserve keyboard focus during incremental query updates.
  const focused=document.activeElement?.dataset.day;
  $('calendar-grid').replaceChildren(fragment);
  if(focused) {
    const target=$('calendar-grid').querySelector(`[data-day="${focused}"]`);
    if(target && !target.disabled) target.focus({preventScroll:true});
  }
}
function render() {
  const rows=visibleRows(),done=snapshot?.queries.length || 0,total=snapshot?.jobs.length || 0;
  const errors=snapshot?.queries.filter(q=>q.status!=='ok') || [],cached=snapshot?.queries.filter(q=>q.cached).length || 0;
  const currentRows=snapshot?legRows(rows,snapshot.config,calendarLeg(snapshot.config,snapshot.selection)):[];
  $('lowest').textContent=currentRows.length?currentRows[0].price_aud.toFixed(2):'—';
  $('lowest-note').textContent=currentRows.length?`${currentRows[0].date} · ${currentRows[0].direction}`:'尚无匹配报价';
  $('count').textContent=currentRows.length.toLocaleString();$('count-note').textContent=snapshot?`本次共 ${snapshot.rows.length} 条报价`:'按价格从低到高';
  $('progress-count').textContent=`${done} / ${total}`;$('progress-note').textContent=`复用缓存 ${cached} 项${errors.length?` · 失败 ${errors.length} 项`:''}`;
  $('progress').max=total || 1;$('progress').value=done;
  $('query-fields').disabled=running;$('search').disabled=running;$('stop').hidden=!running;
  $('resume').hidden=running || !snapshot || done>=total;$('retry').hidden=running || !errors.length;
  $('clear').disabled=running;$('export').disabled=!rows.length;document.body.classList.toggle('running',running);
  if(!running) $('status').textContent=!snapshot?'选好路线和日期，开始寻找下一程。':done<total?'查询已暂停或中断，可继续未完成的日期。':errors.length?'查询结束，部分日期失败，可重试。':`查询完成，复用 ${cached} 项缓存。点击日历查看班次。`;
  $('scope').textContent=snapshot?`${routeText(snapshot.config)} · ${snapshot.config.tripType==='roundtrip'?'往返':'单程'} · ${snapshot.config.start} — ${snapshot.config.end}`:'结果将在这里显示';
  renderCalendar(rows);
  $('errors').hidden=!errors.length;$('errors-label').textContent=`${errors.length} 项查询失败（不代表没票）`;
  $('error-list').replaceChildren(...errors.map(q=>el('li',`${q.day} ${routeText(q)} ${q.provider}：${q.error}`)));
  const route=snapshot?.config || {origin:$('origin').value,destination:$('destination').value,tripType:$('tripType').value};
  $('route-origin').textContent=route.origin;$('route-destination').textContent=route.destination;$('route-arrow').textContent=route.tripType==='roundtrip'?'↔':'→';
}
async function persist(){await chrome.storage.local.set({snapshot,fareCache:cache});}
async function run(mode='new') {
  if(running) return;
  notify();$('status').textContent='正在准备查询…';
  await navigator.locks.request('fare-scan',{ifAvailable:true},async lock=>{
    if(!lock){render();notify('已有另一个查询页面正在扫描，请在原页面操作。');return;}
    const saved=await chrome.storage.local.get(['fareCache','snapshot']);
    cache=hydrateCache(saved.fareCache,migrateSnapshot(saved.snapshot));
    if(mode==='new') {
      const config=Object.fromEntries(configKeys.map(k=>[k,$(k).value]));
      let jobs;try{jobs=makeJobs(config);}catch(e){render();notify(e.message);return;}
      const refresh=$('refresh').checked;
      snapshot=createSnapshot(config,jobs,cache,refresh);month=config.start.slice(0,7);
      // A failed explicit refresh must not resurrect older prices on the next scan.
      if(refresh) for(const job of jobs) delete cache.entries[jobKey(job)];
      $('refresh').checked=false;
    }
    if(!snapshot) return;
    if(mode==='retry') snapshot.queries=snapshot.queries.filter(q=>q.status==='ok');
    running=true;controller=new AbortController();client=new FareClient(controller.signal);render();
    try {
      await persist();
      for(const job of pendingJobs(snapshot)) {
        controller.signal.throwIfAborted();activeJob=job;
        $('status').textContent=`正在查询 ${job.day} · ${routeText(job)} · ${job.provider==='flixbus'?'FlixBus':'NSW TrainLink'}`;renderCalendar(visibleRows());
        let result;
        try {
          const fares=await client.search(job);controller.signal.throwIfAborted();
          const checkedAt=new Date().toISOString();remember(cache,job,fares,checkedAt);
          snapshot.rows.push(...fares);result={...job,status:'ok',fares:fares.length,checkedAt,cached:false};
        } catch(e) {
          if(controller.signal.aborted) throw e;
          result={...job,status:'error',error:e.message || String(e),checkedAt:new Date().toISOString()};
        }
        snapshot.queries.push(result);activeJob=null;await persist();render();
      }
    } catch(e) {
      if(!controller.signal.aborted) notify(`查询中断：${e.message}。已保存结果仍可使用。`);
    } finally {
      try{await client.close();}catch{}
      try{await persist();}catch{notify('浏览器未能保存结果，请先导出 CSV，或清除旧缓存后重试。');}
      running=false;activeJob=null;controller=null;client=null;render();
    }
  });
}
$('search-form').addEventListener('submit',e=>{e.preventDefault();run().catch(e=>{render();notify(e.message);});});
$('resume').addEventListener('click',()=>run('resume').catch(e=>notify(e.message)));
$('retry').addEventListener('click',()=>run('retry').catch(e=>notify(e.message)));
$('stop').addEventListener('click',()=>{controller?.abort();client?.close().catch(()=>{});$('status').textContent='正在暂停并保存结果…';});
$('swap').addEventListener('click',()=>{const origin=$('origin').value;$('origin').value=$('destination').value;$('destination').value=origin;});
for(const button of document.querySelectorAll('[data-days]')) button.addEventListener('click',()=>{$('end').value=addDays($('start').value || defaultStart,Number(button.dataset.days)-1);});
for(const key of ['max','direct','central']) $(key).addEventListener('input',()=>{render();chrome.storage.local.set({filters:filters()}).catch(e=>notify(e.message));});
function saveSelection(){chrome.storage.local.set({snapshot}).catch(e=>notify(e.message));}
$('calendar-grid').addEventListener('click',event=>{
  const button=event.target.closest('button[data-day]');if(!button || button.disabled || !snapshot)return;
  snapshot.selection=selectDay(snapshot.selection,button.dataset.day,snapshot.config.tripType);render();saveSelection();
  if(snapshot.selection.inbound) $('reset-selection').focus({preventScroll:true});
});
$('reset-selection').addEventListener('click',()=>{snapshot.selection=emptySelection();render();saveSelection();});
for(const [id,delta] of [['prev-month',-1],['next-month',1]]) $(id).addEventListener('click',()=>{month=shiftMonth(month,delta);renderCalendar(visibleRows());});
$('export').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([csv(visibleRows())],{type:'text/csv;charset=utf-8'}));const link=el('a');link.href=url;
  link.download=`${snapshot.config.origin}-${snapshot.config.destination}-${snapshot.config.start}-${snapshot.config.end}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('clear').addEventListener('click',async()=>{
  if(running)return;
  try{await navigator.locks.request('fare-scan',{ifAvailable:true},async lock=>{
    if(!lock){notify('另一页面正在查询，请先暂停后清除。');return;}
    await chrome.storage.local.remove(['snapshot','fareCache']);snapshot=null;cache=hydrateCache(null,null);month=null;notify();render();
  });}catch(e){notify(e.message);}
});
async function init() {
  const owner=await chrome.tabs.getCurrent(),{trainHelper}=await chrome.storage.session.get('trainHelper');
  if(trainHelper?.owner===owner?.id) {
    try{await chrome.tabs.remove(trainHelper.tab);}catch{}
    await chrome.storage.session.remove('trainHelper');
  }
  const stored=await chrome.storage.local.get(['snapshot','filters','fareCache']);
  snapshot=migrateSnapshot(stored.snapshot);cache=hydrateCache(stored.fareCache,snapshot);
  if(snapshot?.config) {
    for(const key of configKeys) $(key).value=snapshot.config[key];
    month=(snapshot.selection.inbound || snapshot.selection.outbound || snapshot.config.start).slice(0,7);
  }
  if(stored.filters) {$('max').value=stored.filters.max ?? '';$('direct').checked=!!stored.filters.direct;$('central').checked=!!stored.filters.central;}
  render();
}
try{await init();}catch(e){notify(`无法读取本地记录：${e.message}`);}
