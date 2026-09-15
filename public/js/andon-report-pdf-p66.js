(()=>{
'use strict';

function commonAncestor(nodes){
  if(!nodes.length)return null;
  let n=nodes[0];
  while(n&&n!==document.body){
    if(nodes.every(x=>n.contains(x)))return n;
    n=n.parentElement;
  }
  return null;
}

function makePrintableClone(){
  const source=document.querySelector('#view-reports');
  if(!source)throw new Error('No se encontró la vista de Reportes.');

  // Antes de clonar convertimos canvas a imágenes para conservar las gráficas.
  const originals=[...source.querySelectorAll('canvas')];
  const clone=source.cloneNode(true);
  const copies=[...clone.querySelectorAll('canvas')];

  originals.forEach((canvas,i)=>{
    try{
      const img=document.createElement('img');
      img.src=canvas.toDataURL('image/png');
      img.style.width=(canvas.getBoundingClientRect().width||canvas.width)+'px';
      img.style.maxWidth='100%';
      img.style.height='auto';
      copies[i]?.replaceWith(img);
    }catch{}
  });

  // Eliminar el panel de filtros por estructura, NO por CSS.
  const ids=['repPlant','repDept','repGroup','repCategory','repEngineer','repStatus','repFrom','repTo'];
  const originalControls=ids.map(id=>document.getElementById(id)).filter(Boolean);
  const panel=commonAncestor(originalControls);

  if(panel && panel!==source){
    // Buscar el equivalente dentro del clon por id y eliminar su ancestro equivalente.
    const clonedControls=ids.map(id=>clone.querySelector('#'+id)).filter(Boolean);
    const clonedPanel=commonAncestor(clonedControls);
    if(clonedPanel && clonedPanel!==clone)clonedPanel.remove();
  }

  // Por si el contenedor no comparte todos los controles:
  ids.forEach(id=>clone.querySelector('#'+id)?.closest('div')?.remove());

  // Nunca exportar acciones.
  clone.querySelector('#exportReportPdf')?.remove();
  clone.querySelector('#exportReportExcel')?.remove();
  clone.querySelectorAll('button').forEach(x=>x.remove());

  // Eliminar cualquier bloque que todavía sea claramente el filtro principal.
  [...clone.querySelectorAll('div,section,form')].forEach(el=>{
    const txt=String(el.innerText||'').replace(/\s+/g,' ').trim().toLowerCase();
    if(
      txt.includes('filtro principal') &&
      txt.includes('planta') &&
      txt.includes('área') &&
      txt.includes('desde') &&
      txt.includes('hasta')
    ){
      el.remove();
    }
  });

  clone.style.display='block';
  clone.style.margin='0';
  clone.style.padding='0';

  return clone;
}

function cssLinks(){
  return [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map(x=>`<link rel="stylesheet" href="${x.href}">`).join('');
}

async function exportPdf(){
  const clone=makePrintableClone();
  const w=window.open('about:blank','_blank');
  if(!w)throw new Error('El navegador bloqueó la ventana del reporte.');

  const generated=new Date().toLocaleString('es-MX');

  w.document.open();
  w.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ANDON Support · Reporte Ejecutivo</title>
${cssLinks()}
<style>
  html,body{margin:0;padding:0;background:#fff!important}
  body{padding:22px;font-family:Arial,Helvetica,sans-serif}
  .p66-print-head{margin:0 0 18px}
  .p66-print-head h1{margin:0 0 8px;font-size:30px;color:#111}
  .p66-print-head div{font-size:14px;color:#333}
  nav,aside,.sidebar,.topbar,.app-sidebar{display:none!important}
  #view-reports{display:block!important;margin:0!important;padding:0!important}
  #view-reports select,#view-reports input,#view-reports button{display:none!important}
  @page{size:landscape;margin:8mm}
  @media print{
    body{padding:0}
    .p66-no-print{display:none!important}
    *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
  }
</style>
</head>
<body>
  <div class="p66-print-head">
    <h1>ANDON Support · Reporte Ejecutivo</h1>
    <div>Generado: ${generated}</div>
  </div>
  ${clone.outerHTML}
</body>
</html>`);
  w.document.close();

  setTimeout(()=>{
    try{w.focus();w.print()}catch{}
  },900);
}

document.addEventListener('click',e=>{
  const btn=e.target.closest?.('#exportReportPdf');
  if(!btn)return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  exportPdf().catch(err=>alert(err.message));
},true);

})();