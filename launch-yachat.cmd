@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo YaChat launcher
echo Project: %CD%
echo This console will show the local link and the Wi-Fi/LAN link.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-yachat.ps1"

echo.
echo YaChat launcher finished. Keep this window if you need the links above.
pause
