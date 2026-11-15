@echo off
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 需要安装 Python 才能启动系统服务。
  pause
  exit /b 1
)
REM 端口由 server.py 决定：8765 被别的程序占用时会自动换端口，并把实际地址写进 data\port.txt
if exist "data\port.txt" del "data\port.txt"
start "growth_system" /min python server.py
REM 等服务写出实际端口后再开浏览器（最多等 10 秒）
set "PORTFILE=data\port.txt"
for /l %%i in (1,1,20) do (
  if exist "%PORTFILE%" goto :openbrowser
  timeout /t 1 /nobreak >nul
)
:openbrowser
set "PORT=8765"
if exist "%PORTFILE%" set /p PORT=<"%PORTFILE%"
if "%PORT%"=="" set "PORT=8765"
start "" "http://127.0.0.1:%PORT%"
