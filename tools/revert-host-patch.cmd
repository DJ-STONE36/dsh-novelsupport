@echo off
rem Revert the one-line host patch on the installed app.asar.
rem
rem RUN THIS IN A NORMAL CONSOLE WINDOW, WITH DSH FULLY QUIT (tray included).
rem A command started from inside the DSH chat is a child of DSH and dies with it - which is
rem the one moment this has to survive. That is why this cannot be run from the chat, and why
rem tools\_revert-payload.ps1 exists for the day an independent launcher is available.
rem
rem After it prints RESULT: UNPATCHED, start DSH and drive the agent once to confirm that the
rem plugin works with the original, unpatched host.
setlocal
call "%~dp0run.cmd" patch-asar.mjs "D:\deepseekharness\resources\app.asar" --revert
echo.
echo Now start DSH again and retest the agent.
exit /b %ERRORLEVEL%
