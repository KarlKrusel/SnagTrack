@echo off
title SnagTrack
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found.
  echo   Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   First run - installing dependencies, please wait...
  echo.
  call npm install
)

echo.
echo   Starting SnagTrack...  ( http://127.0.0.1:7766 )
echo   Close the browser tab to quit, or close this window.
echo.

node app.js

echo.
echo   SnagTrack has stopped.
pause
