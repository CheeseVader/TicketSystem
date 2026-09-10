require('dotenv').config();
const fs=require('fs');
const path=require('path');
const pool=require('./db');
(async()=>{try{const sql=fs.readFileSync(path.join(__dirname,'..','sql','migrate-r11-2.sql'),'utf8');await pool.query(sql);console.log('ANDON R11.2 migration OK');process.exit(0)}catch(e){console.error('ANDON R11.2 migration ERROR:',e);process.exit(1)}})();
