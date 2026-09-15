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
function markFilterPanel(){
  document.querySelectorAll('.p65-print-hide').forEach(x=>x.classList.remove('p65-print-hide'));

  const ids=['repPlant','repDept','repGroup','repCategory','repEngineer','repStatus','repFrom','repTo'];
  const controls=ids.map(id=>document.getElementById(id)).filter(Boolean);
  let panel=commonAncestor(controls);

  // Evita marcar toda la vista de reportes.
  if(panel){
    while(panel.parentElement &&
          panel.parentElement.id!=='view-reports' &&
          panel.getBoundingClientRect().height<70){
      panel=panel.parentElement;
    }
    if(panel.id!=='view-reports')panel.classList.add('p65-print-hide');
  }

  // También elimina acciones/exportadores.
  ['exportReportPdf','exportReportExcel'].forEach(id=>{
    const x=document.getElementById(id);
    if(x)x.closest('div')?.classList.add('p65-print-hide');
  });

  document.querySelectorAll('#view-reports select,#view-reports input[type="date"]').forEach(x=>{
    let p=x.parentElement;
    for(let i=0;p&&i<4;i++,p=p.parentElement){
      const txt=(p.innerText||'').toLowerCase();
      if(txt.includes('filtro principal')||txt.includes('planta')||txt.includes('desde')||txt.includes('hasta')){
        p.classList.add('p65-print-hide');
      }
    }
  });
}
window.addEventListener('beforeprint',markFilterPanel);
document.addEventListener('DOMContentLoaded',markFilterPanel);
setTimeout(markFilterPanel,1200);
})();