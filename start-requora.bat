@echo off
title ReQuora - local server
cd /d "%~dp0backend"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Download the LTS version from https://nodejs.org
  echo Install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing packages. This takes a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist .env (
  echo Creating your settings file...
  copy .env.example .env >nul
  node -e "const fs=require('fs');const s=require('crypto').randomBytes(48).toString('hex');fs.writeFileSync('.env',fs.readFileSync('.env','utf8').replace(/^JWT_SECRET=.*$/m,'JWT_SECRET='+s));"
)

echo.
echo Starting ReQuora... your browser will open at http://localhost:5000
echo Leave this window open while you use the website. Close it to stop.
echo.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:5000"
call npm start
echo.
echo ReQuora stopped. If you saw an error above, copy it and send it to me.
pause
