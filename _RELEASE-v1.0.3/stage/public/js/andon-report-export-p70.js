(()=>{
'use strict';

const FILTER_IDS=[
  'repPlant','repDept','repGroup','repCategory',
  'repEngineer','repStatus','repFrom','repTo'
];

function norm(v){
  return String(v||'').replace(/\s+/g,' ').trim().toLowerCase();
}

function visible(el){
  if(!el)return false;
  const s=getComputedStyle(el);
  return s.display!=='none' && s.visibility!=='hidden';
}

function commonAncestor(nodes){
  if(!nodes.length)return null;
  let n=nodes[0];
  while(n&&n!==document.body){
    if(nodes.every(x=>n.contains(x)))return n;
    n=n.parentElement;
  }
  return null;
}

function findFilterPanel(){
  const view=document.querySelector('#view-reports');
  if(!view)return null;

  const controls=FILTER_IDS.map(id=>document.getElementById(id)).filter(Boolean);
  const title=[...view.querySelectorAll('*')]
    .find(el=>norm(el.textContent)==='filtro principal')||null;

  const nodes=[...controls];
  if(title)nodes.push(title);

  let panel=commonAncestor(nodes);

  // Si el ancestro común es demasiado grande, buscar un ancestro pequeño del título
  // que contenga la mayoría de los controles.
  if(!panel || panel===view){
    if(title){
      for(let n=title.parentElement;n&&n!==view;n=n.parentElement){
        const inside=controls.filter(c=>n.contains(c)).length;
        const r=n.getBoundingClientRect();
        if(inside>=Math.min(6,controls.length) && r.height>=50 && r.height<=320){
          panel=n;
          break;
        }
      }
    }
  }

  // Firma textual final.
  if(panel && panel!==view){
    const t=norm(panel.textContent);
    if(t.includes('filtro principal') && t.includes('planta') && t.includes('desde') && t.includes('hasta')){
      return panel;
    }
  }

  const candidates=[...view.querySelectorAll('section,form,div')]
    .filter(el=>{
      const t=norm(el.textContent);
      if(!t.includes('filtro principal'))return false;
      const hits=['planta','área','grupo / línea','categoría','usuario / técnico','estado','desde','hasta']
        .filter(x=>t.includes(x)).length;
      const c=el.querySelectorAll('select,input').length;
      const r=el.getBoundingClientRect();
      return (hits>=6||c>=4) && r.height<=340;
    })
    .sort((a,b)=>a.getBoundingClientRect().height-b.getBoundingClientRect().height);

  return candidates[0]||null;
}

function hideForCapture(){
  const changed=[];
  const hide=el=>{
    if(!el||changed.some(x=>x[0]===el))return;
    changed.push([
      el,
      el.style.getPropertyValue('display'),
      el.style.getPropertyPriority('display')
    ]);
    el.style.setProperty('display','none','important');
  };

  const panel=findFilterPanel();
  hide(panel);

  FILTER_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    hide(el.closest('label')||el.parentElement||el);
  });

  hide(document.getElementById('exportReportPdf'));
  hide(document.getElementById('exportReportExcel'));
  document.querySelectorAll('#view-reports button').forEach(hide);

  return ()=>{
    for(const [el,value,priority] of changed){
      if(value)el.style.setProperty('display',value,priority||'');
      else el.style.removeProperty('display');
    }
  };
}

async function captureReport(){
  const source=document.querySelector('#view-reports');
  if(!source)throw new Error('No se encontró la vista de Reportes.');
  if(typeof html2canvas!=='function')throw new Error('html2canvas no está cargado.');

  const restore=hideForCapture();

  try{
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

    const title=[...source.querySelectorAll('*')]
      .find(el=>norm(el.textContent)==='filtro principal');

    if(title && visible(title)){
      throw new Error('FILTRO PRINCIPAL sigue visible. No se exportará.');
    }

    return await html2canvas(source,{
      backgroundColor:'#07131d',
      scale:2,
      useCORS:true,
      logging:false,
      windowWidth:source.scrollWidth,
      width:source.scrollWidth,
      height:source.scrollHeight
    });
  }finally{
    restore();
  }
}

function queryString(){
  const q=new URLSearchParams();
  const map={
    from:'repFrom',
    to:'repTo',
    department:'repDept',
    group:'repGroup',
    category:'repCategory',
    engineer:'repEngineer',
    status:'repStatus'
  };
  for(const [key,id] of Object.entries(map)){
    const v=document.getElementById(id)?.value||'';
    if(v)q.set(key,v);
  }
  return q.toString();
}

async function canvasBlob(canvas){
  return await new Promise((resolve,reject)=>{
    canvas.toBlob(
      b=>b?resolve(b):reject(new Error('No se pudo generar la imagen del reporte.')),
      'image/png',
      1
    );
  });
}

function saveBlob(blob,name){
  const a=document.createElement('a');
  const url=URL.createObjectURL(blob);
  a.href=url;
  a.download=name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}

async function exportPdf(preview){
  try{
    const canvas=await captureReport();
    const data=canvas.toDataURL('image/png',1);
    const generated=new Date().toLocaleString('es-MX');

    preview.document.open();
    preview.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ANDON Support · Reporte Ejecutivo</title>
<style>
html,body{margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif}
body{padding:18px}
.toolbar{
  position:sticky;top:0;z-index:20;display:flex;justify-content:flex-end;
  gap:10px;padding:10px 0;background:#fff
}
.toolbar button{border:0;border-radius:9px;padding:10px 16px;font-weight:700;cursor:pointer}
.print{background:#2f80ed;color:#fff}
.close{background:#e9eef3;color:#213547}
h1{margin:0 0 6px;font-size:28px}
.generated{margin:0 0 16px;font-size:14px}
img{display:block;width:100%;height:auto}
@page{size:landscape;margin:7mm}
@media print{body{padding:0}.toolbar{display:none!important}}
</style>
</head>
<body>
<div class="toolbar">
  <button class="close" onclick="window.close()">Cerrar</button>
  <button class="print" onclick="window.print()">Imprimir / Guardar PDF</button>
</div>
<h1>ANDON Support · Reporte Ejecutivo</h1>
<div class="generated">Generado: ${generated}</div>
<img src="${data}" alt="Reporte Ejecutivo">
</body>
</html>`);
    preview.document.close();
    try{preview.focus()}catch{}
  }catch(err){
    preview.document.open();
    preview.document.write(`<h2 style="font-family:Arial;padding:30px">Error: ${String(err.message||err)}</h2>`);
    preview.document.close();
  }
}

async function exportExcel(preview){
  try{
    const canvas=await captureReport();
    const data=canvas.toDataURL('image/png',1);
    const generated=new Date().toLocaleString('es-MX');
    const downloadUrl=window.location.origin+'/api/r187/reports/dynamic.xlsx?'+queryString();

    preview.document.open();
    preview.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ANDON Support · Vista previa Excel</title>
<style>
html,body{margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif}
body{padding:18px}
.toolbar{position:sticky;top:0;z-index:20;display:flex;justify-content:flex-end;gap:10px;padding:10px 0;background:#fff}
.toolbar button{border:0;border-radius:9px;padding:10px 16px;font-weight:700;cursor:pointer}
.download{background:#217346;color:#fff}
.close{background:#e9eef3;color:#213547}
h1{margin:0 0 6px;font-size:28px}
.generated{margin:0 0 8px;font-size:14px}
.note{margin:0 0 16px;color:#445}
img{display:block;width:100%;height:auto}
</style>
</head>
<body>
<div class="toolbar">
  <button class="close" id="p75ExcelClose">Cerrar</button>
  <button class="download" id="p75ExcelDownload">Descargar Excel dinámico</button>
</div>
<h1>ANDON Support · Reporte Ejecutivo</h1>
<div class="generated">Generado: ${generated}</div>
<div class="note">El archivo descargado tendrá gráficas nativas, KPIs y pestaña Filtros.</div>
<img src="${data}" alt="Reporte Ejecutivo">
</body>
</html>`);
    preview.document.close();

    preview.document.getElementById('p75ExcelClose').onclick=()=>preview.close();

    preview.document.getElementById('p75ExcelDownload').onclick=()=>{
      const btn=preview.document.getElementById('p75ExcelDownload');
      btn.textContent='Descargando...';
      btn.disabled=true;

      // Descarga directa desde el servidor.
      // Evita fetch/blob dentro de about:blank, que era el punto que fallaba.
      const frame=preview.document.createElement('iframe');
      frame.style.display='none';
      frame.src=downloadUrl;
      preview.document.body.appendChild(frame);

      setTimeout(()=>{
        btn.textContent='Descargar Excel dinámico';
        btn.disabled=false;
      },2500);
    };

    try{preview.focus()}catch{}
  }catch(err){
    preview.document.open();
    preview.document.write(`<h2 style="font-family:Arial;padding:30px">Error: ${String(err.message||err)}</h2>`);
    preview.document.close();
  }
}
// P7.2:
// CAPTURA EN WINDOW, antes que document/target.
// Así ningún handler antiguo de PDF o Excel puede ejecutarse.
// ANDON_R187_P761_EXCEL_DIRECT
window.addEventListener('click',e=>{
  const excel=e.target?.closest?.('#exportReportExcel');
  if(!excel)return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const oldLabel=excel.textContent;
  excel.disabled=true;
  excel.textContent='Generando Excel...';

  try{
    const frame=document.createElement('iframe');
    frame.style.display='none';
    frame.src='/api/r187/reports/dynamic.xlsx?'+queryString();
    document.body.appendChild(frame);

    setTimeout(()=>{
      try{frame.remove()}catch{}
    },30000);
  }catch(err){
    alert(err.message);
  }finally{
    setTimeout(()=>{
      excel.disabled=false;
      excel.textContent=oldLabel;
    },2500);
  }
},true);
window.addEventListener('click',e=>{
  const pdf=e.target?.closest?.('#exportReportPdf');
  const excel=e.target?.closest?.('#exportReportExcel');

  if(!pdf && !excel)return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if(pdf){
    // Abrir inmediatamente para evitar popup blocker.
    const preview=window.open('about:blank','_blank');
    if(!preview){
      alert('El navegador bloqueó la ventana del reporte.');
      return;
    }

    preview.document.write(
      '<div style="font-family:Arial;padding:30px;font-size:18px">Generando vista previa del reporte...</div>'
    );

    exportPdf(preview);
    return;
  }

  const preview=window.open('about:blank','_blank');
  if(!preview){
    alert('El navegador bloqueó la ventana de vista previa de Excel.');
    return;
  }

  preview.document.write(
    '<div style="font-family:Arial;padding:30px;font-size:18px">Generando vista previa de Excel...</div>'
  );

  exportExcel(preview);
},true);

console.log('[ANDON P7.5] Excel dinámico con descarga directa');

})();