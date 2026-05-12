@echo off
title FitTrack Server
echo Starting FitTrack server...
echo.
echo Open your browser and go to: http://localhost:8080
echo Keep this window open while using the app.
echo Close this window to stop the server.
echo.
cd /d "%~dp0"
"C:\Program Files\nodejs\npx.cmd" serve . -l 8080
pause
