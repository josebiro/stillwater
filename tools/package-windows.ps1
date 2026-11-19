$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$cache = Join-Path $root '.dev'
$moonshineRuntime = Join-Path $cache 'moonshine'
$moonshineModel = Join-Path $cache 'moonshine-models/download.moonshine.ai/model/medium-streaming-en/quantized_26_11_02'
if (!(Test-Path -LiteralPath (Join-Path $moonshineRuntime 'moonshine_voice') -PathType Container)) {
    throw 'Stage Moonshine Voice 0.1.6 and its English Medium Streaming snapshot under .dev before packaging. See the Windows build instructions in README.md.'
}
$moonshineFiles = @('adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort',
    'frontend.model.ort', 'frontend.weights.ort', 'streaming_config.json', 'tokenizer.bin')
foreach ($name in $moonshineFiles) {
    $file = Get-Item -LiteralPath (Join-Path $moonshineModel $name) -ErrorAction SilentlyContinue
    if (!$file -or $file.PSIsContainer -or !$file.Length) {
        throw "Moonshine model file is missing or empty: $name. See the Windows build instructions in README.md."
    }
}
$archive = Join-Path $cache 'python-3.12.4-embed-amd64.zip'
New-Item -ItemType Directory -Path $dist, $cache -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.4/python-3.12.4-embed-amd64.zip' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm MD5).Hash -ne '8db759b337ac4f6966f52b3662c05dd7') {
    throw 'Embedded Python archive checksum mismatch.'
}
$package = Join-Path $dist ('Stillwater-win-x64-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $package | Out-Null
Copy-Item -Path (Join-Path $root 'node_modules/electron/dist/*') -Destination $package -Recurse
Rename-Item -LiteralPath (Join-Path $package 'electron.exe') -NewName 'Stillwater.exe'
$app = Join-Path $package 'resources/app'
$markdown = Join-Path $app 'node_modules/markdown-it'
New-Item -ItemType Directory -Path (Join-Path $markdown 'dist') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'node_modules/markdown-it/dist/markdown-it.min.js') -Destination (Join-Path $markdown 'dist')
Copy-Item -LiteralPath (Join-Path $root 'node_modules/markdown-it/LICENSE') -Destination $markdown
$runtime = Join-Path $app 'python' 
New-Item -ItemType Directory -Path $app, $runtime -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'package.json'), (Join-Path $root 'desktop'), (Join-Path $root 'worker') -Destination $app -Recurse
New-Item -ItemType Directory -Path (Join-Path $app 'tools') | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'tools/cuda_probe.py') -Destination (Join-Path $app 'tools')
Expand-Archive -LiteralPath $archive -DestinationPath $runtime
New-Item -ItemType Directory -Path (Join-Path $runtime 'Lib') | Out-Null
Copy-Item -LiteralPath (Join-Path $root '.venv/Lib/site-packages') -Destination (Join-Path $runtime 'Lib') -Recurse
$site = Join-Path $runtime 'Lib/site-packages'
Get-ChildItem -LiteralPath $moonshineRuntime |
    Where-Object { !(Test-Path -LiteralPath (Join-Path $site $_.Name)) } |
    Copy-Item -Destination $site -Recurse
$bundledModels = Join-Path $app 'moonshine-model'
New-Item -ItemType Directory -Path $bundledModels | Out-Null
Copy-Item -LiteralPath $moonshineModel -Destination $bundledModels -Recurse
Set-Content -LiteralPath (Join-Path $runtime 'python312._pth') -Encoding ascii -Value @(
    'python312.zip'
    '.'
    'Lib\site-packages'
    'import site'
)
Write-Output $package
