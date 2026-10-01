@echo off
setlocal
title Estado ANDON DCI WiFi Watchdog
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0VER-ESTADO-R2.4.4.ps1"
pause
