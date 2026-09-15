(()=>{
'use strict';

const api=async(url,opt={})=>{
  const r=await fetch(url,{
    ...opt,
    cache:'no-store',
    credentials:'same-origin',
    headers:{'Content-Type':'application/json',...(opt.headers||{})}
  });
  let d={};try{d=await r.json()}catch{}
  if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);
  return d;
};

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

const supportArea=v=>{
  const s=String(v||'').toLowerCase();
  return s==='systems'?'Sistemas':s==='maintenance'?'Mantenimiento':(v||'—');
};

function normalize(v){
  return String(v||'').trim().toLowerCase().replace(/\s+/g,' ');
}

function candidateCard(target){
  // P7.0: JAMÁS abrir el modal fuera del Dashboard.
  const dashboard=document.querySelector('#view-dashboard');
  if(!dashboard || !dashboard.classList.contains('active'))return null;

  // Sólo una tarjeta real dentro de Grupos y equipos.
  const tile=target instanceof Element
    ? target.closest('#groupsGrid .station-tile')
    : null;

  if(!tile)return null;

  // Y únicamente dentro del bloque ADMINISTRATIVOS.
  const line=tile.closest('.line-card');
  if(!line)return null;

  const lineText=String(line.innerText||'').toUpperCase();
  if(!lineText.includes('ADMINISTRATIVOS'))return null;

  const tileText=String(tile.innerText||'').toLowerCase();

  // Sólo tickets pendientes; un click en un área OK no abre detalle.
  if(!tileText.includes('sin asignar'))return null;

  return tile;
}

function scoreRow(row,text){
  let score=0;
  const values=[
    row.requested_by,
    row.requester_area,
    row.support_location,
    row.category_label,
    row.category,
    row.station_name
  ];
  for(const v of values){
    const s=normalize(v);
    if(s.length>1 && text.includes(s))score+=3;
  }
  const dep=normalize(row.department);
  if(dep==='systems' && text.includes('sistemas'))score+=2;
  if(dep==='maintenance' && text.includes('mantenimiento'))score+=2;
  return score;
}

async function rowForCard(card){
  const rows=await api('/api/r187/admin-open-p61');
  if(!Array.isArray(rows)||!rows.length)return null;
  const text=normalize(card.innerText);

  let best=null,bestScore=-1;
  for(const row of rows){
    const s=scoreRow(row,text);
    if(s>bestScore){best=row;bestScore=s}
  }
  return bestScore>=2?best:null;
}

function closeModal(){
  document.querySelector('#p66AdminModal')?.remove();
  document.querySelector('#p66Success')?.remove();
  document.body.classList.remove('modal-open','no-scroll','overflow-hidden');
  document.documentElement.classList.remove('modal-open','no-scroll','overflow-hidden');
  document.body.style.removeProperty('overflow');
  document.documentElement.style.removeProperty('overflow');
}

async function refreshDashboard(){
  closeModal();
  try{if(typeof loadDashboard==='function')await loadDashboard()}catch{}
}

function success(message){
  closeModal();
  return new Promise(resolve=>{
    const d=document.createElement('div');
    d.id='p66Success';
    d.style.cssText='position:fixed;inset:0;z-index:120000;background:rgba(3,10,18,.70);display:flex;align-items:center;justify-content:center;padding:20px';
    d.innerHTML=`
      <div style="width:min(470px,94vw);background:#0f1d2a;border:1px solid #33516a;border-radius:18px;padding:26px;color:#fff;box-shadow:0 28px 80px rgba(0,0,0,.55)">
        <div style="font-size:21px;font-weight:900;margin-bottom:10px">Asignación realizada</div>
        <div style="color:#bed0df;line-height:1.5;margin-bottom:22px">${esc(message)}</div>
        <div style="display:flex;justify-content:flex-end">
          <button id="p66SuccessOk" style="border:0;border-radius:10px;background:#3281ed;color:white;font-weight:850;padding:11px 25px;cursor:pointer">OK</button>
        </div>
      </div>`;
    document.body.appendChild(d);
    d.querySelector('#p66SuccessOk').onclick=async()=>{
      d.remove();
      await refreshDashboard();
      resolve();
    };
  });
}

async function openAdmin(row){
  closeModal();

  const r=await api(`/api/r187/requests/${row.id}/detail-p61`);
  const st=String(r.ticket_status||r.status||'unassigned').toLowerCase();
  const canAssign=st==='unassigned';

  const d=document.createElement('div');
  d.id='p66AdminModal';
  d.style.cssText='position:fixed;inset:0;z-index:110000;background:rgba(3,10,18,.72);display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto';
  d.innerHTML=`
    <div style="width:min(700px,96vw);background:#101e2a;border:1px solid #33516a;border-radius:20px;color:#fff;box-shadow:0 30px 90px rgba(0,0,0,.58);overflow:hidden">
      <div style="padding:24px 26px 18px;border-bottom:1px solid #294258;display:flex;justify-content:space-between;align-items:flex-start;gap:18px">
        <div>
          <h2 style="margin:0 0 6px;font-size:27px">Solicitud administrativa</h2>
          <div style="color:#9db4c8">Detalle de la alerta activa</div>
        </div>
        <button id="p66Close" style="border:0;background:transparent;color:#d8e4ed;font-size:30px;cursor:pointer">×</button>
      </div>

      <div style="padding:22px 26px">
        <div class="p66grid">
          <div class="p66field"><span>Solicitante</span><strong>${esc(r.requested_by||'No capturado')}</strong></div>
          <div class="p66field"><span>Área / Departamento</span><strong>${esc(r.requester_area||'—')}</strong></div>
          <div class="p66field"><span>Ubicación</span><strong>${esc(r.support_location||r.station_name||'—')}</strong></div>
          <div class="p66field"><span>Área de soporte</span><strong>${esc(supportArea(r.department))}</strong></div>
          <div class="p66field"><span>Categoría</span><strong>${esc(r.category_label||r.category||'—')}</strong></div>
          <div class="p66field"><span>Estado</span><strong>${esc(st)}</strong></div>
        </div>

        <div class="p66field" style="margin-top:13px">
          <span>Descripción</span>
          <strong style="white-space:pre-wrap">${esc(r.notes||r.description||'—')}</strong>
        </div>

        <div id="p66OtherWrap" style="display:none;margin-top:16px">
          <label style="display:block;color:#bdd0df;font-weight:850;margin-bottom:7px">Asignar a otro usuario</label>
          <select id="p66Assignee" style="width:100%;background:#091521;color:#fff;border:1px solid #385873;border-radius:10px;padding:12px"></select>
        </div>
      </div>

      <div style="padding:18px 26px 24px;border-top:1px solid #294258;display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
        ${canAssign?`
          <button id="p66Mine" class="p66btn primary">Asignármelo</button>
          <button id="p66Other" class="p66btn secondary">Asignar a otro usuario</button>
          <button id="p66Confirm" class="p66btn ok" style="display:none">Confirmar asignación</button>
        `:''}
        <button id="p66Cancel" class="p66btn ghost">Cancelar</button>
      </div>
    </div>`;

  const style=document.createElement('style');
  style.textContent=`
    #p66AdminModal .p66grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}
    #p66AdminModal .p66field{background:#0a1723;border:1px solid #315069;border-radius:12px;padding:12px 14px;display:grid;gap:5px}
    #p66AdminModal .p66field span{font-size:12px;font-weight:850;color:#9fb6ca}
    #p66AdminModal .p66field strong{font-size:16px;color:#fff}
    #p66AdminModal .p66btn{border-radius:10px;padding:12px 18px;font-weight:850;cursor:pointer}
    #p66AdminModal .primary{border:0;background:#3281ed;color:#fff}
    #p66AdminModal .secondary{border:1px solid #54728b;background:#173047;color:#fff}
    #p66AdminModal .ok{border:0;background:#17a568;color:#fff}
    #p66AdminModal .ghost{border:1px solid #54728b;background:transparent;color:#dae6ee}
    @media(max-width:650px){#p66AdminModal .p66grid{grid-template-columns:1fr}}
  `;
  d.appendChild(style);
  document.body.appendChild(d);

  d.querySelector('#p66Close').onclick=closeModal;
  d.querySelector('#p66Cancel').onclick=closeModal;
  d.addEventListener('click',e=>{if(e.target===d)closeModal()});

  if(canAssign){
    d.querySelector('#p66Mine').onclick=async()=>{
      try{
        const x=await api(`/api/requests/${r.id}/assign`,{method:'POST',body:'{}'});
        await success(`Ticket ${x.ticket?.ticket_number||''} asignado a ti.`);
      }catch(e){alert(e.message)}
    };

    d.querySelector('#p66Other').onclick=async()=>{
      try{
        const users=await api(`/api/r187/requests/${r.id}/assignees`);
        const sel=d.querySelector('#p66Assignee');
        sel.innerHTML='<option value="">Selecciona un usuario...</option>'+users.map(u=>
          `<option value="${u.id}">${esc(u.full_name||u.username)} · ${esc(u.role)}${u.department?` · ${esc(u.department)}`:''}</option>`
        ).join('');
        d.querySelector('#p66OtherWrap').style.display='block';
        d.querySelector('#p66Confirm').style.display='';
      }catch(e){alert(e.message)}
    };

    d.querySelector('#p66Confirm').onclick=async()=>{
      const userId=Number(d.querySelector('#p66Assignee').value||0);
      if(!userId)return alert('Selecciona un usuario.');
      try{
        const x=await api(`/api/r187/requests/${r.id}/assign-to`,{
          method:'POST',
          body:JSON.stringify({userId})
        });
        await success(`Ticket ${x.ticket?.ticket_number||''} asignado a ${x.assignedTo?.full_name||x.assignedTo?.username||'usuario'}.`);
      }catch(e){alert(e.message)}
    };
  }
}

// CLAVE P6.6:
// Capturamos el click ANTES que el dashboard viejo.
// Así el modal viejo NO llega a abrirse y NO puede quedar un backdrop fantasma.
document.addEventListener('click',async e=>{
  if(e.target.closest?.('#p66AdminModal,#p66Success'))return;

  // P7.0: no interceptar navegación, Reportes, sidebar ni cualquier vista ajena.
  const dashboard=document.querySelector('#view-dashboard');
  if(!dashboard || !dashboard.classList.contains('active'))return;

  const card=candidateCard(e.target);
  if(!card)return;

  try{
    const row=await rowForCard(card);
    if(!row)return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    await openAdmin(row);
  }catch(err){
    console.error('P6.6 admin direct click',err);
  }
},true);

document.addEventListener('keydown',e=>{
  if(e.key==='Escape')closeModal();
},true);

})();