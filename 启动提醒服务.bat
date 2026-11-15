@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "提醒服务.pyw" (
  echo 找不到 提醒服务.pyw
  pause
  exit /b 1
)
REM 桌面版（宿主成长系统.pyw）关窗后常驻托盘，并自带提醒和图标。
REM 它在跑时再起本服务，托盘上就会出现两个图标 → 先探它的锁端口 8768。
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',8768)).Close();exit 0}catch{exit 1}"
if not errorlevel 1 (
  echo 桌面版已在运行（自带托盘与提醒），无需再启动提醒服务。
  echo 需要图标就用托盘里那一个；要单独跑提醒服务，先右键托盘退出桌面版。
  timeout /t 3 >nul
  exit /b 0
)
start "" pythonw.exe "%~dp0提醒服务.pyw"
