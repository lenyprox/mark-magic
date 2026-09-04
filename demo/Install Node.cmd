@echo off
setlocal
title Install Node.js for the Vault demo
set NODE_VERSION=22.16.0

where node >nul 2>nul
if errorlevel 1 goto install
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODE_MAJOR=%%v
if %NODE_MAJOR% GEQ 20 goto already
echo Node.js v%NODE_MAJOR% is installed but the demo needs 20 or newer. Upgrading...

:install
where winget >nul 2>nul
if not errorlevel 1 (
  echo Installing Node.js LTS with winget ^(a Windows prompt may ask for permission^)...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  if not errorlevel 1 goto done
  echo winget did not finish; falling back to the installer from nodejs.org.
)

set ARCH=x64
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set ARCH=arm64
set MSI=%TEMP%\node-v%NODE_VERSION%-%ARCH%.msi
echo Downloading Node.js v%NODE_VERSION% ^(%ARCH%^) from nodejs.org...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-%ARCH%.msi' -OutFile '%MSI%'"
if errorlevel 1 (
  echo The download failed. Opening https://nodejs.org/ so you can install it by hand.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
echo Running the installer ^(a Windows prompt may ask for permission^)...
msiexec /i "%MSI%" /passive
if errorlevel 1 (
  echo The installer did not finish. Opening https://nodejs.org/ so you can install it by hand.
  start "" https://nodejs.org/
  pause
  exit /b 1
)

:done
echo.
echo Node.js is installed. Close this window, then double-click "Start Vault Demo.cmd".
echo ^(A new window is needed so it picks up the updated PATH.^)
pause
exit /b 0

:already
echo Node.js is already installed:
node -v
echo Nothing to do. Double-click "Start Vault Demo.cmd" to run the demo.
pause
exit /b 0
