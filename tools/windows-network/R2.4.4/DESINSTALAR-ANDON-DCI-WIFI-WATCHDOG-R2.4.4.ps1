#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference="Stop"

$Task="ANDON-DCI-WiFiWatchdog"
$Base="C:\ProgramData\ANDON-DCI-NETWORK"
$RpiIp="10.138.43.217"

$id=[Security.Principal.WindowsIdentity]::GetCurrent()
$p=New-Object Security.Principal.WindowsPrincipal($id)
if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw "Ejecuta como Administrador."
}

try{Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue}catch{}
try{Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue}catch{}

foreach($store in @("PersistentStore","ActiveStore")){
    @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$RpiIp/32" -PolicyStore $store -ErrorAction SilentlyContinue) |
      Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
}

Remove-Item (Join-Path $Base "WATCHDOG-ANDON-DCI-R2.4.4.ps1") -Force -ErrorAction SilentlyContinue

$hosts="$env:SystemRoot\System32\drivers\etc\hosts"
if(Test-Path $hosts){
    $lines=@(Get-Content $hosts -ErrorAction SilentlyContinue)
    @($lines | Where-Object {$_ -notmatch '(?i)(^|\s)(andon|dci)\.local(\s|$)'}) |
      Set-Content $hosts -Encoding ascii
}
ipconfig /flushdns | Out-Null

Write-Host "[OK] Watchdog R2.4.4 desinstalado." -ForegroundColor Green
Write-Host "Se conserva el log para diagnostico: $Base\wifi-watchdog.log" -ForegroundColor Yellow
Write-Host "No se reinstalan automatismos legacy retirados porque eran los que podian reinyectar la ruta incorrecta." -ForegroundColor Yellow
