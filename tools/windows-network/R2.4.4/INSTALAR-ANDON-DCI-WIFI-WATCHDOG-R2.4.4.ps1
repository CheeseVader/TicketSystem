#requires -Version 5.1
[CmdletBinding()]
param([string]$RpiIp="10.138.43.217")

Set-StrictMode -Version Latest
$ErrorActionPreference="Stop"

$NewTask="ANDON-DCI-WiFiWatchdog"
$Base="C:\ProgramData\ANDON-DCI-NETWORK"
$Target=Join-Path $Base "WATCHDOG-ANDON-DCI-R2.4.4.ps1"

$id=[Security.Principal.WindowsIdentity]::GetCurrent()
$p=New-Object Security.Principal.WindowsPrincipal($id)
if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw "Ejecuta como Administrador."
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " ANDON + DCI WIFI WATCHDOG R2.4.4" -ForegroundColor White
Write-Host " MISMA RPi: $RpiIp" -ForegroundColor White
Write-Host "======================================================================" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $Base | Out-Null

Write-Host "[1/6] Retirando automatismos LEGACY que pueden reinyectar 10.138.95.1..." -ForegroundColor Cyan
$legacyTasks=@(
    "ANDON-AutoNetworkFix",
    "ANDON-DCI-AutoNetworkFix",
    "ANDON-DCI-WiFiMonitor",
    $NewTask
)

foreach($name in $legacyTasks){
    try{ Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }catch{}
    try{
        $t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if($t){
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
            Write-Host "      eliminado task: $name" -ForegroundColor Yellow
        }
    }catch{}
}

# Old installer used this directory and repair-route.ps1.
$legacyDir="C:\ProgramData\ANDON-NETWORK-FIX"
if(Test-Path -LiteralPath $legacyDir){
    Remove-Item -LiteralPath $legacyDir -Recurse -Force
    Write-Host "      eliminado legacy: $legacyDir" -ForegroundColor Yellow
}

Write-Host "[2/6] Limpiando rutas viejas de 10.138.43.217..." -ForegroundColor Cyan
foreach($store in @("PersistentStore","ActiveStore")){
    @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$RpiIp/32" -PolicyStore $store -ErrorAction SilentlyContinue) |
      Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
}

Write-Host "[3/6] Instalando watchdog..." -ForegroundColor Cyan
$src=Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "WATCHDOG-ANDON-DCI-R2.4.4.ps1"
if(-not(Test-Path -LiteralPath $src)){ throw "Falta $src" }
Copy-Item -LiteralPath $src -Destination $Target -Force

Write-Host "[4/6] Asegurando nombres locales..." -ForegroundColor Cyan
$hosts="$env:SystemRoot\System32\drivers\etc\hosts"
$lines=@(Get-Content -LiteralPath $hosts -ErrorAction SilentlyContinue)
$clean=@($lines | Where-Object {$_ -notmatch '(?i)(^|\s)(andon|dci)\.local(\s|$)'})
@($clean + "$RpiIp`tandon.local" + "$RpiIp`tdci.local") |
  Set-Content -LiteralPath $hosts -Encoding ascii
ipconfig /flushdns | Out-Null

Write-Host "[5/6] Creando tarea SYSTEM persistente..." -ForegroundColor Cyan
$action=New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Target`" -RpiIp $RpiIp"

$trigger=New-ScheduledTaskTrigger -AtStartup

$settings=New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $NewTask `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User "SYSTEM" `
  -RunLevel Highest `
  -Force | Out-Null

Start-ScheduledTask -TaskName $NewTask
Start-Sleep -Seconds 3

$t=Get-ScheduledTask -TaskName $NewTask -ErrorAction Stop
if(-not $t){ throw "La tarea $NewTask no existe despues de crearla." }

Write-Host "      [OK] $($t.TaskName) estado=$($t.State)" -ForegroundColor Green

Write-Host "[6/6] Validacion inmediata..." -ForegroundColor Cyan
Start-Sleep -Seconds 5
Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$RpiIp/32" -ErrorAction SilentlyContinue |
  Format-Table DestinationPrefix,NextHop,InterfaceAlias,InterfaceIndex,RouteMetric,Store -AutoSize

Write-Host ""
Write-Host "TAREAS RELACIONADAS:" -ForegroundColor Cyan
Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object {$_.TaskName -match 'ANDON.*NetworkFix|ANDON-DCI.*WiFi'} |
  Format-Table TaskName,State -AutoSize

Write-Host ""
Write-Host "ULTIMO LOG:" -ForegroundColor Cyan
Get-Content (Join-Path $Base "wifi-watchdog.log") -Tail 12 -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[OK] R2.4.4 instalado." -ForegroundColor Green
Write-Host "El watchdog observa Wi-Fi cada 5 segundos y repara la ruta cuando se reconecta." -ForegroundColor Green
Write-Host "NO usa PersistentStore para 10.138.43.217; evita que una ruta vieja sobreviva al cambio de red." -ForegroundColor Yellow
