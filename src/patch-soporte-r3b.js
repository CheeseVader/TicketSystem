const fs=require('fs'),path=require('path');
const root=process.argv[2],server=path.join(root,'src','server.js'),dash=path.join(root,'public','js','dashboard-r10.js');
let s=fs.readFileSync(server,'utf8');
s=s.replaceAll("SELECT department,code,label FROM admin_support_requests_catalog WHERE enabled=TRUE ORDER BY department,sort_order,label",
"SELECT department,code,label,category_group FROM admin_support_requests_catalog WHERE enabled=TRUE ORDER BY department,sort_order,label");
s=s.replace("if(requestType==='other'&&!description)return res.status(400).json({error:'Describe la solicitud cuando seleccionas Otros.'});",
"if(!description)return res.status(400).json({error:'Agrega una descripción breve del problema.'});");
s=s.replace("const notes=requestType==='other'?description:cat.label;","const notes=description;");
fs.writeFileSync(server,s,'utf8');

let d=fs.readFileSync(dash,'utf8');
const lines=d.split(/\r?\n/);
const idx=lines.findIndex(x=>x.includes("$('#groupsGrid').innerHTML=dashData.groups.map"));
if(idx<0)throw new Error('No se encontro la linea groupsGrid del dashboard.');
lines[idx]=`  const productionHtml=dashData.groups.map(g=>{const sts=dashData.stations.filter(s=>s.group_id===g.id);return \`<div class="line-card"><div class="line-title"><div><strong>\${esc(g.name)}</strong><small>\${esc(g.code)} · \${sts.length} equipos</small></div></div><div class="station-grid">\${sts.map(s=>{const arr=byStation[s.code]||[];const state=arr.length?arr.map(x=>\`\${fmtDept(x.department)} · \${statusNames[x.ticket_status||x.status]||x.status}\`).join(' / '):'OK';const cls=arr.some(x=>x.department==='systems')?'has-systems':arr.some(x=>x.department==='maintenance')?'has-maintenance':'';return \`<div class="station-tile \${cls}"><span class="code">\${esc(s.code)}</span><span class="station-name">\${esc(s.label||'')}</span><span class="state">\${esc(state)}</span></div>\`}).join('')}</div></div>\`}).join('');
  const adminOpen=open.filter(x=>x.source==='administrative');
  const adminAreas=[...new Set([...(dashData.adminAreas||[]).map(x=>x.name),...adminOpen.map(x=>x.requester_area).filter(Boolean)])];
  const adminHtml=adminAreas.length?\`<div class="line-card"><div class="line-title"><div><strong>ADMINISTRATIVOS</strong><small>Áreas administrativas · \${adminAreas.length} áreas</small></div></div><div class="station-grid">\${adminAreas.map(area=>{const arr=adminOpen.filter(x=>x.requester_area===area);const state=arr.length?arr.map(x=>\`\${fmtDept(x.department)} · \${statusNames[x.ticket_status||x.status]||x.status}\`).join(' / '):'OK';const cls=arr.some(x=>x.department==='systems')?'has-systems':arr.some(x=>x.department==='maintenance')?'has-maintenance':'';return \`<div class="station-tile \${cls}"><span class="code">\${esc(area)}</span><span class="station-name">\${arr.length?\`Ubicación: \${esc(arr[0].support_location||area)}\`:'Administrativo'}</span><span class="state">\${esc(state)}</span></div>\`}).join('')}</div></div>\`:'';
  $('#groupsGrid').innerHTML=productionHtml+adminHtml;`;

d=lines.join('\n');
d=d.replace("dashData=await api('/api/dashboard');me=dashData.user;renderIdentity();",
"dashData=await api('/api/dashboard');me=dashData.user;renderIdentity();try{const c=await api('/api/soporte/catalog');dashData.adminAreas=c.areas||[]}catch{dashData.adminAreas=[]}");

// Administrative requests in tables: show useful origin/area/location instead of blank station.
d=d.replace(
"function requestRows(rows,compact=false){return rows.length?rows.map(x=>`<tr><td>${esc(x.group_name||'—')}</td><td><strong>${esc(x.code)}</strong><small class=\"subline\">${esc(x.station_name||'')}</small></td>",
"function requestRows(rows,compact=false){return rows.length?rows.map(x=>`<tr><td>${esc(x.source==='administrative'?'ADMINISTRATIVOS':(x.group_name||'—'))}</td><td><strong>${esc(x.source==='administrative'?(x.requester_area||'Administrativo'):(x.code||''))}</strong><small class=\"subline\">${esc(x.source==='administrative'?('Ubicación: '+(x.support_location||'—')):(x.station_name||''))}</small></td>"
);
fs.writeFileSync(dash,d,'utf8');
console.log('Parches backend/dashboard R3B aplicados.');
