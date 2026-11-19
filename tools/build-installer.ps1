param(
    [Parameter(Mandatory)][string]$Payload,
    [Parameter(Mandatory)][string]$Compiler,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'dist' }
$OutputDirectory = (New-Item -ItemType Directory -Path $OutputDirectory -Force).FullName
$payloadPath = (Resolve-Path -LiteralPath $Payload).Path
$compilerPath = (Resolve-Path -LiteralPath $Compiler).Path
if (-not (Test-Path -LiteralPath (Join-Path $payloadPath 'Stillwater.exe') -PathType Leaf)) {
    throw 'Payload must be a staged Stillwater package.'
}
$version = (Get-Content -LiteralPath (Join-Path $payloadPath 'resources/app/package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw 'Invalid payload version.' }
$removeList = Join-Path $root ('.dev/uninstall-' + [guid]::NewGuid().ToString('N') + '.nsh')
$files = Get-ChildItem -LiteralPath $payloadPath -Recurse -File -Force
$directories = Get-ChildItem -LiteralPath $payloadPath -Recurse -Directory -Force |
    Sort-Object { $_.FullName.Length } -Descending
$commands = foreach ($item in $files + $directories) {
    $relative = [IO.Path]::GetRelativePath($payloadPath, $item.FullName)
    if ($relative -match '["$`\r\n]') { throw "Unsupported payload path: $relative" }
    $operation = if ($item.PSIsContainer) { 'RMDir' } else { 'Delete' }
    '{0} "$INSTDIR\{1}"' -f $operation, $relative
}
Set-Content -LiteralPath $removeList -Value $commands -Encoding utf8BOM
$output = Join-Path $OutputDirectory 'Stillwater-Setup-x64.exe'
$cuda = Join-Path $payloadPath 'resources/app/python/Lib/site-packages/nvidia'
$cudaArchive = Join-Path $OutputDirectory 'Stillwater-CUDA-x64.zip'
if (-not (Test-Path -LiteralPath $cuda -PathType Container)) { throw 'Missing bundled CUDA libraries.' }
& tar.exe -a -cf $cudaArchive -C (Split-Path $cuda -Parent) nvidia
if ($LASTEXITCODE -ne 0) { throw "CUDA archive creation failed with exit code $LASTEXITCODE." }
try {
    & $compilerPath '/V2' "/DPAYLOAD=$payloadPath" "/DOUTPUT=$output" "/DREMOVE_LIST=$removeList" "/DAPP_VERSION=$version" (Join-Path $PSScriptRoot 'stillwater-installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw "NSIS failed with exit code $LASTEXITCODE." }
    $manifest = Join-Path $OutputDirectory 'Stillwater-Release.json'
    @{ version = $version } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8
    Write-Output $output
    Write-Output $cudaArchive
    Write-Output $manifest
} finally {
    Remove-Item -LiteralPath $removeList -Force
}
