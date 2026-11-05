@echo off
title StreamVault TV — Wireless Install to TCL 55P635 (No USB Needed!)
cd /d "%~dp0"
set ADB="%~dp0.toolchain\android-sdk\platform-tools\adb.exe"

echo ======================================================================
echo   StreamVault TV — Zero-USB Wi-Fi Installer for TCL 55P635
echo ======================================================================
echo.
echo   One-time TV setup:
echo   1. On your TCL TV, go to Settings -^> Device Preferences -^> About
echo   2. Scroll to "Build" and press OK 7 times to enable Developer Options
echo   3. Go back one screen -^> Developer Options -^> Turn ON "Network Debugging"
echo.
set /p TV_IP="Enter your TCL TV Wi-Fi IP Address (e.g. 192.168.1.50): "

echo.
echo [1/3] Connecting to TCL 55P635 at %TV_IP%:5555 over Wi-Fi...
%ADB% connect %TV_IP%:5555

echo.
echo [2/3] Installing StreamVault-TV.apk onto your TV (Click "Allow" on TV if prompted)...
%ADB% -s %TV_IP%:5555 install -r "%~dp0StreamVault-TV.apk"

echo.
echo [3/3] Launching StreamVault TV on your TCL 55P635 screen...
%ADB% -s %TV_IP%:5555 shell am start -n com.streamvault.tv/.MainActivity

echo.
echo Done! StreamVault TV is now open on your TV screen.
pause
