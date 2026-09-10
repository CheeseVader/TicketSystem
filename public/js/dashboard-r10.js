console.log('ANDON_R11_3_DASHBOARD');
const socket=io();
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmtDate=v=>v?new Date(v).toLocaleString('es-MX'):'—';
let supportDepartments=[];const fmtDept=d=>{const x=supportDepartments.find(a=>a.code===d);return x?.name||(d==='systems'?'Sistemas':d==='maintenance'?'Mantenimiento':d||'—')};
const duration=s=>{if(s==null||Number.isNaN(Number(s)))return'—';s=Math.max(0,Math.floor(Number(s)));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h?`${h}h ${m}m`:`${m}m ${x}s`};
function slaHistoryChip(value){
  if(value===true)return '<span class="sla-chip ok">En tiempo</span>';
  if(value===false)return '<span class="sla-chip bad">Vencido</span>';
  return '<span class="sla-chip neutral">Sin dato</span>';
}
function slaMetricHtml(title,met,actualSeconds,limitMinutes){
  const status=met===true?'En tiempo':met===false?'Vencido':'Sin dato';
  const cls=met===true?'ok':met===false?'bad':'neutral';
  const actual=actualSeconds==null?'—':duration(Number(actualSeconds));
  const limit=limitMinutes==null?'—':`${limitMinutes} min`;
  return `<article class="detail-metric"><span>${esc(title)}</span><strong class="${cls}">${status}</strong><small>Real: ${esc(actual)} · Objetivo: ${esc(limit)}</small></article>`;
}
const elapsed=v=>v?duration((Date.now()-new Date(v).getTime())/1000):'—';
const slug=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim().replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-+/g,'-').slice(0,60);
let me=null,dashData=null,ticketsCache=[],reportFilters=null,adminData=null,slaCache=[],reportCache=null;

function applySidebarState(collapsed){
  const shell=document.querySelector('.dashboard-shell');const btn=document.getElementById('sidebarToggle');
  if(!shell||!btn)return;
  shell.classList.toggle('sidebar-collapsed',!!collapsed);
  btn.setAttribute('aria-label',collapsed?'Mostrar menú':'Ocultar menú');
  btn.title=collapsed?'Mostrar menú':'Ocultar menú';
}
function initSidebar(){
  const btn=document.getElementById('sidebarToggle');if(!btn)return;
  applySidebarState(true);
  btn.addEventListener('click',()=>{const shell=document.querySelector('.dashboard-shell');const next=!shell.classList.contains('sidebar-collapsed');applySidebarState(next);});
}
async function loadPublicBrand(){
  try{const c=await api('/api/public-config');const b=String(c.brandName||'').trim();if(!b)return;const el=document.getElementById('dashboardBrand');if(el){el.textContent=b;el.title=b;}document.title=b+' · Andon Support';}catch{}
}
initSidebar();loadPublicBrand();


const statusNames={unassigned:'Sin asignar',assigned:'Asignado',in_progress:'En progreso',waiting:'En espera',escalated:'Escalado',resolved:'Resuelto',closed:'Cerrado',cancelled:'Cancelado'};
const activeStatuses=['assigned','in_progress','waiting','escalated','resolved'];
const statusChip=s=>`<span class="status-chip ${esc(s)}">${esc(statusNames[s]||s)}</span>`;
const deptBadge=d=>`<span class="dept-badge ${d}">${fmtDept(d)}</span>`;
function slaBadge(row){
  const now=Date.now();let cls='ok',txt='OK';
  const responseDue=row.response_due_at?new Date(row.response_due_at).getTime():null;
  const resolutionDue=row.resolution_due_at?new Date(row.resolution_due_at).getTime():null;
  const st=row.ticket_status||row.status;
  if(st==='unassigned'){
    if(responseDue&&now>responseDue){cls='bad';txt='Respuesta vencida'}
    else{cls='ok';txt='En tiempo'}
  }else if(!row.assigned_at&&responseDue&&now>responseDue){cls='bad';txt='Respuesta vencida'}
  else if(!['resolved','closed','cancelled'].includes(st)&&resolutionDue&&now>resolutionDue){cls='bad';txt='Resolución vencida'}
  else if(st==='resolved'){cls='ok';txt='Resuelto'}
  return `<span class="sla-chip ${cls}">${txt}</span>`;
}
function responseSlaCell(row){
  const due=row.response_due_at;
  if(!due)return row.response_minutes?`${row.response_minutes} min`:'—';
  const left=Math.ceil((new Date(due).getTime()-Date.now())/1000);
  const detail=left>0?`${duration(left)} restantes`:`Vencido hace ${duration(Math.abs(left))}`;
  return `${slaBadge({...row,status:'unassigned',assigned_at:null})}<small class="subline">${esc(detail)}</small>`;
}
function toast(msg,type='info'){const t=$('#toast');t.textContent=msg;t.className=`toast show ${type}`;clearTimeout(t._tm);t._tm=setTimeout(()=>t.className='toast',3500)}
async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})},cache:'no-store'});let d={};try{d=await r.json()}catch{}if(r.status===401){location='/login';throw new Error('Sesión expirada')}if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d}


// ================= ANDON_AUDIO_R1_BEGIN =================
const ANDON_AUDIO_KEY='andon_audio_enabled_v1';
const ANDON_AUDIO_REPEAT_MS=45000;

let andonAudioEnabled=localStorage.getItem(ANDON_AUDIO_KEY)!=='0';
let andonAudioUnlocked=false;
let andonAudioContext=null;
let andonSpeechQueue=[];
let andonSpeaking=false;
let andonPendingRequests=new Map();
let andonLastAlertAt=new Map();

function andonGetAudioContext(){
  if(!andonAudioContext){
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx)return null;
    andonAudioContext=new Ctx();
  }
  return andonAudioContext;
}

async function andonUnlockAudio(showMessage=true){
  if(!andonAudioEnabled)return false;
  try{
    const ctx=andonGetAudioContext();
    if(ctx&&ctx.state==='suspended')await ctx.resume();
    andonAudioUnlocked=!ctx||ctx.state==='running';
    if(window.speechSynthesis)window.speechSynthesis.getVoices();
    andonUpdateAudioButton();
    if(showMessage&&andonAudioUnlocked)toast('Alertas de audio listas','success');
    return andonAudioUnlocked;
  }catch(e){
    console.warn('ANDON audio unlock:',e);
    andonAudioUnlocked=false;
    andonUpdateAudioButton();
    return false;
  }
}

function andonUpdateAudioButton(){
  const btn=document.getElementById('andonAudioToggle');
  const icon=document.getElementById('andonAudioIcon');
  const label=document.getElementById('andonAudioLabel');
  if(!btn||!icon||!label)return;

  btn.classList.toggle('audio-off',!andonAudioEnabled);
  btn.classList.toggle('audio-locked',andonAudioEnabled&&!andonAudioUnlocked);

  if(!andonAudioEnabled){
    icon.textContent='🔇';
    label.textContent='Alertas desactivadas';
  }else if(!andonAudioUnlocked){
    icon.textContent='🔊';
    label.textContent='Activar audio';
  }else{
    icon.textContent='🔊';
    label.textContent='Alertas activadas';
  }
}

function andonSetAudioEnabled(enabled){
  andonAudioEnabled=Boolean(enabled);
  localStorage.setItem(ANDON_AUDIO_KEY,andonAudioEnabled?'1':'0');
  if(!andonAudioEnabled){
    andonSpeechQueue.length=0;
    andonSpeaking=false;
    if(window.speechSynthesis)window.speechSynthesis.cancel();
  }
  andonUpdateAudioButton();
}

function andonTone(freq,start,duration,volume=.12,type='sine'){
  const ctx=andonGetAudioContext();
  if(!ctx||ctx.state!=='running')return;
  const osc=ctx.createOscillator();
  const gain=ctx.createGain();
  osc.type=type;
  osc.frequency.setValueAtTime(freq,ctx.currentTime+start);
  gain.gain.setValueAtTime(.0001,ctx.currentTime+start);
  gain.gain.exponentialRampToValueAtTime(volume,ctx.currentTime+start+.015);
  gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+start+duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime+start);
  osc.stop(ctx.currentTime+start+duration+.03);
}

function andonPlaySystemsAlarm(){
  andonTone(660,0,.16,.14,'sine');
  andonTone(880,.20,.16,.14,'sine');
  andonTone(1100,.40,.22,.14,'sine');
}

function andonPlayMaintenanceAlarm(){
  andonTone(420,0,.22,.12,'square');
  andonTone(420,.30,.22,.12,'square');
  andonTone(560,.60,.28,.11,'square');
}

function andonDepartmentName(department){
  return department==='systems'?'Sistemas':department==='maintenance'?'Mantenimiento':String(department||'Soporte');
}

function andonReadableStation(code){
  const value=String(code||'').trim();
  let m=value.match(/^L(\d+)-E(\d+)$/i);
  if(m)return `Línea ${m[1]}, estación ${m[2]}`;
  m=value.match(/^V(\d+)-(.+)$/i);
  if(m)return `Grupo V ${m[1]}, equipo ${m[2].replace(/[-_]+/g,' ')}`;
  return value?`Equipo ${value.replace(/[-_]+/g,' ')}`:'Equipo no identificado';
}

function andonReadableCategory(value){
  return String(value||'').replace(/[-_]+/g,' ').trim();
}

function andonSpeak(text){
  if(!andonAudioEnabled||!andonAudioUnlocked||!window.speechSynthesis||!text)return;
  andonSpeechQueue.push(text);
  andonProcessSpeechQueue();
}

function andonProcessSpeechQueue(){
  if(andonSpeaking||!andonSpeechQueue.length||!andonAudioEnabled)return;
  const text=andonSpeechQueue.shift();
  const u=new SpeechSynthesisUtterance(text);
  u.lang='es-US';
  u.rate=1.30;
  u.pitch=1.05;
  u.volume=1;
  const voices=window.speechSynthesis.getVoices();
  u.voice=voices.find(v=>v.name==='Google español de Estados Unidos') ||
          voices.find(v=>String(v.lang||'').toLowerCase()==='es-us') ||
          voices.find(v=>String(v.lang||'').toLowerCase().startsWith('es')) ||
          null;
  andonSpeaking=true;
  u.onend=()=>{andonSpeaking=false;setTimeout(andonProcessSpeechQueue,180)};
  u.onerror=()=>{andonSpeaking=false;setTimeout(andonProcessSpeechQueue,180)};
  window.speechSynthesis.speak(u);
}

async function andonEnsureAudioReady(){
  if(!andonAudioEnabled)return false;
  try{
    const ctx=andonGetAudioContext();
    if(ctx&&ctx.state!=='running'){
      try{await ctx.resume()}catch{}
    }
    if(window.speechSynthesis){
      try{window.speechSynthesis.resume()}catch{}
      window.speechSynthesis.getVoices();
    }
    andonAudioUnlocked=!ctx||ctx.state==='running';
    andonUpdateAudioButton();
    return andonAudioUnlocked;
  }catch(e){
    console.warn('ANDON audio ready:',e);
    return false;
  }
}

async function andonAlertRequest(request,repeat=false){
  if(!request||!andonAudioEnabled)return;
  if(!(await andonEnsureAudioReady()))return;
  if(request.department==='maintenance')andonPlayMaintenanceAlarm();
  else andonPlaySystemsAlarm();

  const area=andonDepartmentName(request.department);
  const category=andonReadableCategory(request.category_label||request.category);
  const prefix=repeat?'Recordatorio. Solicitud pendiente de':'Atención. Nueva solicitud de';
  let phrase;
  if(request.source==='administrative'){
    const requester=String(request.requesterArea||'').trim();
    const location=String(request.supportLocation||request.stationCode||'').trim();
    phrase=`${prefix} ${area}. Solicitud administrativa`;
    if(requester)phrase+=` de ${requester}`;
    if(location)phrase+=`. Ubicación ${location}`;
    phrase+='.';
  }else{
    const station=andonReadableStation(request.stationCode||request.station_code||request.code);
    phrase=`${prefix} ${area}. ${station}.`;
  }
  if(category)phrase+=` Categoría ${category}.`;
  setTimeout(()=>andonSpeak(phrase),950);
}

function andonSyncPendingRequests(rows){
  const current=new Map();
  (rows||[]).filter(row=>row.status==='unassigned').forEach(row=>{
    const id=Number(row.id);
    if(!id)return;
    const item={
      id,
      department:row.department,
      stationCode:row.stationCode||row.station_code||row.code,
      category:row.category,
      category_label:row.category_label
    };
    current.set(id,item);
    if(!andonPendingRequests.has(id)){
      andonPendingRequests.set(id,item);
      // Al abrir el dashboard no anunciar solicitudes que ya estaban pendientes.
      if(!andonLastAlertAt.has(id))andonLastAlertAt.set(id,Date.now());
    }
  });

  [...andonPendingRequests.keys()].forEach(id=>{
    if(!current.has(id)){
      andonPendingRequests.delete(id);
      andonLastAlertAt.delete(id);
    }
  });
}

function andonHandleRequestEvent(evt){
  if(!evt||!evt.id)return;

  // Los ingenieros sólo reciben audio de su propia área.
  if(me?.role==='engineer'&&me.department&&evt.department&&evt.department!==me.department)return;

  const id=Number(evt.id);

  if(evt.action==='created'){
    const request={
      id,
      department:evt.department,
      stationCode:evt.stationCode,
      category:evt.category,
      category_label:evt.category_label,
      source:evt.source,
      requesterArea:evt.requesterArea||evt.requester_area,
      supportLocation:evt.supportLocation||evt.support_location
    };
    andonPendingRequests.set(id,request);
    andonLastAlertAt.set(id,Date.now());
    toast(`Nueva alerta: ${request.stationCode||'Soporte'} · ${andonDepartmentName(request.department)}`,'error');
    void andonAlertRequest(request,false);
    return;
  }

  if(['assigned','resolved','closed','cancelled'].includes(evt.action)){
    andonPendingRequests.delete(id);
    andonLastAlertAt.delete(id);
  }
}

function andonCheckPendingAlerts(){
  if(!andonAudioEnabled||!andonAudioUnlocked)return;
  const now=Date.now();
  andonPendingRequests.forEach((request,id)=>{
    const last=andonLastAlertAt.get(id)||now;
    if(now-last>=ANDON_AUDIO_REPEAT_MS){
      andonLastAlertAt.set(id,now);
      void andonAlertRequest(request,true);
    }
  });
}

function andonInitAudio(){
  andonUpdateAudioButton();
  const btn=document.getElementById('andonAudioToggle');

  if(btn){
    btn.addEventListener('click',async()=>{
      if(!andonAudioEnabled){
        andonSetAudioEnabled(true);
        await andonUnlockAudio(false);
        if(andonAudioUnlocked){
          andonPlaySystemsAlarm();
          setTimeout(()=>andonSpeak('Alertas de audio activadas.'),700);
        }
        return;
      }

      if(!andonAudioUnlocked){
        await andonUnlockAudio(false);
        if(andonAudioUnlocked){
          andonPlaySystemsAlarm();
          setTimeout(()=>andonSpeak('Alertas de audio activadas.'),700);
        }
        return;
      }

      andonSetAudioEnabled(false);
      toast('Alertas de audio desactivadas','info');
    });
  }

  const unlock=()=>{
    if(andonAudioEnabled&&!andonAudioUnlocked)andonUnlockAudio(false);
  };
  document.addEventListener('pointerdown',unlock,{once:true});
  document.addEventListener('keydown',unlock,{once:true});

  setInterval(andonCheckPendingAlerts,5000);
}

document.addEventListener('DOMContentLoaded',andonInitAudio);
// ================= ANDON_AUDIO_R1_END =================

const viewMeta={dashboard:['Dashboard','Monitoreo en tiempo real'],requests:['Solicitudes','Pool pendiente y sin asignar'],tickets:['Tickets','Trabajo asignado y pendiente'],history:['Historial','Tickets cerrados'],reports:['Reportes','Análisis dinámico y SLA'],groups:['Grupos y Equipos','Estructura de producción'],users:['Usuarios y áreas','Usuarios, roles y áreas de soporte'],sla:['SLA','Políticas de respuesta, resolución y autocierre']};
async function showView(name){
  if(name!=='groups'&&andonLayoutEdit){andonLayoutEdit=false;andonLayoutSelectedId=null;}
  if(me?.role==='engineer'&&['history','groups','users','sla'].includes(name))name='dashboard';if(me?.role==='supervisor'&&['groups','users','sla'].includes(name))name='dashboard';
  $$('.app-view').forEach(x=>x.classList.toggle('active',x.id===`view-${name}`));
  $$('#sideNav a').forEach(x=>x.classList.toggle('active',x.dataset.view===name));
  const m=viewMeta[name]||viewMeta.dashboard;$('#pageTitle').textContent=m[0];$('#pageSubtitle').textContent=m[1];
  if(location.hash!==`#${name}`)history.replaceState(null,'',`#${name}`);
  if(name==='dashboard')await loadDashboard();
  if(name==='requests')await loadRequests();
  if(name==='tickets')await loadTickets();
  if(name==='history')await loadHistory();
  if(name==='reports')await loadReports(true);
  if(name==='groups')await loadGroups();
  if(name==='users')await loadUsers();
  if(name==='sla')await loadSla();
}
$$('#sideNav a').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();const shell=document.querySelector('.dashboard-shell');if(shell?.classList.contains('sidebar-collapsed'))applySidebarState(false);showView(a.dataset.view)}));
$$('[data-go]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.go)));

function requestRows(rows,compact=false){const delegate=me&&['admin','superadmin','supervisor'].includes(me.role);return rows.length?rows.map(x=>`<tr><td>${esc(x.source==='administrative'?'ADMINISTRATIVOS':(x.group_name||'—'))}</td><td><strong>${esc(x.source==='administrative'?(x.requester_area||'Administrativo'):(x.code||''))}</strong><small class="subline">${esc(x.source==='administrative'?('Ubicación: '+(x.support_location||'—')):(x.station_name||''))}</small></td><td>${deptBadge(x.department)}</td><td>${esc(x.category_label||x.category||'')}</td><td>${esc(x.notes||'—')}</td>${compact?'':`<td>${fmtDate(x.requested_at)}</td>`}<td data-since="${x.requested_at}">${elapsed(x.requested_at)}</td><td>${responseSlaCell(x)}</td><td><button class="btn small attend" onclick="${delegate?`openAssignRequestModal(${x.id},'${esc(x.department)}')`:`assignRequest(${x.id})`}">${delegate?'Asignar':'Asignarme'}</button></td></tr>`).join(''):`<tr><td colspan="${compact?8:9}" class="empty">No hay solicitudes sin asignar.</td></tr>`}

// ================= ANDON_LAYOUT_R11_BEGIN =================
const ANDON_LAYOUT_COLS=20;
const ANDON_LAYOUT_ROWS=2;
let andonLayoutEdit=false;
let andonLayoutDragId=null;
let andonLayoutBusy=false;

function isLayoutManager(){return !!me&&['superadmin','admin'].includes(me.role)}

function stationLayoutPosition(st,index){
  const row=Number(st.layout_row);const col=Number(st.layout_col);
  if(row>=1&&row<=ANDON_LAYOUT_ROWS&&col>=1&&col<=ANDON_LAYOUT_COLS)return {row,col};
  // Compatibilidad temporal si la migracion aun no corrio.
  const i=Math.max(0,Number(st.station_no||index+1)-1);
  return {row:Math.min(ANDON_LAYOUT_ROWS,Math.floor(i/ANDON_LAYOUT_COLS)+1),col:(i%ANDON_LAYOUT_COLS)+1};
}

function renderProductionLine(g,stations,byStation){
  const cells=new Map();const unplaced=[];
  stations.forEach((st,index)=>{
    const pos=stationLayoutPosition(st,index);
    const key=`${pos.row}:${pos.col}`;
    if(cells.has(key))unplaced.push(st);else cells.set(key,st);
  });
  const slots=[];
  for(let row=1;row<=ANDON_LAYOUT_ROWS;row++){
    for(let col=1;col<=ANDON_LAYOUT_COLS;col++){
      const st=cells.get(`${row}:${col}`);
      if(!st){
        slots.push(`<div class="layout-slot layout-empty" data-layout-row="${row}" data-layout-col="${col}" title="Fila ${row}, posición ${col}"><span></span></div>`);
        continue;
      }
      const arr=byStation[st.code]||[];
      const state=arr.length?arr.map(x=>`${fmtDept(x.department)} · ${statusNames[x.ticket_status||x.status]||x.status}`).join(' / '):'OK';
      const cls=arr.some(x=>x.department==='systems')?'has-systems':arr.some(x=>x.department==='maintenance')?'has-maintenance':'';
      const drag=andonLayoutEdit&&isLayoutManager()?'tabindex="0" aria-grabbed="false"':'';
      slots.push(`<div class="layout-slot" data-layout-row="${row}" data-layout-col="${col}"><div class="station-tile ${cls}${andonLayoutEdit?' layout-editable':''}" data-station-id="${st.id}" data-layout-row="${row}" data-layout-col="${col}" ${drag} title="${andonLayoutEdit?'Arrastra o usa las flechas para mover · ':''}Fila ${row}, posición ${col}"><span class="code">${esc(st.code)}</span><span class="station-name">${esc(st.label||'')}</span><span class="state">${esc(state)}</span></div></div>`);
    }
  }
  const overflow=unplaced.length?`<div class="layout-unplaced"><strong>Sin posición (${unplaced.length})</strong>${unplaced.map(st=>`<span>${esc(st.code)}</span>`).join('')}</div>`:'';
  return `<div class="line-card production-line-card" data-group-id="${g.id}"><div class="line-title"><div><strong>${esc(g.name)}</strong><small>${esc(g.code)} · ${stations.length} equipos · 20 × 2</small></div><span class="line-layout-badge">40 posiciones</span></div><div class="production-layout-scroll"><div class="production-layout-grid">${slots.join('')}</div></div>${overflow}</div>`;
}

function bindLayoutEditor(){
  const toggle=document.getElementById('layoutEditToggle');
  if(toggle){
    toggle.classList.toggle('hidden',!isLayoutManager());
    toggle.textContent=andonLayoutEdit?'✓ Terminar edición':'✏ Editar layout';
    toggle.classList.toggle('primary',andonLayoutEdit);
    toggle.classList.toggle('secondary',!andonLayoutEdit);
  }
  if(!andonLayoutEdit||!isLayoutManager())return;
  $$('.station-tile.layout-editable').forEach(tile=>{
    tile.setAttribute('draggable','true');tile.tabIndex=0;
    tile.addEventListener('dragstart',e=>{andonLayoutDragId=Number(tile.dataset.stationId);tile.classList.add('layout-dragging');if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(andonLayoutDragId));}});
    tile.addEventListener('dragend',()=>clearLayoutDragVisuals(tile));
    tile.addEventListener('keydown',async e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)||andonLayoutBusy)return;e.preventDefault();let row=Number(tile.dataset.layoutRow),col=Number(tile.dataset.layoutCol);if(e.key==='ArrowLeft')col--;if(e.key==='ArrowRight')col++;if(e.key==='ArrowUp')row--;if(e.key==='ArrowDown')row++;if(row<1||row>ANDON_LAYOUT_ROWS||col<1||col>ANDON_LAYOUT_COLS)return;await moveStationLayout(Number(tile.dataset.stationId),row,col);});
  });
}

// El botón vive fuera del grid que se vuelve a renderizar. Delegación global evita
// que una recarga del Dashboard deje el botón visualmente activo pero sin evento.
document.addEventListener('click',e=>{
  const btn=e.target.closest?.('#layoutEditToggle');if(!btn)return;
  e.preventDefault();e.stopPropagation();if(!isLayoutManager())return;
  andonLayoutEdit=!andonLayoutEdit;renderDashboardFromData();
});

// R11.4: editor delegado, resistente a re-renderizados del grid.
let andonLayoutSelectedId=null;
document.addEventListener('click',async e=>{
  if(!andonLayoutEdit||!isLayoutManager()||andonLayoutBusy)return;
  const tile=e.target.closest?.('.station-tile.layout-editable');
  if(tile){e.preventDefault();e.stopPropagation();andonLayoutSelectedId=Number(tile.dataset.stationId);$$('.station-tile.layout-selected').forEach(x=>x.classList.remove('layout-selected'));tile.classList.add('layout-selected');toast('Estación seleccionada. Haz clic en la posición destino o usa las flechas.','success');return;}
  const slot=e.target.closest?.('.layout-slot');
  if(slot&&andonLayoutSelectedId){e.preventDefault();e.stopPropagation();await moveStationLayout(andonLayoutSelectedId,Number(slot.dataset.layoutRow),Number(slot.dataset.layoutCol));andonLayoutSelectedId=null;}
},true);
document.addEventListener('dragover',e=>{if(!andonLayoutEdit||!andonLayoutDragId)return;const slot=e.target.closest?.('.layout-slot');if(!slot)return;e.preventDefault();slot.classList.add('layout-drop-target');if(e.dataTransfer)e.dataTransfer.dropEffect='move';},true);
document.addEventListener('dragleave',e=>{const slot=e.target.closest?.('.layout-slot');if(slot)slot.classList.remove('layout-drop-target')},true);
document.addEventListener('drop',async e=>{if(!andonLayoutEdit)return;const slot=e.target.closest?.('.layout-slot');if(!slot)return;e.preventDefault();e.stopPropagation();slot.classList.remove('layout-drop-target');const id=Number(e.dataTransfer?.getData('text/plain')||andonLayoutDragId||andonLayoutSelectedId);if(!id||andonLayoutBusy)return;await moveStationLayout(id,Number(slot.dataset.layoutRow),Number(slot.dataset.layoutCol));andonLayoutSelectedId=null;},true);

function clearLayoutDragVisuals(tile){
  andonLayoutDragId=null;if(tile)tile.classList.remove('layout-dragging');$$('.layout-drop-target').forEach(x=>x.classList.remove('layout-drop-target'));
}

async function moveStationLayout(stationId,row,col){
  andonLayoutBusy=true;
  try{
    await api(`/api/admin/stations/${stationId}/layout`,{method:'PATCH',body:JSON.stringify({row,col})});
    const adminView=document.getElementById('view-groups');
    if(adminView?.classList.contains('active')){
      const st=(adminData?.stations||[]).find(x=>Number(x.id)===Number(stationId));
      await loadGroups(st?.group_id||selectedAdminGroupId||null);
    }else{
      await loadDashboard();
    }
  }catch(e){toast(e.message,'error')}finally{andonLayoutBusy=false}
}
// ================= ANDON_LAYOUT_R11_END =================

let dashboardPlantId='';
function fillPlantSelect(el,plants,includeAll=true){if(!el)return;const cur=el.value;el.innerHTML=(includeAll?'<option value="">Todas</option>':'')+(plants||[]).filter(x=>x.enabled!==false).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');if([...el.options].some(o=>o.value===cur))el.value=cur;}
function bindDashboardPlantFilter(){const el=$('#dashboardPlantFilter');if(!el||el.dataset.bound)return;el.dataset.bound='1';el.addEventListener('change',()=>{dashboardPlantId=el.value;renderDashboardFromData();});}
function productionAlertRows(open,stations){const ids=new Set((stations||[]).map(x=>Number(x.id)));return (open||[]).filter(r=>r.station_id&&ids.has(Number(r.station_id)));}
function adminAlertRows(open){return (open||[]).filter(r=>r.source==='administrative'||!r.station_id);}
function renderDashboardAlerts(groups,stations,open){
  const prod=productionAlertRows(open,stations),admin=adminAlertRows(open);
  if(!prod.length&&!admin.length)return '<div class="line-alert-empty">Sin alertas activas.</div>';
  let html='';
  if(prod.length)html+=`<div class="dashboard-alert-section"><h3>Líneas de producción <span>${prod.length}</span></h3><div class="line-alerts-summary">${prod.map(r=>{const g=groups.find(x=>Number(x.id)===Number(r.group_id));const st=stations.find(x=>Number(x.id)===Number(r.station_id));const status=statusNames[r.ticket_status||r.status]||r.status;return `<button type="button" class="line-alert-card" data-line-map-group="${g?.id||''}" data-line-map-station="${st?.id||''}"><strong>${esc(st?.code||r.code||'Estación')}</strong><small>${esc(g?.name||r.group_name||'Línea')} · ${esc(fmtDept(r.department))}</small><div class="alert-status">${esc(status)}</div></button>`}).join('')}</div></div>`;
  if(admin.length)html+=`<div class="dashboard-alert-section admin-alert-section"><h3>Administrativos <span>${admin.length}</span></h3><div class="line-alerts-summary">${admin.map(r=>{const status=statusNames[r.ticket_status||r.status]||r.status;return `<button type="button" class="line-alert-card admin-alert-card" data-admin-alert-id="${r.id}"><strong>${esc(r.requester_area||r.support_location||'Solicitud administrativa')}</strong><small>${esc(r.plant_name||'')} · ${esc(fmtDept(r.department))} · ${esc(r.support_location||'')}</small><div class="alert-status">${esc(r.category_label||r.category||'')} · ${esc(status)}</div></button>`}).join('')}</div></div>`;
  return html;
}
function ensureLineMapModal(){let el=document.getElementById('lineMapModal');if(el)return el;el=document.createElement('div');el.id='lineMapModal';el.className='modal-overlay hidden';el.innerHTML='<div class="modal-card"><div class="modal-head"><div><h2>Ubicación de alerta</h2><p id="lineMapSubtitle">Mapa de línea</p></div><button type="button" class="modal-x" id="lineMapClose">×</button></div><div id="lineMapBody"></div></div>';document.body.appendChild(el);$('#lineMapClose').onclick=()=>el.classList.add('hidden');el.addEventListener('click',e=>{if(e.target===el)el.classList.add('hidden')});return el;}
function showLineAlertMap(groupId,stationId){if(!dashData)return;const g=(dashData.groups||[]).find(x=>Number(x.id)===Number(groupId));if(!g)return;const sts=(dashData.stations||[]).filter(x=>Number(x.group_id)===Number(groupId));const byStation={};(dashData.open||[]).forEach(r=>{if(r.code)(byStation[r.code]??=[]).push(r)});const el=ensureLineMapModal();$('#lineMapSubtitle').textContent=`${g.name} · ${g.plant_name||''}`;const wasEdit=andonLayoutEdit;andonLayoutEdit=false;$('#lineMapBody').innerHTML=renderProductionLine(g,sts,byStation);andonLayoutEdit=wasEdit;const focus=$(`#lineMapBody .station-tile[data-station-id="${stationId}"]`);if(focus)focus.classList.add('alert-focus');el.classList.remove('hidden');}
function showAdminAlertDetail(id){const r=(dashData?.open||[]).find(x=>Number(x.id)===Number(id));if(!r)return;actionModal({title:'Solicitud administrativa',message:'Detalle de la alerta activa.',confirmText:'Cerrar',fields:[{label:'Planta',value:r.plant_name||'—',readonly:true},{label:'Solicitante / área',value:r.requester_area||r.requested_by||'—',readonly:true},{label:'Ubicación',value:r.support_location||'—',readonly:true},{label:'Área de soporte',value:fmtDept(r.department),readonly:true},{label:'Categoría',value:r.category_label||r.category||'—',readonly:true},{label:'Descripción',value:r.notes||'—',readonly:true}]});}
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-line-map-group]');if(b){showLineAlertMap(Number(b.dataset.lineMapGroup),Number(b.dataset.lineMapStation));return;}const a=e.target.closest?.('[data-admin-alert-id]');if(a)showAdminAlertDetail(Number(a.dataset.adminAlertId));});

function renderDashboardFromData(){
  if(!dashData)return;const pid=Number(dashboardPlantId||0);const groups=(dashData.groups||[]).filter(g=>!pid||Number(g.plant_id)===pid);const groupIds=new Set(groups.map(g=>Number(g.id)));const stations=(dashData.stations||[]).filter(st=>!pid||groupIds.has(Number(st.group_id)));const stationCodes=new Set(stations.map(st=>st.code));const inPlant=x=>!pid||Number(x.plant_id)===pid||(!x.plant_id&&x.code&&stationCodes.has(x.code));
  const open=(dashData.open||[]).filter(inPlant);const unassigned=open.filter(x=>x.status==='unassigned');const tickets=open.filter(x=>x.status!=='unassigned');andonSyncPendingRequests(unassigned);
  $('#metricUnassigned').textContent=unassigned.length;$('#metricTickets').textContent=tickets.length;$('#metricBlocked').textContent=tickets.filter(x=>['waiting','escalated'].includes(x.ticket_status||x.status)).length;$('#metricSla').textContent=open.filter(x=>{const st=x.ticket_status||x.status;const due=st==='unassigned'?x.response_due_at:x.resolution_due_at;return due&&!['resolved','closed','cancelled'].includes(st)&&Date.now()>new Date(due).getTime()}).length;$('#metricClosedToday').textContent=pid?Number((dashData.closedTodayByPlant||[]).find(x=>Number(x.plant_id)===pid)?.count||0):Number(dashData.closedToday||0);$('#metricStations').textContent=stations.length;
  $('#groupsGrid').innerHTML=renderDashboardAlerts(groups,stations,unassigned);
  const reqEl=$('#dashboardRequests');if(reqEl)reqEl.innerHTML=requestRows(unassigned,true);const recentEl=$('#recentList');if(recentEl)recentEl.innerHTML=(dashData.recent||[]).filter(inPlant).slice(0,25).map(recentItem).join('')||'<div class="empty-mini">Sin actividad reciente.</div>';
}

async function loadDashboard(){
  dashData=await api('/api/dashboard');me=dashData.user;supportDepartments=dashData.departments||supportDepartments;renderIdentity();try{const c=await api('/api/soporte/catalog');dashData.adminAreas=c.areas||[]}catch{dashData.adminAreas=[]}
  fillPlantSelect($('#dashboardPlantFilter'),dashData.plants||[],true);if(dashboardPlantId&&[...$('#dashboardPlantFilter').options].some(o=>o.value===dashboardPlantId))$('#dashboardPlantFilter').value=dashboardPlantId;else dashboardPlantId=$('#dashboardPlantFilter')?.value||'';bindDashboardPlantFilter();renderDashboardFromData();
}

async function loadRequests(){const rows=await api('/api/requests-list');$('#requestsTable').innerHTML=requestRows(rows,false)}
window.assignRequest=async(id,assignedTo=null)=>{
  const buttons=$$(`button[onclick*="assignRequest(${id}"]`);
  buttons.forEach(b=>{b.disabled=true;b.dataset.oldText=b.textContent;b.textContent='Asignando...'});
  try{
    const d=await api(`/api/requests/${id}/assign`,{method:'POST',body:JSON.stringify(assignedTo?{assignedTo}:{})});
    toast(`Ticket ${d.ticket.ticket_number} asignado a ${Number(d.ticket.assigned_to)===Number(me.id)?'ti':(d.assignee?.full_name||'técnico')}`,'success');
    await refreshCurrent();
  }catch(e){toast(e.message,'error');buttons.forEach(b=>{b.disabled=false;b.textContent=b.dataset.oldText||'Asignarme'});}
};
async function getAssignmentCandidates(department){return api(`/api/assignment-candidates?department=${encodeURIComponent(department)}`)}
window.openAssignRequestModal=async(id,department)=>{
  try{
    const people=await getAssignmentCandidates(department);
    if(!people.length)return toast('No hay Ingenieros o Supervisores activos en esta área.','error');
    const options=people.map(u=>({value:String(u.id),label:`${u.full_name} · ${u.active_tickets===0?'LIBRE':u.active_tickets+' activo'+(u.active_tickets===1?'':'s')}`}));
    const r=await actionModal({title:'Asignar solicitud',message:`Selecciona quién atenderá esta solicitud de ${fmtDept(department)}. Se muestran primero quienes tienen menos tickets activos.`,confirmText:'Asignar ticket',fields:[{label:'Técnico / Supervisor',type:'select',value:options[0].value,options}]});
    if(!r)return;await assignRequest(id,Number(r[0]));
  }catch(e){toast(e.message,'error')}
};

async function loadTickets(){const mine=$('#mineOnly')?.checked?'1':'0';ticketsCache=await api(`/api/tickets?mine=${mine}`);renderTickets()}
function renderTickets(){const q=($('#ticketSearch').value||'').toLowerCase();const rows=ticketsCache.filter(x=>!q||[x.ticket_number,x.station_code,x.station_name,x.group_name,x.description,x.assigned_to_name,x.category_label].some(v=>String(v||'').toLowerCase().includes(q)));$('#ticketsTable').innerHTML=rows.length?rows.map(x=>`<tr><td><strong class="ticket-number">${esc(x.ticket_number)}</strong><small class="subline">${fmtDate(x.assigned_at)}</small></td><td>${deptBadge(x.department)}</td><td>${esc(x.group_name||'—')}<small class="subline"><strong>${esc(x.station_code)}</strong> · ${esc(x.station_name||'')}</small></td><td>${esc(x.category_label||x.category||'')}</td><td>${esc(x.description||'—')}</td><td>${esc(x.assigned_to_name||'—')}</td><td>${statusChip(x.status)}</td><td>${slaBadge(x)}<small class="subline">Resp: ${fmtDate(x.response_due_at)}<br>Res: ${fmtDate(x.resolution_due_at)}</small></td><td>${x.status==='resolved'?`<span data-countdown="${x.auto_close_at}">${countdown(x.auto_close_at)}</span>`:'—'}</td><td>${ticketActions(x)}</td></tr>`).join(''):'<tr><td colspan="10" class="empty">No hay tickets activos.</td></tr>'}
function countdown(v){if(!v)return'—';const s=Math.max(0,Math.ceil((new Date(v)-Date.now())/1000));return s<=0?'Cerrando...':duration(s)}
function ticketActions(x){
  let opts=[];
  if(['assigned','in_progress','waiting','escalated'].includes(x.status)){
    opts=['in_progress','waiting','escalated','resolved'].filter(s=>s!==x.status);
  }else if(x.status==='resolved' && me && ['admin','superadmin'].includes(me.role)){
    opts=['closed'];
  }
  const canReassign=me&&['admin','superadmin','supervisor'].includes(me.role)&&!['closed','cancelled'].includes(x.status);const reassign=canReassign?`<button class="btn small secondary" onclick="openReassignTicketModal(${x.id})">Reasignar</button>`:'';
  return opts.length
    ? `<div class="ticket-actions"><select id="st-${x.id}"><option value="" selected disabled>Seleccionar estado</option>${opts.map(s=>`<option value="${s}">${statusNames[s]}</option>`).join('')}</select><button class="btn small primary" onclick="changeTicket(${x.id})">Aplicar</button>${reassign}<button class="btn small secondary" onclick="ticketDetail(${x.id})">Detalle</button></div>`
    : `<div class="ticket-actions">${reassign}<button class="btn small secondary" onclick="ticketDetail(${x.id})">Detalle</button></div>`;
}
window.openReassignTicketModal=async id=>{
  const row=ticketsCache.find(x=>Number(x.id)===Number(id));if(!row)return;
  try{
    const people=await getAssignmentCandidates(row.department);
    if(!people.length)return toast('No hay personal activo disponible en esta área.','error');
    const options=people.map(u=>({value:String(u.id),label:`${u.full_name} · ${u.active_tickets===0?'LIBRE':u.active_tickets+' activo'+(u.active_tickets===1?'':'s')}`}));
    const r=await actionModal({title:'Reasignar ticket',message:`${row.ticket_number} · ${fmtDept(row.department)}. La reasignación no reinicia los tiempos SLA.`,confirmText:'Reasignar',fields:[{label:'Nuevo responsable',type:'select',value:String(row.assigned_to||options[0].value),options}]});
    if(!r)return;await api(`/api/tickets/${id}/assignee`,{method:'PATCH',body:JSON.stringify({assignedTo:Number(r[0])})});toast('Ticket reasignado','success');await loadTickets();
  }catch(e){toast(e.message,'error')}
};
window.changeTicket=async id=>{
  const status=$(`#st-${id}`).value;
  if(!status){toast('Selecciona un estado.','error');return;}
  const row=ticketsCache.find(x=>Number(x.id)===Number(id));
  if(['waiting','escalated','resolved','closed'].includes(status)){openTicketActionModal(row,status);return;}
  try{await api(`/api/tickets/${id}/status`,{method:'PATCH',body:JSON.stringify({status})});toast(`Estado: ${statusNames[status]}`,'success');loadTickets()}catch(e){toast(e.message,'error')}
};
function ticketActionConfig(status){return {
  waiting:{title:'Poner ticket en espera',label:'Motivo de espera',placeholder:'Explica qué se está esperando: producción, usuario, material, proveedor, ventana de mantenimiento, etc.',button:'Guardar espera'},
  escalated:{title:'Escalar ticket',label:'Motivo del escalamiento',placeholder:'Describe por qué se escala y, si aplica, a qué persona, equipo o proveedor.',button:'Guardar escalamiento'},
  resolved:{title:'Registrar solución',label:'Solución aplicada',placeholder:'Describe con detalle la solución aplicada, ajustes realizados, pruebas efectuadas y resultado de la validación.',button:'Marcar como Resuelto'},
  closed:{title:'Cerrar ticket',label:'Solución / comentario final de cierre',placeholder:'Documenta la solución final, validación realizada y cualquier dato importante que deba quedar en el historial.',button:'Cerrar ticket'}
}[status]}
function openTicketActionModal(row,status){
  if(!row)return;const c=ticketActionConfig(status);if(!c)return;
  $('#ticketActionId').value=row.id;$('#ticketActionStatus').value=status;$('#ticketActionTitle').textContent=c.title;$('#ticketActionSubtitle').textContent=`${row.ticket_number} · ${row.group_name||'—'} · ${row.station_code}`;
  $('#ticketActionLabel').childNodes[0].nodeValue=c.label+' ';$('#ticketActionText').placeholder=c.placeholder;$('#ticketActionText').value='';$('#ticketActionSave').textContent=c.button;
  $('#ticketActionContext').innerHTML=`<strong>${esc(row.ticket_number)}</strong><span>${fmtDept(row.department)} · ${esc(row.category_label||row.category||'')}</span><span>${esc(row.group_name||'—')} · ${esc(row.station_code)} · ${esc(row.station_name||'')}</span><span>${esc(row.description||'Sin descripción')}</span>`;
  const hint=$('#ticketActionHint');if(hint){hint.textContent='Máximo 4000 caracteres. Esta información quedará registrada en la trazabilidad del ticket.';hint.classList.remove('form-error')}
  $('#ticketActionModal').classList.remove('hidden');setTimeout(()=>$('#ticketActionText').focus(),50);
}
function closeTicketActionModal(){$('#ticketActionModal').classList.add('hidden');$('#ticketActionText').value=''}
$('#ticketActionClose').addEventListener('click',closeTicketActionModal);$('#ticketActionCancel').addEventListener('click',closeTicketActionModal);$('#ticketActionModal').addEventListener('click',e=>{if(e.target.id==='ticketActionModal')closeTicketActionModal()});
$('#ticketActionForm').addEventListener('submit',async e=>{
  e.preventDefault();const id=Number($('#ticketActionId').value),status=$('#ticketActionStatus').value,text=$('#ticketActionText').value.trim();
  if(!text){toast('Debes capturar la información antes de continuar.','error');$('#ticketActionText').focus();return;}
  const body={status};if(status==='waiting'||status==='escalated')body.reason=text;if(status==='resolved')body.comment=text;if(status==='closed')body.closureComment=text;
  const btn=$('#ticketActionSave');btn.disabled=true;const old=btn.textContent;btn.textContent='Guardando...';
  try{
    const saved=await api(`/api/tickets/${id}/status`,{method:'PATCH',body:JSON.stringify(body)});
    closeTicketActionModal();
    toast(status==='resolved'?'Solución registrada. Ticket marcado como Resuelto.':`Estado: ${statusNames[status]}`,'success');
    await loadTickets();
  }catch(err){
    toast(err.message,'error');
    const hint=$('#ticketActionHint');if(hint){hint.textContent=err.message;hint.classList.add('form-error')}
  }finally{btn.disabled=false;btn.textContent=old}
});
function closeTicketDetailModal(){$('#ticketDetailModal').classList.add('hidden')}
$('#ticketDetailClose').addEventListener('click',closeTicketDetailModal);
$('#ticketDetailOk').addEventListener('click',closeTicketDetailModal);
$('#ticketDetailModal').addEventListener('click',e=>{if(e.target.id==='ticketDetailModal')closeTicketDetailModal()});

window.ticketDetail=async id=>{
  try{
    const d=await api(`/api/tickets/${id}/events`),t=d.ticket;
    $('#ticketDetailSubtitle').textContent=`${t.ticket_number} · ${t.group_name||'—'} · ${t.station_code||'—'}`;
    $('#ticketDetailSummary').innerHTML=`<strong>${esc(t.ticket_number||'')}</strong><span>${fmtDept(t.department)} · ${esc(t.category_label||t.category||'Sin categoría')}</span><span>${esc(t.group_name||'—')} · ${esc(t.station_code||'—')} · ${esc(t.station_name||'')}</span><span>Estado: ${esc(statusNames[t.status]||t.status||'—')}</span>`;
    $('#ticketDetailInfo').innerHTML=`<div><span>Descripción</span><strong>${esc(t.description||t.request_notes||'Sin descripción')}</strong></div><div><span>Técnico</span><strong>${esc(t.assigned_to_name||'—')}</strong></div><div><span>Solicitado</span><strong>${fmtDate(t.requested_at)}</strong></div><div><span>Asignado / respuesta</span><strong>${fmtDate(t.actual_response_at||t.assigned_at)}</strong></div><div><span>Resuelto</span><strong>${fmtDate(t.resolved_at)}</strong></div><div><span>Cerrado</span><strong>${fmtDate(t.closed_at)}</strong></div><div><span>Tipo de cierre</span><strong>${esc(t.closure_type||'—')}</strong></div><div><span>SLA aplicado</span><strong>${esc(t.sla_name||'Sin política')}</strong></div>`;
    $('#ticketDetailSla').innerHTML=slaMetricHtml('SLA de respuesta',t.response_sla_met,t.response_seconds,t.response_minutes)+slaMetricHtml('SLA de resolución',t.resolution_sla_met,t.resolution_seconds,t.resolution_minutes)+`<article class="detail-metric"><span>Tiempo total de resolución</span><strong>${t.resolution_seconds==null?'—':duration(Number(t.resolution_seconds))}</strong><small>Desde solicitud hasta Resuelto</small></article>`;
    $('#ticketDetailSolution').innerHTML=`<div><span>Solución aplicada</span><p>${esc(t.resolution_notes||'Sin solución documentada')}</p></div><div><span>Comentario final de cierre</span><p>${esc(t.closure_notes||'Sin comentario de cierre')}</p></div>`;
    $('#ticketDetailTimeline').innerHTML=d.events.length?d.events.map(e=>`<article class="timeline-event"><div class="timeline-dot"></div><div><strong>${fmtDate(e.created_at)} · ${esc(e.user_name||'Sistema')}</strong><span>${e.old_status?`${esc(statusNames[e.old_status]||e.old_status)} → `:''}${esc(statusNames[e.new_status]||e.new_status||e.event_type||'Evento')}</span>${e.comment?`<p>${esc(e.comment)}</p>`:''}</div></article>`).join(''):'<div class="empty">Sin eventos registrados.</div>';
    $('#ticketDetailModal').classList.remove('hidden');
  }catch(e){toast(e.message,'error')}
};

async function loadHistory(){
  try{
    const rows=await api('/api/history');
    $('#historyTable').innerHTML=rows.length?rows.map(x=>`<tr><td><strong>${esc(x.ticket_number)}</strong></td><td>${deptBadge(x.department)}</td><td>${esc(x.group_name||'')}<small class="subline">${esc(x.station_code)} · ${esc(x.station_name||'')}</small></td><td>${esc(x.category_label||x.category||'')}</td><td>${esc(x.assigned_to_name||'—')}</td><td><strong>${esc(x.sla_name||'Sin política')}</strong><small class="subline">${x.response_minutes||'—'}m resp. · ${x.resolution_minutes||'—'}m res.</small></td><td>${slaHistoryChip(x.response_sla_met)}<small class="subline">${x.response_seconds==null?'—':duration(Number(x.response_seconds))}</small></td><td>${slaHistoryChip(x.resolution_sla_met)}<small class="subline">${x.resolution_seconds==null?'—':duration(Number(x.resolution_seconds))}</small></td><td><strong>${x.resolution_seconds==null?'—':duration(Number(x.resolution_seconds))}</strong><small class="subline">Solicitud → Resuelto</small></td><td>${fmtDate(x.closed_at)}</td><td>${esc(x.closure_type||'—')}</td><td><button class="btn small secondary" onclick="ticketDetail(${x.id})">Detalle</button></td></tr>`).join(''):'<tr><td colspan="12" class="empty">Sin tickets cerrados.</td></tr>';
  }catch(e){toast(e.message,'error')}
}

async function ensureReportFilters(){
  if(!reportFilters)reportFilters=await api('/api/report-filters');
  const plant=$('#repPlant'),dept=$('#repDept'),group=$('#repGroup'),eng=$('#repEngineer'),status=$('#repStatus');
  const keep={plant:plant?.value||'',dept:dept?.value||'',group:group?.value||'',eng:eng?.value||'',status:status?.value||''};
  if(plant){plant.innerHTML='<option value="">Todas</option>'+(reportFilters.plants||[]).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');if([...plant.options].some(o=>o.value===keep.plant))plant.value=keep.plant;}
  updateReportCascade();
  if(status){status.innerHTML='<option value="">Todos</option>'+reportFilters.statuses.map(x=>`<option value="${x}">${statusNames[x]||x}</option>`).join('');if([...status.options].some(o=>o.value===keep.status))status.value=keep.status;}
  if(me.role==='engineer'||me.role==='supervisor'){dept.value=me.department;dept.disabled=true;updateReportCascade();}
}
function updateReportCascade(){
  if(!reportFilters)return;
  const plantId=Number($('#repPlant')?.value||0),dept=$('#repDept')?.value||me?.department||'';
  const group=$('#repGroup'),eng=$('#repEngineer');
  if(group){const old=group.value;const rows=(reportFilters.groups||[]).filter(x=>!plantId||Number(x.plant_id)===plantId);group.innerHTML='<option value="">Todos</option>'+rows.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');group.value=[...group.options].some(o=>o.value===old)?old:'';}
  updateReportCategories();
  if(eng){const old=eng.value;const rows=(reportFilters.engineers||[]).filter(x=>!dept||['superadmin','admin'].includes(x.role)||x.department===dept);eng.innerHTML='<option value="">Todos</option>'+rows.map(x=>`<option value="${x.id}">${esc(x.full_name)} · ${x.role==='superadmin'?'Superadmin':x.role==='admin'?'Admin':fmtDept(x.department)}</option>`).join('');eng.value=[...eng.options].some(o=>o.value===old)?old:'';}
}
function updateReportCategories(){if(!reportFilters)return;const d=$('#repDept')?.value||me?.department||'';const el=$('#repCategory');if(!el)return;const old=el.value;el.innerHTML='<option value="">Todas</option>'+reportFilters.categories.filter(x=>!d||x.department===d).map(x=>`<option value="${x.code}">${fmtDept(x.department)} · ${esc(x.label)}</option>`).join('');el.value=[...el.options].some(o=>o.value===old)?old:'';}
function pct(n,d){return d?Math.round(Number(n||0)/Number(d)*100):0}
function reportColorForPct(v){return v>=90?'#27c878':v>=80?'#f0b828':'#f24c55'}
function svgEsc(v){return esc(v)}
function noDataHtml(){return '<div class="chart-empty">Sin datos para los filtros seleccionados.</div>'}

function renderLineChart(sel,rows){
  const el=$(sel); if(!rows?.length){el.innerHTML=noDataHtml();return}
  const W=760,H=245,p={l:38,r:12,t:18,b:36};
  const max=Math.max(1,...rows.flatMap(x=>[Number(x.created||0),Number(x.resolved||0)]));
  const x=i=>p.l+(rows.length===1?0:(W-p.l-p.r)*i/(rows.length-1));
  const y=v=>p.t+(H-p.t-p.b)*(1-Number(v||0)/max);
  const pts=k=>rows.map((r,i)=>`${x(i)},${y(r[k])}`).join(' ');
  const grid=Array.from({length:5},(_,i)=>{const yy=p.t+(H-p.t-p.b)*i/4;const val=Math.round(max*(1-i/4));return `<line x1="${p.l}" y1="${yy}" x2="${W-p.r}" y2="${yy}" class="svg-grid"/><text x="${p.l-8}" y="${yy+4}" class="svg-axis" text-anchor="end">${val}</text>`}).join('');
  const step=Math.max(1,Math.ceil(rows.length/8));
  const labels=rows.map((r,i)=>i%step===0||i===rows.length-1?`<text x="${x(i)}" y="${H-10}" class="svg-axis" text-anchor="middle">${new Date(r.day+'T00:00:00').toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit'})}</text>`:'').join('');
  el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${labels}<polyline points="${pts('created')}" class="line-created"/><polyline points="${pts('resolved')}" class="line-resolved"/>${rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r.created)}" r="3" class="dot-created"><title>${r.day}: ${r.created} creados</title></circle><circle cx="${x(i)}" cy="${y(r.resolved)}" r="3" class="dot-resolved"><title>${r.day}: ${r.resolved} resueltos</title></circle>`).join('')}</svg>`;
}

function renderVerticalBars(sel,rows,maxValue=100){
  const el=$(sel); if(!rows?.length){el.innerHTML=noDataHtml();return}
  const W=420,H=245,p={l:38,r:18,t:20,b:42}; const max=Math.max(maxValue||1,...rows.map(x=>Number(x.value||0)));
  const bw=Math.min(92,(W-p.l-p.r)/(rows.length*1.8)); const gap=(W-p.l-p.r)/rows.length;
  const colors=['#f24c55','#f0b828','#2e82f6','#27c878'];
  el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${[0,25,50,75,100].map(v=>{const yy=p.t+(H-p.t-p.b)*(1-v/max);return `<line x1="${p.l}" y1="${yy}" x2="${W-p.r}" y2="${yy}" class="svg-grid"/><text x="${p.l-8}" y="${yy+4}" class="svg-axis" text-anchor="end">${v}%</text>`}).join('')}
    ${rows.map((r,i)=>{const h=(H-p.t-p.b)*Number(r.value||0)/max;const xx=p.l+gap*i+(gap-bw)/2;const yy=H-p.b-h;return `<rect x="${xx}" y="${yy}" width="${bw}" height="${h}" rx="3" fill="${colors[i%colors.length]}"/><text x="${xx+bw/2}" y="${Math.max(16,yy-7)}" class="bar-value" text-anchor="middle">${r.value}%</text><text x="${xx+bw/2}" y="${H-14}" class="svg-label" text-anchor="middle">${svgEsc(r.label)}</text>`}).join('')}
  </svg>`;
}

function renderHorizontalBars(sel,rows,color='#2e82f6',isPct=false){
  const el=$(sel); if(!rows?.length){el.innerHTML=noDataHtml();return}
  const W=520,rowH=38,H=Math.max(190,rows.length*rowH+30),labelW=120,right=36;
  const max=Math.max(1,...rows.map(x=>Number(isPct?x.percentage:x.total)||0));
  el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${rows.map((r,i)=>{
    const val=Number(isPct?r.percentage:r.total)||0, y=18+i*rowH, bw=(W-labelW-right)*val/max;
    return `<text x="0" y="${y+14}" class="svg-label">${svgEsc(r.label)}</text><rect x="${labelW}" y="${y}" width="${W-labelW-right}" height="16" rx="3" class="bar-track"/><rect x="${labelW}" y="${y}" width="${bw}" height="16" rx="3" fill="${color}"/><text x="${Math.min(W-4,labelW+bw+8)}" y="${y+13}" class="bar-value">${isPct?val+'%':val}</text>`;
  }).join('')}</svg>`;
}

function renderDonut(sel,rows){
  const el=$(sel),clean=(rows||[]).filter(x=>Number(x.total)>0); if(!clean.length){el.innerHTML=noDataHtml();return}
  const total=clean.reduce((a,x)=>a+Number(x.total),0),colors=['#16b8a6','#2e82f6','#8a4ce6','#f0b828'];
  let angle=-Math.PI/2;
  const cx=115,cy=102,r=64,sw=25;
  const arcs=clean.map((x,i)=>{const frac=Number(x.total)/total,a0=angle,a1=angle+Math.PI*2*frac;angle=a1;const x1=cx+r*Math.cos(a0),y1=cy+r*Math.sin(a0),x2=cx+r*Math.cos(a1),y2=cy+r*Math.sin(a1),large=frac>.5?1:0;return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${colors[i%colors.length]}" stroke-width="${sw}"><title>${fmtDept(x.label)}: ${x.total}</title></path>`}).join('');
  el.innerHTML=`<div class="donut-wrap"><svg viewBox="0 0 230 205">${arcs}<text x="${cx}" y="${cy-2}" text-anchor="middle" class="donut-total">${total}</text><text x="${cx}" y="${cy+18}" text-anchor="middle" class="donut-sub">tickets</text></svg><div class="donut-legend">${clean.map((x,i)=>`<div><i style="background:${colors[i%colors.length]}"></i><span>${fmtDept(x.label)}</span><strong>${x.total} (${pct(x.total,total)}%)</strong></div>`).join('')}</div></div>`;
}

function slaPill(v){
  if(v==null)return '<span class="perf-pill neutral">—</span>';
  const cls=v>=90?'good':v>=80?'warn':'bad'; return `<span class="perf-pill ${cls}">${v}%</span>`;
}

async function loadReports(init=false){
  try{
  initReportLayout();
  initReportDatePickers();
  await ensureReportFilters();
  if(init&&!$('#repFrom').value){
    const d=new Date();$('#repTo').value=d.toISOString().slice(0,10);d.setDate(d.getDate()-29);$('#repFrom').value=d.toISOString().slice(0,10);
  }
  const qs=new URLSearchParams({plantId:$('#repPlant')?.value||'',department:$('#repDept').value,groupId:$('#repGroup').value,category:$('#repCategory').value,engineerId:$('#repEngineer').value,status:$('#repStatus').value,from:$('#repFrom').value,to:$('#repTo').value});
  const d=await api('/api/reports?'+qs); reportCache=d;
  const responsePct=pct(d.summary.response_met,d.summary.response_measured);
  const resolutionPct=pct(d.summary.resolution_met,d.summary.resolution_measured);

  $('#repTotal').textContent=d.summary.total||0;
  $('#repClosed').textContent=d.summary.closed||0;
  $('#repTotalSub').textContent='100% del total';
  $('#repClosedSub').textContent=`${pct(d.summary.closed,d.summary.total)}% del total`;
  $('#repResponse').textContent=duration(d.summary.avg_response_seconds);
  $('#repResolution').textContent=duration(d.summary.avg_resolution_seconds);
  $('#repResponseSla').textContent=d.summary.response_measured?`${responsePct}%`:'—';
  $('#repResolutionSla').textContent=d.summary.resolution_measured?`${resolutionPct}%`:'—';
  $('#repResponseSla').style.color=reportColorForPct(responsePct);
  $('#repResolutionSla').style.color=reportColorForPct(resolutionPct);
  $('#repResponseRing').style.setProperty('--pct',responsePct);$('#repResponseRing').style.setProperty('--ring',reportColorForPct(responsePct));
  $('#repResolutionRing').style.setProperty('--pct',resolutionPct);$('#repResolutionRing').style.setProperty('--ring',reportColorForPct(resolutionPct));

  renderLineChart('#chartDaily',d.daily);
  renderVerticalBars('#chartSlaSummary',[{label:'Respuesta',value:responsePct},{label:'Resolución',value:resolutionPct}],100);
  renderHorizontalBars('#chartCategorySla',d.categorySla,'#2fc57d',true);
  renderHorizontalBars('#chartIncidents',d.byCategory.slice(0,6),'#2e82f6',false);
  renderHorizontalBars('#chartGroups',d.byGroup.slice(0,6),'#8a4ce6',false);
  renderDonut('#chartAreas',d.byArea);

  $('#reportEngineerTable').innerHTML=(d.engineerPerformance||[]).map(x=>`<tr>
    <td><strong>${esc(x.label)}</strong></td><td>${x.total}</td><td>${x.closed}</td><td>${x.pending}</td>
    <td>${duration(x.avg_response_seconds)}</td><td>${duration(x.avg_resolution_seconds)}</td>
    <td>${slaPill(x.closure_percentage)}</td><td>${slaPill(x.sla_percentage)}</td>
  </tr>`).join('')||'<tr><td colspan="8" class="empty">Sin datos.</td></tr>';
  $('#reportRecurrentTable').innerHTML=(d.recurrent||[]).map(x=>`<tr><td><strong>${esc(x.label)}</strong><small>${esc(x.station_name||'')}</small></td><td>${esc(x.group_name||'')}</td><td>${x.total}</td><td>${esc(x.principal_incident||'—')}</td><td>${duration(x.avg_resolution_seconds)}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">Sin datos.</td></tr>';
  renderHorizontalBars('#chartResolutionDistribution',d.resolutionDistribution,'#19b9a7',true);

  }catch(e){
    console.error('R10.8.1 loadReports:',e);
    toast(e.message||'No se pudieron cargar los reportes','error');
    ['#chartDaily','#chartSlaSummary','#chartCategorySla','#chartIncidents','#chartGroups','#chartAreas','#chartResolutionDistribution'].forEach(s=>{
      const el=$(s);if(el)el.innerHTML=`<div class="chart-empty">${esc(e.message||'Error al cargar reportes')}</div>`;
    });
  }
}


const REPORT_LAYOUT_KEY='andon_report_layout_r1084';
function saveReportLayout(){
  const grid=$('#reportWidgetGrid');if(!grid)return;
  const data=[...grid.querySelectorAll('.report-widget')].map(x=>({id:x.dataset.widget,span:Number(x.dataset.span||4)}));
  localStorage.setItem(REPORT_LAYOUT_KEY,JSON.stringify(data));
}
function restoreReportLayout(){
  const grid=$('#reportWidgetGrid');if(!grid)return;
  try{
    const saved=JSON.parse(localStorage.getItem(REPORT_LAYOUT_KEY)||'[]');
    if(Array.isArray(saved)&&saved.length){
      saved.forEach(s=>{
        const el=grid.querySelector(`[data-widget="${CSS.escape(String(s.id))}"]`);
        if(el){el.dataset.span=String([3,4,6,8,12].includes(Number(s.span))?Number(s.span):4);grid.appendChild(el)}
      });
    }
  }catch{}
}
function initReportLayout(){
  const grid=$('#reportWidgetGrid');if(!grid||grid.dataset.ready==='1')return;
  grid.dataset.ready='1';
  restoreReportLayout();
  let dragged=null;
  grid.querySelectorAll('.report-widget').forEach(card=>{
    card.draggable=true;
    card.addEventListener('dragstart',e=>{
      if(e.target.closest('button,select,input,a')){e.preventDefault();return}
      dragged=card;card.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain',card.dataset.widget||'widget');
    });
    card.addEventListener('dragend',()=>{
      card.classList.remove('dragging');
      grid.querySelectorAll('.drag-over').forEach(x=>x.classList.remove('drag-over'));
      dragged=null;saveReportLayout();
    });
    card.addEventListener('dragover',e=>{
      e.preventDefault();if(!dragged||dragged===card)return;
      card.classList.add('drag-over');
      const rect=card.getBoundingClientRect();
      const after=(e.clientY-rect.top)>rect.height/2 || (Math.abs(e.clientY-(rect.top+rect.height/2))<rect.height*.2 && e.clientX>rect.left+rect.width/2);
      grid.insertBefore(dragged,after?card.nextSibling:card);
    });
    card.addEventListener('dragleave',()=>card.classList.remove('drag-over'));
    const sizeBtn=card.querySelector('.widget-size-btn');
    if(sizeBtn)sizeBtn.addEventListener('click',e=>{
      e.stopPropagation();
      const sizes=[3,4,6,8,12],cur=Number(card.dataset.span||4);
      card.dataset.span=String(sizes[(Math.max(0,sizes.indexOf(cur))+1)%sizes.length]);
      saveReportLayout();
    });
  });
}
function openDatePicker(input){
  if(!input)return;
  input.focus({preventScroll:true});
  try{if(typeof input.showPicker==='function')input.showPicker()}catch{}
}
function initReportDatePickers(){
  ['repFrom','repTo'].forEach(id=>{
    const input=$('#'+id);if(!input||input.dataset.pickerReady==='1')return;
    input.dataset.pickerReady='1';
    input.addEventListener('click',()=>openDatePicker(input));
  });
}

async function reportExcel(){
  if(!reportCache){toast('No hay datos de reporte para exportar.','error');return;}
  try{
    const payload={
      report:reportCache,
      filters:{
        plant:$('#repPlant')?.selectedOptions?.[0]?.textContent||'Todas',
        department:$('#repDept')?.selectedOptions?.[0]?.textContent||'Todas',
        group:$('#repGroup')?.selectedOptions?.[0]?.textContent||'Todos',
        category:$('#repCategory')?.selectedOptions?.[0]?.textContent||'Todas',
        engineer:$('#repEngineer')?.selectedOptions?.[0]?.textContent||'Todos',
        status:$('#repStatus')?.selectedOptions?.[0]?.textContent||'Todos',
        from:$('#repFrom')?.value||'',to:$('#repTo')?.value||''
      }
    };
    const r=await fetch('/api/reports/export-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||'No se pudo generar el Excel');}
    const blob=await r.blob(),a=document.createElement('a'),url=URL.createObjectURL(blob);
    a.href=url;a.download=`Andon-Reporte-${$('#repFrom').value||'inicio'}-${$('#repTo').value||'hoy'}.xlsx`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
    toast('Excel generado correctamente','success');
  }catch(e){toast(e.message||'No se pudo generar el Excel','error')}
}

function reportPdf(){
  if(!reportCache){toast('No hay datos de reporte para exportar.','error');return;}
  const src=document.getElementById('view-reports');if(!src)return;
  const clone=src.cloneNode(true);
  clone.querySelectorAll('button,.widget-size-btn,.drag-grip').forEach(x=>x.remove());
  clone.querySelectorAll('select,input').forEach(el=>{
    const span=document.createElement('span');span.className='print-filter-value';span.textContent=el.tagName==='SELECT'?(el.selectedOptions?.[0]?.textContent||'Todos'):(el.value||'—');el.replaceWith(span);
  });
  const w=window.open('','_blank');if(!w){toast('El navegador bloqueó la ventana de exportación PDF.','error');return;}
  const title=`ANDON Support · Reporte ${$('#repFrom').value||''} - ${$('#repTo').value||''}`;
  w.document.open();w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#132033;background:#fff;margin:0;font-size:10px}h1,h2,h3{margin:0 0 6px;color:#0d1b2a}.report-title{font-size:20px;margin-bottom:4px}.report-meta{margin-bottom:12px;color:#526578}.analytics-filters{border:1px solid #ccd6e0;border-radius:8px;padding:10px;margin-bottom:10px}.analytics-filter-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.analytics-filter-grid label{font-weight:700;display:grid;gap:3px}.print-filter-value{border:1px solid #d5dde5;border-radius:5px;padding:6px;background:#f8fafc;font-weight:400}.analytics-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin:10px 0}.analytics-kpi{border:1px solid #ccd6e0;border-radius:8px;padding:9px;min-height:68px}.analytics-kpi span,.analytics-kpi small{display:block;color:#526578}.analytics-kpi strong{display:block;font-size:18px;margin:4px 0}.kpi-icon,.sla-ring{display:none!important}.report-widget-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:8px}.report-widget{grid-column:span 6;border:1px solid #ccd6e0;border-radius:8px;padding:8px;break-inside:avoid;page-break-inside:avoid}.report-widget[data-span="3"]{grid-column:span 4}.report-widget[data-span="4"]{grid-column:span 4}.report-widget[data-span="8"]{grid-column:span 8}.report-widget[data-span="12"]{grid-column:span 12}.analytics-panel-head{margin-bottom:6px}.chart-legend{display:flex;gap:10px}.svg-chart{width:100%;height:190px}.svg-chart svg{width:100%;height:100%}.analytics-table-wrap{overflow:visible}.analytics-table,table{width:100%;border-collapse:collapse;font-size:8px}.analytics-table th,.analytics-table td,table th,table td{border:1px solid #dbe3eb;padding:4px;text-align:left}.analytics-table th,table th{background:#edf3f8}.export-bar{display:none!important}.chart-empty{padding:25px;text-align:center;color:#6b7c8f}.svg-axis,.svg-label,.bar-value{fill:#44576a!important}.svg-grid{stroke:#dce4ec!important}.bar-track{fill:#edf2f6!important}.line-created{stroke:#2e82f6!important;fill:none}.line-resolved{stroke:#27a86b!important;fill:none}.dot-created{fill:#2e82f6!important}.dot-resolved{fill:#27a86b!important}
  </style></head><body><div class="report-title">ANDON Support · Reportes</div><div class="report-meta">Generado: ${new Date().toLocaleString('es-MX')}</div>${clone.innerHTML}<script>window.onload=()=>setTimeout(()=>window.print(),350);<\/script></body></html>`);w.document.close();
}


function ensureActionModal(){
  let el=$('#adminActionModal');if(el)return el;
  el=document.createElement('div');el.id='adminActionModal';el.className='modal-overlay hidden';
  el.innerHTML=`<div class="modal-card admin-action-card"><div class="modal-head"><div><h2 id="adminActionTitle">Acción</h2><p id="adminActionMessage"></p></div><button type="button" class="modal-x" id="adminActionClose">×</button></div><form id="adminActionForm"><div id="adminActionFields" class="admin-action-fields"></div><div class="modal-actions"><button type="button" class="btn secondary" id="adminActionCancel">Cancelar</button><button type="submit" class="btn primary" id="adminActionConfirm">Guardar</button></div></form></div>`;
  document.body.appendChild(el);return el;
}
function actionModal({title='Acción',message='',confirmText='Guardar',danger=false,fields=[]}){
  const el=ensureActionModal(),box=$('#adminActionFields');$('#adminActionTitle').textContent=title;$('#adminActionMessage').textContent=message||'';$('#adminActionConfirm').textContent=confirmText;$('#adminActionConfirm').className='btn '+(danger?'danger':'primary');
  box.innerHTML=fields.map((f,i)=>{const id='adminActionField'+i;if(f.type==='select')return `<label>${esc(f.label||'')}<select id="${id}">${(f.options||[]).map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(f.value??'')?'selected':''}>${esc(o.label)}</option>`).join('')}</select></label>`;return `<label>${esc(f.label||'')}<input id="${id}" type="${f.type==='password'?'password':'text'}" value="${esc(f.value??'')}" ${f.placeholder?`placeholder="${esc(f.placeholder)}"`:''} ${f.readonly?'readonly':''} ${f.required===false?'':'required'}></label>`}).join('');
  el.classList.remove('hidden');setTimeout(()=>$('#adminActionField0')?.focus(),20);
  return new Promise(resolve=>{let done=false;const finish=v=>{if(done)return;done=true;el.classList.add('hidden');cleanup();resolve(v)};const form=$('#adminActionForm'),close=$('#adminActionClose'),cancel=$('#adminActionCancel');const submit=e=>{e.preventDefault();const vals=fields.map((f,i)=>$('#adminActionField'+i)?.value??'');if(fields.some((f,i)=>f.required!==false&&!String(vals[i]).trim()))return toast('Completa los campos requeridos.','error');finish(vals)};const x=()=>finish(null);const back=e=>{if(e.target===el)x()};const key=e=>{if(e.key==='Escape')x()};function cleanup(){form.removeEventListener('submit',submit);close.removeEventListener('click',x);cancel.removeEventListener('click',x);el.removeEventListener('click',back);document.removeEventListener('keydown',key)}form.addEventListener('submit',submit);close.addEventListener('click',x);cancel.addEventListener('click',x);el.addEventListener('click',back);document.addEventListener('keydown',key);});
}
async function confirmModal(title,message,confirmText='Confirmar'){const r=await actionModal({title,message,confirmText,danger:true,fields:[]});return r!==null}

let selectedAdminGroupId=null;
let selectedAdminPlantId='';

function enabledPlants(){return (adminData?.plants||[]).filter(x=>x.enabled)}
function adminPlantName(id){return (adminData?.plants||[]).find(x=>Number(x.id)===Number(id))?.name||'Sin planta'}
function populateAdminPlantSelectors(){
  const plants=enabledPlants();
  for(const id of ['groupPlant','groupPlantFilter','stationPlantFilter']){
    const el=$('#'+id);if(!el)continue;const cur=el.value;
    el.innerHTML=((id==='groupPlant')?'':'<option value="">Todas</option>')+plants.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if([...el.options].some(o=>o.value===cur))el.value=cur;
  }
  if($('#groupPlant')&&!$('#groupPlant').value&&plants[0])$('#groupPlant').value=String(plants[0].id);
}
function renderPlantsAdmin(){const el=$('#plantsAdminList');if(!el)return;el.innerHTML=(adminData?.plants||[]).map(p=>`<div class="admin-item"><div><strong>${esc(p.name)}</strong><small>${esc(p.code)} · ${p.enabled?'Activo':'Deshabilitado'}</small></div><div class="admin-actions superadmin-only"><button class="btn small secondary" onclick="renamePlant(${p.id},'${esc(p.name).replace(/'/g,"\\'")}')">Renombrar</button><button class="btn small ${p.enabled?'danger':'resolve'}" onclick="togglePlant(${p.id},${!p.enabled})">${p.enabled?'Deshabilitar':'Habilitar'}</button></div></div>`).join('')||'<div class="empty">No hay plantas.</div>'}
function renderGroupsAdmin(){
  const pf=Number($('#groupPlantFilter')?.value||0);const rows=(adminData?.groups||[]).filter(g=>!pf||Number(g.plant_id)===pf);
  $('#groupsAdminList').innerHTML=rows.map(g=>`<div class="admin-item"><div><strong>${esc(g.name)}</strong><small>${esc(g.code)} · ${esc(g.plant_name||adminPlantName(g.plant_id))} · ${g.enabled?'Activo':'Deshabilitado'}</small></div><div class="admin-actions"><button class="btn small secondary" onclick="cloneGroup(${g.id},'${esc(g.name).replace(/'/g,"\\'")}',${g.plant_id||'null'})">Clonar</button><button class="btn small secondary" onclick="moveGroupPlant(${g.id},${g.plant_id||'null'})">Cambiar planta</button><button class="btn small secondary" onclick="renameGroup(${g.id},'${esc(g.name).replace(/'/g,"\\'")}')">Renombrar</button><button class="btn small ${g.enabled?'danger':'resolve'}" onclick="toggleGroup(${g.id},${!g.enabled})">${g.enabled?'Deshabilitar':'Habilitar'}</button><button class="btn small danger" onclick="deleteGroup(${g.id})">Eliminar</button></div></div>`).join('')||'<div class="empty">No hay líneas para este filtro.</div>';
}
function renderAdminStations(){
  if(!adminData)return;const pf=Number($('#stationPlantFilter')?.value||0);const gid=Number($('#stationGroup').value||selectedAdminGroupId||0);selectedAdminGroupId=gid||null;
  const rows=(adminData.stations||[]).filter(st=>(!pf||Number(st.plant_id)===pf)&&(!gid||Number(st.group_id)===gid));
  $('#stationsAdminList').innerHTML=rows.length?rows.map(st=>`<div class="admin-item"><div><strong>${esc(st.code)}</strong><small>${esc(st.plant_name||'')} · ${esc(st.group_name||'')} · ${esc(st.label||'')} · ${st.enabled?'Activo':'Deshabilitado'} · /station/${esc(st.code)}</small></div><div class="admin-actions"><button class="btn small secondary" onclick="renameStation(${st.id},'${esc(st.label||'').replace(/'/g,"\\'")}')">Renombrar</button><button class="btn small ${st.enabled?'danger':'resolve'}" onclick="toggleStation(${st.id},${!st.enabled})">${st.enabled?'Deshabilitar':'Habilitar'}</button><button class="btn small danger" onclick="deleteStation(${st.id})">Eliminar</button></div></div>`).join(''):'<div class="empty">No hay equipos con este filtro.</div>';
}

function renderAdminLayoutEditor(){
  const host=$('#adminLayoutEditor');if(!host||!adminData)return;
  const gid=Number($('#stationGroup')?.value||selectedAdminGroupId||0);
  const g=(adminData.groups||[]).find(x=>Number(x.id)===gid);
  if(!g){host.innerHTML='<div class="empty">Selecciona una línea para editar su layout.</div>';return;}
  const sts=(adminData.stations||[]).filter(x=>Number(x.group_id)===gid&&x.enabled!==false);
  host.innerHTML=renderProductionLine(g,sts,{});
  const btn=$('#adminLayoutEditToggle');if(btn){btn.textContent=andonLayoutEdit?'✓ Terminar edición':'✏ Editar layout';btn.classList.toggle('primary',andonLayoutEdit);btn.classList.toggle('secondary',!andonLayoutEdit);}
  bindLayoutEditor();
}
function bindAdminLayoutEditor(){
  const btn=$('#adminLayoutEditToggle');if(!btn||btn.dataset.bound)return;btn.dataset.bound='1';
  btn.addEventListener('click',()=>{andonLayoutEdit=!andonLayoutEdit;andonLayoutSelectedId=null;renderAdminLayoutEditor();});
  renderAdminLayoutEditor();
}
function refreshStationGroupOptions(){const pf=Number($('#stationPlantFilter')?.value||0);const groups=(adminData?.groups||[]).filter(g=>g.enabled&&(!pf||Number(g.plant_id)===pf));const cur=Number($('#stationGroup')?.value||selectedAdminGroupId||0);$('#stationGroup').innerHTML=groups.map(g=>`<option value="${g.id}">${esc(g.name)} · ${esc(g.plant_name||adminPlantName(g.plant_id))}</option>`).join('');const target=groups.some(g=>Number(g.id)===cur)?cur:(groups[0]?.id||0);if(target){$('#stationGroup').value=String(target);selectedAdminGroupId=Number(target)}else selectedAdminGroupId=null;renderAdminStations()}
function renderDepartmentsAdmin(){const el=$('#departmentsAdminList');if(!el)return;el.innerHTML=(adminData?.departments||[]).map(d=>`<div class="admin-item"><div><strong>${esc(d.name)}</strong><small>${esc(d.code)} · ${d.enabled?'Activo':'Deshabilitado'}</small></div><div class="admin-actions"><button class="btn small secondary" onclick="renameDepartment(${d.id},'${esc(d.name).replace(/'/g,"\\'")}')">Renombrar</button><button class="btn small ${d.enabled?'danger':'resolve'}" onclick="toggleDepartment(${d.id},${!d.enabled})">${d.enabled?'Deshabilitar':'Habilitar'}</button></div></div>`).join('')||'<div class="empty">No hay áreas.</div>'}

async function loadGroups(preferredGroupId=null){adminData=await api('/api/admin/groups');supportDepartments=adminData.departments||supportDepartments;populateAdminPlantSelectors();renderPlantsAdmin();renderGroupsAdmin();if(preferredGroupId)selectedAdminGroupId=Number(preferredGroupId);refreshStationGroupOptions();$$('.superadmin-only').forEach(x=>x.classList.toggle('hidden',me?.role!=='superadmin'));bindProductionTabs();bindAdminLayoutEditor();renderAdminLayoutEditor()}
$('#groupPlantFilter')?.addEventListener('change',renderGroupsAdmin);$('#stationPlantFilter')?.addEventListener('change',refreshStationGroupOptions);$('#stationGroup')?.addEventListener('change',()=>{selectedAdminGroupId=Number($('#stationGroup').value||0)||null;andonLayoutSelectedId=null;renderAdminStations();});
$('#plantForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/admin/plants',{method:'POST',body:JSON.stringify({name:$('#plantName').value.trim()})});$('#plantName').value='';toast('Planta creada','success');await loadGroups()}catch(x){toast(x.message,'error')}});
$('#departmentForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/admin/departments',{method:'POST',body:JSON.stringify({name:$('#departmentName').value.trim()})});$('#departmentName').value='';toast('Área creada','success');await loadUsers()}catch(x){toast(x.message,'error')}});
$('#groupForm').addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/admin/groups',{method:'POST',body:JSON.stringify({name:$('#groupName').value.trim(),plantId:Number($('#groupPlant').value)})});toast(`Grupo ${d.name} creado`,'success');$('#groupName').value='';await loadGroups(d.id)}catch(x){toast(x.message,'error')}});
$('#stationForm').addEventListener('submit',async e=>{e.preventDefault();const gid=Number($('#stationGroup').value||0),name=$('#stationName').value.trim();try{const d=await api('/api/admin/stations',{method:'POST',body:JSON.stringify({groupId:gid,name})});toast(`Equipo ${d.code} creado`,'success');$('#stationName').value='';await loadGroups(gid)}catch(x){toast(x.message,'error')}});
window.cloneGroup=async(id,current,plantId)=>{const plants=enabledPlants();const r=await actionModal({title:'Clonar línea',message:`Se copiarán estaciones, layout y SLA de ${current}.`,confirmText:'Clonar línea',fields:[{label:'Nombre de la nueva línea',value:current==='V1'?'V2':`${current}-COPIA`},{label:'Planta destino',type:'select',value:String(plantId||plants[0]?.id||''),options:plants.map(p=>({value:String(p.id),label:p.name}))}]});if(!r)return;try{const d=await api(`/api/admin/groups/${id}/clone`,{method:'POST',body:JSON.stringify({name:r[0].trim(),plantId:Number(r[1])})});toast(`Línea clonada: ${d.group.name} (${d.stationCount} estaciones)`,'success');await loadGroups(d.group.id)}catch(e){toast(e.message,'error')}};
window.moveGroupPlant=async(id,currentPlantId)=>{const plants=enabledPlants();const r=await actionModal({title:'Cambiar planta',message:'Selecciona la planta destino para esta línea.',confirmText:'Cambiar planta',fields:[{label:'Planta destino',type:'select',value:String(currentPlantId||''),options:plants.map(p=>({value:String(p.id),label:p.name}))}]});if(!r||Number(r[0])===Number(currentPlantId))return;try{await api(`/api/admin/groups/${id}`,{method:'PATCH',body:JSON.stringify({plantId:Number(r[0])})});toast('Planta de la línea actualizada','success');await loadGroups(id)}catch(e){toast(e.message,'error')}};
window.renameGroup=async(id,current)=>{const r=await actionModal({title:'Renombrar línea',message:'El código de las estaciones se actualizará según corresponda.',confirmText:'Guardar nombre',fields:[{label:'Nuevo nombre de la línea',value:current}]});if(!r||r[0].trim()===current.trim())return;try{await api(`/api/admin/groups/${id}`,{method:'PATCH',body:JSON.stringify({name:r[0].trim()})});toast('Grupo renombrado','success');await loadGroups(selectedAdminGroupId)}catch(e){toast(e.message,'error')}};
window.renameStation=async(id,current)=>{const r=await actionModal({title:'Renombrar estación',message:'El código se regenera automáticamente con el nombre de la línea.',confirmText:'Guardar nombre',fields:[{label:'Nuevo nombre de la estación',value:current}]});if(!r||r[0].trim()===current.trim())return;try{const d=await api(`/api/admin/stations/${id}`,{method:'PATCH',body:JSON.stringify({name:r[0].trim()})});toast(`Equipo renombrado: ${d.code}`,'success');await loadGroups(selectedAdminGroupId)}catch(e){toast(e.message,'error')}};
window.toggleGroup=async(id,enabled)=>{try{await api(`/api/admin/groups/${id}`,{method:'PATCH',body:JSON.stringify({enabled})});await loadGroups(selectedAdminGroupId)}catch(e){toast(e.message,'error')}};
window.toggleStation=async(id,enabled)=>{try{await api(`/api/admin/stations/${id}`,{method:'PATCH',body:JSON.stringify({enabled})});await loadGroups(selectedAdminGroupId)}catch(e){toast(e.message,'error')}};
window.deleteGroup=async id=>{if(!(await confirmModal('Eliminar línea','La línea y sus estaciones se archivarán. El historial se conservará.','Eliminar línea')))return;try{await api(`/api/admin/groups/${id}`,{method:'DELETE'});selectedAdminGroupId=null;await loadGroups()}catch(e){toast(e.message,'error')}};
window.deleteStation=async id=>{if(!(await confirmModal('Eliminar estación','La estación se archivará. El historial se conservará.','Eliminar estación')))return;try{await api(`/api/admin/stations/${id}`,{method:'DELETE'});await loadGroups(selectedAdminGroupId)}catch(e){toast(e.message,'error')}};
window.renamePlant=async(id,current)=>{const r=await actionModal({title:'Renombrar planta',confirmText:'Guardar nombre',fields:[{label:'Nuevo nombre de la planta',value:current}]});if(!r)return;try{await api(`/api/admin/plants/${id}`,{method:'PATCH',body:JSON.stringify({name:r[0].trim()})});await loadGroups()}catch(e){toast(e.message,'error')}};
window.togglePlant=async(id,enabled)=>{try{await api(`/api/admin/plants/${id}`,{method:'PATCH',body:JSON.stringify({enabled})});await loadGroups()}catch(e){toast(e.message,'error')}};
window.renameDepartment=async(id,current)=>{const r=await actionModal({title:'Renombrar área',confirmText:'Guardar nombre',fields:[{label:'Nuevo nombre del área',value:current}]});if(!r)return;try{await api(`/api/admin/departments/${id}`,{method:'PATCH',body:JSON.stringify({name:r[0].trim()})});await loadUsers()}catch(e){toast(e.message,'error')}};
window.toggleDepartment=async(id,enabled)=>{try{await api(`/api/admin/departments/${id}`,{method:'PATCH',body:JSON.stringify({enabled})});await loadUsers()}catch(e){toast(e.message,'error')}};


function bindProductionTabs(){const tabs=$$('[data-production-tab]');if(!tabs.length)return;tabs.forEach(btn=>{if(btn.dataset.bound)return;btn.dataset.bound='1';btn.addEventListener('click',()=>{tabs.forEach(x=>x.classList.toggle('active',x===btn));$$('[data-production-panel]').forEach(x=>x.classList.toggle('active',x.dataset.productionPanel===btn.dataset.productionTab));});});}

function bindUserAreaTabs(){
  const tabs=$$('[data-user-tab]');if(!tabs.length)return;
  tabs.forEach(btn=>{if(btn.dataset.bound)return;btn.dataset.bound='1';btn.addEventListener('click',()=>{
    if(btn.dataset.userTab==='areas'&&me?.role!=='superadmin')return;
    tabs.forEach(x=>x.classList.toggle('active',x===btn));
    $$('[data-user-panel]').forEach(x=>x.classList.toggle('active',x.dataset.userPanel===btn.dataset.userTab));
  })});
}

function userRoleName(role){return role==='superadmin'?'Super Administrador':role==='admin'?'Administrador':role==='supervisor'?'Supervisor':role==='engineer'?'Ingeniero':role}
function userAreaName(u){return ['engineer','supervisor'].includes(u.role)?(u.department?fmtDept(u.department):'—'):'Todas'}
async function loadDepartmentOptions(){try{supportDepartments=await api('/api/support-departments');for(const id of ['userDepartment','repDept','slaDept']){const el=$('#'+id);if(!el)continue;const cur=el.value;el.innerHTML=(id==='userDepartment'?'':'<option value="">Todas</option>')+supportDepartments.map(d=>`<option value="${esc(d.code)}">${esc(d.name)}</option>`).join('');if([...el.options].some(o=>o.value===cur))el.value=cur;}syncUserCreateFields()}catch(e){console.error(e)}}
async function loadUsers(){await loadDepartmentOptions();const rows=await api('/api/admin/users');$('#usersTable').innerHTML=rows.map(u=>`<tr><td>${esc(userAreaName(u))}</td><td>${esc(userRoleName(u.role))}</td><td><strong>${esc(u.username)}</strong></td><td>${esc(u.full_name)}</td><td>${u.active?'Activo':'Deshabilitado'}</td><td>${userActions(u)}</td></tr>`).join('');if(me?.role==='superadmin'){const d=await api('/api/admin/departments');adminData={...(adminData||{}),departments:d};renderDepartmentsAdmin();}bindUserAreaTabs();}
function userActions(u){const protectedSuper=u.role==='superadmin'&&me.role!=='superadmin';return `<div class="ticket-actions"><button class="btn small secondary" ${protectedSuper?'disabled':''} onclick="editUser(${u.id},'${esc(u.full_name).replace(/'/g,"\\'")}','${u.role}','${u.department||''}')">Editar</button><button class="btn small secondary" ${protectedSuper?'disabled':''} onclick="resetUser(${u.id})">Restablecer</button><button class="btn small danger" ${(u.role==='superadmin'||u.id===me.id)?'disabled':''} onclick="deleteUser(${u.id})">Eliminar</button></div>`}
function syncUserCreateFields(){const role=$('#userRole').value,dep=$('#userDepartment');if(['engineer','supervisor'].includes(role)){dep.disabled=false;dep.title='Área que limita dashboard, solicitudes, tickets y reportes';}else{dep.disabled=true;dep.title='Administradores tienen acceso global';}}
$('#userRole').addEventListener('change',syncUserCreateFields);
$('#userForm').addEventListener('submit',async e=>{e.preventDefault();const role=$('#userRole').value;try{await api('/api/admin/users',{method:'POST',body:JSON.stringify({department:['engineer','supervisor'].includes(role)?$('#userDepartment').value:'',role,username:$('#userUsername').value,fullName:$('#userFullName').value,password:$('#userPassword').value})});toast('Usuario creado','success');e.target.reset();syncUserCreateFields();loadUsers()}catch(x){toast(x.message,'error')}});
window.editUser=async(id,name,role,department)=>{const roles=[{value:'superadmin',label:'Super Administrador'},{value:'admin',label:'Administrador'},{value:'supervisor',label:'Supervisor'},{value:'engineer',label:'Ingeniero'}];const r=await actionModal({title:'Editar usuario',message:'Supervisor e Ingeniero quedan limitados al área seleccionada.',confirmText:'Guardar cambios',fields:[{label:'Nombre completo',value:name},{label:'Rol',type:'select',value:role,options:roles},{label:'Área',type:'select',value:department||'',required:false,options:[{value:'',label:'Sin área / acceso global'},...supportDepartments.map(d=>({value:d.code,label:d.name}))]}]});if(!r)return;const newRole=r[1],dep=['engineer','supervisor'].includes(newRole)?r[2]:'';if(['engineer','supervisor'].includes(newRole)&&!dep)return toast('Selecciona un área para Supervisor o Ingeniero.','error');try{await api(`/api/admin/users/${id}`,{method:'PATCH',body:JSON.stringify({fullName:r[0].trim(),role:newRole,department:dep})});toast('Usuario actualizado','success');loadUsers()}catch(e){toast(e.message,'error')}};
window.resetUser=async id=>{const r=await actionModal({title:'Restablecer contraseña',message:'La nueva contraseña debe tener al menos 6 caracteres.',confirmText:'Cambiar contraseña',fields:[{label:'Nueva contraseña',type:'password',value:''}]});if(!r)return;if(r[0].length<6)return toast('La contraseña debe tener al menos 6 caracteres.','error');try{await api(`/api/admin/users/${id}/reset-password`,{method:'POST',body:JSON.stringify({password:r[0]})});toast('Contraseña restablecida','success')}catch(e){toast(e.message,'error')}};
window.deleteUser=async id=>{if(!(await confirmModal('Eliminar usuario','El usuario se deshabilitará y su historial permanecerá.','Eliminar usuario')))return;try{await api(`/api/admin/users/${id}`,{method:'DELETE'});loadUsers()}catch(e){toast(e.message,'error')}};
syncUserCreateFields();

async function loadSla(){const [rows,filters,groups]=await Promise.all([api('/api/admin/slas'),api('/api/report-filters'),api('/api/admin/groups')]);slaCache=rows;reportFilters=filters;adminData=groups;$('#slaGroup').innerHTML='<option value="">Todos</option>'+groups.groups.filter(x=>x.enabled).map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('');updateSlaStations();updateSlaCategories();$('#slaTable').innerHTML=rows.map(s=>`<tr><td>${esc(s.name)}</td><td>${s.department?fmtDept(s.department):'Todas'}</td><td>${esc(s.group_name||'Todos')}${s.station_code?`<small class="subline">${esc(s.station_code)} · ${esc(s.station_name||'')}</small>`:''}</td><td>${esc(s.category_label||s.category||'Todas')}</td><td>${s.response_minutes} min</td><td>${s.resolution_minutes} min</td><td>${s.autoclose_minutes} min</td><td>${s.pause_on_waiting?'Pausa':'Corre'}</td><td>${s.enabled?'Activo':'Deshabilitado'}</td><td><button class="btn small secondary" onclick="editSla(${s.id})">Editar</button><button class="btn small danger" onclick="deleteSla(${s.id})">Eliminar regla</button></td></tr>`).join('')}
function updateSlaStations(){const gid=Number($('#slaGroup').value||0);const sts=(adminData?.stations||[]).filter(x=>!gid||x.group_id===gid);$('#slaStation').innerHTML='<option value="">Todos</option>'+sts.map(x=>`<option value="${x.id}">${esc(x.code)} · ${esc(x.label||'')}</option>`).join('')}
function updateSlaCategories(){const d=$('#slaDept').value;const cats=(reportFilters?.categories||[]).filter(x=>!d||x.department===d);$('#slaCategory').innerHTML='<option value="">Todas</option>'+cats.map(x=>`<option value="${x.code}">${fmtDept(x.department)} · ${esc(x.label)}</option>`).join('')}$('#slaDept').addEventListener('change',updateSlaCategories);$('#slaGroup').addEventListener('change',updateSlaStations);
$('#slaForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/admin/slas',{method:'POST',body:JSON.stringify({name:$('#slaName').value,department:$('#slaDept').value,groupId:$('#slaGroup').value,stationId:$('#slaStation').value,category:$('#slaCategory').value,responseMinutes:$('#slaResponse').value,resolutionMinutes:$('#slaResolution').value,autocloseMinutes:$('#slaAutoclose').value,pauseOnWaiting:$('#slaPause').checked})});toast('SLA creado','success');e.target.reset();$('#slaResponse').value=5;$('#slaResolution').value=60;$('#slaAutoclose').value=10;$('#slaPause').checked=true;loadSla()}catch(x){toast(x.message,'error')}});
function ensureSlaEditModal(){
  if($('#slaEditModal'))return;
  const el=document.createElement('div');
  el.id='slaEditModal';el.className='modal-overlay hidden';
  el.innerHTML=`<div class="modal-card sla-edit-card">
    <div class="modal-head"><div><h2>Editar regla SLA</h2><p>Modifica alcance, categoría y tiempos.</p></div><button type="button" class="modal-x" id="slaEditClose">×</button></div>
    <form id="slaEditForm" class="sla-edit-form">
      <input type="hidden" id="slaEditId">
      <label>Nombre<input id="slaEditName" required></label>
      <label>Área<select id="slaEditDept"><option value="">Todas</option><option value="systems">Sistemas</option><option value="maintenance">Mantenimiento</option></select></label>
      <label>Grupo<select id="slaEditGroup"><option value="">Todos</option></select></label>
      <label>Equipo<select id="slaEditStation"><option value="">Todos</option></select></label>
      <label>Categoría<select id="slaEditCategory"><option value="">Todas</option></select></label>
      <label>Respuesta (min)<input type="number" min="1" id="slaEditResponse" required></label>
      <label>Resolución (min)<input type="number" min="1" id="slaEditResolution" required></label>
      <label>Autocierre (min)<input type="number" min="1" id="slaEditAutoclose" required></label>
      <label class="check-label"><input type="checkbox" id="slaEditPause"> Pausar SLA en espera</label>
      <div class="modal-actions"><button type="button" class="btn secondary" id="slaEditCancel">Cancelar</button><button type="submit" class="btn primary">Guardar cambios</button></div>
    </form>
  </div>`;
  document.body.appendChild(el);
  const close=()=>el.classList.add('hidden');
  $('#slaEditClose').onclick=close;$('#slaEditCancel').onclick=close;
  el.addEventListener('click',e=>{if(e.target===el)close()});
  $('#slaEditDept').addEventListener('change',()=>fillEditCategories());
  $('#slaEditGroup').addEventListener('change',()=>fillEditStations());
  $('#slaEditForm').addEventListener('submit',saveSlaEdit);
}
function fillEditGroups(selected=''){
  $('#slaEditGroup').innerHTML='<option value="">Todos</option>'+(adminData?.groups||[]).filter(x=>x.enabled||String(x.id)===String(selected)).map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('');
  $('#slaEditGroup').value=selected||'';
}
function fillEditStations(selected=''){
  const gid=Number($('#slaEditGroup').value||0);
  const sts=(adminData?.stations||[]).filter(x=>(!gid||x.group_id===gid)&&(x.enabled||String(x.id)===String(selected)));
  $('#slaEditStation').innerHTML='<option value="">Todos</option>'+sts.map(x=>`<option value="${x.id}">${esc(x.code)} · ${esc(x.label||'')}</option>`).join('');
  $('#slaEditStation').value=selected||'';
}
function fillEditCategories(selected=''){
  const d=$('#slaEditDept').value;
  const cats=(reportFilters?.categories||[]).filter(x=>!d||x.department===d);
  $('#slaEditCategory').innerHTML='<option value="">Todas</option>'+cats.map(x=>`<option value="${x.code}">${fmtDept(x.department)} · ${esc(x.label)}</option>`).join('');
  if(selected&&!cats.some(x=>x.code===selected))$('#slaEditCategory').insertAdjacentHTML('beforeend',`<option value="${esc(selected)}">${esc(selected)}</option>`);
  $('#slaEditCategory').value=selected||'';
}
window.editSla=(id)=>{
  const s=slaCache.find(x=>Number(x.id)===Number(id));if(!s)return;
  ensureSlaEditModal();
  $('#slaEditId').value=s.id;$('#slaEditName').value=s.name||'';$('#slaEditDept').value=s.department||'';
  fillEditGroups(s.group_id||'');fillEditStations(s.station_id||'');fillEditCategories(s.category||'');
  $('#slaEditResponse').value=s.response_minutes;$('#slaEditResolution').value=s.resolution_minutes;$('#slaEditAutoclose').value=s.autoclose_minutes;$('#slaEditPause').checked=!!s.pause_on_waiting;
  $('#slaEditModal').classList.remove('hidden');
};
async function saveSlaEdit(e){
  e.preventDefault();const id=$('#slaEditId').value;
  const body={name:$('#slaEditName').value,department:$('#slaEditDept').value,groupId:$('#slaEditGroup').value,stationId:$('#slaEditStation').value,category:$('#slaEditCategory').value,responseMinutes:$('#slaEditResponse').value,resolutionMinutes:$('#slaEditResolution').value,autocloseMinutes:$('#slaEditAutoclose').value,pauseOnWaiting:$('#slaEditPause').checked};
  try{await api(`/api/admin/slas/${id}`,{method:'PATCH',body:JSON.stringify(body)});$('#slaEditModal').classList.add('hidden');toast('Regla SLA actualizada','success');await loadSla()}catch(x){toast(x.message,'error')}
}
window.deleteSla=async id=>{
  const s=slaCache.find(x=>Number(x.id)===Number(id));if(!s)return;
  if(!confirm(`¿Eliminar permanentemente la regla SLA "${s.name}"?\n\nLos tickets históricos se conservarán.`))return;
  try{await api(`/api/admin/slas/${id}`,{method:'DELETE'});toast('Regla SLA eliminada','success');await loadSla()}catch(e){toast(e.message,'error')}
};

function renderIdentity(){if(!me)return;const role=me.role==='superadmin'?'Super Administrador':me.role==='admin'?'Administrador':me.role==='supervisor'?`Supervisor ${fmtDept(me.department)}`:`Ingeniero ${fmtDept(me.department)}`;$('#roleLabel').textContent=`${me.fullName} · ${role}`;$('#sideUser').textContent=me.fullName;$$('.manager-only').forEach(x=>x.classList.toggle('hidden',!['superadmin','admin'].includes(me.role)));$$('.superadmin-only').forEach(x=>x.classList.toggle('hidden',me.role!=='superadmin'));const hist=$('#sideNav a[data-view="history"]');if(hist)hist.classList.toggle('hidden',!['superadmin','admin','supervisor'].includes(me.role));if(me.role!=='superadmin')$('#superadminOption')?.remove()}
async function refreshCurrent(){await showView(location.hash.replace('#','')||'dashboard')}
initReportLayout();initReportDatePickers();

let reportAutoFilterTimer=null;
function scheduleReportReload(){
  clearTimeout(reportAutoFilterTimer);
  reportAutoFilterTimer=setTimeout(()=>{
    if(location.hash==='#reports')loadReports(false).catch(()=>{});
  },180);
}
['repPlant','repDept','repGroup','repCategory','repEngineer','repStatus','repFrom','repTo'].forEach(id=>{
  const el=$('#'+id);
  if(el&&!el.dataset.autoFilterReady){
    el.dataset.autoFilterReady='1';
    el.addEventListener('change',scheduleReportReload);
  }
});

$('#exportReportExcel').addEventListener('click',reportExcel);
$('#exportReportPdf').addEventListener('click',reportPdf);
setInterval(()=>{if(location.hash==='#reports')loadReports(false).catch(()=>{})},300000);
$('#refreshRequests').addEventListener('click',loadRequests);$('#refreshTickets').addEventListener('click',loadTickets);$('#refreshHistory').addEventListener('click',loadHistory);$('#ticketSearch').addEventListener('input',renderTickets);$('#mineOnly').addEventListener('change',loadTickets);$('#repPlant')?.addEventListener('change',updateReportCascade);$('#repDept')?.addEventListener('change',updateReportCascade);
setInterval(()=>{$$('[data-since]').forEach(e=>e.textContent=elapsed(e.dataset.since));$$('[data-countdown]').forEach(e=>e.textContent=countdown(e.dataset.countdown))},1000);
socket.on('request:changed',evt=>{
  andonHandleRequestEvent(evt);
  refreshCurrent();
});socket.on('ticket:changed',()=>refreshCurrent());socket.on('data:changed',()=>{reportFilters=null;refreshCurrent()});socket.on('server:hello',info=>{if(!info?.bootId)return;const k='andon_r10_boot';const old=sessionStorage.getItem(k);sessionStorage.setItem(k,info.bootId);if(old&&old!==info.bootId){const u=new URL(location.href);u.searchParams.set('_reload',Date.now());location.replace(u)}});
(async()=>{const m=await api('/api/me');if(!m.user)return location='/login';me=m.user;await loadDepartmentOptions();renderIdentity();await showView(location.hash.replace('#','')||'dashboard')})();


