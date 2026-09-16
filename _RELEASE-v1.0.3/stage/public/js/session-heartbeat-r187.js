(()=>{
  const HEARTBEAT_MS=20000;
  let stopped=false;

  async function beat(){
    if(stopped)return;
    try{
      const r=await fetch('/api/session/heartbeat',{
        method:'POST',
        credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body:'{}',
        keepalive:true
      });

      if(r.status===401){
        stopped=true;
        location.href='/login?session=closed';
      }
    }catch{
      // No cerrar sesion por una falla breve de red.
    }
  }

  // Al cargar o refrescar, este heartbeat borra closing_at.
  beat();
  setInterval(beat,HEARTBEAT_MS);

  // pagehide ocurre tanto al cerrar como al refrescar.
  // Por eso NO hacemos logout inmediato: solo marcamos "intencion de cierre".
  // Si fue F5, la pagina recarga y el heartbeat cancela ese cierre.
  // Si fue cierre real, no hay nuevo heartbeat y el servidor libera la sesion.
  addEventListener('pagehide',()=>{
    try{
      navigator.sendBeacon(
        '/api/session/release',
        new Blob(['{}'],{type:'application/json'})
      );
    }catch{}
  });
})();