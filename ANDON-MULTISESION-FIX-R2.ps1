#requires -Version 5.1
$ErrorActionPreference = "Stop"

Set-Location "C:\Users\igarcia\Videos\andon"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " ANDON - FIX MULTISESSION FINAL" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$Server = (Resolve-Path ".\src\server.js").Path
$Admin  = (Resolve-Path ".\public\js\admin-users-plants-r187.js").Path
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"

# ============================================================
# 1. BACKUPS
# ============================================================

$ServerBak = "$Server.BACKUP-MULTISESSION-FINAL-$Stamp"
$AdminBak  = "$Admin.BACKUP-MULTISESSION-FINAL-$Stamp"

Copy-Item $Server $ServerBak -Force
Copy-Item $Admin $AdminBak -Force

Write-Host "[BACKUP] $ServerBak" -ForegroundColor Green
Write-Host "[BACKUP] $AdminBak" -ForegroundColor Green

# ============================================================
# 2. RESTORE ADMIN FILE DIRECTLY FROM CURRENT GIT HEAD
#    This removes the previously corrupted encoding.
# ============================================================

git checkout -- .\public\js\admin-users-plants-r187.js

if ($LASTEXITCODE -ne 0) {
    throw "Could not restore admin file from Git HEAD."
}

Write-Host "[OK] Admin file restored from Git HEAD." -ForegroundColor Green

# ============================================================
# 3. SERVER.JS
#    Remove ONLY the single-session login rejection.
# ============================================================

$ServerText = [System.IO.File]::ReadAllText($Server, [System.Text.Encoding]::UTF8)

$LoginPattern = '(?s)\s*const active=\(await client\.query\(`.*?FROM active_user_sessions.*?WHERE user_id=\$1.*?FOR UPDATE.*?\`,\[user\.id\]\)\)\.rows\[0\];\s*if\(active\)\{.*?\n\s*\}'

$LoginMatches = [regex]::Matches($ServerText, $LoginPattern)

Write-Host "Single-session login blocks found: $($LoginMatches.Count)"

if ($LoginMatches.Count -eq 1) {
    $ServerText = [regex]::Replace(
        $ServerText,
        $LoginPattern,
        "`r`n    // MULTISESSION: existing sessions do not block login.`r`n",
        1
    )
    Write-Host "[OK] Single-session login block removed." -ForegroundColor Green
}
elseif ($LoginMatches.Count -eq 0) {
    Write-Host "[OK] Single-session login block is already absent." -ForegroundColor Green
}
else {
    throw "Multiple single-session login blocks found. Nothing else was changed."
}

# Remove only the old 23505 catch that returned the single-session message.
$P23505 = '(?s)\s*catch\(e\)\{\s*if\(e\.code===[''"]23505[''"]\)\{\s*await client\.query\([''"]ROLLBACK[''"]\);\s*return res\.status\(409\)\.send\(\s*[''"].*?already.*?active.*?[''"]\+\s*[''"]<a href="/login">.*?</a>[''"]\s*\);\s*\}\s*throw e;\s*\}'

$M23505 = [regex]::Matches($ServerText, $P23505)

Write-Host "Old single-session 23505 handlers found: $($M23505.Count)"

if ($M23505.Count -eq 1) {
    $ServerText = [regex]::Replace($ServerText, $P23505, "`r`n    catch(e){ throw e; }", 1)
    Write-Host "[OK] Old single-session 23505 handler removed." -ForegroundColor Green
}
elseif ($M23505.Count -gt 1) {
    throw "Multiple old single-session 23505 handlers found."
}

# ============================================================
# 4. Remove obsolete admin session endpoints.
#    The normal /api/session/release endpoint is NOT removed.
# ============================================================

$PActiveSessions = '(?s)\s*app\.get\(''/api/admin/active-sessions'',requireManager,async\(req,res\)=>\{.*?\n\}\);\s*'
$MActive = [regex]::Matches($ServerText, $PActiveSessions)

Write-Host "Admin active-sessions endpoints found: $($MActive.Count)"

if ($MActive.Count -eq 1) {
    $ServerText = [regex]::Replace($ServerText, $PActiveSessions, "`r`n", 1)
    Write-Host "[OK] Admin active-sessions endpoint removed." -ForegroundColor Green
}
elseif ($MActive.Count -gt 1) {
    throw "Multiple admin active-sessions endpoints found."
}

$PReleaseAdmin = '(?s)\s*app\.post\(''/api/admin/users/:id/release-session'',requireManager,async\(req,res\)=>\{.*?\n\}\);\s*'
$MReleaseAdmin = [regex]::Matches($ServerText, $PReleaseAdmin)

Write-Host "Admin release-session endpoints found: $($MReleaseAdmin.Count)"

if ($MReleaseAdmin.Count -eq 1) {
    $ServerText = [regex]::Replace($ServerText, $PReleaseAdmin, "`r`n", 1)
    Write-Host "[OK] Admin release-session endpoint removed." -ForegroundColor Green
}
elseif ($MReleaseAdmin.Count -gt 1) {
    throw "Multiple admin release-session endpoints found."
}

# ============================================================
# 5. Save server.js without BOM.
# ============================================================

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Server, $ServerText, $Utf8NoBom)

# ============================================================
# 6. Clean admin UI.
# ============================================================

$AdminText = [System.IO.File]::ReadAllText($Admin, [System.Text.Encoding]::UTF8)

# Remove the session header only.
$AdminText = [regex]::Replace(
    $AdminText,
    '(?m)^\s*<th>Sesi[oo]n</th>\s*\r?\n?',
    '',
    1
)

# Remove the session status cell.
$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\s*<td><span class="r187-pill \$\{u\.session_active.*?</span></td>',
    '',
    1
)

# Remove the admin release-session cell/button.
$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\s*<td>\$\{u\.session_active\s*&&\s*u\.role!==''superadmin''.*?</td>',
    '',
    1
)

# Remove old releaseSession function.
$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\r?\nasync function releaseSession\(id\)\{.*?\r?\n\}\r?\n(?=function renderAreas)',
    "`r`n",
    1
)

# Remove old data-release listener.
$AdminText = [regex]::Replace(
    $AdminText,
    '(?s)\r?\n\s*document\.querySelectorAll\(''\[data-release\]''\).*?\}\);',
    '',
    1
)

# Empty table colspan after removing one column.
$AdminText = $AdminText.Replace(
    'colspan="8" class="r187-empty"',
    'colspan="7" class="r187-empty"'
)

[System.IO.File]::WriteAllText($Admin, $AdminText, $Utf8NoBom)

Write-Host "[OK] Admin UI cleaned." -ForegroundColor Green

# ============================================================
# 7. VALIDATE UTF-8.
# ============================================================

$AdminCheck = [System.IO.File]::ReadAllText($Admin, [System.Text.Encoding]::UTF8)

if ($AdminCheck -match 'A|A|') {
    Copy-Item $AdminBak $Admin -Force
    throw "Corrupt UTF-8 characters detected. Admin file restored."
}

Write-Host "[OK] Admin UTF-8 is clean." -ForegroundColor Green

# ============================================================
# 8. VALIDATE NODE SYNTAX.
# ============================================================

node --check $Server

if ($LASTEXITCODE -ne 0) {
    Copy-Item $ServerBak $Server -Force
    throw "server.js syntax error. Server file restored."
}

Write-Host "[OK] server.js syntax is valid." -ForegroundColor Green

# ============================================================
# 9. SEARCH FOR REMAINING SINGLE-SESSION LOGIN BLOCKS.
# ============================================================

Write-Host ""
Write-Host "=== REMAINING SINGLE-SESSION REFERENCES ===" -ForegroundColor Yellow

$SearchPatterns = @(
    "This user already has an active session",
    "already has an active session",
    "session_active",
    "releaseSession",
    "data-release",
    "/api/admin/active-sessions",
    "/api/admin/users/:id/release-session"
)

$Hits = Select-String `
    -Path $Server,$Admin `
    -Pattern $SearchPatterns `
    -CaseSensitive:$false

if ($Hits) {
    $Hits | ForEach-Object {
        Write-Host ("{0}:{1}: {2}" -f $_.Path,$_.LineNumber,$_.Line.Trim())
    }
}
else {
    Write-Host "[OK] No obsolete single-session references found." -ForegroundColor Green
}

# ============================================================
# 10. FINAL DIFF
# ============================================================

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " FINAL GIT DIFF" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

git diff --stat

Write-Host ""
git diff -- .\src\server.js .\public\js\admin-users-plants-r187.js

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " DONE - NO COMMIT AND NO PUSH" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
