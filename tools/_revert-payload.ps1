# Revert the host patch on app.asar and verify it. Runs as its OWN process, started by Task
# Scheduler, so it is not a child of DSH and survives DSH exiting. ASCII only: Windows
# PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so non-ASCII here would corrupt the parse.
$ErrorActionPreference = 'Continue'
$root = 'D:\documents\GitHub\my-project'
$log = Join-Path $root '.revert-result.log'
$asar = 'D:\deepseekharness\resources\app.asar'
$target = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js'

function Say($text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  Add-Content -Path $log -Value $line
}

function Locked {
  try {
    $fs = [System.IO.File]::Open($asar, 'Open', 'ReadWrite', 'None')
    $fs.Close()
    return $false
  } catch {
    return $true
  }
}

Say "payload started (pid $PID)"

# Wait for the archive to stop being locked rather than for a process name: that is the exact
# condition the revert needs, and it also covers DSH still shutting down.
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
  if (-not (Locked)) { break }
  Start-Sleep -Seconds 2
}
if (Locked) { Say "TIMEOUT: app.asar is still locked; nothing was changed"; exit 1 }
Say "app.asar is unlocked; reverting"

$out = & (Join-Path $root 'tools\run.cmd') 'patch-asar.mjs' $asar '--revert' 2>&1
$code = $LASTEXITCODE
foreach ($line in $out) { Say ("  " + $line) }
Say "patch-asar --revert exit=$code"

# VERIFY by reading the line back out of the archive instead of trusting the exit code.
Start-Sleep -Seconds 2
$verify = & (Join-Path $root 'tools\run.cmd') 'asar-peek.mjs' $asar 'range' $target '3096' '3098' 2>&1
foreach ($line in $verify) { Say ("  " + $line) }
$joined = ($verify -join "`n")
$patchedNeedle = 'signal?' + '.throwIfAborted'
$plainNeedle = 'signal.' + 'throwIfAborted();'
if ($joined.Contains($patchedNeedle)) {
  Say "RESULT: STILL PATCHED - the revert did not take"
} elseif ($joined.Contains($plainNeedle)) {
  Say "RESULT: UNPATCHED - original host restored; start DSH and retest the agent"
} else {
  Say "RESULT: UNCLEAR - inspect the lines above by hand"
}
Say "payload done"
