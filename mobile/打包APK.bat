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

echo [4.7/6] Detecting a local JDK 21 (Capacitor 7 needs it)...
set "JDK21BASE=%LOCALAPPDATA%\cherry-jdk21"
set "JDK21="
call :find_jdk21 "%JDK21BASE%"
call :find_jdk21 "%JAVA_HOME%\.."
call :find_jdk21 "%ProgramFiles%\Eclipse Adoptium"
call :find_jdk21 "%ProgramFiles%\Java"
call :find_jdk21 "%ProgramFiles%\Microsoft"
call :find_jdk21 "%ProgramFiles%\Zulu"
call :find_jdk21 "%ProgramFiles%\BellSoft"
call :find_jdk21 "%ProgramFiles%\Amazon Corretto"
call :find_jdk21 "%ProgramFiles%\Semeru"
if defined JDK21 goto :jdk_found

echo.
echo [ACTION NEEDED] No JDK 21 was found on this PC.
echo Install a Java 21 (JDK) ONCE, then re-run this script:
echo   1) On the page that just opened, download the Windows x64 JDK 21 ZIP
echo      (file name like: OpenJDK21U-jdk_x64_windows_hotspot_21.0.x_y.zip)
echo   2) Unzip it INTO this folder (a jdk-21... subfolder should appear):
echo        %JDK21BASE%
echo      Final path should look like:
echo        %JDK21BASE%\jdk-21.0.x+y\bin\java.exe
echo   3) Re-run this script - it will auto-detect the JDK and continue.
echo.
if not exist "%JDK21BASE%" mkdir "%JDK21BASE%"
start "" "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/"
start "" "%JDK21BASE%"
pause
exit /b 1

:jdk_found
set "JAVA_HOME=%JDK21%"
echo   Using JDK 21: %JAVA_HOME%
if not exist "%JAVA_HOME%\bin\java.exe" ( echo [ERROR] java.exe missing at %JAVA_HOME% & pause & exit /b 1 )

echo   Pinning Gradle to JDK 21 and using a faster Gradle mirror...
powershell -NoProfile -Command "(Get-Content 'android\gradle\wrapper\gradle-wrapper.properties') -replace 'services.gradle.org/distributions','mirrors.cloud.tencent.com/gradle' -replace 'networkTimeout=10000','networkTimeout=60000' | Set-Content 'android\gradle\wrapper\gradle-wrapper.properties'"
powershell -NoProfile -Command "$p='android/gradle.properties'; $j=$env:JAVA_HOME -replace '\\','/'; $c=@(); if(Test-Path $p){ $c=Get-Content $p | Where-Object { $_ -notmatch '^org\.gradle\.java\.home' } }; ($c + ('org.gradle.java.home=' + $j)) | Set-Content $p"

echo [5/6] Building Debug APK with Gradle...
cd android
call gradlew.bat --stop >nul 2>nul
call gradlew.bat assembleDebug
if errorlevel 1 (
  echo.
  echo [ERROR] Gradle build failed.
  echo   Using JDK 21 at: %JAVA_HOME%
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
echo This APK is fully offline (JSZip and FontAwesome are bundled locally).
echo.
pause
exit /b 0

rem ---- subroutine: find a JDK 21 under a parent dir, set JDK21 if found ----
:find_jdk21
if defined JDK21 goto :eof
if "%~1"=="" goto :eof
if not exist "%~1" goto :eof
for /d %%d in ("%~1\jdk-21*") do if exist "%%d\bin\java.exe" set "JDK21=%%d"
if not defined JDK21 for /d %%d in ("%~1\*jdk*21*") do if exist "%%d\bin\java.exe" set "JDK21=%%d"
goto :eof
