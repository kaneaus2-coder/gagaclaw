@echo off
:loop
node telegram.js telegram-agent
if %ERRORLEVEL% == 42 (
    echo.
    echo [Restart] Restarting telegram.js telegram-agent...
    echo.
    goto loop
)
