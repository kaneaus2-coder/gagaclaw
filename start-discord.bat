@echo off
:loop
node discord.js discord-bot
if %ERRORLEVEL% == 42 (
    echo.
    echo [Restart] Restarting discord.js discord-bot...
    echo.
    goto loop
)
