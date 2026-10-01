#requires -Version 5.1
param(
    [string]$RpiIp="10.138.43.217",
    [int]$IntervalSeconds=5,
    [switch]$Console
)

$ErrorActionPreference="SilentlyContinue"
$Base="C:\ProgramData\ANDON-DCI-NETWORK"
$Log=Join-Path $Base "wifi-watchdog.log"
$StatePath=Join-Path $Base "wifi-watchdog.state"
New-Item -ItemType Directory -Force -Path $Base | Out-Null

function Log([string]$Text){
    $line="$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Text"
    Add-Content -LiteralPath $Log -Value $line
    if($Console){ Write-Host $line }
}

function Get-CorpWifi {
    $cfg=Get-NetIPConfiguration -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue
    $adp=Get-NetAdapter -Name "Wi-Fi" -ErrorAction SilentlyContinue
    if(-not $cfg -or -not $adp){ return $null }

    $ip=@($cfg.IPv4Address | ForEach-Object {$_.IPAddress} |
        Where-Object {$_ -match '^10\.138\.(40|41|42|43)\.'}) | Select-Object -First 1
    $gw=@($cfg.IPv4DefaultGateway | ForEach-Object {$_.NextHop} |
        Where-Object {$_ -match '^10\.138\.'}) | Select-Object -First 1

    if($adp.Status -ne "Up" -or -not $ip -or -not $gw){ return $null }

    [pscustomobject]@{
        IP=[string]$ip
        Gateway=[string]$gw
        IfIndex=[int]$cfg.InterfaceIndex
        Alias=[string]$cfg.InterfaceAlias
    }
}

function Remove-RpiRouteAllStores {
    $prefix="$RpiIp/32"
    foreach($store in @("PersistentStore","ActiveStore")){
        try{
            @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -PolicyStore $store -ErrorAction SilentlyContinue) |
              Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
        }catch{}
    }
}

function Ensure-Route($n){
    $prefix="$RpiIp/32"
    $pcOct=($n.IP -split '\.')[2]
    $rpiOct=($RpiIp -split '\.')[2]

    # No persistent route: the watchdog owns the route lifecycle.
    try{
        @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -PolicyStore PersistentStore -ErrorAction SilentlyContinue) |
          Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
    }catch{}

    if($pcOct -eq $rpiOct){
        try{
            @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue) |
              Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
        }catch{}
        return "DIRECT"
    }

    $routes=@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix $prefix -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
    $good=@($routes | Where-Object {$_.InterfaceIndex -eq $n.IfIndex -and $_.NextHop -eq $n.Gateway})
    $bad=@($routes | Where-Object {$_.InterfaceIndex -ne $n.IfIndex -or $_.NextHop -ne $n.Gateway})

    if($bad.Count -gt 0){
        $bad | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
        Log "REMOVED_BAD_ROUTE count=$($bad.Count)"
    }

    if($good.Count -eq 0){
        New-NetRoute -AddressFamily IPv4 `
          -DestinationPrefix $prefix `
          -InterfaceIndex $n.IfIndex `
          -NextHop $n.Gateway `
          -RouteMetric 5 `
          -PolicyStore ActiveStore `
          -ErrorAction SilentlyContinue | Out-Null
        Log "ROUTE_SET $prefix via=$($n.Gateway) if=$($n.IfIndex) alias=$($n.Alias)"
    }

    return "VIA=$($n.Gateway) IF=$($n.IfIndex)"
}

function Register-Rpi {
    $u=New-Object Net.Sockets.UdpClient
    try{
        $u.Client.ReceiveTimeout=900
        $bytes=[Text.Encoding]::ASCII.GetBytes("ANDON_REGISTER_V1")
        [void]$u.Send($bytes,$bytes.Length,$RpiIp,8788)
        $ep=New-Object Net.IPEndPoint([Net.IPAddress]::Any,0)
        $reply=$u.Receive([ref]$ep)
        return [Text.Encoding]::ASCII.GetString($reply)
    }catch{
        return ""
    }finally{
        try{$u.Close()}catch{}
    }
}

$lastState=""
$lastRegister=[datetime]::MinValue
$lastTcp=$null
Log "WATCHDOG_START RPI=$RpiIp interval=${IntervalSeconds}s"

while($true){
    $n=Get-CorpWifi

    if(-not $n){
        $state="WIFI_DOWN_OR_NONCORP"
        if($state -ne $lastState){
            Log $state
            $lastState=$state
        }
        Start-Sleep -Seconds $IntervalSeconds
        continue
    }

    $state="WIFI_UP IP=$($n.IP) GW=$($n.Gateway) IF=$($n.IfIndex)"
    if($state -ne $lastState){
        Log $state
        $lastState=$state
    }

    $routeState=Ensure-Route $n

    if(((Get-Date)-$lastRegister).TotalSeconds -ge 30){
        $reply=Register-Rpi
        if($reply){ Log "UDP8788_REPLY $reply" }
        else{ Log "UDP8788_NO_REPLY route=$routeState" }
        $lastRegister=Get-Date
    }

    # Test TCP only every state change in result, avoiding noisy logs.
    $tcp=$false
    try{
        $tcp=[bool](Test-NetConnection $RpiIp -Port 80 -InformationLevel Quiet -WarningAction SilentlyContinue)
    }catch{}
    if($null -eq $lastTcp -or $tcp -ne $lastTcp){
        Log "TCP80=$tcp route=$routeState"
        $lastTcp=$tcp
    }

    Start-Sleep -Seconds $IntervalSeconds
}
