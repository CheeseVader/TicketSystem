'use strict';

/*
 * ANDON R1.8.7 P6.4
 *
 * El bloqueo "una sesión por usuario" sólo es válido mientras vive
 * el mismo proceso/arranque de ANDON.
 *
 * Al reiniciar Node, actualizar ANDON o reiniciar la RPi:
 *   - las sesiones web del proceso anterior ya no son confiables;
 *   - cualquier lock persistente del arranque anterior debe liberarse.
 *
 * Este módulo NO desactiva usuarios ni modifica contraseñas/roles.
 * Sólo limpia columnas/tablas que por nombre y forma son locks de sesión.
 */

function qi(name){
  return '"' + String(name).replace(/"/g,'""') + '"';
}

async function getColumns(pool,table){
  const q=await pool.query(`
    SELECT column_name,data_type,is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1
    ORDER BY ordinal_position
  `,[table]);
  return q.rows;
}

function isNullLockColumn(name){
  const n=String(name||'').toLowerCase();

  return new Set([
    'active_session_id',
    'current_session_id',
    'login_session_id',
    'session_id',
    'active_session_token',
    'session_token',
    'current_session_token',
    'active_session_last_seen_at',
    'session_last_seen_at',
    'active_session_started_at',
    'session_started_at',
    'active_session_expires_at',
    'session_expires_at',
    'active_session_boot_id',
    'session_boot_id',
    'login_boot_id',
    'closing_at',
    'session_closing_at'
  ]).has(n);
}

function isFalseLockColumn(name){
  const n=String(name||'').toLowerCase();
  return new Set([
    'is_logged_in',
    'logged_in',
    'session_active',
    'has_active_session',
    'active_login'
  ]).has(n);
}

async function clearUsersLocks(pool){
  const cols=await getColumns(pool,'users');
  if(!cols.length)return {table:'users',found:false,columns:[],rows:0};

  const sets=[];
  const used=[];

  for(const c of cols){
    if(isNullLockColumn(c.column_name) && c.is_nullable==='YES'){
      sets.push(`${qi(c.column_name)}=NULL`);
      used.push(c.column_name);
    }else if(isFalseLockColumn(c.column_name) && c.data_type==='boolean'){
      sets.push(`${qi(c.column_name)}=FALSE`);
      used.push(c.column_name);
    }
  }

  if(!sets.length){
    return {table:'users',found:true,columns:[],rows:0};
  }

  // No WHERE: un restart de ANDON invalida todos los locks del arranque anterior.
  const q=await pool.query(`UPDATE users SET ${sets.join(', ')}`);
  return {table:'users',found:true,columns:used,rows:q.rowCount};
}

async function clearDedicatedSessionTables(pool){
  const tables=(await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
      AND table_type='BASE TABLE'
      AND (
        table_name ILIKE '%session%'
        OR table_name ILIKE '%login_lock%'
      )
    ORDER BY table_name
  `)).rows.map(x=>x.table_name);

  const results=[];
  const safeExact=new Set([
    'user_sessions',
    'active_sessions',
    'login_sessions',
    'andon_sessions',
    'user_login_sessions',
    'user_session_locks',
    'login_locks'
  ]);

  for(const table of tables){
    const cols=await getColumns(pool,table);
    const names=new Set(cols.map(x=>String(x.column_name).toLowerCase()));

    // Sólo borrar si el nombre es inequívoco o si la estructura luce
    // específicamente como un lock de login por usuario.
    const structuredLock=
      (names.has('user_id') || names.has('username')) &&
      (
        names.has('last_seen_at') ||
        names.has('session_id') ||
        names.has('token') ||
        names.has('session_token') ||
        names.has('boot_id')
      );

    if(!safeExact.has(table.toLowerCase()) && !structuredLock)continue;

    const q=await pool.query(`DELETE FROM ${qi(table)}`);
    results.push({table,rows:q.rowCount});
  }

  return results;
}

module.exports=async function resetPreviousBootSessions(pool,bootId){
  const started=Date.now();

  const userLocks=await clearUsersLocks(pool);
  const sessionTables=await clearDedicatedSessionTables(pool);

  console.log(
    '[SESSION BOOT RESET]',
    'boot='+String(bootId||'unknown'),
    'users_rows='+userLocks.rows,
    'users_columns='+(userLocks.columns.join(',')||'none'),
    'tables='+(sessionTables.map(x=>`${x.table}:${x.rows}`).join(',')||'none'),
    'ms='+(Date.now()-started)
  );

  return {bootId,userLocks,sessionTables};
};