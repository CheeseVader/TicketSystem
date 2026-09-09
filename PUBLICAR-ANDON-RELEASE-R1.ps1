#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ProjectRoot = "C:\Users\igarcia\Videos\andon",
    [string]$GitHubOwner = "CheeseVader",
    [string]$CodeRepoName = "TicketSystem",
    [string]$ReleaseRepoName = "TicketSystem-Release",
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m){ Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok([string]$m){ Write-Host "[OK] $m" -ForegroundColor Green }
function Fail([string]$m){ throw $m }
function Run-Git([string[]]$A){ & git.exe @A; if($LASTEXITCODE -ne 0){ Fail "git fallo: $($A -join ' ')" } }
function Run-Gh([string[]]$A){ & gh.exe @A; if($LASTEXITCODE -ne 0){ Fail "gh fallo: $($A -join ' ')" } }

if(-not (Test-Path $ProjectRoot)){ Fail "No existe $ProjectRoot" }
foreach($cmd in @("git.exe","gh.exe","tar.exe")){
    if(-not (Get-Command $cmd -ErrorAction SilentlyContinue)){ Fail "No encontre $cmd" }
}
& gh.exe auth status *> $null
if($LASTEXITCODE -ne 0){ Fail "GitHub CLI no autenticado. Ejecuta: gh auth login" }

Set-Location $ProjectRoot
$codeRepo = "$GitHubOwner/$CodeRepoName"
$releaseRepo = "$GitHubOwner/$ReleaseRepoName"

$origin = ((& git.exe remote get-url origin) | Out-String).Trim()
if($origin -notmatch "(?i)github\.com[:/]+$([regex]::Escape($GitHubOwner))/$([regex]::Escape($CodeRepoName))(?:\.git)?$"){
    Fail "origin no apunta a $codeRepo. Actual: $origin"
}

if([string]::IsNullOrWhiteSpace($Version)){
    if(Test-Path ".\VERSION"){ $Version = (Get-Content ".\VERSION" -Raw).Trim() }
    if([string]::IsNullOrWhiteSpace($Version)){
        $Version = Read-Host "Version a publicar (ej. 1.0.0)"
    }
}
$Version = $Version.Trim().TrimStart("v")
if($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$'){
    Fail "Version invalida: $Version"
}
$tag = "v$Version"
Set-Content ".\VERSION" $Version -Encoding ASCII

Step "Validando sintaxis y dependencias"
& node.exe --check ".\src\server.js"
if($LASTEXITCODE -ne 0){ Fail "src/server.js tiene error de sintaxis." }
if(Test-Path ".\package-lock.json"){
    & npm.cmd ci
}else{
    & npm.cmd install
}
if($LASTEXITCODE -ne 0){ Fail "npm fallo." }

Step "Guardando codigo en GitHub"
Run-Git @("add",".")
$status = ((& git.exe status --porcelain) | Out-String).Trim()
if($status){ Run-Git @("commit","-m","release: ANDON $tag") }
$branch = ((& git.exe branch --show-current) | Out-String).Trim()
Run-Git @("push","origin",$branch)
$commit = ((& git.exe rev-parse "HEAD") | Out-String).Trim()

Step "Generando paquete Release limpio"
$out = Join-Path $ProjectRoot "release-output"
if(Test-Path $out){ Remove-Item $out -Recurse -Force }
New-Item $out -ItemType Directory | Out-Null
$stage = Join-Path $out "andon-$Version"
New-Item $stage -ItemType Directory | Out-Null

# Usa el snapshot exacto committeado; evita .env/node_modules/backups por no estar versionados.
$archiveTar = Join-Path $out "source.tar"
& git.exe archive --format=tar --output=$archiveTar HEAD
if($LASTEXITCODE -ne 0){ Fail "git archive fallo." }
& tar.exe -xf $archiveTar -C $stage
if($LASTEXITCODE -ne 0){ Fail "No pude extraer snapshot." }
Remove-Item $archiveTar -Force

# Evitar incluir herramientas de publicacion dentro del runtime si se desea conservarlas en codigo.
foreach($p in @(".git",".env","node_modules","release-output","backups")){
    $candidate = Join-Path $stage $p
    if(Test-Path $candidate){ Remove-Item $candidate -Recurse -Force }
}

$asset = "andon-rpi-$Version.tar.gz"
$assetPath = Join-Path $out $asset
Push-Location $stage
try{
    & tar.exe -czf $assetPath .
    if($LASTEXITCODE -ne 0){ Fail "tar.gz fallo." }
}finally{ Pop-Location }

$sha = (Get-FileHash -Algorithm SHA256 $assetPath).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    format = 1
    app = "ANDON"
    version = $Version
    tag = $tag
    asset = $asset
    sha256 = $sha
    source_repo = $codeRepo
    source_commit = $commit
    port = 3000
    created_utc = [DateTime]::UtcNow.ToString("o")
}
$manifestPath = Join-Path $out "release-manifest.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content $manifestPath -Encoding UTF8

Step "Publicando GitHub Release $tag"
& gh.exe release view $tag --repo $releaseRepo *> $null
if($LASTEXITCODE -eq 0){ Fail "Ya existe el Release $tag en $releaseRepo. Incrementa VERSION." }

Run-Gh @(
    "release","create",$tag,
    $assetPath,
    $manifestPath,
    "--repo",$releaseRepo,
    "--title","ANDON $tag",
    "--notes","ANDON estable $tag`nSource commit: $commit"
)

Run-Git @("tag","-a",$tag,"-m","ANDON $tag")
Run-Git @("push","origin",$tag)

Ok "Release publicado: $releaseRepo / $tag"
Write-Host "Asset : $asset"
Write-Host "SHA256: $sha"
