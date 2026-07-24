# Registers the hourly standing-work tick with Windows Task Scheduler for the
# current user. Idempotent: re-running replaces the existing task.
#
# Run once: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-standing-work-task.ps1

$ErrorActionPreference = 'Stop'

$taskName = 'KingAiOpsHub-StandingWork'
$repoRoot = Split-Path -Parent $PSScriptRoot
$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue)
if (-not $npx) { throw 'npx.cmd not found on PATH; install Node.js first.' }

# --conditions=react-server: the domain layer imports `server-only`, whose
# default export throws outside a server runtime. That package ships an empty
# module under this condition, which is exactly what a Node script needs.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c cd /d `"$repoRoot`" && npx tsx --conditions=react-server scripts\run-standing-work.ts >> `"$env:USERPROFILE\Backups\king-ai-hub\standing-work.log`" 2>&1"

# Hourly, on the hour, catch-up on wake. The tick is idempotent per window:
# next_run_at advances before execution, so overlapping or missed ticks can
# never double-run a schedule.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 45)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Hourly standing-work tick for King AI Ops Hub (see scripts/run-standing-work.ts)' `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
Write-Output "OK registered '$taskName' (state: $($task.State)) -- hourly, catch-up on wake, logs to Backups\king-ai-hub\standing-work.log"
