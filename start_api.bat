@echo off
rem Start GPT-SoVITS API. Prefers the root set in the web "Voice Engine" panel
rem (config.json engines.gpt-sovits.root), else auto-detects a GPT-SoVITS* dir.
set "GSV="

rem 1) Try the path configured in the web UI
for /f "usebackq delims=" %%i in (`python -c "import json;print(json.load(open(r'%~dp0config.json',encoding='utf-8')).get('engines',{}).get('gpt-sovits',{}).get('root',''))" 2^>nul`) do set "GSV=%%i"
if not "%GSV%"=="" if not exist "%GSV%\api_v2.py" set "GSV="

rem 2) Auto-detect under the project root
if "%GSV%"=="" (
  for /d %%d in ("%~dp0GPT-SoVITS*") do if exist "%%d\api_v2.py" set "GSV=%%d"
)

if "%GSV%"=="" (
  echo Cannot find GPT-SoVITS (no api_v2.py). Set its path in the web Settings - Voice Engine panel,
  echo or place the GPT-SoVITS folder in the project root.
  pause & exit /b 1
)
echo Using GPT-SoVITS directory: %GSV%
cd /d "%GSV%"
set "PATH=%GSV%\runtime;%PATH%"
runtime\python.exe -I api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
pause
