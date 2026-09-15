'use strict';

const fs=require('fs');
const os=require('os');
const path=require('path');
const JSZip=require('jszip');

const str=v=>v===undefined||v===null?'':String(v);
const date=v=>{
  if(!v)return '';
  const d=new Date(v);
  return Number.isNaN(d.getTime())?'':d;
};
const uniq=(rows,key)=>[...new Set(rows.map(r=>str(r[key])).filter(Boolean))]
  .sort((a,b)=>a.localeCompare(b,'es',{sensitivity:'base'}));

async function addDynamicChartLabels(inputBytes){
  const zip=await JSZip.loadAsync(Buffer.from(inputBytes));

  const chartNames=Object.keys(zip.files)
    .filter(n=>/^xl\/charts\/chart\d+\.xml$/i.test(n));

  let patched=0;

  for(const name of chartNames){
    const file=zip.file(name);
    if(!file)continue;

    let xml=await file.async('string');

    // Aplicar a graficas tipo bar/column.
    if(!/<c:barChart\b/i.test(xml))continue;

    // Evitar duplicar si ya existe dLbls.
    if(/<c:dLbls\b/i.test(xml))continue;

    const labels=
      '<c:dLbls>'+
        '<c:numFmt formatCode="0;-0;;" sourceLinked="0"/>'+
        '<c:dLblPos val="outEnd"/>'+
        '<c:showLegendKey val="0"/>'+
        '<c:showVal val="1"/>'+
        '<c:showCatName val="0"/>'+
        '<c:showSerName val="0"/>'+
        '<c:showPercent val="0"/>'+
        '<c:showBubbleSize val="0"/>'+
        '<c:showLeaderLines val="0"/>'+
      '</c:dLbls>';

    // dLbls va dentro de c:barChart. Insertarlo antes del primer axId.
    const before=xml;
    xml=xml.replace(/(<c:axId\b)/i,labels+'$1');

    if(xml!==before){
      zip.file(name,xml);
      patched++;
    }
  }

  const out=await zip.generateAsync({
    type:'nodebuffer',
    compression:'DEFLATE',
    compressionOptions:{level:6}
  });

  return {buffer:out,patched};
}
async function forceExcelAutoCalc(inputBytes){
  const zip=await JSZip.loadAsync(Buffer.from(inputBytes));

  const wbFile=zip.file('xl/workbook.xml');
  if(!wbFile)throw new Error('XLSX sin xl/workbook.xml');

  let xml=await wbFile.async('string');

  // Excel debe recalcular TODAS las formulas al abrir y despues de cualquier cambio.
  const calcPr='<calcPr calcId="191029" calcMode="auto" calcOnSave="1" fullCalcOnLoad="1" forceFullCalc="1"/>';

  if(/<calcPr\b[^>]*\/>/i.test(xml)){
    xml=xml.replace(/<calcPr\b[^>]*\/>/i,calcPr);
  }else if(/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/i.test(xml)){
    xml=xml.replace(/<calcPr\b[^>]*>[\s\S]*?<\/calcPr>/i,calcPr);
  }else{
    xml=xml.replace(/<\/workbook>\s*$/i,calcPr+'</workbook>');
  }

  zip.file('xl/workbook.xml',xml);

  // calcChain puede contener dependencias viejas. Excel la reconstruirá.
  if(zip.file('xl/calcChain.xml')){
    zip.remove('xl/calcChain.xml');

    const rel=zip.file('xl/_rels/workbook.xml.rels');
    if(rel){
      let relXml=await rel.async('string');
      relXml=relXml.replace(
        /<Relationship\b[^>]*Type="[^"]*calcChain"[^>]*\/>/gi,
        ''
      );
      zip.file('xl/_rels/workbook.xml.rels',relXml);
    }

    const ct=zip.file('[Content_Types].xml');
    if(ct){
      let ctXml=await ct.async('string');
      ctXml=ctXml.replace(
        /<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/gi,
        ''
      );
      zip.file('[Content_Types].xml',ctXml);
    }
  }

  return await zip.generateAsync({
    type:'nodebuffer',
    compression:'DEFLATE',
    compressionOptions:{level:6}
  });
}
async function makeWorkbook(rows,opts={}){
  const {createWorkbook}=await import('@entree_pos/xlsx');

  const from=str(opts.from||'');
  const to=str(opts.to||'');

  const wb=createWorkbook('Reporte Ejecutivo');
  const dash=wb.sheet('Reporte Ejecutivo');
  const tickets=wb.addSheet('Tickets');
  const data=wb.addSheet('Datos');
  const filters=wb.addSheet('Filtros');
  const model=wb.addSheet('Modelo');

  const headers=[
    'request_id','ticket_id','ticket_number','requested_at','requested_by',
    'requester_area','support_location','source','department','group_name',
    'station_code','station_name','category','category_label','technician',
    'status','assigned_at','resolved_at','closed_at','response_due_at',
    'resolution_due_at','total_wait_seconds','notes',
    'response_minutes','resolution_minutes','sla_response_met',
    'sla_resolution_met','date_only','match'
  ];

  const values=[headers];
  rows.forEach(r=>values.push([
    r.request_id,r.ticket_id||'',r.ticket_number||'',date(r.requested_at),
    r.requested_by||'',r.requester_area||'',r.support_location||'',
    r.source||'',r.department||'',r.group_name||'',r.station_code||'',
    r.station_name||'',r.category||'',r.category_label||r.category||'',
    r.technician||'Sin asignar',r.status||'',date(r.assigned_at),
    date(r.resolved_at),date(r.closed_at),date(r.response_due_at),
    date(r.resolution_due_at),Number(r.total_wait_seconds||0),r.notes||'',
    '','','','','',''
  ]));

  // espacio para edición manual posterior
  for(let i=0;i<150;i++)values.push(new Array(headers.length).fill(''));

  data.range(`A1:AC${values.length}`).setValues(values);
  data.range('A1:AC1').style({bold:true,color:'#FFFFFF',fill:'#15324B'});
  data.range(`D2:D${values.length}`).style({numberFormat:'yyyy-mm-dd hh:mm'});
  data.range(`Q2:U${values.length}`).style({numberFormat:'yyyy-mm-dd hh:mm'});

  for(let r=2;r<=values.length;r++){
    data.cell(`X${r}`).formula(`IF(OR(D${r}="",Q${r}=""),"",MAX(0,(Q${r}-D${r})*1440))`);
    data.cell(`Y${r}`).formula(`IF(OR(D${r}="",R${r}=""),"",MAX(0,(R${r}-D${r})*1440-N(V${r})/60))`);
    data.cell(`Z${r}`).formula(`IF(OR(Q${r}="",T${r}=""),"",--(Q${r}<=T${r}))`);
    data.cell(`AA${r}`).formula(`IF(OR(R${r}="",U${r}=""),"",--(R${r}<=U${r}))`);
    data.cell(`AB${r}`).formula(`IF(D${r}="","",INT(D${r}))`);
    data.cell(`AC${r}`).formula(
      `--AND(A${r}<>"",`+
      `OR(Filtros!$B$4="Todos",F${r}=Filtros!$B$4),`+
      `OR(Filtros!$B$5="Todos",I${r}=Filtros!$B$5),`+
      `OR(Filtros!$B$6="Todos",J${r}=Filtros!$B$6),`+
      `OR(Filtros!$B$7="Todos",N${r}=Filtros!$B$7),`+
      `OR(Filtros!$B$8="Todos",O${r}=Filtros!$B$8),`+
      `OR(Filtros!$B$9="Todos",P${r}=Filtros!$B$9),`+
      `OR(Filtros!$B$10="",AB${r}>=Filtros!$B$10),`+
      `OR(Filtros!$B$11="",AB${r}<=Filtros!$B$11))`
    );
  }

  data.autoFilter();
  data.autoFit({min:8,max:28,padding:1});

  // filtros editables
  filters.range('A1:F1').merge();
  filters.set('A1','FILTROS DE ANÁLISIS');
  filters.range('A1:F1').style({bold:true,color:'#FFFFFF',fill:'#15324B',horizontal:'center'});
  filters.range('A3:B11').setValues([
    ['Filtro','Valor'],
    ['Área / Departamento solicitante','Todos'],
    ['Área de soporte','Todos'],
    ['Grupo / Línea','Todos'],
    ['Categoría','Todos'],
    ['Usuario / Técnico','Todos'],
    ['Estado','Todos'],
    ['Desde',from?new Date(from+'T00:00:00'):''],
    ['Hasta',to?new Date(to+'T00:00:00'):'']
  ]);
  filters.range('A3:B3').style({bold:true,color:'#FFFFFF',fill:'#2F80ED'});
  filters.range('A4:A11').style({bold:true,fill:'#EAF3FE'});
  filters.range('B10:B11').style({numberFormat:'yyyy-mm-dd'});

  const lists=[
    ['Área / Departamento',uniq(rows,'requester_area')],
    ['Área soporte',uniq(rows,'department')],
    ['Grupo / Línea',uniq(rows,'group_name')],
    ['Categoría',[...new Set(rows.map(r=>r.category_label||r.category).filter(Boolean))].sort()],
    ['Técnico',uniq(rows,'technician')],
    ['Estado',uniq(rows,'status')]
  ];
  lists.forEach((x,i)=>{
    const col=String.fromCharCode(68+i);
    filters.set(`${col}3`,x[0]);
    filters.cell(`${col}3`).style({bold:true,color:'#FFFFFF',fill:'#2F80ED'});
    filters.set(`${col}4`,'Todos');
    x[1].forEach((v,j)=>filters.set(`${col}${5+j}`,v));
  });
  filters.autoFit({min:12,max:34,padding:1});

  // tickets
  const th=[
    'Folio','Solicitud','Fecha','Solicitante','Área / Departamento','Ubicación',
    'Área soporte','Grupo / Línea','Equipo','Categoría','Técnico','Estado',
    'Asignado','Resuelto','SLA respuesta','SLA resolución'
  ];
  const tv=[th];
  rows.forEach(r=>{
    const a=date(r.assigned_at),z=date(r.resolved_at),rd=date(r.response_due_at),zd=date(r.resolution_due_at);
    tv.push([
      r.ticket_number||'Sin asignar',r.request_id,date(r.requested_at),
      r.requested_by||'—',r.requester_area||'—',r.support_location||r.station_name||'—',
      r.department||'—',r.group_name||'—',r.station_code||'—',
      r.category_label||r.category||'—',r.technician||'Sin asignar',r.status||'—',
      a,z,a&&rd?(a<=rd?'Cumple':'Vencido'):'—',z&&zd?(z<=zd?'Cumple':'Vencido'):'—'
    ]);
  });
  tickets.range(`A1:P${tv.length}`).setValues(tv);
  tickets.range('A1:P1').style({bold:true,color:'#FFFFFF',fill:'#15324B'});
  tickets.autoFilter();
  tickets.autoFit({min:10,max:30,padding:1});

  const end=values.length;

  // modelo de tendencia
  model.range('A1:C1').setValues([['Fecha','Creados','Cerrados']]);
  model.range('A1:C1').style({bold:true,color:'#FFFFFF',fill:'#15324B'});

  const fDate=from?new Date(from+'T00:00:00'):new Date();
  const tDate=to?new Date(to+'T00:00:00'):new Date();
  const days=Math.max(1,Math.min(120,Math.round((tDate-fDate)/86400000)+1));

  for(let i=0;i<days;i++){
    const rr=2+i;
    model.set(`A${rr}`,new Date(fDate.getTime()+i*86400000));
    model.cell(`B${rr}`).formula(`SUMIFS(Datos!$AC$2:$AC$${end},Datos!$AB$2:$AB$${end},A${rr})`);
    model.cell(`C${rr}`).formula(
      `SUMIFS(Datos!$AC$2:$AC$${end},Datos!$AB$2:$AB$${end},A${rr},Datos!$P$2:$P$${end},"resolved")+`+
      `SUMIFS(Datos!$AC$2:$AC$${end},Datos!$AB$2:$AB$${end},A${rr},Datos!$P$2:$P$${end},"closed")`
    );
  }
  model.range(`A2:A${days+1}`).style({numberFormat:'dd/mm'});

  model.range('E1:F3').setValues([['Indicador','Cumplimiento'],['Respuesta',''],['Resolución','']]);
  model.range('E1:F1').style({bold:true,color:'#FFFFFF',fill:'#15324B'});
  model.cell('F2').formula(
    `IFERROR(SUMPRODUCT(Datos!$AC$2:$AC$${end},N(Datos!$Z$2:$Z$${end}))/SUMPRODUCT(Datos!$AC$2:$AC$${end},--(Datos!$Z$2:$Z$${end}<>"")),0)`
  );
  model.cell('F3').formula(
    `IFERROR(SUMPRODUCT(Datos!$AC$2:$AC$${end},N(Datos!$AA$2:$AA$${end}))/SUMPRODUCT(Datos!$AC$2:$AC$${end},--(Datos!$AA$2:$AA$${end}<>"")),0)`
  );
  model.range('F2:F3').style({numberFormat:'0%'});

  const categories=[...new Set(rows.map(r=>r.category_label||r.category).filter(Boolean))].sort();
  model.range('H1:I1').setValues([['Categoría','Cantidad']]);
  categories.forEach((v,i)=>{
    const rr=2+i;
    model.set(`H${rr}`,v);
    model.cell(`I${rr}`).formula(`SUMIFS(Datos!$AC$2:$AC$${end},Datos!$N$2:$N$${end},H${rr})`);
  });

  const groups=uniq(rows,'group_name');
  model.range('K1:L1').setValues([['Grupo / Línea','Cantidad']]);
  groups.forEach((v,i)=>{
    const rr=2+i;
    model.set(`K${rr}`,v);
    model.cell(`L${rr}`).formula(`SUMIFS(Datos!$AC$2:$AC$${end},Datos!$J$2:$J$${end},K${rr})`);
  });

  const areas=uniq(rows,'requester_area');
  model.range('N1:O1').setValues([['Área','Cantidad']]);
  areas.forEach((v,i)=>{
    const rr=2+i;
    model.set(`N${rr}`,v);
    model.cell(`O${rr}`).formula(`SUMIFS(Datos!$AC$2:$AC$${end},Datos!$F$2:$F$${end},N${rr})`);
  });

  // dashboard
  dash.range('A1:L2').merge();
  dash.set('A1','ANDON Support · Reporte Ejecutivo Dinámico');
  dash.range('A1:L2').style({bold:true,color:'#FFFFFF',fill:'#07131D',fontSize:22});
  dash.range('A3:L3').merge();
  dash.set('A3','Cambia criterios en la pestaña Filtros. Excel recalcula KPIs y gráficas.');
  dash.range('A3:L3').style({color:'#9DB8CE',fill:'#07131D'});

  const cards=[
    ['A4:B4','A5:B8','Tickets creados',`SUM(Datos!$AC$2:$AC$${end})`,'0'],
    ['C4:D4','C5:D8','Tickets cerrados',`SUMIFS(Datos!$AC$2:$AC$${end},Datos!$P$2:$P$${end},"resolved")+SUMIFS(Datos!$AC$2:$AC$${end},Datos!$P$2:$P$${end},"closed")`,'0'],
    ['E4:F4','E5:F8','MTTA (min)',`IFERROR(SUMPRODUCT(Datos!$AC$2:$AC$${end},N(Datos!$X$2:$X$${end}))/SUMPRODUCT(Datos!$AC$2:$AC$${end},--(Datos!$X$2:$X$${end}<>"")),0)`,'0.0'],
    ['G4:H4','G5:H8','MTTR (min)',`IFERROR(SUMPRODUCT(Datos!$AC$2:$AC$${end},N(Datos!$Y$2:$Y$${end}))/SUMPRODUCT(Datos!$AC$2:$AC$${end},--(Datos!$Y$2:$Y$${end}<>"")),0)`,'0.0'],
    ['I4:J4','I5:J8','SLA respuesta','Modelo!$F$2','0%'],
    ['K4:L4','K5:L8','SLA resolución','Modelo!$F$3','0%']
  ];

  cards.forEach(([lr,vr,label,formula,fmt],i)=>{
    dash.range(lr).merge();
    dash.set(lr.split(':')[0],label);
    dash.range(lr).style({fill:'#132637',color:'#9CC1DD',bold:true,horizontal:'center'});
    dash.range(vr).merge();
    const cell=vr.split(':')[0];
    dash.cell(cell).formula(formula);
    dash.cell(cell).style({
      fill:'#132637',color:i>=4?'#FF5261':'#FFFFFF',
      bold:true,fontSize:20,horizontal:'center',vertical:'center',numberFormat:fmt
    });
  });

  // ANDON_R187_P751_LOCAL_CHART_SOURCES
  // @entree_pos/xlsx espera que chart.range sea un rango LOCAL de la hoja
  // indicada por chart.sheet. Por eso espejamos Modelo en filas 80+ del
  // propio Reporte Ejecutivo. Las celdas siguen siendo formulas dinamicas.

  dash.range('A80:C80').setValues([['Fecha','Creados','Cerrados']]);
  for(let i=0;i<days;i++){
    const srcRow=2+i;
    const dstRow=81+i;
    dash.cell(`A${dstRow}`).formula(`Modelo!A${srcRow}`);
    dash.cell(`B${dstRow}`).formula(`Modelo!B${srcRow}`);
    dash.cell(`C${dstRow}`).formula(`Modelo!C${srcRow}`);
  }
  if(days>0)dash.range(`A81:A${80+days}`).style({numberFormat:'dd/mm'});

  dash.range('E80:F82').setValues([
    ['Indicador','Cumplimiento'],
    ['Respuesta',''],
    ['Resolucion','']
  ]);
  dash.cell('F81').formula('Modelo!F2');
  dash.cell('F82').formula('Modelo!F3');
  dash.range('F81:F82').style({numberFormat:'0%'});

  dash.range('H80:I80').setValues([['Categoria','Cantidad']]);
  categories.forEach((v,i)=>{
    const srcRow=2+i;
    const dstRow=81+i;
    dash.set(`H${dstRow}`,v);
    dash.cell(`I${dstRow}`).formula(`Modelo!I${srcRow}`);
  });

  dash.range('K80:L80').setValues([['Grupo / Linea','Cantidad']]);
  groups.forEach((v,i)=>{
    const srcRow=2+i;
    const dstRow=81+i;
    dash.set(`K${dstRow}`,v);
    dash.cell(`L${dstRow}`).formula(`Modelo!L${srcRow}`);
  });

  dash.range('N80:O80').setValues([['Area','Cantidad']]);
  areas.forEach((v,i)=>{
    const srcRow=2+i;
    const dstRow=81+i;
    dash.set(`N${dstRow}`,v);
    dash.cell(`O${dstRow}`).formula(`Modelo!O${srcRow}`);
  });
  wb.charts.add({
    sheet:'Reporte Ejecutivo',name:'TicketsDia',type:'line',
    title:'Tickets por día',range:`A80:C${80+days}`,
    position:{from:'A10',to:'H25'}
  });

  wb.charts.add({
    sheet:'Reporte Ejecutivo',name:'SLA',type:'column',
    title:'Cumplimiento SLA',range:'E80:F82',
    position:{from:'I10',to:'L25'}
  });

  if(categories.length){
    wb.charts.add({
      sheet:'Reporte Ejecutivo',name:'TopIncidencias',type:'bar',
      title:'Top incidencias',range:`H80:I${80+categories.length}`,
      position:{from:'A27',to:'D44'}
    });
  }
  if(groups.length){
    wb.charts.add({
      sheet:'Reporte Ejecutivo',name:'GrupoLinea',type:'bar',
      title:'Tickets por grupo / línea',range:`K80:L${80+groups.length}`,
      position:{from:'E27',to:'H44'}
    });
  }
  if(areas.length){
    wb.charts.add({
      sheet:'Reporte Ejecutivo',name:'Areas',type:'bar',
      title:'Tickets por área',range:`N80:O${80+areas.length}`,
      position:{from:'I27',to:'L44'}
    });
  }

  'ABCDEFGHIJKL'.split('').forEach(c=>dash.column(c).width(14));

  return wb;
}

module.exports=function registerDynamicExcel(app,pool,requireAuth){
  app.get('/api/r187/reports/dynamic.xlsx',requireAuth,async(req,res)=>{
    try{
      const params=[];
      const where=[];
      const add=(expr,v)=>{
        params.push(v);
        where.push(expr.replace('?',`$${params.length}`));
      };

      const now=new Date();
      const from=str(req.query.from||new Date(now.getTime()-30*86400000).toISOString().slice(0,10)).slice(0,10);
      const to=str(req.query.to||now.toISOString().slice(0,10)).slice(0,10);

      add('r.requested_at >= ?::date',from);
      add("r.requested_at < (?::date + interval '1 day')",to);

      if(req.query.department)add('r.department=?',str(req.query.department));
      if(req.query.group)add("COALESCE(t.group_name,r.requester_area,'Administrativo')=?",str(req.query.group));
      if(req.query.category)add('r.category=?',str(req.query.category));
      if(req.query.engineer)add('t.assigned_to=?::int',Number(req.query.engineer));
      if(req.query.status)add('COALESCE(t.status,r.status)=?',str(req.query.status));

      const {rows}=await pool.query(`
        SELECT
          r.id request_id,r.requested_at,r.requested_by,r.requester_area,
          r.support_location,r.source,r.department,r.category,r.notes,
          COALESCE(t.status,r.status) status,t.id ticket_id,t.ticket_number,
          t.assigned_at,t.resolved_at,t.closed_at,t.response_due_at,
          t.resolution_due_at,t.total_wait_seconds,
          COALESCE(t.group_name,r.requester_area,'Administrativo') group_name,
          COALESCE(t.station_code,CASE WHEN r.source='administrative' THEN 'SOPORTE-'||r.id::text ELSE '—' END) station_code,
          COALESCE(t.station_name,r.support_location,'—') station_name,
          COALESCE(t.category_label,ac.label,c.label,r.category) category_label,
          COALESCE(u.full_name,u.username,'Sin asignar') technician
        FROM support_requests r
        LEFT JOIN tickets t ON t.request_id=r.id
        LEFT JOIN users u ON u.id=t.assigned_to
        LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category
        LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category
        WHERE ${where.join(' AND ')}
        ORDER BY r.requested_at
      `,params);

      const wb=await makeWorkbook(rows,{from,to});
      let bytes=wb.toBuffer();
      bytes=await forceExcelAutoCalc(bytes);

      const chartLabelResult=await addDynamicChartLabels(bytes);
      bytes=chartLabelResult.buffer;
      console.log('[P7.6 XLSX] charts con etiquetas:',chartLabelResult.patched);

      if(!bytes||bytes.length<1000){
        throw new Error('El motor XLSX devolvió un archivo vacío.');
      }

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="ANDON_REPORTE_DINAMICO_${from}_${to}.xlsx"`);
      res.setHeader('Cache-Control','no-store');
      res.end(Buffer.from(bytes));
    }catch(e){
      console.error('P7.5 dynamic excel',e);
      res.status(500).json({
        error:'No se pudo generar el Excel dinámico.',
        detail:e.message
      });
    }
  });
};

module.exports.makeWorkbook=makeWorkbook;