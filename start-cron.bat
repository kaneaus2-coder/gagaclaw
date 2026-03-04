@echo off
:loop
node cron.js
if %errorlevel% equ 42 goto loop
pause
