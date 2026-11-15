@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM ============================================================
REM  清理残留：结束跑着本项目的 python/pythonw 进程，并刷新托盘
REM  什么时候用：托盘里有图标但点了没反应 / 两个一样的图标 / 启动说已运行但看不到窗口
REM ============================================================

echo [1/3] 结束本项目的残留进程...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root='%~dp0';" ^
  "$me=$PID;" ^
  "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='pythonw.exe'\" -ErrorAction SilentlyContinue |" ^
  "  Where-Object { $_.CommandLine -and ($_.CommandLine -like ('*'+$root+'*') -or $_.CommandLine -like '*growth_system*') } |" ^
  "  ForEach-Object { Write-Host ('  结束 PID ' + $_.ProcessId + ' : ' + $_.CommandLine); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

if errorlevel 1 (
  echo.
  echo [!] 结束进程失败，请用管理员身份重跑本脚本。
  pause
  exit /b 1
)

echo [2/3] 刷新任务栏托盘（清掉没有宿主的幽灵图标）...
taskkill /f /im explorer.exe >nul 2>nul
timeout /t 2 /nobreak >nul
start "" explorer.exe
REM 等资源管理器把托盘重新建好，否则新图标挂上去也收不到消息
timeout /t 3 /nobreak >nul

echo [3/3] 重新启动...
start "" pythonw.exe "%~dp0宿主成长系统.pyw"

echo.
echo 完成。托盘里现在应该只剩一个图标（品牌六边形）。
echo 单击它打开面板；关窗只会收进托盘；右键 -^> 退出 才真正结束进程。
echo.
echo 如果图标仍然点不动，把 data\tray.log 的最后 20 行发出来。
timeout /t 6 >nul
