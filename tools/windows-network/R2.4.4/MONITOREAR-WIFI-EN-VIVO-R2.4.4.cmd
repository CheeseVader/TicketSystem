@echo off
setlocal
title ANDON DCI WiFi Watchdog - EN VIVO
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0WATCHDOG-ANDON-DCI-R2.4.4.ps1" -Console
