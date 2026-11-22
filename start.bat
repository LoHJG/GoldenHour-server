@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules\werift\package.json" (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if exist "cert.pem" if exist "key.pem" (
  echo Found cert.pem and key.pem. Validating TLS...
) else (
  echo cert.pem/key.pem not found. Using HTTP/WS.
)

node src\index.js
echo.
echo Server stopped.
pause
