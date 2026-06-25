@echo off
cd /d "%~dp0"
title Cherry TingShu - Launcher
echo ============================================
echo            Cherry TingShu - Start
echo ============================================
echo.
echo Starting Web service (port 8000)...
start "TingShu Web Service" cmd /c "python -m uvicorn app.server:app --host 127.0.0.1 --port 8000"

echo.
echo Voice engines are NOT auto-started.
echo Open the web page, go to Settings - Voice Engine, and start
echo GPT-SoVITS / IndexTTS there with the on/off switches when needed.
echo Without any engine you can still import pre-generated packs and listen offline.
echo.

echo Waiting for the web service, then opening the browser...
timeout /t 4 >nul
start http://127.0.0.1:8000

echo.
echo Started. Browser opens http://127.0.0.1:8000
echo (You can close this window; the web service keeps running.)
pause
