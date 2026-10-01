#requires -Version 5.1
$RpiIp="10.138.43.217"
Write-Host "=== WIFI ===" -ForegroundColor Cyan
Get-NetIPConfiguration -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue |
  Select-Object InterfaceAlias,InterfaceIndex,@{N="IPv4";E={$_.IPv4Address.IPAddress}},@{N="Gateway";E={$_.IPv4DefaultGateway.NextHop}} |
  Format-List

Write-Host "=== ROUTE ===" -ForegroundColor Cyan
Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$RpiIp/32" -ErrorAction SilentlyContinue |
  Format-Table DestinationPrefix,NextHop,InterfaceAlias,InterfaceIndex,RouteMetric,Store -AutoSize

Write-Host "=== TASK ===" -ForegroundColor Cyan
Get-ScheduledTask -TaskName "ANDON-DCI-WiFiWatchdog" -ErrorAction SilentlyContinue |
  Format-List TaskName,State

Write-Host "=== LEGACY TASKS ===" -ForegroundColor Cyan
Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object {$_.TaskName -eq "ANDON-AutoNetworkFix" -or $_.TaskName -eq "ANDON-DCI-AutoNetworkFix"} |
  Format-Table TaskName,State -AutoSize

Write-Host "=== TCP80 ===" -ForegroundColor Cyan
Test-NetConnection $RpiIp -Port 80

Write-Host "=== LOG ===" -ForegroundColor Cyan
Get-Content "C:\ProgramData\ANDON-DCI-NETWORK\wifi-watchdog.log" -Tail 20 -ErrorAction SilentlyContinue
