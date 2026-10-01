@echo off
setlocal EnableExtensions
title Desinstalar ANDON DCI WiFi Watchdog R2.4.4
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0DESINSTALAR-ANDON-DCI-WIFI-WATCHDOG-R2.4.4.ps1"
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
