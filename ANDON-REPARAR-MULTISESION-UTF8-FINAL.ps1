#requires -Version 5.1
$ErrorActionPreference = "Stop"

cd C:\Users\igarcia\Videos\andon

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " ANDON - REPARACION MULTISESION + UTF8 FINAL" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$Admin = (Resolve-Path ".\public\js\admin-users-plants-r187.js").Path
$Server = (Resolve-Path ".\src\server.js").Path
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"

# ------------------------------------------------------------
# 1. BACKUP DEL ESTADO ACTUAL
# ------------------------------------------------------------
$AdminBak = "$Admin.BEFORE-UTF8-REPAIR-$Stamp"
$ServerBak = "$Server.BEFORE-UTF8-REPAIR-$Stamp"

Copy-Item $Admin $AdminBak -Force
Copy-Item $Server $ServerBak -Force

Write-Host "[BACKUP] $AdminBak" -ForegroundColor Green
Write-Host "[BACKUP] $ServerBak" -ForegroundColor Green

# ------------------------------------------------------------
# 2. RESTAURAR ADMIN DESDE GIT, NO DESDE EL BACKUP CORRUPTO
#    Esto recupera exactamente la version de origin/local HEAD.
# ------------------------------------------------------------
$TmpAdmin = Join-Path $env:TEMP "andon-admin-users-clean-$Stamp.js"

cmd /c "git show HEAD:public/js/admin-users-plants-r187.js > `"$TmpAdmin`""

if (!(Test-Path $TmpAdmin)) {
    throw "No se pudo extraer el admin original desde Git."
}

Copy-Item $TmpAdmin $Admin -Force
Remove-Item $TmpAdmin -Force

Write-Host "[OK] admin-users-plants-r187.js restaurado directamente desde Git HEAD." -ForegroundColor Green

# ------------------------------------------------------------
# 3. LEER Y GUARDAR UTF-8 REAL
# ------------------------------------------------------------
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Text = [System.IO.File]::ReadAllText($Admin, [System.Text.Encoding]::UTF8)

# ------------------------------------------------------------
# 4. QUITAR COLUMNA "Sesion" DEL HEADER
# ------------------------------------------------------------
$Text = [regex]::Replace(
    $Text,
    '(?m)^\s*<th>Sesi[oó]n</th>\s*\r?\n?',
    '',
    1
)

# ------------------------------------------------------------
# 5. QUITAR CELDA session_active
# ------------------------------------------------------------
$Text = [regex]::Replace(
    $Text,
    '(?s)\s*<td><span class="r187-pill \$\{u\.session_active.*?</span></td>',
    '',
    1
)

# ------------------------------------------------------------
# 6. QUITAR CELDA/BOTON release-session
# ------------------------------------------------------------
$Text = [regex]::Replace(
    $Text,
    '(?s)\s*<td>\$\{u\.session_active\s*&&\s*u\.role!==''superadmin''.*?</td>',
    '',
    1
)

# ------------------------------------------------------------
# 7. QUITAR LISTENER data-release
# ------------------------------------------------------------
$Text = [regex]::Replace(
    $Text,
    '(?s)\s*document\.querySelectorAll\(''\[data-release\]''\).*?\}\);',
    '',
    1
)

# ------------------------------------------------------------
# 8. QUITAR FUNCION releaseSession()
# ------------------------------------------------------------
$Text = [regex]::Replace(
    $Text,
    '(?s)\r?\nasync function releaseSession\(id\)\{.*?\r?\n\}\r?\n(?=function renderAreas)',
    "`r`n",
    1
)

# ------------------------------------------------------------
# 9. AJUSTAR COLSPAN
# ------------------------------------------------------------
$Text = $Text.Replace('colspan="8" class="r187-empty"', 'colspan="7" class="r187-empty"')

# ------------------------------------------------------------
# 10. GUARDAR SIN BOM
# ------------------------------------------------------------
[System.IO.File]::WriteAllText($Admin, $Text, $Utf8)

Write-Host "[OK] Admin guardado como UTF-8 sin BOM." -ForegroundColor Green

# ------------------------------------------------------------
# 11. VALIDAR CARACTERES CORRUPTOS
# ------------------------------------------------------------
$Check = [System.IO.File]::ReadAllText($Admin, [System.Text.Encoding]::UTF8)

if ($Check -match 'Ã|Â|�') {
    Copy-Item $AdminBak $Admin -Force
    throw "Se detectaron caracteres corruptos (Ã/Â/�). Se RESTAURO el admin anterior."
}

Write-Host "[OK] No hay corrupcion UTF-8." -ForegroundColor Green

# ------------------------------------------------------------
# 12. VALIDAR RESTRICCIONES DE SESION EN ADMIN
# ------------------------------------------------------------
$Hits = Select-String -Path $Admin -Pattern `
    "session_active",
    "releaseSession",
    "data-release",
    "/api/admin/active-sessions",
    "release-session" `
    -CaseSensitive:$false

if ($Hits) {
    Write-Host ""
    Write-Host "REFERENCIAS DE SESION RESTANTES EN ADMIN:" -ForegroundColor Yellow
    $Hits | ForEach-Object {
        Write-Host ("{0}:{1}: {2}" -f $_.Path,$_.LineNumber,$_.Line.Trim())
    }
} else {
    Write-Host "[OK] Admin sin referencias de bloqueo/liberacion de sesion." -ForegroundColor Green
}

# ------------------------------------------------------------
# 13. VALIDAR SERVER.JS
# ------------------------------------------------------------
node --check $Server

if ($LASTEXITCODE -ne 0) {
    Copy-Item $ServerBak $Server -Force
    throw "server.js tiene error de sintaxis. Se RESTAURO el backup."
}

Write-Host "[OK] server.js valido." -ForegroundColor Green

# ------------------------------------------------------------
# 14. VERIFICAR QUE EL BLOQUE DE LOGIN SINGLE-SESSION
#     YA NO EXISTA EN SERVER
# ------------------------------------------------------------
$ServerText = [System.IO.File]::ReadAllText($Server, [System.Text.Encoding]::UTF8)

if ($ServerText -match "Este usuario ya tiene una sesión activa" -or
    $ServerText -match "Este usuario ya tiene una sesion activa") {
    Write-Host "[ADVERTENCIA] Todavia existe texto de bloqueo de sesion en server.js." -ForegroundColor Yellow
} else {
    Write-Host "[OK] No existe mensaje de bloqueo de sesion unica en server.js." -ForegroundColor Green
}

# ------------------------------------------------------------
# 15. DIFF FINAL
# ------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " DIFF FINAL" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

git diff --stat

Write-Host ""
Write-Host "IMPORTANTE: NO SE HIZO COMMIT NI PUSH." -ForegroundColor Yellow
Write-Host ""
Write-Host "Si el diff se ve correcto, ejecutar despues:" -ForegroundColor Cyan
Write-Host "  git add src/server.js public/js/admin-users-plants-r187.js"
Write-Host '  git commit -m "ANDON: allow multiple user sessions"'
Write-Host "  git push origin main"
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " REPARACION TERMINADA" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
