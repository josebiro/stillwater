# Stillwater

Stillwater is a Windows meeting notebook. Write notes while it transcribes microphone and system audio locally, then turn the transcript and your writing into one editable outline with links back to the evidence. Meetings are saved in a local vault.

**New note** opens the editor and starts local recording and transcription. The meter and chevron open the transcript above the recording controls. Pause and resume from the pill, or expand it and choose **Finish recording** to save the meeting. Choose the microphone, transcription language, and audio retention in **Settings** before starting. To transcribe an existing audio file, use **My notes → Import a recording**.

In **Settings → Meeting notes and questions**, choose Ollama or LM Studio for local generation, or configure OpenAI or Anthropic to send relevant meeting text to that provider. Speech recognition runs on the device in both modes.

## Daily meeting workflows

- The sidebar lists **Spaces → My notes** and its folders. Use **+** beside Spaces (or **New folder**) to create one with a name, icon or emoji, and description. A note can be in several folders: use **Add to folder** under its title, right-click it in a list, or drag it onto a folder. Folders nest one level, sort A–Z, and can be favourited. Deleting a folder keeps its notes. Press **Ctrl+S** to hide the sidebar.
- A note from a recurring meeting offers a **Suggested folder** (the one its earlier notes use) and a **Suggested label** under its title: **Add** (or **Ctrl+Enter**) accepts, the dropdown picks a different one, **×** dismisses. Accepting a folder for a series also adds that series' later notes automatically; the folder page shows “Auto-adds …” and its options menu stops it. A series with no folder offers **Create folder for this meeting**.
- About a minute before a calendar event with other people or a call link, a small card appears at the top right of the screen. **Join Meet / Zoom / Teams** opens the call in your browser, starts a note titled after the event and begins recording; the arrow beside it offers joining only or notes only. Events you declined in Google Calendar get no card. Turn it off, or try it with **Show a test alert**, under **Settings → Google Calendar**. The connected calendar refreshes every 5 minutes.
- The sidebar's **Labels** section shows the labels you pin: **+** beside Labels creates a view for a label, and a view's **⋯** removes it without touching the label. Every label is still listed under **My notes → Labels**.
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

The packager expects Python 3.12 dependencies from `tools/cuda-probe-requirements.txt` installed in `.venv`, Moonshine Voice 0.1.6 staged in `.dev/moonshine`, and the English Medium Streaming model snapshot in `.dev/moonshine-models/download.moonshine.ai/model/medium-streaming-en/quantized_26_11_02`. Install the Electron dependencies with `npm ci` and supply an NSIS compiler. `tools/stage-build-deps.ps1` stages the Python and Moonshine prerequisites; pass `-Python` with a Python 3.12 interpreter if `python` is a different version.

```powershell
./tools/stage-build-deps.ps1
$payload = & ./tools/package-windows.ps1
& ./tools/build-installer.ps1 -Payload $payload -Compiler (Get-Command makensis.exe).Source
```

## Release

Set the new version in `package.json` and `package-lock.json`, merge to `main`, then tag that commit and push the tag:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

The **Release** workflow checks that the tag matches the `package.json` version and points at a commit on `main`, builds the installer, and publishes `Stillwater-Setup-x64.exe`, `Stillwater-CUDA-x64.zip`, and their SHA-256 checksums as a GitHub release. A tag with a suffix, such as `v0.2.0-rc.1`, is published as a prerelease. To try the build without publishing, run the workflow manually from the Actions tab; the files are kept as an artifact for three days.

Keep the generated setup executable and CUDA companion ZIP together for installation. Model weights, runtime binaries, installers, meeting vaults, and test-run artifacts are managed separately from the source repository.
