const $=id=>document.getElementById(id);
const form=$('supportForm'),nameEl=$('requesterName'),areaEl=$('requesterArea'),locationEl=$('supportLocation');
const deptEl=$('department'),classificationWrap=$('classificationWrap'),categoryEl=$('categoryGroup'),requestEl=$('requestType');
const descriptionEl=$('problemDescription'),messageEl=$('message'),submitBtn=$('submitBtn'),successModal=$('successModal'),successDetail=$('successDetail');
const socket=io();let catalog={areas:[],locations:[],requests:[]},lastRequestId=null;
function msg(text,type=''){messageEl.textContent=text||'';messageEl.className='message '+type}
function ea(v){return String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function sortByName(rows){
  return [...(rows||[])].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'es',{sensitivity:'base',numeric:true}));
}
function fillSimple(s,rows){
  const sorted=sortByName(rows);
  s.innerHTML='<option value="">Seleccione...</option>'+sorted.map(x=>`<option value="${ea(x.name)}">${x.name}</option>`).join('');
}
function fillLocations(select,areas,locations){
  const areaNames=new Set((areas||[]).map(x=>String(x.name||'').trim().toLocaleLowerCase('es')));
  const areaRows=sortByName((locations||[]).filter(x=>areaNames.has(String(x.name||'').trim().toLocaleLowerCase('es'))));
  const lineRows=sortByName((locations||[]).filter(x=>!areaNames.has(String(x.name||'').trim().toLocaleLowerCase('es'))));

  const areaHtml=areaRows.length
    ? '<optgroup label="ÁREAS / DEPARTAMENTOS">'+areaRows.map(x=>`<option value="${ea(x.name)}">${x.name}</option>`).join('')+'</optgroup>'
    : '';

  const lineHtml=lineRows.length
    ? '<optgroup label="LÍNEAS / GRUPOS">'+lineRows.map(x=>`<option value="${ea(x.name)}">${x.name}</option>`).join('')+'</optgroup>'
    : '';

  select.innerHTML='<option value="">Seleccione...</option>'+areaHtml+lineHtml;
}
async function loadCatalog(){const r=await fetch('/api/soporte/catalog',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||'No se pudo cargar el catálogo');catalog=j;fillSimple(areaEl,j.areas||[]);fillLocations(locationEl,j.areas||[],j.locations||[])}
function selectDepartment(dept){deptEl.value=dept;document.querySelectorAll('.dept').forEach(b=>b.classList.toggle('active',b.dataset.dept===dept));const rows=(catalog.requests||[]).filter(x=>x.department===dept);const groups=[...new Set(rows.map(x=>x.category_group||'Otros'))];categoryEl.innerHTML='<option value="">Seleccione...</option>'+groups.map(x=>`<option value="${ea(x)}">${x}</option>`).join('');requestEl.innerHTML='<option value="">Seleccione...</option>';categoryEl.value='';requestEl.value='';descriptionEl.value='';classificationWrap.classList.remove('hidden')}
function fillIncidents(){const rows=(catalog.requests||[]).filter(x=>x.department===deptEl.value&&(x.category_group||'Otros')===categoryEl.value);requestEl.innerHTML='<option value="">Seleccione...</option>'+rows.map(x=>`<option value="${ea(x.code)}">${x.label}</option>`).join('')}
document.querySelectorAll('.dept').forEach(b=>b.addEventListener('click',()=>selectDepartment(b.dataset.dept)));categoryEl.addEventListener('change',fillIncidents);$('closeSuccess').addEventListener('click',()=>successModal.classList.add('hidden'));
form.addEventListener('submit',async e=>{e.preventDefault();msg('');const payload={requesterName:nameEl.value.trim(),requesterArea:areaEl.value,supportLocation:locationEl.value,department:deptEl.value,requestType:requestEl.value,description:descriptionEl.value.trim()};if(!payload.requesterName||!payload.requesterArea||!payload.supportLocation||!payload.department||!categoryEl.value||!payload.requestType)return msg('Complete los campos requeridos.','error');if(!payload.description)return msg('Agrega una descripción breve del problema.','error');submitBtn.disabled=true;try{const r=await fetch('/api/soporte/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),j=await r.json();if(!r.ok)throw new Error(j.error||'No se pudo enviar la solicitud');lastRequestId=j.id;successDetail.textContent=`${j.department_label} · ${j.request_label} · ${j.support_location}`;successModal.classList.remove('hidden');form.reset();deptEl.value='';document.querySelectorAll('.dept').forEach(b=>b.classList.remove('active'));classificationWrap.classList.add('hidden')}catch(err){msg(err.message,'error')}finally{submitBtn.disabled=false}});
function speak(text){if(!window.speechSynthesis||!text)return;let spoken=false;const go=()=>{if(spoken)return true;const vs=speechSynthesis.getVoices();if(!vs.length)return false;spoken=true;const u=new SpeechSynthesisUtterance(text);u.lang='es-US';u.rate=1.30;u.pitch=1.05;u.volume=1;u.voice=vs.find(v=>v.name==='Google español de Estados Unidos')||vs.find(v=>String(v.lang||'').toLowerCase()==='es-us')||vs.find(v=>String(v.lang||'').toLowerCase().startsWith('es'))||vs[0];speechSynthesis.cancel();speechSynthesis.speak(u);return true};if(go())return;let n=0;const t=setInterval(()=>{n++;if(go()||n>=20)clearInterval(t)},250)}
socket.on('request:changed',evt=>{if(evt.action==='assigned'&&lastRequestId&&Number(evt.id)===Number(lastRequestId)){speak(`Su solicitud de ${evt.department==='systems'?'Sistemas':'Mantenimiento'} ha sido asignada. Enseguida será atendida.`);msg('Su solicitud ha sido asignada. Enseguida será atendida.','ok')}});
loadCatalog().catch(e=>msg(e.message,'error'));