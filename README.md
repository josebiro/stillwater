# Stillwater

Stillwater is a Windows meeting notebook. Write notes while it transcribes microphone and system audio locally, then turn the transcript and your writing into one editable outline with links back to the evidence. Meetings are saved in a local vault.

**New note** opens the editor and starts local recording and transcription. The meter and chevron open the transcript above the recording controls. Pause and resume from the pill, or expand it and choose **Finish recording** to save the meeting. Choose the microphone, transcription language, and audio retention in **Settings** before starting. To transcribe an existing audio file, use **My notes → Import a recording**.

In **Settings → Meeting notes and questions**, choose Ollama or LM Studio for local generation, or configure OpenAI or Anthropic to send relevant meeting text to that provider. Speech recognition runs on the device in both modes.

## Daily meeting workflows

- Use **+ Add label** beside a note’s title to file it under a project, person, area, topic, or organization. Click a label to browse related notes. **My notes → Manage labels** and **Label multiple notes** work across the vault.
- Open the next occurrence of a calendar meeting and expand **From last time** to see its previous note, last recorded decision, and outstanding follow-ups. **Add to agenda** copies the item you choose.
- Use **Bring this up with…** on Home or in the Windows tray to save a question for a person. The editor shows it when an attendee, entered participant, or person label matches. It stays pending until you mark it discussed.
- During recording, **Ctrl+Shift+M** or **Mark moment** inserts a timestamp at the cursor. Click the timestamp in the saved notes to reveal the nearest transcript passage.
- **What do I owe?** lets you review cited action items from enhanced notes, confirm the recipient, dismiss suggestions, and mark commitments done. Confirmed commitments appear on Home.
- Use **Record a decision** on a saved project note. Choose the same project and decision topic to record a later outcome with its reason. **Project decisions** on Home shows the current decision, earlier outcomes, and their sources.

These workflows use local vault data. Include the vault’s `stillwater-journal.json` file when backing up reminders, commitments, reusable labels, and decision history.

## Google Calendar

To show upcoming events on Home, copy the **Secret address in iCal format** from Google Calendar’s **Settings → Settings for my calendars → Integrate calendar**. Paste it into Stillwater’s **Settings → Google Calendar** and select **Connect calendar**. This read-only subscription refreshes on launch and every 15 minutes while Stillwater runs. Select an event to start or reopen its note. **Sync now** refreshes immediately. **Disconnect** removes the subscription and its local cache. Imported ICS files continue to appear alongside the subscription.

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
