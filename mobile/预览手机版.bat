@echo off
title Cherry TingShu Mobile - Web Preview
cd /d "%~dp0"

echo ============================================
echo        Cherry TingShu Mobile - Preview
echo ============================================
echo.
echo Local:   http://localhost:8090
echo Phone (same WiFi as this PC):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo     http://%%b:8090
)
echo.
echo Note: Service Worker needs https or localhost; over a LAN IP the
echo       offline/install features are limited, but reading and audio work.
echo       Close this window to stop the preview.
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found. Please install Python or add it to PATH.
  pause & exit /b 1
)

python -m http.server 8090
pause
