# Nightly logical backup of the King AI Ops Hub database.
#
# Strategy (SPRINT-03-PLAN.md §6): pg_dump custom format from the Docker
# container -> %USERPROFILE%\Backups\king-ai-hub, then a copy to OneDrive for
# off-machine durability. 30-day retention on both sides.
#
# Run manually:            powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1
# Registered for 03:00 by: scripts\register-backup-task.ps1

$ErrorActionPreference = 'Stop'

$container = 'king-ai-hub-db'
$dbUser = 'king'
$dbName = 'king_ai_hub'
$retentionDays = 30

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$fileName = "king_ai_hub-$stamp.dump"

$localDir = Join-Path $env:USERPROFILE 'Backups\king-ai-hub'
$oneDriveRoot = $env:OneDrive
if (-not $oneDriveRoot) { $oneDriveRoot = Join-Path $env:USERPROFILE 'OneDrive' }
$remoteDir = Join-Path $oneDriveRoot 'Backups\king-ai-hub'

foreach ($dir in @($localDir, $remoteDir)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

# 1. Dump inside the container (custom format: compressed, pg_restore-able).
$containerPath = "/tmp/$fileName"
docker exec $container pg_dump -U $dbUser -d $dbName -Fc -f $containerPath
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

# 2. Copy out, then remove from the container.
$localPath = Join-Path $localDir $fileName
docker cp "${container}:${containerPath}" $localPath
if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
docker exec $container rm -f $containerPath

# Sanity: a dump of this schema below 10 KB means something went wrong.
$size = (Get-Item $localPath).Length
if ($size -lt 10KB) { throw "Backup suspiciously small ($size bytes): $localPath" }

# 3. Off-machine copy via OneDrive sync folder.
Copy-Item $localPath (Join-Path $remoteDir $fileName) -Force

# 4. Retention.
$cutoff = (Get-Date).AddDays(-$retentionDays)
foreach ($dir in @($localDir, $remoteDir)) {
    Get-ChildItem $dir -Filter 'king_ai_hub-*.dump' |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Force -Confirm:$false
}

Write-Output "OK backup $fileName ($([math]::Round($size / 1KB)) KB) -> $localDir and $remoteDir"
