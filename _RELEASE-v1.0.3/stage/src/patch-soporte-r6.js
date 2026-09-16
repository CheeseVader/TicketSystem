const fs=require('fs');
const path=require('path');
const root=process.argv[2];

const serverPath=path.join(root,'src','server.js');
const dashPath=path.join(root,'public','js','dashboard-r10.js');
const cssPath=path.join(root,'public','css','soporte.css');

let server=fs.readFileSync(serverPath,'utf8');

// 1) Enviar datos administrativos completos en el evento EN EL MISMO INSTANTE del INSERT.
const oldEmit="io.emit('request:changed',{action:'created',id:q.id,stationCode:station?.code||`SOPORTE-${q.id}`,department,category:requestType,source:'administrative'});";
const newEmit="io.emit('request:changed',{action:'created',id:q.id,stationCode:supportLocation,department,category:requestType,category_label:cat.label,source:'administrative',requesterArea,requester_area:requesterArea,supportLocation,support_location:supportLocation});";

if(server.includes(oldEmit)){
  server=server.replace(oldEmit,newEmit);
}else if(!server.includes("category_label:cat.label,source:'administrative'")){
  throw new Error('No se encontro el emit administrativo esperado en server.js.');
}
fs.writeFileSync(serverPath,server,'utf8');

// 2) Enriquecer el objeto que usa el audio existente. NO crear un segundo listener:
// así conserva el mismo tono/cola y no duplica alertas.
let dash=fs.readFileSync(dashPath,'utf8');

const oldReq=`    const request={
      id,
      department:evt.department,
      stationCode:evt.stationCode,
      category:evt.category
    };`;

const newReq=`    const request={
      id,
      department:evt.department,
      stationCode:evt.stationCode,
      category:evt.category,
      category_label:evt.category_label,
      source:evt.source,
      requesterArea:evt.requesterArea||evt.requester_area,
      supportLocation:evt.supportLocation||evt.support_location
    };`;

if(dash.includes(oldReq)){
  dash=dash.replace(oldReq,newReq);
}else if(!dash.includes("supportLocation:evt.supportLocation||evt.support_location")){
  throw new Error('No se encontro el bloque request de andonHandleRequestEvent.');
}

// 3) La voz administrativa usa área + ubicación y sigue disparándose inmediatamente.
// El recordatorio de 45 s queda únicamente para solicitudes que sigan sin asignar.
const oldPhrase=`  const area=andonDepartmentName(request.department);
  const station=andonReadableStation(request.stationCode||request.station_code||request.code);
  const category=andonReadableCategory(request.category_label||request.category);
  const prefix=repeat?'Recordatorio. Solicitud pendiente de':'Atención. Nueva solicitud de';
  let phrase=\`${'${prefix}'} ${'${area}'}. ${'${station}'}.\`;
  if(category)phrase+=\` Categoría ${'${category}'}.\`;
  setTimeout(()=>andonSpeak(phrase),950);`;

const newPhrase=`  const area=andonDepartmentName(request.department);
  const category=andonReadableCategory(request.category_label||request.category);
  const prefix=repeat?'Recordatorio. Solicitud pendiente de':'Atención. Nueva solicitud de';
  let phrase;
  if(request.source==='administrative'){
    const requester=String(request.requesterArea||'').trim();
    const location=String(request.supportLocation||request.stationCode||'').trim();
    phrase=\`${'${prefix}'} ${'${area}'}. Solicitud administrativa\`;
    if(requester)phrase+=\` de ${'${requester}'}\`;
    if(location)phrase+=\`. Ubicación ${'${location}'}\`;
    phrase+='.';
  }else{
    const station=andonReadableStation(request.stationCode||request.station_code||request.code);
    phrase=\`${'${prefix}'} ${'${area}'}. ${'${station}'}.\`;
  }
  if(category)phrase+=\` Categoría ${'${category}'}.\`;
  setTimeout(()=>andonSpeak(phrase),950);`;

if(dash.includes(oldPhrase)){
  dash=dash.replace(oldPhrase,newPhrase);
}else if(!dash.includes("Solicitud administrativa")){
  throw new Error('No se encontro el bloque de frase de audio esperado.');
}

fs.writeFileSync(dashPath,dash,'utf8');

// 4) Corregir conflicto visual: .ok del modal estaba afectando .message.ok.
let css=fs.readFileSync(cssPath,'utf8');
if(!css.includes('/* SOPORTE R6 - FIX MENSAJE */')){
  css += `
/* SOPORTE R6 - FIX MENSAJE */
.message.ok{
  width:auto!important;
  height:auto!important;
  min-height:0!important;
  display:block!important;
  margin:12px 0 0!important;
  padding:0!important;
  border-radius:0!important;
  background:transparent!important;
  color:#6de5a7!important;
  font-size:15px!important;
  line-height:1.4!important;
  font-weight:700!important;
  text-align:center!important;
}
`;
}
fs.writeFileSync(cssPath,css,'utf8');

console.log('R6 aplicado: mensaje visual corregido + alerta administrativa inmediata.');
