param([Parameter(Mandatory)][string]$Executable)

$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$testProfile = Join-Path ([IO.Path]::GetTempPath()) ('stillwater-restart-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testProfile | Out-Null
$resultPath = Join-Path $testProfile 'result.json'
$previousResult = $env:STILLWATER_CHECK_RESTART_RESULT
$env:STILLWATER_CHECK_RESTART_RESULT = $resultPath
try {
    $process = Start-Process -FilePath $executablePath -ArgumentList '--check-tray' -WindowStyle Hidden -PassThru
    if (!$process.WaitForExit(30000)) { throw 'Original Stillwater process did not exit.' }
    if ($process.ExitCode -ne 0) { throw "Original Stillwater process exited with $($process.ExitCode)." }
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if (Test-Path -LiteralPath $resultPath) {
            $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
            if ($result.previousPid -eq $process.Id -and $result.pid -gt 0 -and $result.pid -ne $process.Id) {
                $replacement = Get-Process -Id $result.pid -ErrorAction SilentlyContinue
                if ($replacement -and !$replacement.WaitForExit(5000)) {
                    throw 'Replacement Stillwater process did not exit after the check.'
                }
                Write-Output "Stillwater restarted from process $($process.Id) to $($result.pid)."
                return
            }
        }
        Start-Sleep -Milliseconds 100
    }
    throw 'Replacement Stillwater process did not report successful startup.'
} finally {
    $env:STILLWATER_CHECK_RESTART_RESULT = $previousResult
}
