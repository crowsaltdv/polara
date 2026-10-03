@echo off
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
title Polaris server

netstat -ano | findstr /R /C:":3030 .*LISTENING" >nul
if not errorlevel 1 (
  echo Polaris is already running on port 3030, so I'm opening it instead of starting a second copy.
  echo If you just updated Polaris, close the other Polaris window first, then run this again.
  start "" http://localhost:3030
  echo.
  pause
  exit /b
)

start "" http://localhost:3030
node server.js
echo.
echo Polaris stopped. Read the message above to see why.
pause
