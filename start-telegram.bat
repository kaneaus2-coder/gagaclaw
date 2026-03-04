@echo off
:loop
node telegram.js
if %ERRORLEVEL% == 42 (
    echo.
    echo [Restart] Restarting telegram.js...
    echo.
    goto loop
)
 