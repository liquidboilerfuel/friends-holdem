@echo off
cd /d "%~dp0"
echo ==============================================
echo  Poker server starting...
echo  Keep this window OPEN while you play.
echo  Open in your browser:  http://localhost:3000
echo ==============================================
node src\server.js
echo.
echo Server stopped.
pause
