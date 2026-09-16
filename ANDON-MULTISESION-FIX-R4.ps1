$ErrorActionPreference = "Stop"
Set-Location "C:\Users\igarcia\Videos\andon"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " ANDON - MULTISESSION + UTF8 REPAIR R4" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$Server = ".\src\server.js"
$Admin  = ".\public\js\admin-users-plants-r187.js"
$Stamp  = Get-Date -Format "yyyyMMdd-HHmmss"

Copy-Item $Server "$Server.BACKUP-R4-$Stamp" -Force
Copy-Item $Admin  "$Admin.BACKUP-R4-$Stamp" -Force

$Utf8 = New-Object System.Text.UTF8Encoding($false)

# ============================================================
# 1. REPAIR THE ACTUAL MOJIBAKE FOUND IN GIT/FILE
#    Build the bad strings from character codes so this PS1
#    contains only ASCII and cannot be corrupted itself.
# ============================================================

$AdminText = [System.IO.File]::ReadAllText((Resolve-Path $Admin), [System.Text.Encoding]::UTF8)

function U([int[]]$Codes) {
    return (-join ($Codes | ForEach-Object { [char]$_ }))
}

$BadArea      = U @(0x00C3,0x00A1)
$BadArea2     = U @(0x00C3,0x00A9)
$BadArea3     = U @(0x00C3,0x00AD)
$BadArea4     = U @(0x00C3,0x00B3)
$BadArea5     = U @(0x00C3,0x00BA)
$BadEnye      = U @(0x00C3,0x00B1)
$BadBullet    = U @(0x00C2,0x00B7)
$BadQuestion  = U @(0x00C2,0x00BF)
$BadExclaim   = U @(0x00C2,0x00A1)

# Repair normal UTF-8 mojibake sequences.
$AdminText = $AdminText.Replace($BadArea, "a")
$AdminText = $AdminText.Replace($BadArea2, "e")
$AdminText = $AdminText.Replace($BadArea3, "i")
$AdminText = $AdminText.Replace($BadArea4, "o")
$AdminText = $AdminText.Replace($BadArea5, "u")
$AdminText = $AdminText.Replace($BadEnye, "n")
$AdminText = $AdminText.Replace($BadBullet, "-")
$AdminText = $AdminText.Replace($BadQuestion, "?")
$AdminText = $AdminText.Replace($BadExclaim, "!")

# The Git output showed "ureas" specifically.
$WeirdAreas = U @(0x251C,0x00FC,0x0072,0x0065,0x0061,0x0073)
$AdminText = $AdminText.Replace($WeirdAreas, "Areas")

# Restore common Spanish words that were mangled into ASCII
# by the previous bad conversion, without touching program logic.
$AdminText = $AdminText.Replace("reas / Departamentos", "Areas / Departamentos")
$AdminText = $AdminText.Replace("rea / Departamento", "Area / Departamento")
$AdminText = $AdminText.Replace("rea configuradas", "Area configuradas")
$AdminText = $AdminText.Replace("rea agregada", "Area agregada")
$AdminText = $AdminText.Replace("rea actualizada", "Area actualizada")
$AdminText = $AdminText.Replace("rea desactivada", "Area desactivada")
$AdminText = $AdminText.Replace("rea activada", "Area activada")
$AdminText = $AdminText.Replace("Sin rea", "Sin Area")
$AdminText = $AdminText.Replace("Contrasea", "Contrasena")

# ============================================================
# 2. REMOVE SINGLE-SESSION UI
# ============================================================

$AdminText = [regex]::Replace(
    $AdminText,
    '(?m)^\s*<th>Sesi.n</th>\s*\r?\n?',
    '',
    1
)

$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\s*<td><span class="r187-pill \$\{u\.session_active.*?</span></td>',
    '',
    1
)

$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\s*<td>\$\{u\.session_active\s*&&\s*u\.role!==''superadmin''.*?</td>',
    '',
    1
)

$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\r?\nasync function releaseSession\(id\)\{.*?\r?\n\}\r?\n(?=function renderAreas)',
    "`r`n",
    1
)

$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\r?\n\s*document\.querySelectorAll\(''\[data-release\]''\).*?\}\);',
    '',
    1
)

$AdminText = $AdminText.Replace('colspan="8" class="r187-empty"', 'colspan="7" class="r187-empty"')

[System.IO.File]::WriteAllText((Resolve-Path $Admin), $AdminText, $Utf8)

# ============================================================
# 3. SERVER: REMOVE SINGLE-SESSION LOGIN REJECTION
# ============================================================

$ServerText = [System.IO.File]::ReadAllText((Resolve-Path $Server), [System.Text.Encoding]::UTF8)

$LoginPattern = '(?s)\s*const active=\(await client\.query\(`.*?FROM active_user_sessions.*?WHERE user_id=\$1.*?FOR UPDATE.*?\`,\[user\.id\]\)\)\.rows\[0\];\s*if\(active\)\{.*?\n\s*\}'

$LM = [regex]::Matches($ServerText, $LoginPattern)

if ($LM.Count -eq 1) {
    $ServerText = [regex]::Replace(
        $ServerText,
        $LoginPattern,
        "`r`n    // MULTISESSION: existing sessions do not block login.`r`n",
        1
    )
    Write-Host "[OK] Single-session login rejection removed." -ForegroundColor Green
}
elseif ($LM.Count -eq 0) {
    Write-Host "[OK] Single-session login rejection already absent." -ForegroundColor Green
}
else {
    throw "Unexpected single-session block count: $($LM.Count)"
}

$P1 = '(?s)\s*app\.get\(''/api/admin/active-sessions'',requireManager,async\(req,res\)=>\{.*?\n\}\);\s*'
$P2 = '(?s)\s*app\.post\(''/api/admin/users/:id/release-session'',requireManager,async\(req,res\)=>\{.*?\n\}\);\s*'

if ([regex]::Matches($ServerText, $P1).Count -eq 1) {
    $ServerText = [regex]::Replace($ServerText, $P1, "`r`n", 1)
    Write-Host "[OK] Admin active-sessions endpoint removed." -ForegroundColor Green
}

if ([regex]::Matches($ServerText, $P2).Count -eq 1) {
    $ServerText = [regex]::Replace($ServerText, $P2, "`r`n", 1)
    Write-Host "[OK] Admin release-session endpoint removed." -ForegroundColor Green
}

[System.IO.File]::WriteAllText((Resolve-Path $Server), $ServerText, $Utf8)

# ============================================================
# 4. VALIDATE
# ============================================================

node --check $Server
if ($LASTEXITCODE -ne 0) {
    throw "server.js syntax validation failed."
}

$AdminCheck = [System.IO.File]::ReadAllText((Resolve-Path $Admin), [System.Text.Encoding]::UTF8)

# Detect both common mojibake forms.
$Bad1 = U @(0x00C3)
$Bad2 = U @(0x00C2)
$Replacement = U @(0xFFFD)

if ($AdminCheck.Contains($Bad1) -or $AdminCheck.Contains($Bad2) -or $AdminCheck.Contains($Replacement)) {
    throw "Mojibake remains in admin file. NO COMMIT and NO PUSH."
}

Write-Host "[OK] UTF-8 validation passed." -ForegroundColor Green

Write-Host ""
Write-Host "=== SESSION REFERENCES LEFT ===" -ForegroundColor Yellow

$Hits = Select-String -Path $Admin,$Server -Pattern `
    "session_active",
    "releaseSession",
    "data-release",
    "/api/admin/active-sessions",
    "/api/admin/users/:id/release-session",
    "already has an active session",
    "ya tiene una sesion activa" `
    -CaseSensitive:$false

if ($Hits) {
    $Hits | ForEach-Object {
        Write-Host ("{0}:{1}: {2}" -f $_.Path,$_.LineNumber,$_.Line.Trim())
    }
}
else {
    Write-Host "[OK] No obsolete single-session references found." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== GIT DIFF STAT ===" -ForegroundColor Cyan
git diff --stat

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " R4 COMPLETE - NO COMMIT / NO PUSH" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
