@echo off
:loop
node discord.js
if %ERRORLEVEL% == 42 (
    echo.
    echo [Restart] Restarting discord.js...
    echo.
    goto loop
)
