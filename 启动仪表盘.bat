@echo off
chcp 65001 >nul 2>&1

cd /d "%~dp0"

echo ========================================
echo    LM Studio Monitor Dashboard
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found in PATH
    echo Install Node.js: https://nodejs.org
    pause
    exit /b 1
)

echo [1/4] Checking LM Studio...
curl -s http://localhost:1234/v1/models >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] LM Studio not detected on port 1234
    echo.
)

echo [2/4] Installing dependencies...
cd proxy
call npm install >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed
    cd ..
    pause
    exit /b 1
)
cd ..

echo [3/4] Starting proxy on port 7890...
start "LM Studio Proxy" cmd /k "cd /d "%~dp0proxy" && node server.js"

echo [4/4] Opening dashboard...
timeout /t 2 /nobreak >nul
start "" "dashboard.html"

echo.
echo ========================================
echo  Ready!
echo ========================================
echo.
echo  Proxy:     http://localhost:7890
echo  Dashboard: dashboard.html
echo.
echo  Set API Base URL to:
echo  http://localhost:7890/v1
echo.
pause
