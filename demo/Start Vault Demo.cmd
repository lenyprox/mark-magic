@echo off
setlocal
title Vault demo
cd /d "%~dp0"
if not exist package.json cd ..

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Running "Install Node.cmd" for you...
  call "%~dp0Install Node.cmd"
  echo When Node.js is installed, double-click "Start Vault Demo.cmd" again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or newer is required ^(found v%NODE_MAJOR%^). Run "Install Node.cmd" to upgrade, then start this again.
  pause
  exit /b 1
)

node demo\check-deps.cjs
if errorlevel 1 (
  echo.
  echo The bundled dependencies were built for another Node.js version. Reinstalling them for this machine ^(one time, needs internet^)...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo npm ci failed. Check the messages above, then run this file again.
    pause
    exit /b 1
  )
)

if not exist "apps\web\.next\BUILD_ID" (
  echo Building the web app ^(one time, a few minutes^)...
  call npm run web:build
  if errorlevel 1 (
    echo The build failed. Check the messages above.
    pause
    exit /b 1
  )
)

set PORT=3000
if not "%~1"=="" set PORT=%~1
set MTG_ROOT=%CD%
echo.
echo Starting Vault at http://localhost:%PORT%   ^(close this window to stop the demo^)
echo The browser opens by itself once the server answers.
echo.
start "" /b node demo\open-browser.mjs %PORT%
call npm run web:start
echo.
echo The server stopped.
pause
