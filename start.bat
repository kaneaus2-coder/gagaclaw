@echo off
:loop
node cli.js
if %ERRORLEVEL% == 42 (
    echo.
    echo [Restart] Restarting cli.js...
    echo.
    goto loop
)
