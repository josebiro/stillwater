# Stillwater

Stillwater is a Windows meeting notebook. Write notes while it transcribes microphone and system audio locally, then turn the transcript and your writing into one editable outline with links back to the evidence. Meetings are saved in a local vault.

In **Settings → Meeting notes and questions**, choose Ollama or LM Studio for local generation, or configure OpenAI or Anthropic to send relevant meeting text to that provider. Speech recognition runs on the device in both modes.

## Run the desktop UI

Use Node.js 24 on Windows x64. From the repository root, run:

```powershell
npm ci
npm start
```

The UI can open without speech models. Recording also requires the Python recognition runtime and local model files. English live capture uses Moonshine Medium Streaming. Whisper supports import, multilingual transcription, and refinement.

## Run source checks

These checks use synthetic data and require no meeting recordings or provider accounts:

```powershell
npm run check:outline
npm run check:meeting-qa
npm run check:calendar
npm run check:hosted-settings
```

Audio benchmarks and recording checks that read external fixtures require separately supplied media. Keep local media and benchmark output under `.probe/`.

## Build the Windows installer

The packager expects Python 3.12 dependencies from `tools/cuda-probe-requirements.txt` installed in `.venv`, Moonshine Voice 0.1.6 staged in `.dev/moonshine`, and the English Medium Streaming model snapshot in `.dev/moonshine-models/download.moonshine.ai/model/medium-streaming-en/quantized_26_11_02`. Install the Electron dependencies with `npm ci` and supply an NSIS compiler.

```powershell
$payload = & ./tools/package-windows.ps1
& ./tools/build-installer.ps1 -Payload $payload -Compiler (Get-Command makensis.exe).Source
```

Keep the generated setup executable and CUDA companion ZIP together for installation. Model weights, runtime binaries, installers, meeting vaults, and test-run artifacts are managed separately from the source repository.
