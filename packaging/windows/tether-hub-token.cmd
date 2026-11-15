@echo off
rem Tether Hub token CLI (installed version): uses HUB_DATA_DIR from the service config, requires administrator.
chcp 65001 >nul
setlocal
set "CFG=%ProgramData%\tether-hub\config.env"
net session >nul 2>&1
if errorlevel 1 goto elevate
if "%~1"=="" goto usage
"%~dp0node.exe" --env-file="%CFG%" "%~dp0dist\token-cli.js" %*
exit /b %errorlevel%

:usage
echo Tether Hub token 命令行
echo.
echo   tether-hub-token create ^<名称^>   签发新 token（明文只显示一次）
echo   tether-hub-token list            列出 token
echo   tether-hub-token revoke ^<名称^>   吊销 token，使用它的机器约 1 秒内断开
echo.
endlocal & cd /d "%~dp0"
exit /b 0

:elevate
if not "%~1"=="" (
  echo 需要管理员权限：请在「以管理员身份运行」的命令提示符中执行。
  exit /b 1
)
rem 无参数打开（如开始菜单）：以管理员身份另开一个命令行窗口
set SELF="%~f0"
powershell -NoProfile -Command "Start-Process cmd.exe -Verb RunAs -ArgumentList ('/k ' + $env:SELF)"
echo 已请求以管理员身份打开 token 命令行窗口，此窗口可关闭。
exit /b 0
