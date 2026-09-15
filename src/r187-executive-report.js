'use strict';

const ExcelJS=require('exceljs');
const sharp=require('sharp');

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'
}[c]));

const n=v=>Number.isFinite(Number(v))?Number(v):0;
const pct=(a,b)=>b?Math.round(a*1000/b)/10:0;
const avg=a=>a.length?a.reduce((s,x)=>s+n(x),0)/a.length:0;
const status=x=>String(x.status||'unassigned').toLowerCase();
const terminal=s=>['resolved','closed','cancelled'].includes(String(s||'').toLowerCase());
const completed=s=>['resolved','closed'].includes(String(s||'').toLowerCase());
const fmtMin=m=>{
  m=n(m);if(!m)return '0 min';
  if(m<60)return `${Math.round(m)} min`;
  return `${Math.floor(m/60)} h ${Math.round(m%60)} min`;
};
const group=(rows,fn)=>{
  const m=new Map();
  rows.forEach(r=>{const k=String(fn(r)||'Sin dato');m.set(k,(m.get(k)||0)+1)});
  return [...m.entries()].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value);
};

function linePath(values,x,y,w,h){
  if(!values.length)return '';
  const max=Math.max(1,...values.map(v=>n(v.value)));
  return values.map((v,i)=>{
    const px=values.length===1?x+w/2:x+(w*i/(values.length-1));
    const py=y+h-(h*n(v.value)/max);
    return `${i?'L':'M'} ${px.toFixed(1)} ${py.toFixed(1)}`;
  }).join(' ');
}

function bars(values,x,y,w,h,color,maxItems=6){
  const v=values.slice(0,maxItems);
  if(!v.length)return '';
  const max=Math.max(1,...v.map(a=>n(a.value)));
  const row=h/v.length;
  return v.map((a,i)=>{
    const bw=(w-170)*n(a.value)/max;
    const yy=y+i*row;
    return `
      <text x="${x}" y="${yy+row*.58}" fill="#BBD0E1" font-size="15">${esc(a.label).slice(0,24)}</text>
      <rect x="${x+170}" y="${yy+row*.22}" width="${Math.max(2,bw)}" height="${row*.48}" rx="4" fill="${color}"/>
      <text x="${x+180+bw}" y="${yy+row*.58}" fill="#FFFFFF" font-size="14" font-weight="700">${a.value}</text>
    `;
  }).join('');
}

function dashboardSvg(data){
  const {
    from,to,total,closed,backlog,mtta,mttr,slaR,slaZ,
    trend,byCat,byGroup,byDept,byTech
  }=data;

  const W=1500,H=1120;
  const line=linePath(trend.slice(-10),70,430,1360,220);
  const maxTrend=Math.max(1,...trend.slice(-10).map(x=>n(x.value)));
  const pts=trend.slice(-10).map((v,i)=>{
    const x=trend.slice(-10).length===1?750:70+(1360*i/(trend.slice(-10).length-1));
    const y=430+220-(220*n(v.value)/maxTrend);
    return `<circle cx="${x}" cy="${y}" r="5" fill="#35D39A"/>`;
  }).join('');

  const dates=trend.slice(-10).map((v,i)=>{
    const x=trend.slice(-10).length===1?750:70+(1360*i/(trend.slice(-10).length-1));
    return `<text x="${x}" y="680" text-anchor="middle" fill="#86A9C5" font-size="13">${esc(String(v.label).slice(5))}</text>`;
  }).join('');

  const slaColor=v=>v>=90?'#35D39A':'#FF5261';

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#07131D"/>
  <text x="45" y="55" fill="#FFFFFF" font-family="Arial" font-size="34" font-weight="700">ANDON Support · Reporte Ejecutivo</text>
  <text x="45" y="88" fill="#9DB8CE" font-family="Arial" font-size="16">Periodo ${esc(from)} a ${esc(to)}</text>

  ${[
    ['Tickets creados',total,'100% del total','#17365D'],
    ['Tickets cerrados',closed,`${pct(closed,total)}% del total`,'#17365D'],
    ['Tiempo prom. respuesta',mtta,'Tiempo hasta asignación','#17365D'],
    ['Tiempo prom. resolución',mttr,'Tiempo efectivo de resolución','#17365D'],
    ['SLA respuesta',`${slaR}%`,'Cumplimiento del periodo','#17365D'],
    ['SLA resolución',`${slaZ}%`,'Cumplimiento del periodo','#17365D']
  ].map((k,i)=>{
    const col=i%3,row=Math.floor(i/3),x=45+col*475,y=120+row*145;
    const valueColor=i>=4?slaColor(i===4?slaR:slaZ):'#FFFFFF';
    return `
      <rect x="${x}" y="${y}" width="445" height="120" rx="18" fill="#132637" stroke="#294A63"/>
      <text x="${x+22}" y="${y+30}" fill="#9CC1DD" font-family="Arial" font-size="15">${esc(k[0])}</text>
      <text x="${x+22}" y="${y+74}" fill="${valueColor}" font-family="Arial" font-size="38" font-weight="700">${esc(k[1])}</text>
      <text x="${x+22}" y="${y+102}" fill="#8CB5D2" font-family="Arial" font-size="13">${esc(k[2])}</text>
    `;
  }).join('')}

  <rect x="45" y="405" width="1410" height="310" rx="18" fill="#132637" stroke="#294A63"/>
  <text x="65" y="445" fill="#FFFFFF" font-family="Arial" font-size="20" font-weight="700">Tickets por día</text>
  ${[0,1,2,3,4].map(i=>{
    const yy=470+i*48;
    return `<line x1="70" y1="${yy}" x2="1430" y2="${yy}" stroke="#294A63" stroke-dasharray="5 7"/>`;
  }).join('')}
  <path d="${line}" fill="none" stroke="#35D39A" stroke-width="5"/>
  ${pts}
  ${dates}

  <rect x="45" y="740" width="685" height="330" rx="18" fill="#132637" stroke="#294A63"/>
  <text x="65" y="780" fill="#FFFFFF" font-family="Arial" font-size="20" font-weight="700">Top incidencias</text>
  ${bars(byCat,70,805,620,225,'#2F80ED',6)}

  <rect x="770" y="740" width="685" height="330" rx="18" fill="#132637" stroke="#294A63"/>
  <text x="790" y="780" fill="#FFFFFF" font-family="Arial" font-size="20" font-weight="700">Carga por técnico</text>
  ${bars(byTech,795,805,620,225,'#35D39A',6)}
</svg>`;
}

function tableHeader(row){
  row.eachCell(c=>{
    c.font={bold:true,color:{argb:'FFFFFF'}};
    c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'15324B'}};
  });
}

module.exports=function(app,pool,requireAuth){
  app.get('/api/r187/reports/executive.xlsx',requireAuth,async(req,res)=>{
    try{
      const params=[],where=[];
      const add=(expr,v)=>{params.push(v);where.push(expr.replace('?',`$${params.length}`))};
      const now=new Date();
      const from=String(req.query.from||new Date(now-30*86400000).toISOString().slice(0,10)).slice(0,10);
      const to=String(req.query.to||now.toISOString().slice(0,10)).slice(0,10);

      add('r.requested_at >= ?::date',from);
      add("r.requested_at < (?::date + interval '1 day')",to);
      if(req.query.department)add('r.department=?',String(req.query.department));
      if(req.query.group)add("COALESCE(t.group_name,r.requester_area,'Administrativo')=?",String(req.query.group));
      if(req.query.category)add('r.category=?',String(req.query.category));
      if(req.query.engineer)add('t.assigned_to=?::int',Number(req.query.engineer));
      if(req.query.status)add('COALESCE(t.status,r.status)=?',String(req.query.status));

      const {rows}=await pool.query(`
        SELECT
          r.id request_id,r.requested_at,r.requested_by,r.requester_area,r.support_location,
          r.source,r.department,r.category,r.notes,
          COALESCE(t.status,r.status) status,
          t.id ticket_id,t.ticket_number,t.assigned_at,t.resolved_at,t.closed_at,
          t.response_due_at,t.resolution_due_at,t.total_wait_seconds,
          COALESCE(t.group_name,r.requester_area,'Administrativo') group_name,
          COALESCE(t.station_code,CASE WHEN r.source='administrative' THEN 'SOPORTE-'||r.id::text ELSE '—' END) station_code,
          COALESCE(t.station_name,r.support_location,'—') station_name,
          COALESCE(t.category_label,ac.label,c.label,r.category) category_label,
          u.id technician_id,COALESCE(u.full_name,u.username,'Sin asignar') technician
        FROM support_requests r
        LEFT JOIN tickets t ON t.request_id=r.id
        LEFT JOIN users u ON u.id=t.assigned_to
        LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category
        LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category
        WHERE ${where.join(' AND ')}
        ORDER BY r.requested_at
      `,params);

      const total=rows.length;
      const closed=rows.filter(x=>completed(status(x))).length;
      const backlog=rows.filter(x=>!terminal(status(x))).length;

      const resp=rows.filter(x=>x.assigned_at&&x.requested_at);
      const respMins=resp.map(x=>(new Date(x.assigned_at)-new Date(x.requested_at))/60000);
      const resol=rows.filter(x=>x.resolved_at&&x.requested_at);
      const resolMins=resol.map(x=>Math.max(0,(new Date(x.resolved_at)-new Date(x.requested_at))/60000-n(x.total_wait_seconds)/60));

      const sr=rows.filter(x=>x.assigned_at&&x.response_due_at);
      const sz=rows.filter(x=>x.resolved_at&&x.resolution_due_at);
      const slaR=pct(sr.filter(x=>new Date(x.assigned_at)<=new Date(x.response_due_at)).length,sr.length);
      const slaZ=pct(sz.filter(x=>new Date(x.resolved_at)<=new Date(x.resolution_due_at)).length,sz.length);

      const byCat=group(rows,x=>x.category_label||x.category);
      const byGroup=group(rows,x=>x.group_name);
      const byDept=group(rows,x=>x.department);
      const byTech=group(rows.filter(x=>x.technician_id),x=>x.technician);

      const dm=new Map();
      rows.forEach(x=>{
        const d=new Date(x.requested_at);
        const k=Number.isNaN(d.getTime())?'Sin fecha':d.toISOString().slice(0,10);
        const v=dm.get(k)||{created:0,closed:0};
        v.created++;
        if(completed(status(x)))v.closed++;
        dm.set(k,v);
      });
      const trend=[...dm].sort((a,b)=>a[0].localeCompare(b[0])).map(([label,v])=>({label,value:v.created,closed:v.closed}));

      const svg=dashboardSvg({
        from,to,total,closed,backlog,
        mtta:fmtMin(avg(respMins)),
        mttr:fmtMin(avg(resolMins)),
        slaR,slaZ,trend,byCat,byGroup,byDept,byTech
      });
      const png=await sharp(Buffer.from(svg)).png().toBuffer();

      const wb=new ExcelJS.Workbook();
      wb.creator='ANDON Support';
      wb.title='ANDON Support · Reporte Ejecutivo';

      const ws=wb.addWorksheet('Reporte Ejecutivo');
      ws.views=[{showGridLines:false}];
      for(let i=1;i<=18;i++)ws.getColumn(i).width=11;
      for(let i=1;i<=58;i++)ws.getRow(i).height=20;
      ws.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:1};
      ws.sheetProperties.pageSetUpPr={fitToPage:true};
      ws.pageSetup.printArea='A1:R58';

      const imageId=wb.addImage({buffer:png,extension:'png'});
      ws.addImage(imageId,{tl:{col:0,row:0},ext:{width:1500,height:1120}});

      const det=wb.addWorksheet('Tickets');
      det.views=[{state:'frozen',ySplit:1,showGridLines:false}];
      const headers=[
        'Folio','Solicitud','Fecha','Solicitante','Área / Departamento','Ubicación',
        'Área soporte','Grupo / Línea','Equipo','Categoría','Técnico','Estado',
        'Asignado','Resuelto','SLA respuesta','SLA resolución'
      ];
      det.addRow(headers);tableHeader(det.getRow(1));
      rows.forEach(x=>{
        const rs=x.assigned_at&&x.response_due_at?(new Date(x.assigned_at)<=new Date(x.response_due_at)?'Cumple':'Vencido'):'—';
        const rz=x.resolved_at&&x.resolution_due_at?(new Date(x.resolved_at)<=new Date(x.resolution_due_at)?'Cumple':'Vencido'):'—';
        det.addRow([
          x.ticket_number||'Sin asignar',x.request_id,x.requested_at,x.requested_by||'—',
          x.requester_area||'—',x.support_location||x.station_name||'—',
          String(x.department||'').toLowerCase()==='systems'?'Sistemas':
            String(x.department||'').toLowerCase()==='maintenance'?'Mantenimiento':x.department,
          x.group_name,x.station_code,x.category_label,x.technician,status(x),
          x.assigned_at||'',x.resolved_at||'',rs,rz
        ]);
      });
      [16,12,20,24,24,24,18,22,18,26,24,16,20,20,18,18]
        .forEach((w,i)=>det.getColumn(i+1).width=w);

      const raw=wb.addWorksheet('Datos');
      raw.views=[{state:'frozen',ySplit:1,showGridLines:false}];
      const rawHeaders=[
        'request_id','ticket_id','ticket_number','requested_at','requested_by','requester_area',
        'support_location','source','department','group_name','station_code','station_name',
        'category','category_label','technician','status','assigned_at','resolved_at',
        'closed_at','response_due_at','resolution_due_at','total_wait_seconds','notes'
      ];
      raw.addRow(rawHeaders);tableHeader(raw.getRow(1));
      rows.forEach(x=>raw.addRow(rawHeaders.map(h=>x[h]??'')));
      rawHeaders.forEach((_,i)=>raw.getColumn(i+1).width=i===22?40:18);

      const buf=await wb.xlsx.writeBuffer();
      const name=`ANDON_REPORTE_EJECUTIVO_${from}_${to}.xlsx`;
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
      res.setHeader('Cache-Control','no-store');
      res.end(Buffer.from(buf));
    }catch(e){
      console.error('P6.6 executive xlsx',e);
      res.status(500).json({error:'No se pudo generar el reporte ejecutivo.',detail:e.message});
    }
  });
};