$ErrorActionPreference = "Stop"
Set-Location "C:\Users\igarcia\Videos\andon"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " ANDON - REPAIR EXISTING MOJIBAKE + MULTISESSION" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$Server = ".\src\server.js"
$Admin  = ".\public\js\admin-users-plants-r187.js"
$Stamp  = Get-Date -Format "yyyyMMdd-HHmmss"

# Backups
Copy-Item $Server "$Server.BACKUP-R3-$Stamp" -Force
Copy-Item $Admin  "$Admin.BACKUP-R3-$Stamp" -Force

# ============================================================
# 1. REPAIR THE KNOWN MOJIBAKE ALREADY PRESENT IN GIT HEAD
# ============================================================

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Text = [System.IO.File]::ReadAllText((Resolve-Path $Admin), [System.Text.Encoding]::UTF8)

$Fixes = [ordered]@{
    "A" = "a"
    "A" = "e"
    "A" = "i"
    "A3" = "o"
    "Ao" = "u"
    "A" = "n"
    "A" = "A"
    "A" = "E"
    "A" = "I"
    "A" = "O"
    "As" = "U"
    "A" = "N"
    "A" = "-"
    "A" = "?"
    "A" = "!"
}

# The Git file contains literal mojibake. Convert only these known
# sequences, preserving all application logic.
foreach ($k in $Fixes.Keys) {
    $Text = $Text.Replace($k, $Fixes[$k])
}

# Fix the specific word "Areas" that became mojibake.
$Text = $Text.Replace("reas", "Areas")

# ============================================================
# 2. REMOVE SESSION-ONLY UI
# ============================================================

$Text = [regex]::Replace(
    $Text,
    '(?m)^\s*<th>Sesi[oo]n</th>\s*\r?\n?',
    '',
    1
)

$Text = [regex]::Replace(
    $Text,
    '(?s)\s*<td><span class="r187-pill \$\{u\.session_active.*?</span></td>',
    '',
    1
)

$Text = [regex]::Replace(
    $Text,
    '(?s)\s*<td>\$\{u\.session_active\s*&&\s*u\.role!==''superadmin''.*?</td>',
    '',
    1
)

$Text = [regex]::Replace(
    $Text,
    '(?s)\r?\nasync function releaseSession\(id\)\{.*?\r?\n\}\r?\n(?=function renderAreas)',
    "`r`n",
    1
)

$Text = [regex]::Replace(
    $Text,
    '(?s)\r?\n\s*document\.querySelectorAll\(''\[data-release\]''\).*?\}\);',
    '',
    1
)

$Text = $Text.Replace('colspan="8" class="r187-empty"', 'colspan="7" class="r187-empty"')

[System.IO.File]::WriteAllText((Resolve-Path $Admin), $Text, $Utf8NoBom)

# ============================================================
# 3. SERVER - REMOVE SINGLE SESSION LOGIN REJECTION
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
    throw "Unexpected number of single-session login blocks: $($LM.Count)"
}

# Remove obsolete admin endpoints only if present.
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

[System.IO.File]::WriteAllText((Resolve-Path $Server), $ServerText, $Utf8NoBom)

# ============================================================
# 4. VALIDATION
# ============================================================

node --check $Server
if ($LASTEXITCODE -ne 0) {
    throw "server.js syntax validation failed."
}

$AdminCheck = [System.IO.File]::ReadAllText((Resolve-Path $Admin), [System.Text.Encoding]::UTF8)

if ($AdminCheck -match 'A|A|') {
    throw "Mojibake still exists in admin file. No commit/push."
}

Write-Host "[OK] UTF-8 / mojibake validation passed." -ForegroundColor Green

Write-Host ""
Write-Host "=== REMAINING SESSION REFERENCES ===" -ForegroundColor Yellow

$Hits = Select-String -Path $Admin,$Server -Pattern `
    "session_active",
    "releaseSession",
    "data-release",
    "/api/admin/active-sessions",
    "/api/admin/users/:id/release-session",
    "already has an active session",
    "ya tiene una sesion activa",
    "ya tiene una sesion activa" `
    -CaseSensitive:$false

if ($Hits) {
    $Hits | ForEach-Object {
        Write-Host ("{0}:{1}: {2}" -f $_.Path,$_.LineNumber,$_.Line.Trim())
    }
} else {
    Write-Host "[OK] No obsolete single-session references found." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== GIT DIFF STAT ===" -ForegroundColor Cyan
git diff --stat

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " REPAIR COMPLETE - NO COMMIT / NO PUSH" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
