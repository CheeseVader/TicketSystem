const fs=require('fs');
const path=require('path');

const root=process.argv[2];
const jsPath=path.join(root,'public','js','soporte.js');

let s=fs.readFileSync(jsPath,'utf8');

const old1="function fillSimple(s,rows){s.innerHTML='<option value=\"\">Seleccione...</option>'+rows.map(x=>`<option value=\"${ea(x.name)}\">${x.name}</option>`).join('')}";
const new1=`function sortByName(rows){
  return [...(rows||[])].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'es',{sensitivity:'base',numeric:true}));
}
function fillSimple(s,rows){
  const sorted=sortByName(rows);
  s.innerHTML='<option value="">Seleccione...</option>'+sorted.map(x=>\`<option value="\${ea(x.name)}">\${x.name}</option>\`).join('');
}
function fillLocations(select,areas,locations){
  const areaNames=new Set((areas||[]).map(x=>String(x.name||'').trim().toLocaleLowerCase('es')));
  const areaRows=sortByName((locations||[]).filter(x=>areaNames.has(String(x.name||'').trim().toLocaleLowerCase('es'))));
  const lineRows=sortByName((locations||[]).filter(x=>!areaNames.has(String(x.name||'').trim().toLocaleLowerCase('es'))));

  const areaHtml=areaRows.length
    ? '<optgroup label="ÁREAS / DEPARTAMENTOS">'+areaRows.map(x=>\`<option value="\${ea(x.name)}">\${x.name}</option>\`).join('')+'</optgroup>'
    : '';

  const lineHtml=lineRows.length
    ? '<optgroup label="LÍNEAS / GRUPOS">'+lineRows.map(x=>\`<option value="\${ea(x.name)}">\${x.name}</option>\`).join('')+'</optgroup>'
    : '';

  select.innerHTML='<option value="">Seleccione...</option>'+areaHtml+lineHtml;
}`;

if(!s.includes(old1)){
  throw new Error('No se encontro la funcion fillSimple esperada en soporte.js.');
}
s=s.replace(old1,new1);

const old2="async function loadCatalog(){const r=await fetch('/api/soporte/catalog',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||'No se pudo cargar el catálogo');catalog=j;fillSimple(areaEl,j.areas||[]);fillSimple(locationEl,j.locations||[])}";
const new2="async function loadCatalog(){const r=await fetch('/api/soporte/catalog',{cache:'no-store'}),j=await r.json();if(!r.ok)throw new Error(j.error||'No se pudo cargar el catálogo');catalog=j;fillSimple(areaEl,j.areas||[]);fillLocations(locationEl,j.areas||[],j.locations||[])}";

if(!s.includes(old2)){
  throw new Error('No se encontro loadCatalog esperado en soporte.js.');
}
s=s.replace(old2,new2);

fs.writeFileSync(jsPath,s,'utf8');
console.log('Orden alfabetico y grupos de ubicacion aplicados.');
