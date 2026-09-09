@echo off
setlocal
set "NODE_NO_WARNINGS=1"
"%~dp0runtime\node.exe" "%~dp0lib\dist\src\cli.js" %*
exit /b %errorlevel%
