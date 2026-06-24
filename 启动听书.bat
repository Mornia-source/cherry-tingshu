@echo off
cd /d "%~dp0"
title Cherry TingShu - Launcher
echo ============================================
echo            Cherry TingShu - Start All
echo ============================================
echo.
echo [1/3] Starting GPT-SoVITS voice engine (port 9880)...
echo       First load takes 1-2 min, please wait
start "GPT-SoVITS Engine" cmd /c "%~dp0start_api.bat"

echo [2/3] Starting Web service (port 8000)...
start "TingShu Web Service" cmd /c "python -m uvicorn app.server:app --host 127.0.0.1 --port 8000"

echo.
echo NOTE: IndexTTS is NOT auto-started (it is heavy and competes for GPU/VRAM).
echo       Start it MANUALLY only when you need it, by running:  start_indextts.bat
echo       Tip: on an 8GB laptop GPU, run only ONE engine at a time.
echo.

echo [3/3] Waiting for services then opening browser...
timeout /t 6 >nul
start http://127.0.0.1:8000

echo.
echo Started! Browser will open http://127.0.0.1:8000
echo If a voice engine is still loading, wait a bit before reading aloud.
echo.
echo To stop: close the popped-up engine/web windows.
echo (This window can be closed safely, it does not affect running services)
pause
