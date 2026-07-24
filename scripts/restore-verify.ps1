# Restore drill (SPRINT-03-PLAN.md §6): prove the latest backup actually
# restores. Spins up a throwaway Postgres container, restores the newest dump,
# row-counts core tables, and tears everything down. Never touches the real DB.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-verify.ps1

$ErrorActionPreference = 'Stop'

$localDir = Join-Path $env:USERPROFILE 'Backups\king-ai-hub'
$latest = Get-ChildItem $localDir -Filter 'king_ai_hub-*.dump' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $latest) { throw "No backups found in $localDir -- run scripts\backup.ps1 first." }

$testContainer = 'king-ai-hub-restore-test'

# Clean slate if a previous drill crashed mid-way. cmd /c so stderr from
# "no such container" never reaches PowerShell's error stream (PS 5.1 + EAP
# Stop turns redirected native stderr into a terminating error).
cmd /c "docker rm -f $testContainer >nul 2>nul"

Write-Output "Restoring $($latest.Name) into throwaway container..."
docker run --rm -d --name $testContainer -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=restore_check postgres:17-alpine | Out-Null

try {
    # Wait for the server to accept connections.
    $ready = $false
    foreach ($i in 1..30) {
        docker exec $testContainer pg_isready -U postgres -d restore_check 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Throwaway Postgres did not become ready within 30s.' }

    docker cp $latest.FullName "${testContainer}:/tmp/restore.dump"

    # The dump carries GRANTs to app_server; the role must exist or pg_restore
    # exits non-zero even though all data restored.
    docker exec $testContainer psql -U postgres -d restore_check -c "CREATE ROLE app_server NOLOGIN;" | Out-Null

    # --no-owner: roles from the source DB (e.g. app_server) don't exist here,
    # and ownership is irrelevant to a restore drill.
    docker exec $testContainer pg_restore -U postgres -d restore_check --no-owner /tmp/restore.dump
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed with exit code $LASTEXITCODE" }

    $tables = @('profiles', 'organizations', 'projects', 'agents', 'tasks', 'runs', 'messages', 'usage_events', 'audit_logs', 'approvals')
    $failures = @()
    foreach ($t in $tables) {
        $count = cmd /c "docker exec $testContainer psql -U postgres -d restore_check -t -A -c ""select count(*) from $t"" 2>nul"
        if ($LASTEXITCODE -ne 0) { $failures += "$t (missing)"; continue }
        Write-Output ("  {0,-15} {1,6} rows" -f $t, $count.Trim())
    }
    if ($failures.Count -gt 0) { throw "Restore drill FAILED -- tables not restored: $($failures -join ', ')" }

    Write-Output "OK restore drill passed for $($latest.Name)"
} finally {
    cmd /c "docker rm -f $testContainer >nul 2>nul"
}
