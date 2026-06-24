@echo off
rem Start the IndexTTS bridge service (port 9881) inside IndexTTS's uv env.
rem Reads the IndexTTS root dir from config.json (set it in the web "voice engine" panel).
cd /d "%~dp0"

rem Read IndexTTS root from config.json via system python
for /f "usebackq delims=" %%i in (`python -c "import json;print(json.load(open(r'%~dp0config.json',encoding='utf-8'))['engines']['indextts']['root'])"`) do set "IDXROOT=%%i"

if "%IDXROOT%"=="" (
  echo Cannot read IndexTTS root from config.json. Set it in the web Settings - Voice Engine panel first.
  pause & exit /b 1
)
echo IndexTTS root: %IDXROOT%

rem Run the bridge inside IndexTTS's uv environment; inject fastapi/uvicorn ephemerally
cd /d "%IDXROOT%"
uv run --with fastapi --with uvicorn python "%~dp0indextts_server.py"
pause
