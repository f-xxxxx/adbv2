@echo off
setlocal

REM 切换到脚本所在目录（项目根目录）
cd /d "%~dp0"

REM 调用 PowerShell 启动脚本
powershell -ExecutionPolicy Bypass -File "%~dp0start_windows.ps1"

if errorlevel 1 (
  echo.
  echo 启动失败，请检查上方错误信息。
  pause
  exit /b 1
)

endlocal
