@echo off
chcp 65001 >nul
title 立川木业木材管理系统

rem ============================================================
rem  双击本文件启动系统；关掉这个窗口就等于停止系统
rem  电脑重启后服务不会自动起来，需要再双击一次
rem ============================================================

cd /d "%~dp0"

rem 已经在跑就直接打开浏览器，不用重复启动
netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul 2>nul
if %errorlevel%==0 (
  echo.
  echo   系统已经在运行，直接打开浏览器...
  start "" http://localhost:3001
  rem <nul 是为了在非交互环境里也能用（比如从别的程序调用时）
  timeout /t 2 /nobreak <nul >nul 2>nul
  exit /b 0
)

rem 找 Node：优先用 PATH 里的，其次用本机自带的那份
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE (
  set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not exist "%NODE_EXE%" if /i not "%NODE_EXE%"=="node" (
  echo.
  echo   [错误] 找不到 Node 运行环境，无法启动。
  echo   请确认 node.exe 的位置后，修改本文件里的 NODE_EXE。
  echo.
  pause
  exit /b 1
)

echo.
echo   立川木业木材管理系统 正在启动...
echo   约 3 秒后会自动打开浏览器；这个窗口不要关（关了系统就停了）。
echo.

rem 后台等 3 秒再开浏览器，保证打开时服务已经起来了
start "" /min cmd /c "timeout /t 3 /nobreak <nul >nul 2>nul && explorer http://localhost:3001"

"%NODE_EXE%" server\index.js

echo.
echo   系统已停止。按任意键关闭窗口。
pause >nul
