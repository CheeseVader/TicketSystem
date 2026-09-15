'use strict';

const ExcelJS=require('exceljs');
const sharp=require('sharp');
const express=require('express');

function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function qv(v){return v===undefined||v===null?'':String(v)}

module.exports=function registerVisualExcelP69(app,pool,requireAuth){
  app.post(
    '/api/r187/reports/executive-visual.xlsx',
    requireAuth,
    express.raw({type:'image/png',limit:'25mb'}),
    async(req,res)=>{
      try{
        if(!Buffer.isBuffer(req.body)||req.body.length<1000){
          return res.status(400).json({error:'No se recibió la imagen del reporte.'});
        }

        const meta=await sharp(req.body).metadata();
        const imgW=n(meta.width)||1600;
        const imgH=n(meta.height)||900;

        const wb=new ExcelJS.Workbook();
        wb.creator='ANDON Support';
        wb.company='ANDON Support';
        wb.title='ANDON Support · Reporte Ejecutivo';
        wb.subject='Reporte ejecutivo visual';

        const ws=wb.addWorksheet('Reporte Ejecutivo');
        ws.views=[{showGridLines:false,zoomScale:65}];
        ws.pageSetup={
          orientation:'landscape',
          fitToPage:true,
          fitToWidth:1,
          fitToHeight:1,
          paperSize:9
        };
        ws.pageMargins={left:.15,right:.15,top:.2,bottom:.2,header:.05,footer:.05};

        // La hoja se dimensiona al screenshot real, evitando el enorme espacio vacío
        // que tenían los reportes anteriores.
        const maxDisplayW=1500;
        const scale=Math.min(1,maxDisplayW/imgW);
        const displayW=Math.round(imgW*scale);
        const displayH=Math.round(imgH*scale);

        const cols=Math.max(12,Math.ceil(displayW/75));
        const rows=Math.max(30,Math.ceil(displayH/20));

        for(let c=1;c<=cols;c++)ws.getColumn(c).width=10.5;
        for(let r=1;r<=rows;r++)ws.getRow(r).height=15;

        const imageId=wb.addImage({buffer:req.body,extension:'png'});
        ws.addImage(imageId,{
          tl:{col:0,row:0},
          ext:{width:displayW,height:displayH}
        });

        ws.pageSetup.printArea=`A1:${ws.getColumn(cols).letter}${rows}`;

        // Hojas de detalle: mantienen utilidad analítica sin ensuciar el dashboard.
        const params=[];
        const where=[];
        const add=(expr,v)=>{
          params.push(v);
          where.push(expr.replace('?',`$${params.length}`));
        };

        const now=new Date();
        const from=qv(req.query.from||new Date(now-30*86400000).toISOString().slice(0,10)).slice(0,10);
        const to=qv(req.query.to||now.toISOString().slice(0,10)).slice(0,10);

        add('r.requested_at >= ?::date',from);
        add("r.requested_at < (?::date + interval '1 day')",to);

        if(req.query.department)add('r.department=?',qv(req.query.department));
        if(req.query.group)add("COALESCE(t.group_name,r.requester_area,'Administrativo')=?",qv(req.query.group));
        if(req.query.category)add('r.category=?',qv(req.query.category));
        if(req.query.engineer)add('t.assigned_to=?::int',Number(req.query.engineer));
        if(req.query.status)add('COALESCE(t.status,r.status)=?',qv(req.query.status));

        const {rows:data}=await pool.query(`
          SELECT
            r.id request_id,
            r.requested_at,
            r.requested_by,
            r.requester_area,
            r.support_location,
            r.source,
            r.department,
            r.category,
            r.notes,
            COALESCE(t.status,r.status) status,
            t.id ticket_id,
            t.ticket_number,
            t.assigned_at,
            t.resolved_at,
            t.closed_at,
            t.response_due_at,
            t.resolution_due_at,
            t.total_wait_seconds,
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

        const det=wb.addWorksheet('Tickets');
        det.views=[{state:'frozen',ySplit:1,showGridLines:false}];
        const headers=[
          'Folio','Solicitud','Fecha','Solicitante','Área / Departamento',
          'Ubicación','Área soporte','Grupo / Línea','Equipo','Categoría',
          'Técnico','Estado','Asignado','Resuelto','SLA respuesta','SLA resolución'
        ];
        det.addRow(headers);
        det.getRow(1).eachCell(c=>{
          c.font={bold:true,color:{argb:'FFFFFF'}};
          c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'15324B'}};
        });

        data.forEach(x=>{
          const rs=x.assigned_at&&x.response_due_at
            ?(new Date(x.assigned_at)<=new Date(x.response_due_at)?'Cumple':'Vencido')
            :'—';
          const rz=x.resolved_at&&x.resolution_due_at
            ?(new Date(x.resolved_at)<=new Date(x.resolution_due_at)?'Cumple':'Vencido')
            :'—';

          det.addRow([
            x.ticket_number||'Sin asignar',
            x.request_id,
            x.requested_at,
            x.requested_by||'—',
            x.requester_area||'—',
            x.support_location||x.station_name||'—',
            String(x.department||'').toLowerCase()==='systems'?'Sistemas':
              String(x.department||'').toLowerCase()==='maintenance'?'Mantenimiento':
              x.department,
            x.group_name,
            x.station_code,
            x.category_label,
            x.technician,
            x.status,
            x.assigned_at||'',
            x.resolved_at||'',
            rs,
            rz
          ]);
        });

        [16,12,20,24,24,24,18,22,18,26,24,16,20,20,18,18]
          .forEach((w,i)=>det.getColumn(i+1).width=w);

        det.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};

        const raw=wb.addWorksheet('Datos');
        raw.views=[{state:'frozen',ySplit:1,showGridLines:false}];
        const rawHeaders=[
          'request_id','ticket_id','ticket_number','requested_at','requested_by',
          'requester_area','support_location','source','department','group_name',
          'station_code','station_name','category','category_label','technician',
          'status','assigned_at','resolved_at','closed_at','response_due_at',
          'resolution_due_at','total_wait_seconds','notes'
        ];
        raw.addRow(rawHeaders);
        raw.getRow(1).eachCell(c=>{
          c.font={bold:true,color:{argb:'FFFFFF'}};
          c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'15324B'}};
        });
        data.forEach(x=>raw.addRow(rawHeaders.map(h=>x[h]??'')));
        rawHeaders.forEach((_,i)=>raw.getColumn(i+1).width=i===22?42:18);

        const buf=await wb.xlsx.writeBuffer();
        const name=`ANDON_REPORTE_EJECUTIVO_${from}_${to}.xlsx`;

        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
        res.setHeader('Cache-Control','no-store');
        res.end(Buffer.from(buf));
      }catch(e){
        console.error('P6.9 visual excel',e);
        res.status(500).json({
          error:'No se pudo generar el Excel visual.',
          detail:e.message
        });
      }
    }
  );
};