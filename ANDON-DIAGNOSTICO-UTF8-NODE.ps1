$ErrorActionPreference = "Stop"
Set-Location "C:\Users\igarcia\Videos\andon"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " ANDON - DIAGNOSTICO REAL UTF8 (NODE)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$Admin = ".\public\js\admin-users-plants-r187.js"
$Server = ".\src\server.js"

if (!(Test-Path $Admin)) { throw "No existe $Admin" }
if (!(Test-Path $Server)) { throw "No existe $Server" }

# Node reads UTF-8 explicitly. This avoids Windows PowerShell 5.1
# mis-decoding UTF-8 as the system code page.
$diag = @'
const fs = require("fs");
const cp = require("child_process");

const admin = process.argv[2];
const server = process.argv[3];

function readUtf8(p) {
  return fs.readFileSync(p, "utf8");
}

function check(name, text) {
  const bad = /A|A|/.test(text);
  const weird = /|/.test(text);
  console.log(`${name}|bytes=${Buffer.byteLength(text,"utf8")}|bad_utf8=${bad}|weird_cp437=${weird}`);

  const needles = [
    "Area","Areas","area","Sesion","Contrasena",
    "A","A","","","session_active","releaseSession",
    "/api/admin/active-sessions",
    "/api/admin/users/:id/release-session",
    "ya tiene una sesion activa",
    "ya tiene una sesion activa"
  ];
  for (const n of needles) {
    const i = text.indexOf(n);
    if (i >= 0) {
      const a = Math.max(0,i-90), b = Math.min(text.length,i+n.length+140);
      console.log(`MATCH|${n}|${JSON.stringify(text.slice(a,b))}`);
    }
  }
}

check("CURRENT_ADMIN", readUtf8(admin));
check("CURRENT_SERVER", readUtf8(server));

console.log("GIT_HEAD_ADMIN");
const head = cp.execFileSync("git",["show","HEAD:public/js/admin-users-plants-r187.js"]);
const headText = head.toString("utf8");
check("HEAD_ADMIN", headText);

console.log("GIT_HEAD_SERVER");
const sh = cp.execFileSync("git",["show","HEAD:src/server.js"]);
const shText = sh.toString("utf8");
check("HEAD_SERVER", shText);
'@

$tmp = Join-Path $env:TEMP "andon-utf8-diagnostic-$([guid]::NewGuid().ToString('N')).js"
[System.IO.File]::WriteAllText($tmp,$diag,(New-Object System.Text.UTF8Encoding($false)))

node $tmp $Admin $Server

Remove-Item $tmp -Force

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " DIAGNOSTICO TERMINADO - NO SE MODIFICO NADA" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
