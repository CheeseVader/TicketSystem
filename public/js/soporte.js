
async function applySupportBranding(){
  try{
    const r=await fetch('/api/public-config',{cache:'no-store'}),c=await r.json();
    const brand=String(c.brandName||'').trim();
    if(brand) document.title=`${brand} - Portal de soporte`;
  }catch(_){ }
}
applySupportBranding();
const $=id=>document.getElementById(id);
const form=$('supportForm'),plantEl=$('supportPlant'),nameEl=$('requesterName'),areaEl=$('requesterArea'),locationEl=$('supportLocation');
const deptEl=$('department'),classificationWrap=$('classificationWrap'),categoryEl=$('categoryGroup'),requestEl=$('requestType');
const descriptionEl=$('problemDescription'),messageEl=$('message'),submitBtn=$('submitBtn'),successModal=$('successModal'),successDetail=$('successDetail');
const socket=io();let catalog={plants:[],areas:[],groups:[],requests:[],departments:[]},lastRequestId=null;
function msg(text,type=''){messageEl.textContent=text||'';messageEl.className='message '+type}
function ea(v){return String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function sortByName(rows){return [...(rows||[])].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'es',{sensitivity:'base',numeric:true}))}
function fillSimple(s,rows,placeholder='Seleccione...'){const sorted=sortByName(rows);s.innerHTML=`<option value="">${placeholder}</option>`+sorted.map(x=>`<option value="${ea(x.id??x.name)}">${ea(x.name)}</option>`).join('')}
function fillLocations(){
  const plantId=Number(plantEl.value||0);
  if(!plantId){locationEl.innerHTML='<option value="">Seleccione primero una planta...</option>';locationEl.disabled=true;return}
  locationEl.disabled=false;
  const areas=sortByName(catalog.areas||[]);
  const groups=sortByName((catalog.groups||[]).filter(g=>Number(g.plant_id)===plantId));
  const plantName=(catalog.plants||[]).find(p=>Number(p.id)===plantId)?.name||'';
  const lineHtml=groups.length?`<optgroup label="LÍNEAS DE PRODUCCIÓN · ${ea(plantName)}">`+groups.map(x=>`<option value="group:${ea(x.id)}">${ea(x.name)} · Línea de producción</option>`).join('')+'</optgroup>':`<optgroup label="LÍNEAS DE PRODUCCIÓN · ${ea(plantName)}"><option value="" disabled>Sin líneas registradas en esta planta</option></optgroup>`;
  const areaHtml=areas.length?'<optgroup label="ÁREAS ADMINISTRATIVAS">'+areas.map(x=>`<option value="area:${ea(x.name)}">${ea(x.name)}</option>`).join('')+'</optgroup>':'';
  locationEl.innerHTML='<option value="">Seleccione ubicación...</option>'+lineHtml+areaHtml;
}
async function loadCatalog(){
  const r=await fetch('/api/soporte/catalog',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||'No se pudo cargar el catálogo');catalog=j;
  fillSimple(plantEl,j.plants||[]);fillSimple(areaEl,j.areas||[]);fillLocations();
  const box=$('departmentButtons');box.innerHTML=(j.departments||[]).map(d=>`<button type="button" class="dept" data-dept="${ea(d.code)}"><span class="tech-icon">${d.code==='systems'?'▣':d.code==='maintenance'?'◇':'◆'}</span><strong>${ea(d.name.toUpperCase())}</strong></button>`).join('');
  box.querySelectorAll('.dept').forEach(b=>b.addEventListener('click',()=>selectDepartment(b.dataset.dept)))
}
plantEl.addEventListener('change',()=>{fillLocations();locationEl.value=''});
function selectDepartment(dept){deptEl.value=dept;document.querySelectorAll('.dept').forEach(b=>b.classList.toggle('active',b.dataset.dept===dept));const rows=(catalog.requests||[]).filter(x=>x.department===dept);const groups=[...new Set(rows.map(x=>x.category_group||'Otros'))];categoryEl.innerHTML='<option value="">Seleccione...</option>'+groups.map(x=>`<option value="${ea(x)}">${ea(x)}</option>`).join('');requestEl.innerHTML='<option value="">Seleccione...</option>';categoryEl.value='';requestEl.value='';descriptionEl.value='';classificationWrap.classList.remove('hidden')}
function fillIncidents(){const rows=(catalog.requests||[]).filter(x=>x.department===deptEl.value&&(x.category_group||'Otros')===categoryEl.value);requestEl.innerHTML='<option value="">Seleccione...</option>'+rows.map(x=>`<option value="${ea(x.code)}">${ea(x.label)}</option>`).join('')}
categoryEl.addEventListener('change',fillIncidents);$('closeSuccess').addEventListener('click',()=>successModal.classList.add('hidden'));
form.addEventListener('submit',async e=>{
  e.preventDefault();msg('');
  const rawLoc=locationEl.value;let supportLocation='',supportGroupId=null;
  if(rawLoc.startsWith('group:')){supportGroupId=Number(rawLoc.slice(6));supportLocation=(catalog.groups||[]).find(g=>Number(g.id)===supportGroupId)?.name||''}
  else if(rawLoc.startsWith('area:')) supportLocation=rawLoc.slice(5);
  const payload={plantId:Number(plantEl.value||0),requesterName:nameEl.value.trim(),requesterArea:areaEl.value,supportLocation,supportGroupId,department:deptEl.value,requestType:requestEl.value,description:descriptionEl.value.trim()};
  if(!payload.plantId||!payload.requesterName||!payload.requesterArea||!payload.supportLocation||!payload.department||!categoryEl.value||!payload.requestType)return msg('Complete los campos requeridos.','error');
  if(!payload.description)return msg('Agrega una descripción breve del problema.','error');
  submitBtn.disabled=true;try{const r=await fetch('/api/soporte/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),j=await r.json();if(!r.ok)throw new Error(j.error||'No se pudo enviar la solicitud');lastRequestId=j.id;successDetail.textContent=`${j.plant_name||''} · ${j.department_label} · ${j.request_label} · ${j.support_location}`;successModal.classList.remove('hidden');form.reset();fillLocations();deptEl.value='';document.querySelectorAll('.dept').forEach(b=>b.classList.remove('active'));classificationWrap.classList.add('hidden')}catch(err){msg(err.message,'error')}finally{submitBtn.disabled=false}
});
function speak(text){if(!window.speechSynthesis||!text)return;let spoken=false;const go=()=>{if(spoken)return true;const vs=speechSynthesis.getVoices();if(!vs.length)return false;spoken=true;const u=new SpeechSynthesisUtterance(text);u.lang='es-US';u.rate=1.30;u.pitch=1.05;u.volume=1;u.voice=vs.find(v=>v.name==='Google español de Estados Unidos')||vs.find(v=>String(v.lang||'').toLowerCase()==='es-us')||vs.find(v=>String(v.lang||'').toLowerCase().startsWith('es'))||vs[0];speechSynthesis.cancel();speechSynthesis.speak(u);return true};if(go())return;let n=0;const t=setInterval(()=>{n++;if(go()||n>=20)clearInterval(t)},250)}
socket.on('request:changed',evt=>{if(evt.action==='assigned'&&lastRequestId&&Number(evt.id)===Number(lastRequestId)){speak(`Su solicitud de ${(catalog.departments||[]).find(d=>d.code===evt.department)?.name||evt.department} ha sido asignada. Enseguida será atendida.`);msg('Su solicitud ha sido asignada. Enseguida será atendida.','ok')}});
loadCatalog().catch(e=>msg(e.message,'error'));
