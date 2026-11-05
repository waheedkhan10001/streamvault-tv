@echo off
title StreamVault TV — Local PC Simulator
cd /d "%~dp0"
echo ================================================================
echo   StreamVault TV — Local PC Simulator (TCL 55P635 Preview)
echo   - Use Keyboard Arrow Keys (Up/Down/Left/Right), Enter, Esc
echo   - Or click with your mouse!
echo ================================================================
start "" "http://localhost:8765/tv"
node "%~dp0pc-runner\server.js"
pause
