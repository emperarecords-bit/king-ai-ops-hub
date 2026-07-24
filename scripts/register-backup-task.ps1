# Registers the nightly 03:00 backup with Windows Task Scheduler for the
# current user. Idempotent: re-running replaces the existing task.
#
# Run once: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1

$ErrorActionPreference = 'Stop'

$taskName = 'KingAiOpsHub-NightlyBackup'
$scriptPath = Join-Path $PSScriptRoot 'backup.ps1'
if (-not (Test-Path $scriptPath)) { throw "backup.ps1 not found at $scriptPath" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -Daily -At 03:00

# StartWhenAvailable: if the machine is asleep at 03:00, run at next wake.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Nightly pg_dump of king_ai_hub to Backups + OneDrive (see scripts/backup.ps1)' `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
Write-Output "OK registered '$taskName' (state: $($task.State)) -- daily at 03:00, catch-up on wake."
