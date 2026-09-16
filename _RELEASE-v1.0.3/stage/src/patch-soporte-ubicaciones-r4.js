const fs=require('fs');
const path=require('path');

const root=process.argv[2];
const server=path.join(root,'src','server.js');
let s=fs.readFileSync(server,'utf8');

const start=s.indexOf("app.get('/api/soporte/catalog'");
const end=s.indexOf("app.post('/api/soporte/requests'", start);

if(start<0 || end<0){
  throw new Error('No se encontro el bloque /api/soporte/catalog.');
}

const route=`app.get('/api/soporte/catalog',async(req,res)=>{
  try{
    const [areas,groups,requests]=await Promise.all([
      pool.query(\`SELECT name FROM support_areas WHERE enabled=TRUE ORDER BY sort_order,name\`),
      pool.query(\`SELECT name FROM production_groups WHERE enabled=TRUE AND archived_at IS NULL ORDER BY sort_order,name\`),
      pool.query(\`SELECT department,code,label,category_group FROM admin_support_requests_catalog WHERE enabled=TRUE ORDER BY department,sort_order,label\`)
    ]);

    // Ubicacion = Areas/Departamentos + Lineas/Grupos.
    // No incluir estaciones individuales (INPUT, PACKING, ESCANEO, etc.).
    const locationMap=new Map();

    for(const item of [...areas.rows,...groups.rows]){
      const name=String(item.name||'').trim();
      if(!name) continue;

      const key=name
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g,'')
        .toUpperCase();

      if(!locationMap.has(key)){
        locationMap.set(key,{name});
      }
    }

    res.json({
      areas:areas.rows,
      locations:[...locationMap.values()],
      requests:requests.rows
    });
  }catch(e){
    console.error('soporte catalog',e);
    res.status(500).json({error:'No se pudo cargar el catalogo de soporte'});
  }
});

`;

s=s.slice(0,start)+route+s.slice(end);
fs.writeFileSync(server,s,'utf8');
console.log('Catalogo /api/soporte/catalog actualizado.');
