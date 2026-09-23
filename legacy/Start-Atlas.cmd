@echo off
cd /d "%~dp0"
echo Opening the Atlas local development server at http://127.0.0.1:4318
echo Use sample information only. Press Ctrl+C to stop.
node server/index.mjs
pause
