$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (!(Test-Path .env)) { Copy-Item .env.example .env }
Write-Host '1/4 Levantando PostgreSQL con Docker...' -ForegroundColor Cyan
docker compose up -d
Write-Host '2/4 Instalando dependencias Node.js...' -ForegroundColor Cyan
npm install
Write-Host '3/4 Inicializando base de datos...' -ForegroundColor Cyan
npm run db:init
Write-Host '4/4 Iniciando Andon Support...' -ForegroundColor Green
npm start
