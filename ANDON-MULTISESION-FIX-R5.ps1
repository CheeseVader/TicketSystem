$ErrorActionPreference = "Stop"
Set-Location "C:\Users\igarcia\Videos\andon"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " ANDON - MULTISESSION FINAL REPAIR R5" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$Admin  = ".\public\js\admin-users-plants-r187.js"
$Server = ".\src\server.js"
$Stamp  = Get-Date -Format "yyyyMMdd-HHmmss"

Copy-Item $Admin  "$Admin.BACKUP-R5-$Stamp" -Force
Copy-Item $Server "$Server.BACKUP-R5-$Stamp" -Force

# Use Node for ALL UTF-8 work. This avoids Windows PowerShell 5.1
# decoding Git output with the Windows code page.
$NodeScript = @'
const fs = require("fs");
const cp = require("child_process");

const admin = process.argv[2];
const server = process.argv[3];

const utf8 = "utf8";

function gitText(file) {
  return cp.execFileSync("git", ["show", "HEAD:" + file], {encoding:"utf8"});
}

function write(file, text) {
  fs.writeFileSync(file, text, {encoding:utf8});
}

function hasBad(text) {
  return /[\u00c3\u00c2\uFFFD\u251c\u252c]/.test(text);
}

function removeOnce(text, re, label) {
  const before = text;
  const after = text.replace(re, "");
  if (after !== before) console.log("[OK] " + label);
  return after;
}

/*
 * ADMIN:
 * Start from the clean UTF-8 version that is actually in HEAD.
 * The diagnostic proved HEAD_ADMIN contains real UTF-8 "Areas".
 * Then remove only the single-session UI pieces.
 */
let a = gitText("public/js/admin-users-plants-r187.js");

a = removeOnce(
  a,
  /<th>Sesi.n<\/th>\s*/g,
  "Removed session column header"
);

a = removeOnce(
  a,
  /\s*<td><span class="r187-pill \$\{u\.session_active\?'ok':'off'\}">.*?<\/span><\/td>/g,
  "Removed session status cell"
);

a = removeOnce(
  a,
  /\s*<td>\$\{u\.session_active\s*&&\s*u\.role!=='superadmin'\s*\?[\s\S]*?<\/td>/g,
  "Removed release-session action cell"
);

a = removeOnce(
  a,
  /\s*document\.querySelectorAll\('\[data-release\]'\)\.forEach\(btn=>btn\.onclick=\(\)=>releaseSession\(btn\.dataset\.release\)\);/g,
  "Removed release-session click handler"
);

a = removeOnce(
  a,
  /\s*async function releaseSession\(id\)\{[\s\S]*?\n\}/g,
  "Removed releaseSession function"
);

a = a.replace(/colspan="8"/g, 'colspan="7"');

if (hasBad(a)) {
  throw new Error("Admin still contains mojibake after clean HEAD restore.");
}

write(admin, a);

/*
 * SERVER:
 * Keep the already successful multi-session login change in the current
 * server.js. Remove only the obsolete admin session-management endpoints.
 */
let s = fs.readFileSync(server, utf8);

s = removeOnce(
  s,
  /\/\* ANDON_R187_SINGLE_SESSION_ADMIN \*\/\s*app\.get\('\/api\/admin\/active-sessions'[\s\S]*?\n\}\);\s*/,
  "Removed admin active-sessions endpoint"
);

s = removeOnce(
  s,
  /app\.post\('\/api\/admin\/users\/:id\/release-session'[\s\S]*?\n\}\);\s*/,
  "Removed admin release-session endpoint"
);

write(server, s);

if (hasBad(a)) throw new Error("Admin mojibake validation failed.");
if (!/MULTISESSION: existing sessions do not block login/i.test(s)) {
  console.log("[WARNING] Multi-session marker not found in current server.js.");
}

console.log("[OK] UTF-8 validated by Node.");
'@

$tmp = Join-Path $env:TEMP "andon-multisession-r5-$([guid]::NewGuid().ToString('N')).js"
[System.IO.File]::WriteAllText($tmp, $NodeScript, (New-Object System.Text.UTF8Encoding($false)))

node $tmp $Admin $Server
if ($LASTEXITCODE -ne 0) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    throw "Node repair failed. Backups were created; no commit/push."
}

Remove-Item $tmp -Force

node --check $Server
if ($LASTEXITCODE -ne 0) {
    throw "server.js syntax failed. Restore from BACKUP-R5 if necessary. No commit/push."
}

Write-Host ""
Write-Host "=== VERIFY SINGLE SESSION REFERENCES ===" -ForegroundColor Cyan

$Patterns = @(
    "ANDON_R187_SINGLE_SESSION_ADMIN",
    "/api/admin/active-sessions",
    "/api/admin/users/:id/release-session",
    "releaseSession",
    "data-release"
)

$Hits = Select-String -Path $Admin,$Server -Pattern $Patterns -CaseSensitive:$false

if ($Hits) {
    $Hits | ForEach-Object {
        Write-Host ("FOUND {0}:{1}: {2}" -f $_.Path,$_.LineNumber,$_.Line.Trim()) -ForegroundColor Yellow
    }
} else {
    Write-Host "[OK] No obsolete single-session UI/admin references found." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== GIT DIFF STAT ===" -ForegroundColor Cyan
git diff --stat

Write-Host ""
Write-Host "=== GIT STATUS ===" -ForegroundColor Cyan
git status --short

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " R5 COMPLETE - NO COMMIT / NO PUSH" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
