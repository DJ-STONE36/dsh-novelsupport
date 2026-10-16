# Stop tracking generated artifacts and the plugin's own backup churn.
#
# WHY A SCRIPT AND NOT FOUR PASTED COMMANDS.
#   1. `.gitignore` must stay valid UTF-8; `Add-Content` in PowerShell 5.1 writes ANSI by
#      default, which would corrupt the existing Chinese comments in that file.
#   2. `novel/` holds non-ASCII names; paths have to be enumerated with `-z` and passed
#      through unchanged, or git receives mangled paths and silently matches nothing.
#   3. The obvious one-liner `git rm --cached -r --cached <path>` is invalid - `--cached`
#      twice makes git error out, which is exactly what happened the first time.
#
# `--cached` never touches your files on disk. It only stops tracking them from now on.
$ErrorActionPreference = 'Stop'
Set-Location 'D:\documents\GitHub\my-project'

Write-Host '1) appending ignore rules (UTF-8, no BOM, CRLF)...'
$ignore = Join-Path (Get-Location) '.gitignore'
$existing = [System.IO.File]::ReadAllText($ignore)
$block = @(
  '',
  '# 构建产物与插件的自动备份（可随时由工具/插件重新生成，不该进版本库）',
  '*.tgz',
  '*.prev',
  '*.bak-*'
) -join "`r`n"
if ($existing -match '(?m)^\*\.prev\s*$') {
  Write-Host '   rules already present; leaving .gitignore alone'
} else {
  [System.IO.File]::WriteAllText($ignore, $existing.TrimEnd() + "`r`n" + $block + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '   done'
}

Write-Host '2) stopping tracking of the tarball...'
$tgz = @(git ls-files -- '*.tgz')
if ($tgz.Count -gt 0) {
  git rm --cached -- @tgz | Out-Null
  Write-Host ("   untracked: " + ($tgz -join ', '))
} else {
  Write-Host '   nothing tracked'
}

Write-Host '3) stopping tracking of the backup churn under novel/...'
# `-z` keeps paths verbatim (no quoting), so a Chinese filename survives the round trip.
$all = git ls-files -z | ForEach-Object { $_ -split "`0" } | Where-Object { $_ -ne '' }
$churn = @($all | Where-Object { $_ -like 'novel/*' -and ($_ -like '*.prev' -or $_ -like '*.bak-*') })
if ($churn.Count -gt 0) {
  $churn | ForEach-Object { Write-Host ("   - " + $_) }
  $churn | ForEach-Object { git rm --cached --quiet -- $_ }
  Write-Host ("   untracked {0} file(s)" -f $churn.Count)
} else {
  Write-Host '   nothing tracked'
}

Write-Host ''
Write-Host '4) result:'
git status --short
Write-Host ''
Write-Host 'Files are still on disk; only tracking changed. Review the list above, then:'
Write-Host '   git commit -m "chore: 不再跟踪构建产物与插件的备份文件"'
Write-Host '   git push'
Write-Host ''
Write-Host 'NOTE: these files remain in the earlier commit 0ad6bc5 in HISTORY.'
Write-Host 'Removing them from history needs a rewrite + force-push, which is a separate decision.'
