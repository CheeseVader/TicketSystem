(()=>{
'use strict';
let current=null;

const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function p4api(url,opt={}){
  const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});
  const txt=await r.text();let j=null;try{j=txt?JSON.parse(txt):null}catch{j={error:txt}}
  if(!r.ok)throw new Error(j?.error||`HTTP ${r.status}`);return j;
}
function closeAlertLocationModal(){
  const p4=document.querySelector('#r187P4Modal');
  if(p4)p4.classList.remove('open');

  const headings=[...document.querySelectorAll('h1,h2,h3')];
  const h=headings.find(x=>/Ubicación de alerta/i.test(x.textContent||''));

  if(h){
    const modal=h.closest('.modal,.modal-card,.dialog,[role="dialog"]')
      || h.parentElement?.parentElement?.parentElement
      || h.parentElement?.parentElement;

    if(modal){
      const closeBtn=[...modal.querySelectorAll('button')].find(b=>{
        const t=(b.textContent||'').trim();
        const aria=b.getAttribute('aria-label')||'';
        return t==='×' || t==='✕' || /^cerrar$/i.test(aria) || /^close$/i.test(aria);
      });

      if(closeBtn){
        try{closeBtn.click()}catch{}
      }else{
        modal.classList.add('hidden');
        modal.style.display='none';
      }
    }
  }
}

async function returnToMainDashboard(){
  closeAlertLocationModal();

  try{
    if(typeof showView==='function'){
      await showView('dashboard');
    }
  }catch{}

  try{
    location.hash='#dashboard';
  }catch{}

  try{
    if(typeof loadDashboard==='function'){
      await loadDashboard();
    }
  }catch{}
}

function p4SuccessPopup(message){
  return new Promise(resolve=>{
    let pop=document.querySelector('#r187SuccessPopup');

    if(!pop){
      pop=document.createElement('div');
      pop.id='r187SuccessPopup';
      pop.style.cssText=[
        'position:fixed',
        'inset:0',
        'z-index:100000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(0,0,0,.62)',
        'padding:20px'
      ].join(';');

      pop.innerHTML=`
        <div style="
          width:min(480px,94vw);
          background:#101e2a;
          border:1px solid #345069;
          border-radius:16px;
          box-shadow:0 24px 70px rgba(0,0,0,.50);
          color:#fff;
          padding:24px;">
          <div style="font-size:20px;font-weight:800;margin-bottom:10px;">
            Asignación realizada
          </div>
          <div id="r187SuccessPopupText"
               style="color:#c8d8e6;line-height:1.5;margin-bottom:22px;"></div>
          <div style="display:flex;justify-content:flex-end;">
            <button id="r187SuccessPopupOk" style="
              border:0;
              border-radius:10px;
              padding:11px 24px;
              background:#2f80ed;
              color:#fff;
              font-weight:800;
              cursor:pointer;">OK</button>
          </div>
        </div>`;

      document.body.appendChild(pop);
    }

    pop.style.display='flex';
    document.querySelector('#r187SuccessPopupText').textContent=message;

    document.querySelector('#r187SuccessPopupOk').onclick=async()=>{
      pop.style.display='none';
      await returnToMainDashboard();
      resolve();
    };
  });
}
async function getLiveOpenRequests(){
  try{
    const rows=await p4api('/api/requests-list');
    return Array.isArray(rows)?rows:[];
  }catch(e){
    try{
      return (typeof dashData!=='undefined'&&Array.isArray(dashData?.open))?dashData.open:[];
    }catch{
      return [];
    }
  }
}

function normalizeCode(v){
  return String(v||'').trim().toUpperCase().replace(/\s+/g,'');
}

function extractTileCode(el){
  const text=(el?.innerText||el?.textContent||'').replace(/\s+/g,' ').trim();
  const explicit=el?.dataset?.stationCode||el?.dataset?.code||'';
  if(explicit)return String(explicit).trim().toUpperCase();

  const candidates=text.match(/[A-Z0-9]+(?:-[A-Z0-9]+)+/gi)||[];
  if(candidates.length)return candidates[0].toUpperCase();

  // Algunas tarjetas muestran el codigo truncado visualmente pero lo conservan en title.
  const title=el?.getAttribute?.('title')||'';
  const t=title.match(/[A-Z0-9]+(?:-[A-Z0-9]+)+/i);
  return t?t[0].toUpperCase():'';
}

function tileCandidatesFromClick(target){
  const out=[];
  let n=target;
  for(let i=0;n&&i<8;i++,n=n.parentElement){
    if(n===document.body)break;
    const txt=(n.innerText||n.textContent||'').trim();
    if(txt && txt.length<220)out.push(n);
  }
  return out;
}

async function findRequestForClickedTile(target){
  const rows=(await getLiveOpenRequests()).filter(x=>(x.ticket_status||x.status)==='unassigned');
  if(!rows.length)return null;

  const candidates=tileCandidatesFromClick(target);
  for(const el of candidates){
    const code=extractTileCode(el);
    if(code){
      const exact=rows.find(x=>normalizeCode(x.station_code||x.code)===normalizeCode(code));
      if(exact)return exact;
    }

    const txt=(el.innerText||el.textContent||'').toUpperCase();
    const byStation=rows.find(x=>{
      const c=String(x.station_code||'').toUpperCase();
      const n=String(x.station_name||'').toUpperCase();
      return (c&&txt.includes(c)) || (n&&n.length>2&&txt.includes(n));
    });
    if(byStation)return byStation;
  }
  return null;
}

function ensureModal(){
  if(document.querySelector('#r187P4Modal'))return;
  const d=document.createElement('div');d.id='r187P4Modal';
  d.innerHTML=`<div class="p4-card">
    <div class="p4-head"><div><h2 id="p4Title">Solicitud</h2><p id="p4Subtitle"></p></div><button class="p4-x" id="p4Close">×</button></div>
    <div class="p4-body"><div class="p4-grid" id="p4Fields"></div><div id="p4AssignOther" style="display:none">
      <div class="p4-field"><span>Asignar a otro usuario</span><select id="p4Assignee"></select></div>
    </div></div>
    <div class="p4-actions">
      <button class="p4-btn" id="p4Mine">Asignármelo</button>
      <button class="p4-btn secondary" id="p4Other">Asignar a otro usuario</button>
      <button class="p4-btn secondary" id="p4DoAssign" style="display:none">Confirmar asignación</button>
      <button class="p4-btn ghost" id="p4Cancel">Cancelar</button>
    </div>
  </div>`;
  document.body.appendChild(d);

  const close=()=>{d.classList.remove('open');current=null};
  document.querySelector('#p4Close').onclick=close;
  document.querySelector('#p4Cancel').onclick=close;
  d.addEventListener('click',e=>{if(e.target===d)close()});

  document.querySelector('#p4Mine').onclick=async()=>{
    if(!current)return;
    try{
      const r=await p4api(`/api/requests/${current.id}/assign`,{method:'POST',body:'{}'});
      await p4SuccessPopup(`Ticket ${r.ticket?.ticket_number||''} asignado a ti.`);
    }catch(e){alert(e.message)}
  };

  document.querySelector('#p4Other').onclick=async()=>{
    if(!current)return;
    try{
      const users=await p4api(`/api/r187/requests/${current.id}/assignees`);
      const sel=document.querySelector('#p4Assignee');
      sel.innerHTML='<option value="">Selecciona...</option>'+users.map(u=>`<option value="${u.id}">${esc(u.full_name||u.username)} · ${esc(u.role)}${u.department?` · ${esc(u.department)}`:''}</option>`).join('');
      document.querySelector('#p4AssignOther').style.display='block';
      document.querySelector('#p4DoAssign').style.display='';
    }catch(e){alert(e.message)}
  };

  document.querySelector('#p4DoAssign').onclick=async()=>{
    if(!current)return;
    const userId=Number(document.querySelector('#p4Assignee').value||0);
    if(!userId)return alert('Selecciona un usuario.');
    try{
      const r=await p4api(`/api/r187/requests/${current.id}/assign-to`,{method:'POST',body:JSON.stringify({userId})});
      await p4SuccessPopup(`Ticket ${r.ticket?.ticket_number||''} asignado a ${r.assignedTo?.full_name||r.assignedTo?.username||'usuario'}.`);
    }catch(e){alert(e.message)}
  };
}

async function openRequest(row){
  ensureModal();
  try{
    current=await p4api(`/api/r187/requests/${row.id}/detail`);
  }catch{
    current=row;
  }

  const r=current;
  document.querySelector('#p4Title').textContent=r.source==='administrative'?'Solicitud administrativa':'Solicitud de producción';
  document.querySelector('#p4Subtitle').textContent=`${r.station_code||''} · ${r.ticket_number||'Sin asignar'}`;

  const fields=[
    ['Solicitante',r.requested_by||'No capturado'],
    ['Área solicitante',r.requester_area||r.group_name||'—'],
    ['Ubicación',r.support_location||r.station_name||'—'],
    ['Área de soporte',String(r.department||'').toLowerCase()==='systems'?'Sistemas':String(r.department||'').toLowerCase()==='maintenance'?'Mantenimiento':(r.department||'—')],
    ['Categoría',r.category_label||r.category||'—'],
    ['Estado',(r.ticket_status||r.status||'—')],
    ['Descripción',r.notes||r.description||'—']
  ];

  document.querySelector('#p4Fields').innerHTML=fields.map(([a,b])=>`<div class="p4-field"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join('');
  document.querySelector('#p4AssignOther').style.display='none';
  document.querySelector('#p4DoAssign').style.display='none';

  const canAssign=(r.ticket_status||r.status)==='unassigned';
  document.querySelector('#p4Mine').style.display=canAssign?'':'none';
  document.querySelector('#p4Other').style.display=canAssign?'':'none';
  document.querySelector('#r187P4Modal').classList.add('open');
}

// Captura cualquier click dentro del modal "Ubicación de alerta".
// No depende de una clase CSS concreta del tile.
document.addEventListener('click',async e=>{
  const overlay=[...document.querySelectorAll('div')].find(x=>{
    const h=x.querySelector?.('h1,h2,h3');
    return h && /Ubicación de alerta/i.test(h.textContent||'') && x.contains(e.target);
  });

  if(!overlay)return;

  const row=await findRequestForClickedTile(e.target);
  if(!row)return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  await openRequest(row);
},true);

// Hace visibles como clickeables las tarjetas que contienen una solicitud pendiente.
async function markClickableAlertTiles(){
  const rows=(await getLiveOpenRequests()).filter(x=>(x.ticket_status||x.status)==='unassigned');
  if(!rows.length)return;

  const all=[...document.querySelectorAll('div')];
  for(const el of all){
    const txt=(el.innerText||'').trim();
    if(!txt || txt.length>180)continue;

    const code=extractTileCode(el);
    if(!code)continue;

    if(rows.some(r=>normalizeCode(r.station_code||r.code)===normalizeCode(code))){
      el.style.cursor='pointer';
      el.dataset.r187ClickableRequest='1';
      el.title='Clic para ver y asignar solicitud';
    }
  }
}
setInterval(markClickableAlertTiles,1200);
// Corrige modal administrativo heredado: separa Solicitante de Área cuando sea posible.
function patchLegacyAdminModal(){
  const all=[...document.querySelectorAll('h1,h2,h3')];
  const h=all.find(x=>(x.textContent||'').trim()==='Solicitud administrativa');
  if(!h)return;
  const card=h.closest('.modal-card,.dialog,.card,[role="dialog"]')||h.parentElement?.parentElement;
  if(!card)return;
  const labels=[...card.querySelectorAll('label,.field-label,span,strong,div')];
  const lab=labels.find(x=>(x.textContent||'').trim()==='Solicitante / Área');
  if(!lab)return;
  const rows=getOpenRows().filter(x=>x.source==='administrative');
  if(!rows.length)return;
  const text=card.textContent||'';
  const r=rows.find(x=>x.requester_area&&text.includes(x.requester_area))||rows[0];
  if(!r?.requested_by)return;

  lab.textContent='Solicitante';
  const holder=lab.parentElement;
  if(holder){
    const vals=[...holder.children].filter(x=>x!==lab);
    if(vals[0])vals[0].textContent=r.requested_by;
    if(!card.querySelector('[data-r187-area-requester]')){
      const clone=holder.cloneNode(true);
      clone.dataset.r187AreaRequester='1';
      const c=[...clone.children];
      if(c[0])c[0].textContent='Área solicitante';
      if(c[1])c[1].textContent=r.requester_area||'—';
      holder.after(clone);
    }
  }
}
new MutationObserver(patchLegacyAdminModal).observe(document.documentElement,{subtree:true,childList:true,attributes:true});

// PDF limpio: intercepta el export actual y genera una copia sin filtros/controles.
function exportCleanPdf(){
  const report=document.querySelector('#view-reports')||[...document.querySelectorAll('.app-view')].find(x=>/Tickets por día/i.test(x.textContent||''));
  if(!report)return alert('No encontré la vista de Reportes.');
  const clone=report.cloneNode(true);
  clone.querySelectorAll('form,.report-filters,button,select,input,textarea,.no-print,[data-no-print="true"]').forEach(x=>x.remove());
  clone.querySelectorAll('.panel-head,.analytics-panel-head').forEach(x=>{
    [...x.querySelectorAll('button,.actions,.report-actions')].forEach(b=>b.remove());
  });

  const w=window.open('','_blank');
  if(!w)return alert('El navegador bloqueó la ventana de impresión.');
  const links=[...document.querySelectorAll('link[rel="stylesheet"]')].map(l=>`<link rel="stylesheet" href="${esc(l.href)}">`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>ANDON Support · Reporte</title>${links}
  <style>
  body{background:#fff!important;color:#111!important;margin:18px;font-family:Arial,sans-serif}
  .dashboard-shell,.dashboard-content{display:block!important;margin:0!important;padding:0!important;background:#fff!important;color:#111!important}
  .app-view{display:block!important}
  .sidebar,.dashboard-sidebar,.topbar,.dashboard-topbar,nav,button,select,input,form,.report-filters{display:none!important}
  *{box-shadow:none!important}
  @page{size:landscape;margin:10mm}
  </style></head><body><h1>ANDON Support · Reporte Ejecutivo</h1><p>Generado: ${new Date().toLocaleString()}</p>${clone.outerHTML}</body></html>`);
  w.document.close();
  setTimeout(()=>{w.focus();w.print()},700);
}

function reportParams(){
  const get=(...ids)=>{for(const id of ids){const e=document.getElementById(id);if(e&&e.value)return e.value}return ''};
  const q=new URLSearchParams();
  const vals={
    from:get('repFrom','reportFrom'),
    to:get('repTo','reportTo'),
    department:get('repDept','reportDept'),
    category:get('repCategory','reportCategory'),
    engineer:get('repEngineer','reportEngineer'),
    status:get('repStatus','reportStatus'),
    area:get('repArea','reportArea')
  };
  for(const [k,v] of Object.entries(vals)){
    if(v && !['all','todos','todas'].includes(String(v).toLowerCase()))q.set(k,v);
  }
  return q.toString();
}
function exportManagerExcel(){
  location.href='/api/r187/reports/excel?'+reportParams();
}

// Capture para reemplazar los exportadores heredados sin depender del id exacto.
document.addEventListener('click',e=>{
  const b=e.target.closest?.('button,a');
  if(!b)return;
  const t=(b.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();
  if(t.includes('exportar pdf')){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();exportCleanPdf();
  }else if(t.includes('exportar excel')){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();exportManagerExcel();
  }
},true);

ensureModal();
})();