(()=>{
'use strict';

function val(id){
  return document.getElementById(id)?.value||'';
}

function buildQuery(){
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
  for(const [k,id] of Object.entries(map)){
    const v=val(id);
    if(v)q.set(k,v);
  }
  return q.toString();
}

function text(el){
  return String(el?.innerText||'').replace(/\s+/g,' ').trim().toLowerCase();
}

function findFilterPanel(){
  const title=[...document.querySelectorAll('#view-reports *')]
    .find(el=>/^filtro principal$/i.test(String(el.textContent||'').trim()));

  if(!title)return null;

  let best=null;
  for(let n=title;n&&n.id!=='view-reports';n=n.parentElement){
    const t=text(n);
    if(
      t.includes('filtro principal') &&
      t.includes('planta') &&
      t.includes('desde') &&
      t.includes('hasta')
    ){
      best=n;
    }
  }
  return best;
}

function hideForCapture(){
  const changed=[];
  const hide=el=>{
    if(!el)return;
    changed.push([el,el.style.display]);
    el.style.setProperty('display','none','important');
  };

  hide(findFilterPanel());
  hide(document.getElementById('exportReportPdf'));
  hide(document.getElementById('exportReportExcel'));

  document.querySelectorAll('#view-reports button').forEach(hide);

  return ()=>{
    for(const [el,display] of changed){
      if(display)el.style.display=display;
      else el.style.removeProperty('display');
    }
  };
}

async function saveBlob(blob,filename){
  const a=document.createElement('a');
  const url=URL.createObjectURL(blob);
  a.href=url;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}

async function exportVisualExcel(){
  const source=document.querySelector('#view-reports');
  if(!source)throw new Error('No se encontró la vista de Reportes.');
  if(typeof html2canvas!=='function')throw new Error('html2canvas no está disponible.');

  const restore=hideForCapture();

  try{
    // Esperar dos frames para que el layout se compacte sin filtros/botones.
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

    const canvas=await html2canvas(source,{
      backgroundColor:'#ffffff',
      scale:2,
      useCORS:true,
      logging:false,
      windowWidth:source.scrollWidth,
      width:source.scrollWidth,
      height:source.scrollHeight
    });

    const blob=await new Promise((resolve,reject)=>{
      canvas.toBlob(b=>b?resolve(b):reject(new Error('No se pudo generar PNG del reporte.')),'image/png',1);
    });

    const q=buildQuery();
    const response=await fetch('/api/r187/reports/executive-visual.xlsx?'+q,{
      method:'POST',
      credentials:'same-origin',
      headers:{'Content-Type':'image/png'},
      body:blob
    });

    if(!response.ok){
      let msg='No se pudo generar el Excel.';
      try{
        const d=await response.json();
        msg=d.error||d.detail||msg;
      }catch{}
      throw new Error(msg);
    }

    const xlsx=await response.blob();

    let filename='ANDON_REPORTE_EJECUTIVO.xlsx';
    const cd=response.headers.get('content-disposition')||'';
    const m=cd.match(/filename="([^"]+)"/i);
    if(m)filename=m[1];

    await saveBlob(xlsx,filename);
  }finally{
    restore();
  }
}

// Captura temprana: reemplaza cualquier exportador Excel anterior.
document.addEventListener('click',e=>{
  const btn=e.target.closest?.('#exportReportExcel');
  if(!btn)return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const old=btn.textContent;
  btn.disabled=true;
  btn.textContent='Generando Excel...';

  exportVisualExcel()
    .catch(err=>alert(err.message))
    .finally(()=>{
      btn.disabled=false;
      btn.textContent=old;
    });
},true);

})();