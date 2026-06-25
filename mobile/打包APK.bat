@echo off
title Cherry TingShu Mobile - Build APK
cd /d "%~dp0"

echo ============================================
echo        Cherry TingShu Mobile - Build APK
echo ============================================
echo Requirement: Node.js only.
echo The Android SDK and JDK 21 are downloaded automatically (no Android Studio).
echo First run downloads ~hundreds of MB; later runs are fast.
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js / npm not found. Install from https://nodejs.org
  pause & exit /b 1
)

echo [1/6] Preparing www folder (web assets only, no node_modules/android)...
if exist www rmdir /s /q www
mkdir www
copy /y index.html www\ >nul
copy /y manifest.webmanifest www\ >nul
copy /y sw.js www\ >nul
copy /y logo.svg www\ >nul
copy /y favicon.svg www\ >nul
xcopy /e /i /y css www\css >nul
xcopy /e /i /y js www\js >nul
xcopy /e /i /y vendor www\vendor >nul
if exist icons xcopy /e /i /y icons www\icons >nul

echo [2/6] Initializing Capacitor (first run downloads deps)...
if not exist package.json call npm init -y >nul
if not exist node_modules\@capacitor\cli (
  call npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/app
  if errorlevel 1 ( echo [ERROR] Failed to install Capacitor deps & pause & exit /b 1 )
)
if not exist node_modules\@capacitor\app (
  call npm install @capacitor/app
)
if not exist capacitor.config.json if not exist capacitor.config.ts (
  call npx cap init "Cherry TingShu" "com.cherry.tingshu" --web-dir=www
  if errorlevel 1 ( echo [ERROR] cap init failed & pause & exit /b 1 )
)

echo [3/6] Adding Android platform...
if not exist android (
  call npx cap add android
  if errorlevel 1 ( echo [ERROR] cap add android failed & pause & exit /b 1 )
)

echo [4/6] Syncing web assets into the Android project...
call npx cap copy
if errorlevel 1 ( echo [ERROR] cap copy failed & pause & exit /b 1 )

echo [4.2/6] Applying custom app name and launcher icon (cap-res)...
if exist cap-res xcopy /e /i /y cap-res "android\app\src\main\res" >nul

echo [4.5/6] Setting up Android SDK (command-line, no Android Studio needed)...
set "SDKDIR=%LOCALAPPDATA%\Android\Sdk"
if defined ANDROID_HOME if exist "%ANDROID_HOME%\cmdline-tools" set "SDKDIR=%ANDROID_HOME%"
set "CLT=%SDKDIR%\cmdline-tools\latest"

if not exist "%CLT%\bin\sdkmanager.bat" (
  echo   Downloading Android command-line tools...
  if not exist "%SDKDIR%" mkdir "%SDKDIR%"
  curl -L -o "%TEMP%\cmdtools.zip" "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
  if errorlevel 1 ( echo [ERROR] Download failed. Check your network/proxy. & pause & exit /b 1 )
  if exist "%TEMP%\cmdtools_x" rmdir /s /q "%TEMP%\cmdtools_x"
  mkdir "%TEMP%\cmdtools_x"
  tar -xf "%TEMP%\cmdtools.zip" -C "%TEMP%\cmdtools_x"
  if errorlevel 1 ( echo [ERROR] Failed to unzip command-line tools. & pause & exit /b 1 )
  if not exist "%CLT%" mkdir "%CLT%"
  xcopy /e /i /y "%TEMP%\cmdtools_x\cmdline-tools\*" "%CLT%\" >nul
)

set "ANDROID_HOME=%SDKDIR%"
set "ANDROID_SDK_ROOT=%SDKDIR%"
set "PATH=%CLT%\bin;%SDKDIR%\platform-tools;%PATH%"

echo   Accepting licenses and installing SDK packages...
echo   (first time downloads a few hundred MB, please wait)
> "%TEMP%\sdk_yes.txt" (for /l %%i in (1,1,60) do @echo y)
call "%CLT%\bin\sdkmanager.bat" --sdk_root="%SDKDIR%" --licenses < "%TEMP%\sdk_yes.txt" >nul
call "%CLT%\bin\sdkmanager.bat" --sdk_root="%SDKDIR%" "platform-tools" "platforms;android-36" "build-tools;36.0.0" < "%TEMP%\sdk_yes.txt"
if errorlevel 1 ( echo [ERROR] SDK package install failed. & pause & exit /b 1 )

echo   SDK ready: %SDKDIR%
> android\local.properties echo sdk.dir=%SDKDIR:\=/%

echo [4.7/6] Ensuring JDK 21 (Capacitor 7 requires it)...
set "JDK21BASE=%LOCALAPPDATA%\cherry-jdk21"
set "JDK21="
if exist "%JDK21BASE%" for /d %%d in ("%JDK21BASE%\jdk-21*") do set "JDK21=%%d"
if not defined JDK21 (
  echo   Downloading Temurin JDK 21...
  if not exist "%JDK21BASE%" mkdir "%JDK21BASE%"
  curl -L -o "%TEMP%\jdk21.zip" "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk"
  if errorlevel 1 ( echo [ERROR] JDK 21 download failed. & pause & exit /b 1 )
  tar -xf "%TEMP%\jdk21.zip" -C "%JDK21BASE%"
  for /d %%d in ("%JDK21BASE%\jdk-21*") do set "JDK21=%%d"
)
set "JAVA_HOME=%JDK21%"
echo   JAVA_HOME=%JAVA_HOME%

echo   Pointing Gradle wrapper to a faster mirror...
powershell -NoProfile -Command "(Get-Content 'android\gradle\wrapper\gradle-wrapper.properties') -replace 'services.gradle.org/distributions','mirrors.cloud.tencent.com/gradle' -replace 'networkTimeout=10000','networkTimeout=60000' | Set-Content 'android\gradle\wrapper\gradle-wrapper.properties'"

echo [5/6] Building Debug APK with Gradle...
cd android
call gradlew.bat assembleDebug
if errorlevel 1 (
  echo.
  echo [ERROR] Gradle build failed.
  echo   Make sure JAVA_HOME points to a JDK 17 (current: %JAVA_HOME%).
  echo   See the Gradle output above for the exact cause, then re-run this script.
  cd ..
  pause & exit /b 1
)
cd ..

echo [6/6] Copying the APK to this folder...
copy /y "android\app\build\outputs\apk\debug\app-debug.apk" "CherryTingShu.apk" >nul

echo.
echo ============================================
echo  Done! Installer: %~dp0CherryTingShu.apk
echo ============================================
echo Note: the web app uses JSZip / FontAwesome via CDN. For a fully
echo       offline APK, localize these two libraries first (ask the assistant).
echo.
pause
