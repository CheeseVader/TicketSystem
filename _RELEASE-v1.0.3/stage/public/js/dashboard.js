console.log('ANDON_DASHBOARD_R8');
const socket=io();

let andonDashFirstConnect = true;
function dashFreshReload() {
  const u = new URL(window.location.href);
  u.searchParams.set('_andon_reload', Date.now().toString());
  window.location.replace(u.toString());
}
socket.on('server:hello', info => {
  if (!info || !info.bootId) return;
  const key = 'andon_dashboard_boot_id';
  const old = sessionStorage.getItem(key);
  sessionStorage.setItem(key, info.bootId);
  if (old && old !== info.bootId) return dashFreshReload();
  if (typeof load === 'function') load().catch(() => {});
});
socket.on('connect', () => {
  if (!andonDashFirstConnect && typeof load === 'function') load().catch(() => {});
  andonDashFirstConnect = false;
});

let lastActiveIds=new Set();
const fmtDept=d=>d==='systems'?'Sistemas':'Mantenimiento';
const fmtCategory=x=>`${x.category_icon||'•'} ${x.category_label||x.category||'Sin categoría'}`;
const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fmtTime=v=>new Date(v).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const elapsed=v=>{const s=Math.max(0,Math.floor((Date.now()-new Date(v))/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`};
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2800)}
async function action(id,kind){const r=await fetch(`/api/requests/${id}/${kind}`,{method:'POST'});const d=await r.json();if(!r.ok) return toast(d.error||'No se pudo realizar la acción');load();}
window.takeRequest=id=>action(id,'attend');window.resolveRequest=id=>action(id,'resolve');
async function load(){
 const r=await fetch('/api/dashboard'); if(r.status===401||r.redirected){location='/login';return;} const d=await r.json();
 document.getElementById('roleLabel').textContent=`${d.user.fullName} · ${d.user.role==='superadmin'?'Superadmin':d.user.role==='systems'?'Sistemas':'Mantenimiento'}`;
 document.getElementById('metricActive').textContent=d.active.filter(x=>x.status==='requested').length;
 document.getElementById('metricAttending').textContent=d.active.filter(x=>x.status==='attending').length;
 document.getElementById('metricToday').textContent=d.attendedToday;
 const byStation={}; d.active.forEach(x=>(byStation[x.code]??=[]).push(x));
 document.getElementById('linesGrid').innerHTML=[1,2,3].map(line=>{
   const stations=d.stations.filter(s=>s.line_no===line); const counts=d.active.filter(x=>x.line_no===line);
   const sCount=counts.filter(x=>x.department==='systems').length,mCount=counts.filter(x=>x.department==='maintenance').length;
   return `<div class="line-card"><div class="line-title"><strong>LÍNEA ${line}</strong><span style="font-size:11px;color:#8ea0b2">${sCount} Sistemas · ${mCount} Mantenimiento</span></div><div class="station-grid">${stations.map(s=>{
    const a=byStation[s.code]||[];const hs=a.some(x=>x.department==='systems'),hm=a.some(x=>x.department==='maintenance'),ha=a.some(x=>x.status==='attending');
    const cls=hs&&hm?'both':hs?'has-systems':hm?'has-maintenance':'';
    const state=a.length?a.map(x=>`${x.department==='systems'?'SIS':'MANT'} · ${x.category_label||x.category||''} · ${x.status==='attending'?'ATEND.':'ALERTA'}`).join(' / '):'OK';
    return `<div class="station-tile ${cls} ${ha?'attending':''}"><span class="code">${s.code}</span><span class="state">${state}</span></div>`}).join('')}</div></div>`}).join('');
 document.getElementById('activeTable').innerHTML=d.active.length?d.active.map(x=>`<tr>
 <td>Línea ${x.line_no}</td>
 <td><strong>${x.code}</strong></td>
 <td><span class="dept-badge ${x.department}">${fmtDept(x.department)}</span></td>
 <td class="category-cell">${fmtCategory(x)}</td>
 <td class="notes-cell">${x.notes ? escapeHtml(x.notes) : '—'}</td>
 <td><span class="status-chip ${x.status}">${x.status==='requested'?'SOLICITADO':'EN ATENCIÓN'}</span></td>
 <td>${fmtTime(x.requested_at)}</td>
 <td data-since="${x.requested_at}">${elapsed(x.requested_at)}</td>
 <td>${x.attended_by_name||'—'}</td>
 <td>${x.status==='requested'?`<button class="btn small attend" onclick="takeRequest(${x.id})">Atender</button>`:`<button class="btn small resolve" onclick="resolveRequest(${x.id})">Resolver</button>`}</td>
 </tr>`).join(''):'<tr><td colspan="10">No hay solicitudes activas.</td></tr>';
 document.getElementById('recentList').innerHTML=d.recent.map(x=>`<div class="recent-item"><strong>${x.code} · ${fmtDept(x.department)} · ${fmtCategory(x)} · ${x.status==='resolved'?'Resuelta':x.status==='attending'?'Atendiendo':'Solicitada'}</strong><small>${fmtTime(x.requested_at)}${x.notes?` · ${escapeHtml(x.notes)}`:''}${x.attended_by_name?` · ${x.attended_by_name}`:''}</small></div>`).join('');
 const current=new Set(d.active.map(x=>x.id)); const newOnes=[...current].filter(id=>!lastActiveIds.has(id)); if(lastActiveIds.size && newOnes.length) toast('🚨 Nueva solicitud de apoyo'); lastActiveIds=current;
}
setInterval(()=>document.querySelectorAll('[data-since]').forEach(el=>el.textContent=elapsed(el.dataset.since)),1000);
socket.on('request:changed',load); load();
