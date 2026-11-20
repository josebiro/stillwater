# Stages everything tools/package-windows.ps1 expects besides node_modules:
# the Python 3.12 .venv, Moonshine Voice under .dev/moonshine, and the English
# Medium Streaming model snapshot under .dev/moonshine-models. Safe to re-run.
param(
    # A Python 3.12 interpreter used to create .venv when it does not exist yet.
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root '.dev'
$venvPython = Join-Path $root '.venv/Scripts/python.exe'
$moonshine = Join-Path $cache 'moonshine'
$models = Join-Path $cache 'moonshine-models'

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE." }
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    Invoke-Checked 'Virtual environment creation' { & $Python -m venv (Join-Path $root '.venv') }
}
$version = & $venvPython -c 'import sys; print("%d.%d" % sys.version_info[:2])'
if ($version -ne '3.12') {
    throw "The packaged runtime is Python 3.12, but .venv uses Python $version. Remove .venv and pass -Python with a 3.12 interpreter."
}

Invoke-Checked 'Speech dependency installation' {
    & $venvPython -m pip install --disable-pip-version-check --no-cache-dir -r (Join-Path $PSScriptRoot 'cuda-probe-requirements.txt')
}
if (-not (Test-Path -LiteralPath (Join-Path $moonshine 'moonshine_voice-0.1.6.dist-info') -PathType Container)) {
    if (Test-Path -LiteralPath $moonshine) { Remove-Item -LiteralPath $moonshine -Recurse -Force }
    Invoke-Checked 'Moonshine Voice installation' {
        & $venvPython -m pip install --disable-pip-version-check --no-cache-dir --target $moonshine 'moonshine-voice==0.1.6'
    }
}

# The downloader skips files already present and verifies each one's size and CRC32C.
$previousPath = $env:PYTHONPATH
$env:PYTHONPATH = $moonshine
try {
    Invoke-Checked 'Moonshine model download' {
        & $venvPython -c @'
import sys
from moonshine_voice.download import download_model_from_info, find_model_info
from moonshine_voice.moonshine_api import ModelArch
path, _ = download_model_from_info(find_model_info("en", ModelArch.MEDIUM_STREAMING), cache_root=sys.argv[1])
print(path)
'@ $models
    }
} finally {
    $env:PYTHONPATH = $previousPath
}
