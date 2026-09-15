(()=>{
  'use strict';

  const API=async(url,opt={})=>{
    const r=await fetch(url,{
      ...opt,
      cache:'no-store',
      credentials:'same-origin',
      headers:{'Content-Type':'application/json',...(opt.headers||{})}
    });
    let d={};
    try{d=await r.json()}catch{}
    if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);
    return d;
  };

  const E=s=>String(s??'').replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  const dept=v=>{
    const s=String(v||'').toLowerCase();
    if(s==='systems')return 'Sistemas';
    if(s==='maintenance')return 'Mantenimiento';
    return v||'—';
  };

  function findLegacyAdminModal(){
    const hs=[...document.querySelectorAll('h1,h2,h3')];
    const h=hs.find(x=>/Solicitud administrativa/i.test(x.textContent||''));
    if(!h)return null;
    return h.closest('.modal,.modal-card,.dialog,[role="dialog"]')
      || h.parentElement?.parentElement?.parentElement
      || h.parentElement?.parentElement;
  }

  function closeLegacyAdminModal(){
    const modal=findLegacyAdminModal();
    if(!modal)return;
    const btn=[...modal.querySelectorAll('button')].find(b=>{
      const t=(b.textContent||'').trim();
      const a=b.getAttribute('aria-label')||'';
      return t==='×'||t==='✕'||/^cerrar$/i.test(t)||/^close$/i.test(a);
    });
    if(btn){try{btn.click()}catch{}}
    modal.style.display='none';
    modal.classList.add('hidden');
  }

  async function refreshDashboard(){
    closeLegacyAdminModal();
    try{document.querySelector('#r187P6AdminModal')?.remove()}catch{}
    try{document.querySelector('#r187P4Modal')?.classList.remove('open')}catch{}
    try{if(typeof showView==='function')await showView('dashboard')}catch{}
    try{location.hash='#dashboard'}catch{}
    try{if(typeof loadDashboard==='function')await loadDashboard()}catch{}
  }

  function success(message){
    return new Promise(resolve=>{
      let d=document.querySelector('#r187P6Success');
      if(!d){
        d=document.createElement('div');
        d.id='r187P6Success';
        d.style.cssText='position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:20px';
        d.innerHTML=`
          <div style="width:min(500px,94vw);background:#101e2a;border:1px solid #345069;border-radius:18px;padding:26px;color:#fff;box-shadow:0 28px 80px rgba(0,0,0,.55)">
            <div style="font-size:21px;font-weight:850;margin-bottom:10px">Asignación realizada</div>
            <div id="r187P6SuccessText" style="color:#c8d8e6;line-height:1.5;margin-bottom:22px"></div>
            <div style="display:flex;justify-content:flex-end">
              <button id="r187P6SuccessOk" style="border:0;border-radius:10px;background:#2f80ed;color:#fff;font-weight:800;padding:11px 24px;cursor:pointer">OK</button>
            </div>
          </div>`;
        document.body.appendChild(d);
      }
      d.style.display='flex';
      document.querySelector('#r187P6SuccessText').textContent=message;
      document.querySelector('#r187P6SuccessOk').onclick=async()=>{
        d.style.display='none';
        await refreshDashboard();
        resolve();
      };
    });
  }

  async function detail(id){
    try{return await API(`/api/r187/requests/${id}/detail-p6`)}
    catch{return await API(`/api/r187/requests/${id}/detail`)}
  }

  async function openP6(row){
    const r=await detail(row.id);
    closeLegacyAdminModal();

    document.querySelector('#r187P6AdminModal')?.remove();
    const d=document.createElement('div');
    d.id='r187P6AdminModal';
    d.style.cssText='position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:22px;overflow:auto';

    const status=String(r.ticket_status||r.status||'').toLowerCase();
    const canAssign=status==='unassigned';

    d.innerHTML=`
      <div style="width:min(720px,96vw);background:#101e2a;border:1px solid #345069;border-radius:20px;box-shadow:0 30px 90px rgba(0,0,0,.55);color:#fff;overflow:hidden">
        <div style="display:flex;justify-content:space-between;gap:16px;padding:24px 26px 18px;border-bottom:1px solid #294158">
          <div>
            <h2 style="margin:0 0 6px;font-size:26px">Solicitud administrativa</h2>
            <div style="color:#9fb5c9">${E(r.ticket_number||'Sin asignar')} · ${E(status||'—')}</div>
          </div>
          <button id="r187P6Close" style="border:0;background:transparent;color:#d5e1eb;font-size:30px;cursor:pointer">×</button>
        </div>
        <div style="padding:22px 26px">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px">
            ${[
              ['Solicitante',r.requested_by||'No capturado'],
              ['Área / Departamento solicitante',r.requester_area||'—'],
              ['Ubicación',r.support_location||r.station_name||'—'],
              ['Área de soporte',dept(r.department)],
              ['Categoría',r.category_label||r.category||'—'],
              ['Estado',status||'—']
            ].map(([a,b])=>`
              <div style="border:1px solid #2d4a62;border-radius:12px;padding:12px 14px;background:#0b1722">
                <div style="font-size:12px;font-weight:800;color:#9fb5c9;margin-bottom:5px">${E(a)}</div>
                <div style="font-size:16px;font-weight:750;color:#fff">${E(b)}</div>
              </div>`).join('')}
          </div>
          <div style="margin-top:14px;border:1px solid #2d4a62;border-radius:12px;padding:12px 14px;background:#0b1722">
            <div style="font-size:12px;font-weight:800;color:#9fb5c9;margin-bottom:5px">Descripción</div>
            <div style="font-size:16px;color:#fff;white-space:pre-wrap">${E(r.notes||r.description||'—')}</div>
          </div>
          <div id="r187P6OtherWrap" style="display:none;margin-top:16px">
            <label style="display:block;font-weight:800;color:#c9d8e5;margin-bottom:7px">Asignar a otro usuario</label>
            <select id="r187P6Assignee" style="width:100%;border:1px solid #385873;background:#091522;color:#fff;border-radius:10px;padding:12px"></select>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding:18px 26px 24px;border-top:1px solid #294158">
          ${canAssign?`
            <button id="r187P6Mine" style="border:0;border-radius:10px;padding:12px 18px;background:#2f80ed;color:#fff;font-weight:800;cursor:pointer">Asignármelo</button>
            <button id="r187P6Other" style="border:1px solid #537089;border-radius:10px;padding:12px 18px;background:#162b3c;color:#fff;font-weight:800;cursor:pointer">Asignar a otro usuario</button>
            <button id="r187P6Confirm" style="display:none;border:0;border-radius:10px;padding:12px 18px;background:#18a66a;color:#fff;font-weight:800;cursor:pointer">Confirmar asignación</button>
          `:''}
          <button id="r187P6Cancel" style="border:1px solid #537089;border-radius:10px;padding:12px 18px;background:transparent;color:#d8e3ed;font-weight:800;cursor:pointer">Cancelar</button>
        </div>
      </div>`;

    document.body.appendChild(d);

    const close=()=>d.remove();
    d.querySelector('#r187P6Close').onclick=close;
    d.querySelector('#r187P6Cancel').onclick=close;
    d.addEventListener('click',e=>{if(e.target===d)close()});

    if(canAssign){
      d.querySelector('#r187P6Mine').onclick=async()=>{
        try{
          const x=await API(`/api/requests/${r.id}/assign`,{method:'POST',body:'{}'});
          await success(`Ticket ${x.ticket?.ticket_number||''} asignado a ti.`);
        }catch(e){alert(e.message)}
      };

      d.querySelector('#r187P6Other').onclick=async()=>{
        try{
          const users=await API(`/api/r187/requests/${r.id}/assignees`);
          const s=d.querySelector('#r187P6Assignee');
          s.innerHTML='<option value="">Selecciona un usuario...</option>'+users.map(u=>
            `<option value="${u.id}">${E(u.full_name||u.username)} · ${E(u.role)}${u.department?` · ${E(u.department)}`:''}</option>`
          ).join('');
          d.querySelector('#r187P6OtherWrap').style.display='block';
          d.querySelector('#r187P6Confirm').style.display='';
        }catch(e){alert(e.message)}
      };

      d.querySelector('#r187P6Confirm').onclick=async()=>{
        const userId=Number(d.querySelector('#r187P6Assignee').value||0);
        if(!userId)return alert('Selecciona un usuario.');
        try{
          const x=await API(`/api/r187/requests/${r.id}/assign-to`,{
            method:'POST',
            body:JSON.stringify({userId})
          });
          await success(`Ticket ${x.ticket?.ticket_number||''} asignado a ${x.assignedTo?.full_name||x.assignedTo?.username||'usuario'}.`);
        }catch(e){alert(e.message)}
      };
    }
  }

  function modalValues(modal){
    return (modal?.innerText||'').replace(/\s+/g,' ').trim().toLowerCase();
  }

  async function chooseForLegacyModal(modal){
    const rows=await API('/api/r187/admin-open-requests');
    if(!Array.isArray(rows)||!rows.length)return null;
    const txt=modalValues(modal);

    let best=null,bestScore=-1;
    for(const r of rows){
      let score=0;
      for(const v of [r.requested_by,r.requester_area,r.support_location,r.category_label,r.notes]){
        const s=String(v||'').trim().toLowerCase();
        if(s.length>=2&&txt.includes(s))score+=2;
      }
      if(String(r.department||'').toLowerCase()==='systems'&&txt.includes('sistemas'))score++;
      if(String(r.department||'').toLowerCase()==='maintenance'&&txt.includes('mantenimiento'))score++;
      if(score>bestScore){best=r;bestScore=score}
    }
    return bestScore>=2?best:(rows.length===1?rows[0]:null);
  }

  let opening=false;
  const observer=new MutationObserver(async()=>{
    if(opening)return;
    const modal=findLegacyAdminModal();
    if(!modal||modal.dataset.r187P6Handled==='1')return;
    if(getComputedStyle(modal).display==='none')return;

    modal.dataset.r187P6Handled='1';
    opening=true;
    try{
      const row=await chooseForLegacyModal(modal);
      if(row){
        closeLegacyAdminModal();
        await openP6(row);
      }
    }catch(e){
      console.error('P6 admin modal bridge',e);
      modal.dataset.r187P6Handled='';
    }finally{
      opening=false;
    }
  });
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});

  window.r187P6OpenAdministrativeRequest=openP6;
})();