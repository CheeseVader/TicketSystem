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

const norm=v=>String(v||'').replace(/\s+/g,' ').trim().toLowerCase();

function visible(el){
  if(!el)return false;
  const s=getComputedStyle(el);
  return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';
}

function legacyModal(){
  const headings=[...document.querySelectorAll('h1,h2,h3')]
    .filter(h=>/Solicitud administrativa/i.test(h.textContent||''));

  for(const h of headings){
    if(h.closest('#p75AdminModal,#p66AdminModal,#p61AdminModal,#r187P4Modal'))continue;

    let root=null;
    for(let n=h;n&&n!==document.body;n=n.parentElement){
      const cls=String(n.className||'');
      if(
        n.getAttribute?.('role')==='dialog' ||
        /modal-overlay|modal\b|overlay|dialog/i.test(cls) ||
        getComputedStyle(n).position==='fixed'
      ){
        root=n;
      }
    }

    if(!root||!visible(root))continue;

    const t=norm(root.innerText);
    if(
      t.includes('planta') &&
      t.includes('solicitante / área') &&
      t.includes('área de soporte') &&
      t.includes('categoría')
    ){
      return root;
    }
  }
  return null;
}

function fieldValue(root,label){
  const labels=[...root.querySelectorAll('label,strong,span,div')];
  const node=labels.find(x=>norm(x.textContent)===norm(label));
  if(!node)return '';

  let p=node.parentElement;
  for(let i=0;p&&i<4;i++,p=p.parentElement){
    const input=p.querySelector('input,select,textarea');
    if(input?.value)return input.value;

    const values=[...p.querySelectorAll('input,select,textarea,strong')]
      .map(x=>x.value||x.textContent)
      .map(x=>String(x||'').trim())
      .filter(Boolean);

    const different=values.find(v=>norm(v)!==norm(label));
    if(different)return different;
  }
  return '';
}

async function matchRequest(root){
  const rows=await api('/api/r187/admin-open-p61');
  if(!Array.isArray(rows)||!rows.length)return null;
  if(rows.length===1)return rows[0];

  const text=norm(root.innerText);
  const category=norm(fieldValue(root,'Categoría'));
  const description=norm(fieldValue(root,'Descripción'));
  const area=norm(fieldValue(root,'Solicitante / área'));
  const location=norm(fieldValue(root,'Ubicación'));

  let best=null,bestScore=-1;

  for(const r of rows){
    let score=0;
    const pairs=[
      [category,r.category_label||r.category,6],
      [description,r.notes,6],
      [area,r.requester_area,5],
      [location,r.support_location,5]
    ];
    for(const [a,b,w] of pairs){
      if(a&&norm(b)===a)score+=w;
    }

    for(const v of [r.requester_area,r.support_location,r.category_label,r.category,r.notes]){
      const s=norm(v);
      if(s.length>1&&text.includes(s))score++;
    }

    if(score>bestScore){best=r;bestScore=score}
  }

  return best;
}

function supportName(v){
  const s=norm(v);
  return s==='systems'?'Sistemas':s==='maintenance'?'Mantenimiento':(v||'—');
}

function removeModal(root){
  try{
    root.classList.add('hidden');
    root.classList.remove('open','show','active');
    root.style.setProperty('display','none','important');
    root.style.setProperty('pointer-events','none','important');
    root.setAttribute('aria-hidden','true');
  }catch{}
  document.body.classList.remove('modal-open','no-scroll','overflow-hidden');
  document.documentElement.classList.remove('modal-open','no-scroll','overflow-hidden');
}

async function showCorrect(root,row){
  const r=await api(`/api/r187/requests/${row.id}/detail-p61`);
  removeModal(root);

  document.querySelector('#p75AdminModal')?.remove();

  const status=String(r.ticket_status||r.status||'unassigned').toLowerCase();
  const canAssign=status==='unassigned';

  const d=document.createElement('div');
  d.id='p75AdminModal';
  d.style.cssText='position:fixed;inset:0;z-index:200000;background:rgba(3,10,18,.72);display:flex;align-items:center;justify-content:center;padding:20px;overflow:auto';

  d.innerHTML=`
  <div style="width:min(720px,96vw);background:#101e2a;border:1px solid #33516a;border-radius:20px;color:#fff;box-shadow:0 30px 90px rgba(0,0,0,.58);overflow:hidden">
    <div style="padding:24px 26px 18px;border-bottom:1px solid #294258;display:flex;justify-content:space-between;gap:18px">
      <div>
        <h2 style="margin:0 0 6px;font-size:27px">Solicitud administrativa</h2>
        <div style="color:#9db4c8">Detalle de la alerta activa</div>
      </div>
      <button id="p75Close" style="border:0;background:transparent;color:#d8e4ed;font-size:30px;cursor:pointer">×</button>
    </div>

    <div style="padding:22px 26px">
      <div class="p75grid">
        <div class="p75field"><span>Solicitante</span><strong>${esc(r.requested_by||'No capturado')}</strong></div>
        <div class="p75field"><span>Área / Departamento</span><strong>${esc(r.requester_area||'—')}</strong></div>
        <div class="p75field"><span>Ubicación</span><strong>${esc(r.support_location||r.station_name||'—')}</strong></div>
        <div class="p75field"><span>Área de soporte</span><strong>${esc(supportName(r.department))}</strong></div>
        <div class="p75field"><span>Categoría</span><strong>${esc(r.category_label||r.category||'—')}</strong></div>
        <div class="p75field"><span>Estado</span><strong>${esc(status)}</strong></div>
      </div>
      <div class="p75field" style="margin-top:13px">
        <span>Descripción</span>
        <strong style="white-space:pre-wrap">${esc(r.notes||r.description||'—')}</strong>
      </div>

      <div id="p75OtherWrap" style="display:none;margin-top:16px">
        <label style="display:block;color:#bdd0df;font-weight:850;margin-bottom:7px">Asignar a otro usuario</label>
        <select id="p75Assignee" style="width:100%;background:#091521;color:#fff;border:1px solid #385873;border-radius:10px;padding:12px"></select>
      </div>
    </div>

    <div style="padding:18px 26px 24px;border-top:1px solid #294258;display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
      ${canAssign?`
        <button id="p75Mine" class="p75btn primary">Asignármelo</button>
        <button id="p75Other" class="p75btn secondary">Asignar a otro usuario</button>
        <button id="p75Confirm" class="p75btn ok" style="display:none">Confirmar asignación</button>
      `:''}
      <button id="p75Cancel" class="p75btn ghost">Cancelar</button>
    </div>
  </div>`;

  const st=document.createElement('style');
  st.textContent=`
    #p75AdminModal .p75grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}
    #p75AdminModal .p75field{background:#0a1723;border:1px solid #315069;border-radius:12px;padding:12px 14px;display:grid;gap:5px}
    #p75AdminModal .p75field span{font-size:12px;font-weight:850;color:#9fb6ca}
    #p75AdminModal .p75field strong{font-size:16px;color:#fff}
    #p75AdminModal .p75btn{border-radius:10px;padding:12px 18px;font-weight:850;cursor:pointer}
    #p75AdminModal .primary{border:0;background:#3281ed;color:#fff}
    #p75AdminModal .secondary{border:1px solid #54728b;background:#173047;color:#fff}
    #p75AdminModal .ok{border:0;background:#17a568;color:#fff}
    #p75AdminModal .ghost{border:1px solid #54728b;background:transparent;color:#dae6ee}
    @media(max-width:650px){#p75AdminModal .p75grid{grid-template-columns:1fr}}
  `;
  d.appendChild(st);
  document.body.appendChild(d);

  const close=()=>{
    d.remove();
    removeModal(root);
  };

  d.querySelector('#p75Close').onclick=close;
  d.querySelector('#p75Cancel').onclick=close;
  d.addEventListener('click',e=>{if(e.target===d)close()});

  if(canAssign){
    d.querySelector('#p75Mine').onclick=async()=>{
      try{
        const x=await api(`/api/requests/${r.id}/assign`,{method:'POST',body:'{}'});
        alert(`Ticket ${x.ticket?.ticket_number||''} asignado a ti.`);
        close();
        try{if(typeof loadDashboard==='function')await loadDashboard()}catch{}
      }catch(e){alert(e.message)}
    };

    d.querySelector('#p75Other').onclick=async()=>{
      try{
        const users=await api(`/api/r187/requests/${r.id}/assignees`);
        const sel=d.querySelector('#p75Assignee');
        sel.innerHTML='<option value="">Selecciona un usuario...</option>'+users.map(u=>
          `<option value="${u.id}">${esc(u.full_name||u.username)} · ${esc(u.role)}${u.department?` · ${esc(u.department)}`:''}</option>`
        ).join('');
        d.querySelector('#p75OtherWrap').style.display='block';
        d.querySelector('#p75Confirm').style.display='';
      }catch(e){alert(e.message)}
    };

    d.querySelector('#p75Confirm').onclick=async()=>{
      const userId=Number(d.querySelector('#p75Assignee').value||0);
      if(!userId)return alert('Selecciona un usuario.');
      try{
        const x=await api(`/api/r187/requests/${r.id}/assign-to`,{
          method:'POST',
          body:JSON.stringify({userId})
        });
        alert(`Ticket ${x.ticket?.ticket_number||''} asignado a ${x.assignedTo?.full_name||x.assignedTo?.username||'usuario'}.`);
        close();
        try{if(typeof loadDashboard==='function')await loadDashboard()}catch{}
      }catch(e){alert(e.message)}
    };
  }
}

let working=false;
async function inspect(){
  if(working||document.querySelector('#p75AdminModal'))return;
  const root=legacyModal();
  if(!root)return;

  working=true;
  try{
    const row=await matchRequest(root);
    if(!row)return;
    await showCorrect(root,row);
  }catch(e){
    console.error('P7.5 admin modal',e);
  }finally{
    working=false;
  }
}

const observer=new MutationObserver(()=>inspect());
observer.observe(document.body,{
  subtree:true,
  childList:true,
  attributes:true,
  attributeFilter:['class','style','aria-hidden']
});

setInterval(inspect,250);
})();