@echo off
chcp 65001 >nul
title 宿主成长系统 · 开机自启设置
cd /d "%~dp0"

echo.
echo   开启后：登录 Windows 时自动启动「宿主成长系统」窗口，
echo           关掉窗口也不会退出，而是留在托盘里继续提醒。
echo   关闭后：不再自动启动，但面板仍可手动双击打开。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\宿主成长系统提醒.lnk';" ^
  "if (Test-Path $p) { Remove-Item $p -Force; Write-Host '已关闭开机自启。' -ForegroundColor Yellow }" ^
  "else {" ^
  "  $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p);" ^
  "  $s.TargetPath='pythonw.exe';" ^
  "  $s.Arguments='\"' + (Resolve-Path '宿主成长系统.pyw').Path + '\"';" ^
  "  $s.WorkingDirectory=(Get-Location).Path;" ^
  "  $s.WindowStyle=7;" ^
  "  $s.Save();" ^
  "  Write-Host '已开启开机自启。下次登录 Windows 时面板会自动启动（关窗后留在托盘）。' -ForegroundColor Green" ^
  "}"

echo.
echo   提示：也可以在托盘图标上右键 -^> 「开机自启」切换。
echo.
pause
