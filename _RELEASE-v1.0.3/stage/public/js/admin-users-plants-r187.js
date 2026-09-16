(()=>{
'use strict';
const S={plants:[],users:[],areas:[],departments:[]};
let mounted=false,activeTab='users';
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

async function api(url,opt={}){
  const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opt.headers||{})},...opt});
  const text=await r.text();
  let data=null; try{data=text?JSON.parse(text):null}catch{data={error:text}}
  if(!r.ok) throw new Error(data?.error||`HTTP ${r.status}`);
  return data;
}

function plantOptions(){
  return S.plants.map(p=>`<option value="${p.id}">${esc(p.name||p.code)}${p.code&&p.name?` · ${esc(p.code)}`:''}</option>`).join('');
}
function deptOptions(){
  const seen=new Map();
  for(const d of S.departments||[]) seen.set(String(d.code||d.name),d.name||d.code);
  for(const u of S.users||[]) if(u.department) seen.set(u.department,u.department);
  return [...seen.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]))).map(([v,n])=>`<option value="${esc(v)}">${esc(n)}</option>`).join('');
}
function findTarget(){
  const views=[...document.querySelectorAll('.app-view')];
  return views.find(v=>{
    const t=(v.textContent||'').replace(/\s+/g,' ');
    return /Usuarios y áreas/i.test(t) || (/Crear usuario/i.test(t)&&/Áreas/i.test(t));
  }) || null;
}
function msg(text,error=false){
  const e=document.querySelector('#r187Msg'); if(!e)return;
  e.textContent=text||''; e.className='r187-msg'+(error?' error':'');
}
async function refresh(){
  [S.plants,S.users,S.areas,S.departments]=await Promise.all([
    api('/api/r187/admin/plants'),
    api('/api/r187/admin/users'),
    api('/api/r187/admin/areas'),
    api('/api/r187/admin/departments')
  ]);
}
function render(){
  const root=document.querySelector('#r187Root'); if(!root)return;
  root.innerHTML=`
    <div class="r187-admin-wrap">
      <div class="r187-tabs">
        <button id="r187TabUsers" class="${activeTab==='users'?'active':''}">Usuarios</button>
        <button id="r187TabAreas" class="${activeTab==='areas'?'active':''}">Áreas</button>
      </div>
      <div id="r187Msg" class="r187-msg"></div>
      <div id="r187Content"></div>
    </div>`;
  document.querySelector('#r187TabUsers').onclick=()=>{activeTab='users';render()};
  document.querySelector('#r187TabAreas').onclick=()=>{activeTab='areas';render()};
  activeTab==='users'?renderUsers():renderAreas();
}
function renderUsers(){
  const c=document.querySelector('#r187Content');
  c.innerHTML=`
    <section class="r187-card">
      <div class="r187-card-head"><h3>Usuarios</h3><p>Planta, área, rol y estado de sesión.</p></div>
      <form id="r187UserForm" class="r187-form">
        <label>Planta<select id="r187UserPlant" required><option value="">Selecciona...</option>${plantOptions()}</select></label>
        <label>Área<select id="r187UserDept" required><option value="">Selecciona...</option>${deptOptions()}</select></label>
        <label>Rol<select id="r187UserRole"><option value="engineer">Ingeniero</option><option value="admin">Administrador</option><option value="superadmin">Super Administrador</option></select></label>
        <label>Usuario<input id="r187Username" required></label>
        <label>Nombre<input id="r187FullName" required></label>
        <label>Contraseña<input id="r187Password" type="password" minlength="6" required></label>
        <button class="r187-btn" type="submit">Crear usuario</button>
      </form>
      <div class="r187-table-wrap">
        <table class="r187-table">
          <thead><tr><th>Planta</th><th>Área</th><th>Rol</th><th>Usuario</th><th>Nombre</th><th>Estado</th><th>Sesión</th><th>Acciones</th></tr></thead>
          <tbody id="r187UsersBody"></tbody>
        </table>
      </div>
    </section>`;
  const role=document.querySelector('#r187UserRole'),plant=document.querySelector('#r187UserPlant');
  role.onchange=()=>{const s=role.value==='superadmin';plant.disabled=s;plant.required=!s;if(s)plant.value=''};
  document.querySelector('#r187UserForm').onsubmit=createUser;
  drawUsers();
}
function drawUsers(){
  const b=document.querySelector('#r187UsersBody'); if(!b)return;
  if(!S.users.length){b.innerHTML='<tr><td colspan="8" class="r187-empty">No hay usuarios.</td></tr>';return}
  b.innerHTML=S.users.map(u=>`
    <tr>
      <td>${u.role==='superadmin'
        ? '<span class="r187-pill">Todas</span>'
        : `<select data-user-plant="${u.id}"><option value="">Sin asignar</option>${plantOptions()}</select>`}</td>
      <td><select data-user-dept="${u.id}"><option value="">Sin área</option>${deptOptions()}</select></td>
      <td>${esc(u.role)}</td><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td>
      <td><span class="r187-pill ${u.active?'ok':'off'}">${u.active?'Activo':'Inactivo'}</span></td>
      <td><span class="r187-pill ${u.session_active?'ok':'off'}">${u.session_active?'Activa':'Libre'}</span></td>
      <td>${u.session_active && u.role!=='superadmin'
        ? `<button class="r187-btn warn" data-release="${u.id}">Liberar sesión</button>`
        : u.session_active?'<span class="r187-pill">Sesión actual</span>':'—'}</td>
    </tr>`).join('');
  for(const u of S.users){
    const p=document.querySelector(`[data-user-plant="${u.id}"]`);
    if(p){p.value=u.plant_id||'';p.onchange=()=>updateUser(u.id,p.value,undefined)}
    const d=document.querySelector(`[data-user-dept="${u.id}"]`);
    if(d){d.value=u.department||'';d.onchange=()=>updateUser(u.id,undefined,d.value)}
  }
  document.querySelectorAll('[data-release]').forEach(btn=>btn.onclick=()=>releaseSession(btn.dataset.release));
}
async function createUser(e){
  e.preventDefault();
  const role=document.querySelector('#r187UserRole').value;
  try{
    await api('/api/r187/admin/users',{method:'POST',body:JSON.stringify({
      plantId:role==='superadmin'?null:(Number(document.querySelector('#r187UserPlant').value)||null),
      department:document.querySelector('#r187UserDept').value,
      role,
      username:document.querySelector('#r187Username').value.trim(),
      fullName:document.querySelector('#r187FullName').value.trim(),
      password:document.querySelector('#r187Password').value
    })});
    await refresh(); render(); msg('Usuario creado correctamente.');
  }catch(e){msg(e.message,true)}
}
async function updateUser(id,plantId,department){
  const body={};
  if(plantId!==undefined)body.plantId=plantId?Number(plantId):null;
  if(department!==undefined)body.department=department||null;
  try{
    await api(`/api/r187/admin/users/${id}`,{method:'PATCH',body:JSON.stringify(body)});
    await refresh(); drawUsers(); msg('Usuario actualizado.');
  }catch(e){await refresh();drawUsers();msg(e.message,true)}
}
async function releaseSession(id){
  if(!confirm('¿Liberar la sesión activa de este usuario?'))return;
  try{
    await api(`/api/admin/users/${id}/release-session`,{method:'POST',body:'{}'});
    await refresh(); drawUsers(); msg('Sesión liberada.');
  }catch(e){msg(e.message,true)}
}
function renderAreas(){
  const c=document.querySelector('#r187Content');
  c.innerHTML=`
    <section class="r187-card">
      <div class="r187-card-head">
        <h3>Áreas / Departamentos</h3>
        <p>Catálogo global. Un mismo departamento puede utilizarse en cualquier planta.</p>
      </div>
      <form id="r187AreaForm" class="r187-form area">
        <label>Área / Departamento
          <input id="r187AreaName" placeholder="Ej. Production, Engineering, Quality, HR..." required>
        </label>
        <button class="r187-btn" type="submit">Agregar área</button>
      </form>
      <div class="r187-table-wrap">
        <table class="r187-table">
          <thead><tr><th>Área / Departamento</th><th>Estado</th><th>Acciones</th></tr></thead>
          <tbody id="r187AreasBody"></tbody>
        </table>
      </div>
    </section>`;
  document.querySelector('#r187AreaForm').onsubmit=createArea;
  drawAreas();
}

function drawAreas(){
  const b=document.querySelector('#r187AreasBody'); if(!b)return;
  if(!S.areas.length){
    b.innerHTML='<tr><td colspan="3" class="r187-empty">No hay áreas configuradas.</td></tr>';
    return;
  }
  b.innerHTML=S.areas.map(a=>`
    <tr>
      <td><input data-area-name="${a.id}" value="${esc(a.name)}"></td>
      <td><span class="r187-pill ${a.enabled?'ok':'off'}">${a.enabled?'Activa':'Inactiva'}</span></td>
      <td>
        <button class="r187-btn secondary" data-area-save="${a.id}">Guardar</button>
        <button class="r187-btn ${a.enabled?'danger':'secondary'}" data-area-toggle="${a.id}">
          ${a.enabled?'Desactivar':'Activar'}
        </button>
      </td>
    </tr>`).join('');

  document.querySelectorAll('[data-area-save]').forEach(btn=>btn.onclick=()=>saveArea(btn.dataset.areaSave));
  document.querySelectorAll('[data-area-toggle]').forEach(btn=>btn.onclick=()=>toggleArea(btn.dataset.areaToggle));
}

async function createArea(e){
  e.preventDefault();
  try{
    await api('/api/r187/admin/areas',{method:'POST',body:JSON.stringify({
      name:document.querySelector('#r187AreaName').value.trim()
    })});
    await refresh();render();msg('Área agregada.');
  }catch(e){msg(e.message,true)}
}

async function saveArea(id){
  const a=S.areas.find(x=>Number(x.id)===Number(id)); if(!a)return;
  try{
    await api(`/api/r187/admin/areas/${id}`,{method:'PATCH',body:JSON.stringify({
      name:document.querySelector(`[data-area-name="${id}"]`).value.trim(),
      enabled:a.enabled
    })});
    await refresh();drawAreas();msg('Área actualizada.');
  }catch(e){msg(e.message,true)}
}

async function toggleArea(id){
  const a=S.areas.find(x=>Number(x.id)===Number(id)); if(!a)return;
  try{
    await api(`/api/r187/admin/areas/${id}`,{method:'PATCH',body:JSON.stringify({
      name:a.name,enabled:!a.enabled
    })});
    await refresh();drawAreas();msg(a.enabled?'Área desactivada.':'Área activada.');
  }catch(e){msg(e.message,true)}
}
async function mount(){
  if(mounted)return;
  const target=findTarget(); if(!target)return;
  mounted=true;
  [...target.children].forEach(x=>x.style.display='none');
  const host=document.createElement('div');host.id='r187Root';target.appendChild(host);
  try{await refresh();render()}catch(e){host.innerHTML=`<div class="r187-msg error">${esc(e.message)}</div>`}
}
new MutationObserver(()=>mount()).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
setInterval(mount,500);
mount();
})();