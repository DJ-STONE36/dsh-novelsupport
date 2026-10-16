@echo off
rem Wait for DSH to quit, then apply the one-line host patch to app.asar.
rem
rem RUN THIS IN A NORMAL CONSOLE WINDOW. A command started from inside the DSH chat is a child of DSH and
rem dies with it — which is the one moment this script has to survive, because the patch needs DSH gone.
rem
rem Usage:
rem   tools\apply-host-patch.cmd                 wait (up to 15 min), then patch
rem   tools\apply-host-patch.cmd --check         report the state and exit
rem   tools\apply-host-patch.cmd --timeout 30    wait up to 30 minutes
rem
rem Node discovery and argument forwarding live in run.cmd; this only names the script.
setlocal
call "%~dp0run.cmd" wait-and-patch.mjs %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
