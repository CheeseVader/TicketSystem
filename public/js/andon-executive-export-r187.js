(()=>{
  'use strict';

  function val(id){return document.getElementById(id)?.value||''}

  function buildUrl(){
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
    Object.entries(map).forEach(([k,id])=>{
      const v=val(id);
      if(v)q.set(k,v);
    });
    return '/api/r187/reports/executive.xlsx?'+q.toString();
  }

  document.addEventListener('click',e=>{
    const btn=e.target.closest?.('#exportReportExcel');
    if(!btn)return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    window.location.href=buildUrl();
  },true);
})();