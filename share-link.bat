@echo off
cd /d "%~dp0"
echo Creating a share link (run start.bat first and keep it open).
echo Send the https://...trycloudflare.com URL to your friends.
npx cloudflared tunnel --url http://localhost:3000
pause
