@echo off
chcp 65001 >nul
title Cherry TingShu - Stop All
echo ============================================
echo          Cherry TingShu - Stop All
echo ============================================
echo.
echo Stopping services on ports 8000 (Web), 9880 (GPT-SoVITS), 9881 (IndexTTS)...

for %%P in (8000 9880 9881) do (
  for /f "tokens=5" %%i in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    echo   - port %%P -> PID %%i, killing...
    taskkill /F /T /PID %%i >nul 2>&1
  )
)

echo.
echo Done. All Cherry TingShu services stopped.
echo (You can close this window.)
timeout /t 3 >nul
