@echo off
rem Run one of the tools/ scripts without needing node on PATH.
rem
rem `node` is not on PATH on this machine, and the DSH runtime that does exist lives under
rem D:\dsh-home\dsh-runtimes\... — so every suite in tools/ was unrunnable by hand. This finds a
rem node and runs the named script.
rem
rem Usage, from the repository root:
rem   tools\run.cmd agent-smoke.mjs
rem   tools\run.cmd impl-selftest.mjs
rem   tools\run.cmd api-selftest.mjs --root D:\some\project
rem
rem Deliberately written as one statement per line with no parenthesised blocks: cmd.exe closes a
rem block at the first `)`, and `%ProgramFiles(x86)%` inside one silently truncates the command.
setlocal
set "HERE=%~dp0"
set "SCRIPT=%~1"
if "%SCRIPT%"=="" goto :usage
shift

set "NODE="

rem 1. node on PATH, if it is there.
for %%N in (node.exe) do if not defined NODE if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"

rem 2. The DSH bundled runtime, whichever version directory it sits in. `dir /s` does the
rem    wildcard expansion that a bare `for` will not do on a quoted path.
if not defined NODE call :find_dsh_runtime

rem 3. Ordinary install locations.
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE goto :nonode

rem `%*` is deliberately NOT used: `shift` renumbers %1..%9 but leaves %* holding the ORIGINAL
rem arguments, so `%*` re-passes the script name. live-check.mjs reads its first argument as the
rem project root, so through this wrapper it was handed "live-check.mjs" and failed nine checks.
rem Up to eight arguments are forwarded; these scripts take at most two.
"%NODE%" "%HERE%%SCRIPT%" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

rem A wildcard in the middle of a path is not something `dir /s` expands (it answers "The filename,
rem directory name, or volume label syntax is incorrect"), so the version directories are walked
rem one at a time instead.
:find_dsh_runtime
if not exist "D:\dsh-home\dsh-runtimes" exit /b 0
for /d %%R in ("D:\dsh-home\dsh-runtimes\*") do call :try_runtime "%%~fR"
exit /b 0

:try_runtime
if defined NODE exit /b 0
if exist "%~1\dependencies\node\bin\node.exe" set "NODE=%~1\dependencies\node\bin\node.exe"
exit /b 0

:usage
echo usage: run.cmd ^<script^> [args...]
echo   e.g. run.cmd agent-smoke.mjs
echo        run.cmd impl-selftest.mjs
exit /b 2

:nonode
echo run.cmd: could not find node.exe
echo   Looked on PATH, under D:\dsh-home\dsh-runtimes\^*\dependencies\node\bin, and the usual install paths.
echo   Set one explicitly:  set NODE=C:\path\to\node.exe
exit /b 1
