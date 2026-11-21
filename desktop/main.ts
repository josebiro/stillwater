import { readDaily, changeDaily } from "./daily.ts";
import { GoogleCalendarFeed } from "./google-calendar.ts";
import { installMeetingAlerts } from "./meeting-alert-window.ts";
import { isHosted, listHostedModels, readHostedKey, saveHostedKey } from "./hosted-models.ts";
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, powerMonitor, powerSaveBlocker } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fixtureRoundTrip } from "./worker.ts";
import { importMeeting, recognitionRuntime, refineMeeting, saveCapturedMeeting, setRecognitionModel, transcribe } from "./import-meeting.ts";
import { downloadMultilingualModel, readModelSetting, requireLocalSpeechModel, writeModelSetting } from "./model-settings.ts";
import { captureKeepsRecording, captureSpool, inspectCaptureStorage, recoverCapture, validateCaptureDirectory } from "./capture-spool.ts";
import { checkRecovery } from "./check-recovery.ts";
import { moonshineModelPath, requireMoonshineModel, startRecognition } from "./live-recognition.ts";
import { archiveMeeting, createMeeting, flagTranscript, openMeeting, renameMeeting, resolveFilingSuggestion, saveMeetingContexts, saveTranscriptRevision } from "./vault.ts";
import { enhanceMeetingOutline, listEnhancements, lmStudioEndpoint } from "./enhance.ts";
import { askMeeting, askVault } from "./meeting-qa.ts";
import { parseCalendar } from "./calendar.ts";
import { installTray, recordPerformanceTrace, stillwaterIcon } from "./tray.ts";
import { EnhancedNotesConflict, readEnhancedNotes, saveEnhancedNotes } from "./enhanced-notes.ts";
import { findCalendarMeeting, listRecentActions, listVaultContexts, resolveMeetingLink, searchVault } from "./vault-search.ts";
import { seedDemoVault } from "./demo-vault.ts";

const normalLaunch = !process.argv.some((argument) => argument.startsWith("--check-"));
// --screenshot <file.png>: open a made-up sample vault behind other windows, photograph My notes, save, exit.
const screenshotFlag = process.argv.indexOf("--screenshot");
const screenshotPath = screenshotFlag >= 0 ? process.argv[screenshotFlag + 1] : undefined;
if (screenshotFlag >= 0 && !screenshotPath) {
  console.error("Usage: --screenshot <file.png>");
  process.exit(2);
}
if (screenshotPath) {
  // A window behind others must keep drawing so the picture isn't blank.
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}
const trayRestartResult = process.argv.includes("--check-tray") ? process.env.STILLWATER_CHECK_RESTART_RESULT : undefined;
if (trayRestartResult) app.setPath("userData", dirname(trayRestartResult));
if ((normalLaunch || trayRestartResult) && !screenshotPath && app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0);
let pendingActivation = false;
let activateWindow: (() => void) | undefined;
app.on("second-instance", () => {
  if (activateWindow) activateWindow();
  else pendingActivation = true;
});
await app.whenReady();
const root = app.getAppPath();
function participantNames(value: unknown = "") {
  if (typeof value !== "string" || value.length > 1000) throw new Error("Enter up to 1,000 characters of participant names.");
  return [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
}
function speechLanguage(value: unknown) {
  if (typeof value !== "string" || !["en", "auto", "es", "fr", "de", "ja"].includes(value)) {
    throw new Error("Choose a supported transcription language");
  }
  return value;
}
if (process.argv.includes("--check-recovery")) {
  await checkRecovery(root);
  app.exit(0);
} else if (process.argv.includes("--check-import")) {
  const vault = await mkdtemp(join(app.getPath("temp"), "stillwater-vault-check-"));
  try {
    const audio = process.env.STILLWATER_CHECK_AUDIO ?? join(root, ".probe/jfk.flac");
    const result = await importMeeting(root, vault, audio, "Fixture meeting", "Raw notes", "en",
      ["Morgan"], { id: "import-fixture", start: "2026-11-12T16:00:00.000Z" }, "topic: Imported audio");
    if (!result.segments.some((segment) => /fellow Americans/i.test(segment.text)) ||
        !result.notes.includes("Raw notes") || result.metadata.participants?.[0] !== "Morgan" ||
        result.metadata.calendarEvent?.id !== "import-fixture" ||
        result.metadata.contexts?.[0]?.name !== "Imported audio") throw new Error("Unexpected saved meeting");
    console.log(`Saved and reopened ${result.segments.length} speech segments.`);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
  app.exit(0);
} else if (process.argv.includes("--check-worker")) {
  try {
    console.log(await fixtureRoundTrip(root));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
} else {
  const checkCaptureExit = process.argv.includes("--check-capture-exit");
  const checkCaptureQuota = process.argv.includes("--check-capture-quota");
  const checkCaptureWorker = process.argv.includes("--check-capture-worker");
  const checkCombinedNotes = process.argv.includes("--check-combined-notes");
  const checkCaptureEditorFinish = process.argv.includes("--check-capture-editor-finish");
  const checkCombinedNotesFailure = checkCombinedNotes && process.argv.includes("--check-combined-notes-failure");
  let fixtureOutlines = 0;
  const checkCaptureLoopback = process.argv.includes("--check-capture-loopback");
  const checkCaptureSpeech = checkCaptureLoopback || process.argv.includes("--check-capture-speech");
  const sustainedSeconds = checkCaptureSpeech || process.argv.includes("--check-capture")
    ? Number(process.env.STILLWATER_CHECK_CAPTURE_SECONDS ?? 0)
    : 0;
  const checkCaptureDevice = process.argv.includes("--check-capture-device");
  const checkCaptureSleep = process.argv.includes("--check-capture-sleep");
  const checkCaptureGap = process.argv.includes("--check-capture-gap");
  const checkCaptureDrain = checkCaptureGap || process.argv.includes("--check-capture-drain");
  const checkCaptureBacklog = process.argv.includes("--check-capture-backlog");
  const checkCaptureStartup = process.argv.includes("--check-capture-startup");
  const checkCaptureModel = process.argv.includes("--check-capture-model");
  let savedCaptureSamples: number | undefined;
  const checkCapture = checkCaptureExit || checkCaptureQuota || checkCaptureWorker ||
    checkCaptureDevice || checkCaptureSleep || checkCaptureDrain || checkCaptureBacklog ||
    checkCaptureStartup || checkCaptureModel || checkCaptureSpeech || process.argv.includes("--check-capture");
  const checkVaultUI = process.argv.includes("--check-vault-ui");
  const checkTray = process.argv.includes("--check-tray");
  const settingsDirectory = checkTray || screenshotPath
    ? await mkdtemp(join(app.getPath("temp"), screenshotPath ? "stillwater-screenshot-" : "stillwater-tray-check-"))
    : app.getPath("userData");
  if (!checkCapture && !checkVaultUI && !screenshotPath) {
    setRecognitionModel(await readModelSetting(settingsDirectory).catch((error) => {
      console.error(error);
      return undefined;
    }));
  }
  let fixtureVault: string | undefined;
  const vaultSetting = join(settingsDirectory, "vault-path.txt");
  let preferredVault = checkCapture || checkVaultUI || screenshotPath ? "" : await readFile(vaultSetting, "utf8").catch(() => "");
  if (screenshotPath) {
    fixtureVault = join(settingsDirectory, "sample-vault");
    await mkdir(fixtureVault);
    await seedDemoVault(fixtureVault);
  }
  const spoolRoot = checkCapture
    ? await mkdtemp(join(app.getPath("temp"), "stillwater-spool-check-"))
    : join(settingsDirectory, "capture-spool");
  await inspectCaptureStorage(spoolRoot).catch((error) => console.error("Capture cleanup failed", error));
  const window = new BrowserWindow({
    show: !checkCapture && !checkVaultUI && !checkTray && !screenshotPath,
    icon: stillwaterIcon(),
    backgroundColor: "#110e15",
    autoHideMenuBar: true,
    width: screenshotPath ? 1380 : 1120,
    height: screenshotPath ? 920 : 800,
    minWidth: 640,
    minHeight: 520,
    webPreferences: {
      backgroundThrottling: !checkCaptureLoopback && !screenshotPath,
      preload: join(root, "desktop/preload.cjs"),
      partition: checkCapture || checkVaultUI || checkTray || screenshotPath ? `stillwater-check-${randomUUID()}` : undefined,
    },
  });
  activateWindow = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  if (pendingActivation) activateWindow();
  let active = false;
  const calendarPath = join(settingsDirectory, "calendar.ics");
  let calendar = parseCalendar(checkCapture || checkVaultUI || screenshotPath ? "" : await readFile(calendarPath, "utf8").catch(() => ""));
  if (checkCapture) {
    const start = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    calendar = parseCalendar(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:capture-fixture",
      "SUMMARY:Calendar recording fixture", "DTSTART:" + start, "RRULE:FREQ=WEEKLY;COUNT=2",
      "END:VEVENT", "END:VCALENDAR"].join("\r\n"));
  }
  const googleCalendar = new GoogleCalendarFeed(settingsDirectory,{
    seal:async value => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) throw Error("Secure calendar storage is unavailable.");
      return safeStorage.encryptStringAsync(value);
    },
    open:async bytes => (await safeStorage.decryptStringAsync(bytes)).result,
  });
  if (!checkVaultUI && !checkCapture && !checkTray && !screenshotPath) await googleCalendar.load();
  const agenda = () => googleCalendar.agenda(calendar);
  // Before-meeting alerts read the same agenda the Home page shows.
  const bringForward = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const alerts = checkCapture || checkVaultUI || checkTray ? undefined : await installMeetingAlerts({
    root, settingsDirectory, window,
    events: () => screenshotPath ? [] : agenda().events,
    start: (event) => { bringForward(); window.webContents.send("alert:start", event); },
    openSettings: () => { bringForward(); window.webContents.send("tray:navigate", "settings"); },
  });
  ipcMain.handle("alerts:setting", async (event, value) => {
    if (event.senderFrame !== window.webContents.mainFrame || !alerts) throw Error("Alert settings unavailable.");
    if (typeof value === "boolean") await alerts.setEnabled(value);
    return alerts.enabled();
  });
  ipcMain.handle("alerts:test", async (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || !alerts) throw Error("Alert settings unavailable.");
    const start = new Date(Date.now() + 60000);
    await alerts.preview({ id: "stillwater-test-alert", title: "Test meeting", allDay: false,
      start: start.toISOString(), end: new Date(start.getTime() + 30 * 60000).toISOString() });
  });
  ipcMain.handle("calendar:google",async (event,action,address) => {
    if (event.senderFrame !== window.webContents.mainFrame || !["connect","sync","disconnect"].includes(action)) throw Error("Calendar settings unavailable.");
    await googleCalendar.change(action,address);
    alerts?.refresh();
    return agenda();
  });
  function linkedEvent(id: unknown, start: unknown) {
    const event = agenda().events.find((entry) => entry.id === id && entry.start === start);
    return event ? { id: event.id, start: event.start } : undefined;
  }
  ipcMain.handle("calendar:read", (event) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error("Calendar unavailable");
    return agenda();
  });
  ipcMain.handle("calendar:import", async (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) throw new Error("Calendar import unavailable");
    active = true;
    try {
      const selection = await dialog.showOpenDialog(window, {
        title: "Choose a local calendar export", properties: ["openFile"],
        filters: [{ name: "iCalendar", extensions: ["ics"] }],
      });
      if (selection.canceled) return null;
      const path = selection.filePaths[0];
      if ((await stat(path)).size > 5 * 1024 * 1024) throw new Error("Choose an iCalendar file under 5 MB");
      const source = await readFile(path, "utf8");
      if (!source.includes("BEGIN:VCALENDAR")) throw new Error("Choose a valid iCalendar export");
      const next = parseCalendar(source);
      const temporary = calendarPath + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, source, { flag: "wx", flush: true });
        await rename(temporary, calendarPath);
        calendar = next;
        alerts?.refresh();
        return agenda();
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      active = false;
    }
  });
  async function isTemporaryVaultLocation(path: string) {
    const recordingRoot = await realpath(spoolRoot).catch(async (error) => {
      if (error.code !== "ENOENT") throw error;
      return join(await realpath(dirname(spoolRoot)), basename(spoolRoot));
    });
    const location = relative(recordingRoot, path);
    return !isAbsolute(location) && location !== ".." && !location.startsWith(".." + sep);
  }

  async function chooseVault(change = false) {
    if (fixtureVault) return fixtureVault;
    if (!change && preferredVault) {
      try {
        const path = await realpath(preferredVault);
        if ((await stat(path)).isDirectory() && !(await isTemporaryVaultLocation(path))) return path;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
    }
    const selected = await dialog.showOpenDialog(window, {
      title: "Choose your Stillwater vault", defaultPath: preferredVault || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (selected.canceled) return undefined;
    const path = await realpath(selected.filePaths[0]);
    if (await isTemporaryVaultLocation(path)) {
      throw new Error("Choose a vault outside Stillwater's temporary recording storage.");
    }
    const temporary = vaultSetting + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, path, { flag: "wx", flush: true });
      await rename(temporary, vaultSetting);
      preferredVault = path;
      return path;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  ipcMain.handle("vault:select", async (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) throw new Error("Vault selection unavailable");
    active = true;
    try {
      return await chooseVault(true);
    } finally {
      active = false;
    }
  });
  ipcMain.handle("model:current", async (event) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error("Model settings unavailable");
    const moonshine = moonshineModelPath(root);
    const whisper = await requireLocalSpeechModel(recognitionRuntime(root).model).catch(() => null);
    const moonshineAvailable = moonshine && await requireMoonshineModel(moonshine).catch(() => null);
    return { moonshine: moonshineAvailable ? "available" : moonshine ? "invalid" : "missing", whisper };
  });
  ipcMain.handle("model:key-status", async (event, provider) => {
    if (event.senderFrame !== window.webContents.mainFrame || !isHosted(provider)) throw Error("Key settings unavailable.");
    return Boolean(await readHostedKey(provider));
  });
  ipcMain.handle("model:save-key", async (event, provider, key) => {
    if (event.senderFrame !== window.webContents.mainFrame || !isHosted(provider)) throw Error("Key settings unavailable.");
    await saveHostedKey(provider,key);
  });
  ipcMain.handle("model:list-local", async (event, provider) => {
    if (event.senderFrame !== window.webContents.mainFrame) throw new Error("Model discovery unavailable");
    if (isHosted(provider)) return listHostedModels(provider, await readHostedKey(provider));
    const ollama = provider === "ollama";
    if (!ollama && provider !== "lm-studio") throw new Error("Unknown local provider");
    const name = ollama ? "Ollama" : "LM Studio";
    try {
      const response = await fetch(ollama ? "http://127.0.0.1:11434/api/tags" : lmStudioEndpoint("/v1/models"),
        { redirect: "error", signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const rows = ollama ? result.models : result.data;
      return [...new Set(rows.map((row) => ollama ? row.name : row.id)
        .filter((id) => typeof id === "string" && id.length > 0))].sort();
    } catch (error) {
      throw new Error(`Could not list local models. Start the ${name} server and try again.`, { cause: error });
    }
  });
  ipcMain.handle("model:select", async (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) {
      throw new Error("Model selection unavailable during capture or processing");
    }
    active = true;
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: "Choose a local Whisper model folder", properties: ["openDirectory"],
      });
      if (selected.canceled) return null;
      const model = await writeModelSetting(settingsDirectory, selected.filePaths[0]);
      setRecognitionModel(model);
      return model;
    } finally {
      active = false;
    }
  });
  ipcMain.handle("model:download", async (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) {
      throw new Error("Model download unavailable during capture or processing");
    }
    active = true;
    try {
      const path = await downloadMultilingualModel(settingsDirectory, recognitionRuntime(root).python);
      const model = await writeModelSetting(settingsDirectory, path);
      setRecognitionModel(model);
      return model;
    } finally {
      active = false;
    }
  });
  let openedMeeting: { vault: string; bundle: string } | undefined;
  let searched: { vault: string; paths: Set<string> } | undefined;
  let browsed: typeof searched;
  let spool: Awaited<ReturnType<typeof captureSpool>> | undefined;
  let recognition: Awaited<ReturnType<typeof startRecognition>> | undefined;
  let captureLanguage = "en";
  const finishAfterResume = () => {
    if (spool && !window.isDestroyed()) window.webContents.send("capture:resume-from-sleep");
  };
  powerMonitor.on("resume", finishAfterResume);
  window.once("closed", () => powerMonitor.removeListener("resume", finishAfterResume));
  ipcMain.handle("capture:begin", async (event, language, meetingMiB, totalMiB, keepRecording) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) {
      throw new Error("Capture unavailable");
    }
    if (!Number.isInteger(meetingMiB) || meetingMiB < 1 || meetingMiB > 7168 ||
        !Number.isInteger(totalMiB) || totalMiB < meetingMiB || totalMiB > 1048576) {
      throw new Error("Invalid temporary audio limits");
    }
    active = true;
    try {
      captureLanguage = speechLanguage(language);
      let firstSystemPreview = true;
      recognition = await startRecognition(root, (segment) => {
        if (!window.isDestroyed()) window.webContents.send("capture:segment", segment);
      }, captureLanguage, (source, text) => {
        if (checkCaptureLoopback && firstSystemPreview && source === "system" && text.trim()) {
          firstSystemPreview = false;
          console.log(`First system preview received from worker at ${Date.now()} ms since epoch.`);
        }
        if (!window.isDestroyed()) window.webContents.send("capture:preview", source, text);
      });
      try {
        spool = await captureSpool(spoolRoot, { meeting: meetingMiB * 1024 ** 2, total: totalMiB * 1024 ** 2 },
          keepRecording === true);
      } catch (error) {
        await recognition.cancel();
        recognition = undefined;
        throw error;
      }
    } finally {
      active = false;
    }
  });
  ipcMain.handle("capture:frame", async (event, offset, frames) => {
    if (event.senderFrame !== window.webContents.mainFrame || !spool || active) {
      throw new Error("Capture unavailable");
    }
    const nearQuota = await spool.append(checkCaptureGap && offset >= 8192 ? offset + 2048 : offset, frames);
    if (checkCaptureBacklog && offset >= 16000) await new Promise((resolve) => setTimeout(resolve, 500));
    if (recognition) {
      try {
        await recognition.append(frames);
        if (checkCaptureWorker && offset === 0) await recognition.cancel();
      } catch (error) {
        console.error("Live transcription interrupted", error);
        await recognition.cancel();
        recognition = undefined;
      }
    }
    if (checkCaptureSleep && offset >= 16000 && offset - frames[0].length < 16000) {
      powerMonitor.emit("resume");
    }
    return { nearQuota, liveInterrupted: !recognition };
  });
  ipcMain.handle("capture:end", async (event, complete, title, notes, keepRecording, participants, review, calendarId, calendarStart, filing, model, provider) => {
    if (event.senderFrame !== window.webContents.mainFrame || active) throw new Error("Capture unavailable");
    if (!spool) return;
    const current = spool;
    const recognizer = recognition;
    spool = undefined;
    recognition = undefined;
    active = true;
    let cleanup = false;
    try {
      if (complete !== true) {
        await recognizer?.cancel();
        await current.release();
        return null;
      }
      const tracks = await current.finish();
      const liveSegments = await recognizer?.finish().catch((error) => {
        console.error("Live transcription could not finish", error);
        return undefined;
      });
      const segments = liveSegments ?? [];
      if (!liveSegments) {
        for (const track of tracks) segments.push(...await transcribe(root, track.path, track.source, captureLanguage));
        segments.sort((left, right) => left.startMs - right.startMs);
      }
      if (typeof title !== "string" || title.length > 200 ||
          typeof notes !== "string" || notes.length > 1000000) throw new Error("Invalid meeting details");
      const vault = await chooseVault();
      if (!vault) return null;
      const bundle = await createMeeting(vault, title.trim() || "Untitled meeting", notes, segments,
        keepRecording === true ? tracks : [], participantNames(participants), review === true,
        linkedEvent(calendarId, calendarStart), filing);
      const meeting = { bundle, ...await openMeeting(vault, bundle) };
      if (checkCapture) {
        if (meeting.metadata.calendarEvent?.id !== "capture-fixture") throw new Error("Calendar link was not saved");
        if (!meeting.metadata.contexts.some((context) => context.name === "Capture fixture")) {
          throw new Error("Recording filing context was not saved");
        }
        if (!meeting.flagged) throw new Error("Recording review flag was not saved");
        if ((checkCaptureSpeech || sustainedSeconds > 0) && !checkCaptureWorker && !liveSegments) {
          throw new Error("Live transcription did not finish");
        }
        const fixturePhrase = checkCaptureLoopback ? /fellow\s+Americans?\b/i : /fellow\s+Americans\b/i;
        if ((checkCaptureWorker || checkCaptureSpeech) && !fixturePhrase.test(meeting.segments
          .filter((segment) => segment.source === "system").map((segment) => segment.text).join(" "))) {
          throw new Error("Saved transcript did not contain the system speech fixture");
        }
        const expectedModel = process.env.STILLWATER_CHECK_MOONSHINE_SNAPSHOT ??
          (checkCaptureLoopback ? "quantized_26_11_02" : undefined);
        if (checkCaptureSpeech && expectedModel) {
          const engines = [...new Set(meeting.segments.map(({ engine, model }) => `${engine}/${model}`))];
          const expected = `moonshine/${expectedModel}`;
          if (engines.length !== 1 || engines[0] !== expected) {
            throw new Error(`Expected ${expected}, received ${engines.join(", ") || "no segments"}`);
          }
          console.log(`Verified speech engine ${expected}.`);
        }
        const trackSizes = await Promise.all(["microphone", "system"].map(async (source) => {
          const file = await open(join(bundle, "audio", source + ".wav"), "r");
          try {
            const header = Buffer.alloc(44);
            const { bytesRead } = await file.read(header, 0, header.length, 0);
            const { size } = await file.stat();
            if (bytesRead !== header.length || header.toString("ascii", 36, 40) !== "data" ||
                header.readUInt32LE(40) !== size - header.length) {
              throw new Error(`Saved ${source} WAV header does not match its audio length`);
            }
            return size;
          } finally {
            await file.close();
          }
        }));
        const pcmBytes = trackSizes[0] - 44;
        if (pcmBytes <= 0 || pcmBytes % 2 !== 0 || trackSizes[0] !== trackSizes[1]) {
          throw new Error("Retained tracks do not contain aligned 16-bit PCM samples");
        }
        savedCaptureSamples = pcmBytes / 2;
      }
      cleanup = true;
      const meetingLink = relative(vault, bundle);
      if (searched?.vault !== vault) searched = { vault, paths: new Set() };
      searched.paths.add(meetingLink);
      return { ...meeting, meetingLink };
    } catch (error) {
      await recognizer?.cancel();
      await current.release();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason.replace(/\.$/, "")}. Open Home and choose Recover recording. Audio folder: ${current.directory}`);
    } finally {
      try {
        if (cleanup) {
          await current.discard().catch((error) => {
            console.error("Meeting was saved, but temporary audio could not be removed", error);
          });
        }
      } finally {
        active = false;
      }
    }
  });
  ipcMain.handle("capture:recover", async (event, title, notes, language, participants, calendarId, calendarStart, filing) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) throw new Error("Recovery unavailable");
    if (typeof title !== "string" || title.length > 200 ||
        typeof notes !== "string" || notes.length > 1000000) throw new Error("Invalid meeting details");
    const recoveryLanguage = speechLanguage(language);
    const recoveryParticipants = participantNames(participants);
    active = true;
    try {
      await requireLocalSpeechModel(recognitionRuntime(root).model);
      const capture = await dialog.showOpenDialog(window, {
        title: "Choose an interrupted recording", defaultPath: spoolRoot, properties: ["openDirectory"],
      });
      if (capture.canceled) return null;
      const directory = await validateCaptureDirectory(spoolRoot, capture.filePaths[0]);
      const vault = await chooseVault();
      if (!vault) return null;
      const tracks = await recoverCapture(spoolRoot, directory);
      const meeting = await saveCapturedMeeting(root, vault, tracks, title, notes, recoveryLanguage,
        await captureKeepsRecording(directory), recoveryParticipants, linkedEvent(calendarId, calendarStart), filing);
      try {
        const completedCapture = await validateCaptureDirectory(spoolRoot, directory);
        await rm(completedCapture, { recursive: true, force: true });
      } catch (error) {
        console.error("Recovered meeting was saved, but temporary audio could not be removed", error);
        return { ...meeting, temporaryAudioRemains: true };
      }
      return meeting;
    } finally {
      active = false;
    }
  });
  window.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== window.webContents.mainFrame || !request.userGesture ||
        !request.audioRequested) {
      callback({});
      return;
    }
    const [screen] = await desktopCapturer.getSources({
      types: ["screen"], thumbnailSize: { width: 0, height: 0 },
    }).catch(() => []);
    callback(screen ? { video: screen, audio: "loopback" } : {});
  });
  let dailyPaths: typeof searched;
  let dailyWriting = false;
  ipcMain.handle("daily:journal", async (event, command) => {
    if (window.isDestroyed() || event.senderFrame !== window.webContents.mainFrame) throw Error("Journal unavailable.");
    if (command && (dailyWriting || active || (spool && ["attach","detach","rename"].includes(command.type)))) throw Error("Finish the current operation and retry.");
    if (command) dailyWriting = true;
    const metadataChange = command && ["attach","detach","rename"].includes(command.type);
    if (metadataChange) active = true;
    try {
      const vault = command ? await chooseVault() : fixtureVault ?? preferredVault;
      if (!vault) return null;
      const result = command ? await changeDaily(vault,command) : await readDaily(vault);
      dailyPaths = {vault, paths:new Set(result.meetings.map(m=>m.path))};
      return result;
    } finally {
      if (command) dailyWriting = false;
      if (metadataChange) active = false;
    }
  });
  ipcMain.handle("daily:source", async (event, id, anchor, revision) => {
    if (event.senderFrame !== window.webContents.mainFrame || !dailyPaths ||
        dailyPaths.vault !== (fixtureVault ?? preferredVault) || typeof id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(id)) throw Error("Meeting source unavailable.");
    const {vault,paths} = dailyPaths;
    const path = [...paths].find(path=>path.endsWith("--"+id));
    if (!path) throw Error("Meeting source unavailable.");
    const bundle = await resolveMeetingLink(vault,path);
    const meeting = await openMeeting(vault,bundle,revision);
    const passage = anchor && meeting.segments.find(s=>s.id===anchor)?.text;
    if (anchor && !passage) throw Error("Transcript passage unavailable.");
    const enhanced = await readEnhancedNotes(bundle);
    return {passage, notes:enhanced.text || meeting.notes.replace(/^---[\s\S]*?---\s*/, "")};
  });
  ipcMain.handle("meeting:search", async (event, query, prompt = true, actions = false, contextFilter = "") => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) throw new Error("Search unavailable");
    if (typeof query !== "string" || query.length > 200) throw new Error("Enter a shorter search query");
    if (typeof contextFilter !== "string" || contextFilter.length > 120) throw new Error("Enter a shorter context name");
    active = true;
    try {
      const vault = prompt === false ? fixtureVault ?? preferredVault : await chooseVault();
      if (!vault) return null;
      const results = actions === true ? await listRecentActions(vault) : await searchVault(vault, query, false, contextFilter);
      searched = { vault, paths: new Set(results.map((result) => String(result.bundle))) };
      return results;
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:resolve-suggestion", async (event, path, key, accept) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool ||
        !searched?.paths.has(path) || typeof key !== "string" || typeof accept !== "boolean") {
      throw new Error("Filing suggestion unavailable");
    }
    active = true;
    try {
      const { vault } = searched;
      const entry = (await searchVault(vault, "")).find((result) => result.bundle === path && result.suggestion?.key === key);
      if (!entry?.suggestion) throw new Error("Filing suggestion expired");
      await resolveFilingSuggestion(vault, join(vault, path), entry.suggestion, accept);
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:browse-contexts", async (event) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) throw new Error("Context browser unavailable");
    active = true;
    try {
      const vault = await chooseVault();
      if (!vault) return null;
      const groups = await listVaultContexts(vault);
      browsed = { vault, paths: new Set(groups.flatMap((group) => group.meetings.map((meeting) => meeting.bundle))) };
      return groups;
    } finally {
      active = false;
    }
  });
  async function loadMeeting(vault: string, bundle: string) {
    const meeting = await openMeeting(vault, bundle);
    const enhancements = await listEnhancements(bundle, meeting);
    const enhancedNotes = await readEnhancedNotes(bundle);
    openedMeeting = { vault, bundle };
    return { bundle, ...meeting, enhancements, enhancedNotes };
  }
  ipcMain.handle("meeting:open-calendar", async (event, id, start) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) {
      throw new Error("Meeting open unavailable during capture or processing");
    }
    const linked = linkedEvent(id, start);
    const vault = fixtureVault ?? preferredVault;
    if (!linked || !vault) return null;
    active = true;
    try {
      const bundle = await findCalendarMeeting(vault, linked);
      return bundle ? await loadMeeting(vault, bundle) : null;
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:open", async (event, result, contextBrowser) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) {
      throw new Error("Meeting open unavailable during capture or processing");
    }
    active = true;
    try {
      if (result !== undefined) {
        const listing = contextBrowser === "journal" ? dailyPaths : contextBrowser === true ? browsed : searched;
        if (typeof result !== "string" || !listing?.paths.has(result)) throw new Error("Meeting result expired");
        return await loadMeeting(listing.vault, await resolveMeetingLink(listing.vault, result));
      }
      const vault = await chooseVault();
      if (!vault) return null;
      const selected = await dialog.showOpenDialog(window, {
        title: "Choose a saved meeting folder", defaultPath: vault,
        properties: ["openDirectory"],
      });
      if (selected.canceled) return null;
      return await loadMeeting(vault, selected.filePaths[0]);
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:flag-transcript", async (event, bundle, revision) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool || !openedMeeting ||
        bundle !== openedMeeting.bundle || !Number.isSafeInteger(revision)) throw new Error("Transcript unavailable");
    active = true;
    try {
      await flagTranscript(openedMeeting.vault, bundle, revision);
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:transcript", async (event, bundle, revision) => {
    if (event.senderFrame !== window.webContents.mainFrame || !openedMeeting ||
        bundle !== openedMeeting.bundle || !Number.isSafeInteger(revision)) throw new Error("Transcript unavailable");
    return await openMeeting(openedMeeting.vault, bundle, revision);
  });
  ipcMain.handle("meeting:refine", async (event, bundle, language) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool ||
        !openedMeeting || bundle !== openedMeeting.bundle) throw new Error("Open a meeting before refining its transcript.");
    active = true;
    try {
      const { vault } = openedMeeting;
      const meeting = await refineMeeting(root, vault, bundle, speechLanguage(language));
      return { ...meeting, enhancements: await listEnhancements(bundle, meeting) };
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:archive", async (event, bundle, archived) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool ||
        !openedMeeting || bundle !== openedMeeting.bundle || typeof archived !== "boolean") {
      throw new Error("Open a meeting before changing its archive status.");
    }
    active = true;
    try {
      const { vault } = openedMeeting;
      openedMeeting = { vault, bundle: await archiveMeeting(vault, bundle, archived) };
      return openedMeeting.bundle;
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:rename", async (event, bundle, title) => {
    if (event.senderFrame !== window.webContents.mainFrame || !openedMeeting || bundle !== openedMeeting.bundle) {
      throw new Error("Open the meeting before renaming it.");
    }
    if (active || spool) throw new Error("A meeting operation is in progress. Try the title edit again.");
    active = true;
    try {
      return await renameMeeting(openedMeeting.vault, bundle, title);
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:contexts", async (event, bundle, value) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool ||
        !openedMeeting || bundle !== openedMeeting.bundle) throw new Error("Open the meeting before saving contexts.");
    active = true;
    try {
      return await saveMeetingContexts(openedMeeting.vault, bundle, value);
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:save-enhanced", async (event, bundle, text, revision) => {
    if (event.senderFrame !== window.webContents.mainFrame ||
        !openedMeeting || bundle !== openedMeeting.bundle) throw new Error("Open the meeting before saving edits.");
    if (active || spool) return { busy: true };
    if (typeof text !== "string" || text.length > 1000000 ||
        (revision !== null && (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)))) {
      throw new Error("Invalid enhanced notes");
    }
    active = true;
    try {
      await openMeeting(openedMeeting.vault, openedMeeting.bundle);
      return { saved: await saveEnhancedNotes(openedMeeting.bundle, text, revision) };
    } catch (error) {
      if (error instanceof EnhancedNotesConflict) return { conflict: error.current };
      throw error;
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:ask", async (event, question, model, acrossVault, provider = "ollama") => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) {
      throw new Error("Questions are unavailable during capture or processing.");
    }
    if (provider !== "ollama" && provider !== "lm-studio" && !isHosted(provider)) throw new Error("Choose a model provider.");
    if (typeof question !== "string" || !question.trim() || question.length > 1000 ||
        typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("Enter a question and select a model in Settings.");
    active = true;
    try {
      if (acrossVault === true) {
        const vault = await chooseVault();
        if (!vault) return null;
        const answer = await askVault(vault, question.trim(), model.trim(), provider);
        if (searched?.vault !== vault) searched = { vault, paths: new Set() };
        for (const citation of answer.citations) if (citation.bundle) searched.paths.add(citation.bundle);
        return answer;
      }
      if (!openedMeeting) throw new Error("Open a saved meeting before asking a question.");
      return await askMeeting(openedMeeting.vault, openedMeeting.bundle, question.trim(), model.trim(), provider);
    } finally {
      active = false;
    }
  });
  let enhancementJob: AbortController | undefined;
  ipcMain.handle("meeting:cancel-enhancement", (event) => {
    if (event.senderFrame !== window.webContents.mainFrame) return;
    enhancementJob?.abort();
  });
  ipcMain.handle("meeting:enhance", async (event, model, provider) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool || !openedMeeting) {
      throw new Error("Open a saved meeting before enhancing it.");
    }
    if (provider !== "ollama" && provider !== "lm-studio" && !isHosted(provider)) throw new Error("Choose a model provider.");
    if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("Select a model in Settings.");
    active = true;
    enhancementJob = new AbortController();
    const originalFetch = globalThis.fetch;
    try {
      if (checkCombinedNotes) {
        globalThis.fetch = async (_url, options) => {
          const input = JSON.parse(JSON.parse(String(options?.body)).messages[1].content.split("\n")[1]);
          if (checkCombinedNotesFailure) return Response.json({ error: "Fixture model unavailable." }, { status: 400 });
          if (!input.notes) return Response.json({done:true,message:{content:JSON.stringify({actions:[]})}});
          const segment = input.transcript.find(s => /fellow americans/i.test(s.text)) ?? input.transcript[0];
          const content = {sections:[{heading:++fixtureOutlines === 1 ? "Release checklist" : "Updated release checklist",
            items:input.notes.map((n,i)=>({manualId:n.id,text:"",segmentIds:[],children:i ? [] : [
              {manualId:"",text:"The speaker addresses fellow Americans.",segmentIds:[segment.id]},
            ]}))}],actions:[]};
          return Response.json({ done: true, message: { content: JSON.stringify(content) } });
        };
      }
      const before = await readEnhancedNotes(openedMeeting.bundle);
      const history = await listEnhancements(openedMeeting.bundle);
      const previousOutlines = history.filter(entry => typeof entry.draft.outline === "string");
      const matching = previousOutlines.find(entry => entry.draft.outline === before.text);
      let writtenNotes: string | undefined;
      if (before.revision !== null) {
        if (matching) writtenNotes = matching.draft.writtenNotes;
        else {
          // Recover original manual wording from the most recent matching line in draft history.
          const generated = new Set<string>();
          const manual = new Map<string,string>();
          for (const {draft} of previousOutlines) {
            for (const line of draft.generatedLines ?? draft.outline.split("\n").filter(line => line.startsWith("- **AI:** "))) generated.add(line);
            for (const line of draft.outline.split("\n").filter(line => line.startsWith("## "))) generated.add(line);
            for (const entry of draft.manualLines ?? []) if (!manual.has(entry.line)) manual.set(entry.line,entry.text);
          }
          writtenNotes = before.text.split("\n").flatMap(line => manual.has(line) ? [manual.get(line)!] : generated.has(line) ? [] : [line]).join("\n");
        }
      }
      const record = await enhanceMeetingOutline(openedMeeting.vault, openedMeeting.bundle, model.trim(), provider,
        enhancementJob.signal, writtenNotes);
      const current = await readEnhancedNotes(openedMeeting.bundle);
      if (record.stale) throw new Error("The meeting changed during generation.");
      return { record, current, usedSavedWriting: !previousOutlines.length && before.revision === current.revision };
    } catch (error) {
      if (enhancementJob.signal.aborted && error === enhancementJob.signal.reason) return null;
      throw error;
    } finally {
      if (checkCombinedNotes) globalThis.fetch = originalFetch;
      enhancementJob = undefined;
      active = false;
    }
  });
  ipcMain.handle("meeting:create-note", async (event, title: unknown, notes: unknown, participants: unknown, calendarId, calendarStart, filing) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) throw new Error("Finish recording before saving a standalone note.");
    if (typeof title !== "string" || title.length > 200 || typeof notes !== "string" ||
        notes.length > 1000000 || (!title.trim() && !notes.trim())) throw new Error("Enter a title or write a note.");
    active = true;
    try {
      const vault = await chooseVault();
      if (!vault) return null;
      const bundle = await createMeeting(vault, title.trim() || "Untitled note", notes, [], [],
        participantNames(participants), false, linkedEvent(calendarId, calendarStart), filing);
      return await loadMeeting(vault, bundle);
    } finally {
      active = false;
    }
  });
  ipcMain.handle("meeting:import", async (event, title, notes, language, participants, calendarId, calendarStart, filing) => {
    if (event.senderFrame !== window.webContents.mainFrame || active || spool) {
      throw new Error("Meeting import unavailable");
    }
    if (typeof title !== "string" || !title.trim() || title.length > 200 ||
        typeof notes !== "string" || notes.length > 1000000) throw new Error("Invalid meeting details");
    active = true;
    try {
      const audio = await dialog.showOpenDialog(window, {
        title: "Choose a recording", properties: ["openFile"],
        filters: [{ name: "Audio", extensions: ["wav", "flac", "mp3", "m4a", "ogg", "webm"] }],
      });
      if (audio.canceled) return null;
      const vault = await chooseVault();
      if (!vault) return null;
      return await importMeeting(root, vault, audio.filePaths[0], title.trim(), notes, speechLanguage(language),
        participantNames(participants), linkedEvent(calendarId, calendarStart), filing);
    } finally {
      active = false;
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  app.on("window-all-closed", () => app.quit());
  if (checkVaultUI) window.webContents.on("console-message", details => {
    if (details.level === "error") console.error(details.message);
  });
  if (screenshotPath) {
    // Draw without taking focus, behind other windows on Windows, and keep drawing while covered.
    window.showInactive();
    if (process.platform === "win32") window.blur();
  }
  await window.loadFile(join(root, "desktop/index.html"));
  if (screenshotPath) {
    await window.webContents.executeJavaScript(`
      (async () => {
        for (let i = 0; i < 200 && !(window.stillwaterJournal?.data.folders.length); i++) await new Promise(r => setTimeout(r, 50));
        window.stillwaterFolders.openMyNotes();
        // STILLWATER_SCREENSHOT_VIEW=folder|picker|suggest|views|alert photographs another state for design review.
        const view = ${JSON.stringify(process.env.STILLWATER_SCREENSHOT_VIEW ?? "")};
        const journal = window.stillwaterJournal.data;
        if (view === "folder") window.stillwaterFolders.openFolder(journal.folders.find(f => f.title === "Launches").id);
        if (view === "picker") {
          const note = journal.meetings.find(m => m.title.startsWith("Pricing"));
          await openSavedMeeting(note.path, "", "journal");
          await new Promise(r => setTimeout(r, 300));
          document.querySelector("#saved-folders .add").click();
          return;
        }
        if (view === "suggest") {
          const note = journal.meetings.filter(m => m.title === "Weekly design review").sort((a, b) => b.date.localeCompare(a.date))[0];
          await openSavedMeeting(note.path, "", "journal");
          await new Promise(r => setTimeout(r, 300));
        }
        if (view === "views") { document.getElementById("sidebar-new-label-view").click(); return; }
        document.activeElement?.blur();
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The alert view photographs the before-meeting card instead of the main window.
    const start = new Date(Date.now() + 60000);
    const card = process.env.STILLWATER_SCREENSHOT_VIEW === "alert" ? await alerts?.preview({
      id: "demo-alert", title: "Weekly design review", allDay: false, start: start.toISOString(),
      end: new Date(start.getTime() + 30 * 60000).toISOString(), attendees: ["Avery Kim"],
      join: { url: "https://meet.google.com/demo", service: "Google Meet" } }) : undefined;
    if (card) await new Promise((resolve) => setTimeout(resolve, 600));
    const image = await (card ?? window).webContents.capturePage(undefined, { stayHidden: true });
    await writeFile(screenshotPath, image.toPNG());
    console.log("Saved " + screenshotPath);
    app.exit(0);
    await new Promise(() => undefined);
  }
  const tray = (!checkCapture || checkCaptureExit) && !checkVaultUI && process.platform === "win32"
    ? installTray(window, async () => {
        if (active || !spool) return !active;
        window.show();
        window.focus();
        const stopped = await window.webContents.executeJavaScript(`
          (async () => {
            const stop = document.querySelector("#capture-stop");
            if (stop.disabled) return false;
            stop.click();
            while (document.querySelector("#capture-start").disabled) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return ${checkCaptureExit} ? /Recording saved\./i.test(
              document.querySelector("#capture-status").textContent) : true;
          })()
        `);
        const ready = stopped && !active && !spool;
        if (ready && checkCaptureExit) await rm(spoolRoot, { recursive: true, force: true });
        return ready;
      }) : undefined;
  if (checkTray) {
    if (!tray || tray.tray.isDestroyed()) throw new Error("Windows tray unavailable");
    const restartResult = trayRestartResult;
    const previousPid = restartResult ? await readFile(restartResult, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    }) : "";
    if (restartResult && previousPid) {
      if (Number(previousPid) === process.pid) throw new Error("Tray restart reused the original process");
      await rm(settingsDirectory, { recursive: true, force: true });
      await writeFile(restartResult, JSON.stringify({ previousPid: Number(previousPid), pid: process.pid }));
      tray.menu.getMenuItemById("exit")!.click();
    } else {
    const click = async (id: string, selector: string) => {
      const item = tray.menu.getMenuItemById(id);
      if (!item) throw new Error("Missing tray action " + id);
      item.click();
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Tray action did not open " + selector);
    };
    const folder = await mkdtemp(join(app.getPath("temp"), "stillwater-trace-check-"));
    try {
      await window.webContents.executeJavaScript('navigator.mediaDevices.getDisplayMedia = async () => { throw Error("Tray fixture audio unavailable"); }; void 0');
      await click("new-note", "#meeting-notes:not([hidden])");
      if (!(await window.webContents.executeJavaScript('document.querySelector("#capture-status").textContent.includes("Tray fixture audio unavailable")'))) {
        throw new Error("Tray New note did not attempt audio capture");
      }
      await click("settings", "#speech-settings[open]");
      window.close();
      if (window.isDestroyed() || window.isVisible()) throw new Error("Close did not hide the window to the tray");
      const path = await recordPerformanceTrace(folder);
      const data = await readFile(path);
      if (data.length < 1024 || data[0] !== 0x0a) throw new Error("Trace did not contain Perfetto packets");
      console.log("Native tray shortcuts, close-to-tray, and local trace passed.");
    } finally {
      await rm(folder, { recursive: true, force: true });
      await rm(settingsDirectory, { recursive: true, force: true });
    }
    if (restartResult) await writeFile(restartResult, String(process.pid), { flag: "wx" });
    const action = tray.menu.getMenuItemById(restartResult ? "restart" : "exit");
    if (!action) throw new Error("Missing tray lifecycle action");
    action.click();
    }
  } else if (checkVaultUI) {
    // Native blur events require focus even when the test window is hidden.
    window.webContents.debugger.attach();
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await window.webContents.executeJavaScript('navigator.mediaDevices.getDisplayMedia = async () => { throw Error("No input in writing-only fixture"); }; void 0');
    window.setSize(640, 520);
    await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const homeScreenshot = process.env.STILLWATER_CHECK_HOME_SCREENSHOT;
    const editorScreenshot = process.env.STILLWATER_CHECK_EDITOR_SCREENSHOT;
    const wideHomeScreenshot = process.env.STILLWATER_CHECK_WIDE_HOME_SCREENSHOT;
    if (wideHomeScreenshot) {
      window.setSize(1120, 800);
      await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await writeFile(wideHomeScreenshot, (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: "wx" });
      window.setSize(640, 520);
    }
    for (const [screenshot, view] of [[homeScreenshot, "home"], [editorScreenshot, "editor"]]) {
      if (!screenshot) continue;
      if (view === "editor") await window.webContents.executeJavaScript('document.querySelector("#new-note").click()');
      await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await writeFile(screenshot, (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: "wx" });
      if (view === "editor") await window.webContents.executeJavaScript('document.querySelector("#go-home").click()');
    }
    await window.webContents.executeJavaScript(`
      (() => {
        const createNote = document.querySelector("#empty-new-note");
        const actionBounds = document.querySelector("#journal-create").getBoundingClientRect();
        if (!actionBounds.height || actionBounds.bottom > innerHeight) {
          throw new Error("The empty library note action is outside the initial viewport");
        }
        createNote.click();
        const editor = document.querySelector("#meeting-notes");
        if (editor.hidden || document.activeElement !== editor.elements.notes) {
          throw new Error("The empty library action did not focus the note editor");
        }
        document.querySelector("#go-home").click();
        const settings = document.querySelector("#speech-settings");
        settings.open = true;
        const panel = settings.querySelector(".settings-panel").getBoundingClientRect();
        if (panel.left < 0 || panel.right > document.documentElement.clientWidth || panel.bottom > innerHeight) {
          throw new Error("Settings extends outside the minimum-size window");
        }
        settings.querySelector("summary").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        if (settings.open || document.activeElement !== settings.querySelector("summary")) {
          throw new Error("Escape did not close Settings and restore focus");
        }
      })()
    `);
    if (process.argv.includes("--check-recovery-model-missing")) {
      await window.webContents.executeJavaScript(`
        (async () => {
          const recover = document.querySelector("#recover-capture");
          recover.click();
          for (let attempt = 0; attempt < 100 && recover.disabled; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const status = document.querySelector("[role=status]").textContent;
          if (recover.disabled || !status.includes("Local Whisper model is unavailable.")) {
            throw new Error("Recovery did not report the missing local model: " + status);
          }
        })()
      `);
      console.log("Recovery reported the missing Whisper model and restored the button.");
    }
    const expectedEnglishEngine = process.env.STILLWATER_CHECK_ENGLISH_ENGINE_TEXT;
    if (expectedEnglishEngine) {
      await window.webContents.executeJavaScript(`
        (async () => {
          const status = document.querySelector("#english-engine");
          for (let attempt = 0; attempt < 100 && !status.textContent; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (status.textContent !== ${JSON.stringify(expectedEnglishEngine)}) {
            throw new Error("Unexpected English recording status: " + status.textContent);
          }
        })()
      `);
    }
    fixtureVault = await mkdtemp(join(root, ".vault-check-"));
    try {
      const id = randomUUID();
      let bundle = await createMeeting(fixtureVault, "Release planning", "Original raw notes.", [
        { id, source: "system", startMs: 100, endMs: 2000, text: "Morgan will send the projector checklist." },
      ]);
      const currentId = randomUUID();
      const current = await saveTranscriptRevision(fixtureVault, bundle, 1, [
        { id: currentId, source: "system", startMs: 100, endMs: 2000, text: "Morgan will send the revised projector checklist." },
      ]);
      const draftId = randomUUID();
      const actionDraftId = randomUUID();
      await writeFile(join(bundle, `enhancement-${actionDraftId}.json`), JSON.stringify({
        schemaVersion: 1, id: actionDraftId, provider: "ollama", model: "fixture",
        createdAt: "2026-01-01T00:00:00.000Z", transcriptRevision: current.revision,
        inputHash: createHash("sha256").update(JSON.stringify({ notes: current.notes, transcript: current.segments })).digest("hex"),
        draft: { summary: "Planning", actions: [{ text: "Send the revised checklist", segmentIds: [currentId] }] },
      }));
      await writeFile(join(bundle, `enhancement-${draftId}.json`), JSON.stringify({
        schemaVersion: 1, id: draftId, provider: "ollama", model: "fixture",
        createdAt: new Date().toISOString(), transcriptRevision: 1,
        draft: { summary: "Planning", actions: [{ text: "Send the checklist", segmentIds: [id] }] },
      }));
      await window.webContents.executeJavaScript(`
        (async () => {
          const form = document.querySelector("#vault-search");
          form.elements.query.value = "projector checklist";
          form.requestSubmit();
          for (let attempt = 0; attempt < 100; attempt++) {
            if (document.querySelector("#search-results button")) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Missing search result before folder rename");
        })()
      `);
      const renamed = join(dirname(bundle), `${basename(bundle).slice(0, 10)}-renamed-planning--${current.metadata.meetingId}`);
      await rename(bundle, renamed);
      bundle = renamed;
      const meetingScreenshot = process.env.STILLWATER_CHECK_MEETING_SCREENSHOT;
      if (meetingScreenshot) {
        await window.webContents.executeJavaScript(`
          (async () => {
            document.querySelector("#search-results button").click();
            for (let attempt = 0; attempt < 100 && document.querySelector("#saved-meeting").hidden; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            if (document.querySelector("#saved-meeting").hidden) throw new Error("Saved meeting did not open for visual review");
            document.querySelector("#saved-transcript-panel").open = false;
            window.scrollTo(0, 0);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()
        `);
        await writeFile(meetingScreenshot, (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG(), { flag: "wx" });
      }
      await window.webContents.executeJavaScript(`
        (async () => {
          const find = async (selector) => {
            for (let attempt = 0; attempt < 100; attempt++) {
              const element = document.querySelector(selector);
              if (element) return element;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error("Missing " + selector + ": " + document.querySelector("[role=status]").textContent);
          };
          const waitStatus = async (expected) => {
            const status = document.querySelector("[role=status]");
            for (let attempt = 0; attempt < 100; attempt++) {
              if (status.textContent === expected) return;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error("Expected " + expected + " but got " + status.textContent);
          };
          const form = document.querySelector("#vault-search");
          if (document.querySelector("#saved-meeting").hidden) (await find("#search-results button")).click();
          const segment = await find("#segment-${currentId}");
          if (!segment.textContent.includes("projector checklist")) throw new Error("Incorrect search result");
          if (!document.querySelector("#refine-meeting").disabled ||
              document.querySelector("#refine-unavailable").hidden) {
            throw new Error("Missing explanation for unavailable refinement");
          }
          const savedTranscript = document.querySelector("#saved-transcript-panel");
          savedTranscript.open = false;
          (await find("#enhancement a")).click();
          const citedSegment = await find("#segment-${id}");
          if (!savedTranscript.open || !citedSegment.getClientRects().length) {
            throw new Error("The historical citation did not reveal its transcript passage");
          }
          if (document.querySelector("#transcript-revision").textContent !== "Revision 1") {
            throw new Error("Historical citation opened the wrong revision");
          }
          const savedSearch = document.querySelector("#saved-transcript-search");
          savedSearch.value = "phrase absent from the fixture";
          savedSearch.dispatchEvent(new Event("input"));
          if (!citedSegment.hidden || !document.querySelector("#saved-transcript-matches").textContent.startsWith("0 ")) {
            throw new Error("Historical transcript search did not filter its passages");
          }
          (await find("#enhancement a")).click();
          if (citedSegment.hidden || savedSearch.value) throw new Error("A citation was hidden by the transcript filter");
          document.querySelector("#flag-transcript").click();
          await waitStatus("Transcript flagged for local review.");
          (await find("#current-transcript:not([hidden])")).click();
          await find("#segment-${currentId}");
          const titleButton = document.querySelector("#rename-title");
          const titleEditor = document.querySelector("#title-editor");
          const originalTitle = document.querySelector("#saved-title").textContent;
          titleButton.click();
          titleEditor.value = "Cancelled title";
          titleEditor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          if (document.querySelector("#saved-title").textContent !== originalTitle) throw Error("Escape changed the saved title");
          titleButton.click();
          titleEditor.value = "Atlas title edit";
          if (document.activeElement !== titleEditor) throw Error("Title edit did not focus input");
          titleEditor.blur();
          try { await find("#title-editor[hidden]"); }
          catch { throw Error("Title commit failed: " + document.querySelector("#title-status").textContent + " readonly=" + titleEditor.readOnly); }
          if (document.querySelector("#saved-title").textContent !== "Atlas title edit" ||
              ![...document.querySelectorAll("#search-results button")].some(b => b.textContent.includes("Atlas title edit"))) {
            throw Error("Title edit did not update the meeting and its library entry");
          }
          titleButton.click();
          titleEditor.value = originalTitle;
          titleEditor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          await find("#title-editor[hidden]");
          document.querySelector("#edit-meeting-notes").click();
          const noteEditor = document.querySelector("#enhanced-editor");
          if (noteEditor.hidden) throw new Error("Edit notes did not open the editor");
          noteEditor.value = "Verified enhanced notes.";
          noteEditor.dispatchEvent(new Event("input", { bubbles: true }));
          await waitStatus("Saved meeting notes.");
          document.querySelector("#meeting-contexts").value = "project: Atlas\\ntopic: Procurement";
          document.querySelector("#save-contexts").click();
          await waitStatus("Saved meeting contexts.");
          form.elements.query.value = "";
          form.elements.context.value = "project: Unknown";
          form.requestSubmit();
          await waitStatus("No matching meetings.");
          if (document.querySelector("#empty-new-note").getClientRects().length) {
            throw new Error("A search with no matches showed the empty library action");
          }
          form.elements.context.value = "project: atlas";
          form.requestSubmit();
          await find("#search-results button");
          form.elements.context.value = "";
          const archive = document.querySelector("#archive-meeting");
          archive.click();
          await waitStatus("Meeting archived.");
          document.querySelector("#browse-contexts").click();
          await waitStatus("Found 2 contexts.");
          const entries = [...document.querySelectorAll("#context-results button")];
          if (entries.length !== 2 || entries.some((entry) => !entry.textContent.includes("Archived"))) {
            throw new Error("Expected the archived meeting in both contexts");
          }
          document.querySelector("#saved-meeting").hidden = true;
          entries[1].click();
          await find("#saved-meeting:not([hidden])");
          archive.click();
          await waitStatus("Meeting restored.");
          document.querySelector("#go-home").click();
          document.querySelector("#recent-meetings").click();
          await waitStatus("Found 1 results.");
          const recentMeeting = await find("#search-results .dated-meeting");
          if (!recentMeeting.textContent.includes("Release planning")) {
            throw new Error("Recent meetings did not show the saved title");
          }
          const meetingLabel = recentMeeting.querySelector("span");
          const originalLabel = meetingLabel.textContent;
          const originalHeight = meetingLabel.getBoundingClientRect().height;
          meetingLabel.textContent = "Release planning and follow-up on the regional rollout ".repeat(8);
          const titleBounds = meetingLabel.getBoundingClientRect();
          const timeBounds = recentMeeting.querySelector("time").getBoundingClientRect();
          if (titleBounds.right >= timeBounds.left || timeBounds.right > document.documentElement.clientWidth ||
              titleBounds.height <= originalHeight) {
            throw new Error("The long meeting title did not wrap beside the timestamp");
          }
          meetingLabel.textContent = originalLabel;
          recentMeeting.click();
          await find("#saved-meeting:not([hidden])");
          if (savedTranscript.open) throw new Error("Opening a recent note expanded its transcript");
          document.querySelector("#go-home").click();
          document.querySelector("#recent-actions").click();
          await waitStatus("Found 1 action items.");
          const action = await find("#search-results button");
          if (!action.textContent.includes("Send the revised checklist")) throw new Error("Incorrect action item");
          action.click();
          await find("#saved-meeting:not([hidden]) #saved-transcript-panel[open] #segment-${currentId}");
          const editor = document.querySelector("#meeting-notes");
          document.querySelector("#new-note").click();
          if (editor.hidden) throw new Error("New note did not open the editor");
          editor.elements.title.value = "Standalone fixture for Atlas";
          editor.elements.participants.value = "Morgan, Alice, Morgan";
          editor.elements.filing.value = "topic: Planning";
          editor.elements.notes.focus();
          editor.elements.notes.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
          const template = await find("#template-picker[open] button[value=meeting]");
          template.click();
          for (let attempt = 0; attempt < 100 && !editor.elements.notes.value.includes("## Action items"); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!editor.elements.notes.value.includes("## Action items")) throw new Error("Template was not inserted");
          document.querySelector("#go-home").click();
          await waitStatus("Saved Standalone fixture for Atlas.");
          if (["title", "notes", "participants", "filing"].some((name) => editor.elements[name].value)) {
            throw new Error("Successful standalone save left the saved draft in the editor");
          }
          editor.elements.notes.value = "Draft survives navigation";
          editor.elements.notes.dispatchEvent(new KeyboardEvent("keydown", {
            key: "k", ctrlKey: true, bubbles: true, cancelable: true,
          }));
          if (!editor.hidden || document.activeElement !== form.elements.query) {
            throw new Error("Ctrl+K did not return Home and focus search");
          }
          const suggestion = await find(".filing-suggestion");
          if (!suggestion.textContent.includes("Add to Atlas")) throw new Error("Expected an Atlas suggestion");
          suggestion.querySelector("button").click();
          await waitStatus("Filed in Atlas.");
          document.querySelector("#new-note").click();
          if (editor.elements.notes.value !== "Draft survives navigation") throw new Error("Navigation lost draft text");
          editor.elements.notes.dispatchEvent(new Event("input", { bubbles: true }));
          const enhanced = document.querySelector("#enhanced-editor");
          enhanced.value = "Unsaved enhanced draft.";
          enhanced.dispatchEvent(new Event("input", { bubbles: true }));
          const provider = document.querySelector("#draft-provider");
          const model = document.querySelector("#draft-model");
          const discoveryProvider = ${JSON.stringify(process.argv.includes("--check-lm-studio-discovery") ? "lm-studio"
            : process.argv.includes("--check-ollama-discovery") ? "ollama" : "")};
          if (discoveryProvider) {
            provider.value = discoveryProvider;
            provider.dispatchEvent(new Event("change", { bubbles: true }));
            document.querySelector("#discover-models").click();
            const button = document.querySelector("#discover-models");
            for (let attempt = 0; attempt < 100 && button.disabled; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!document.querySelector("#local-models option")) {
              throw new Error(discoveryProvider + " discovery failed. " + document.querySelector("#model-discovery-status").textContent);
            }
          }
          provider.value = "lm-studio";
          provider.dispatchEvent(new Event("change", { bubbles: true }));
          model.value = "fixture-local-model";
          model.dispatchEvent(new Event("change", { bubbles: true }));
        })()
      `);
      await window.loadFile(join(root, "desktop/index.html"));
      if (!await window.webContents.executeJavaScript(
        'document.querySelector("#draft-provider").value === "lm-studio" && ' +
        'document.querySelector("#draft-model").value === "fixture-local-model"')) {
        throw new Error("Reload lost the local enhancement preferences");
      }
      if (await window.webContents.executeJavaScript('document.querySelector("[name=notes]").value') !== "Draft survives navigation") {
        throw new Error("Reload lost the editor draft");
      }
      const restored = await openMeeting(fixtureVault, bundle);
      if (restored.flagged || !(await openMeeting(fixtureVault, bundle, 1)).flagged) {
        throw new Error("Review flag did not follow the cited revision");
      }
      if (!(await searchVault(fixtureVault, "Standalone fixture")).length) throw new Error("Standalone note was not indexed");
      const recent = await searchVault(fixtureVault, "");
      const standalone = recent.find((entry) => entry.excerpt === "Standalone fixture for Atlas");
      if (standalone?.participants?.join(", ") !== "Morgan, Alice") throw new Error("Participants were not saved");
      const filed = await openMeeting(fixtureVault, join(fixtureVault, standalone.bundle));
      if (!filed.metadata.contexts.some((context) => context.name === "Planning")) {
        throw new Error("Editor filing was not saved");
      }
      if (!filed.metadata.contexts.some((context) => context.name === "Atlas" && context.status === "confirmed")) {
        throw new Error("Accepted filing suggestion was not persisted");
      }
      if ((await readEnhancedNotes(bundle)).text !== "Verified enhanced notes." || restored.archived ||
          !restored.notes.includes("Original raw notes.") || restored.metadata.contexts.length !== 2) {
        throw new Error("Unexpected vault contents after saving edits");
      }
      await writeFile(join(bundle, "enhanced.md"), "External enhanced edit.");
      await window.webContents.executeJavaScript(`
        (async () => {
          await initialLibraryLoad;
          const search = document.querySelector("#vault-search");
          search.elements.query.value = "projector checklist";
          search.requestSubmit();
          for (let attempt = 0; attempt < 100 && document.querySelector("#recent-meetings").disabled; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          document.querySelector("#search-results button").click();
          const enhanced = document.querySelector("#enhanced-editor");
          for (let attempt = 0; attempt < 100 && !enhanced.value; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (enhanced.value !== "Unsaved enhanced draft.") throw new Error("Reload lost the enhanced draft");
          if (document.querySelector("#enhanced-conflict").hidden ||
              document.querySelector("#enhanced-conflict-text").textContent !== "External enhanced edit.") {
            throw new Error("Conflict did not show the saved copy for comparison");
          }
          let asked = false;
          const confirm = window.confirm;
          try {
            window.confirm = () => { asked = true; return false; };
            document.querySelector("#resolve-note-conflict").click();
            if (!asked || enhanced.value !== "Unsaved enhanced draft.") throw new Error("Draft conflict was not preserved");
          } finally {
            window.confirm = confirm;
          }
        })()
      `);
      if ((await readEnhancedNotes(bundle)).text !== "External enhanced edit.") {
        throw new Error("Declining the conflict prompt changed the disk copy");
      }
      await writeFile(join(bundle, "enhanced.md"), "Second external edit.");
      await window.webContents.executeJavaScript(`
        (async () => {
          const confirm = window.confirm;
          try {
            window.confirm = () => true;
            const save = document.querySelector("#resolve-note-conflict");
            save.click();
            for (let attempt = 0; attempt < 100 && !document.querySelector("#enhanced-conflict-text").textContent.includes("Second external edit."); attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (document.querySelector("#enhanced-conflict-text").textContent !== "Second external edit." ||
                document.querySelector("#enhanced-editor").value !== "Unsaved enhanced draft.") {
              throw new Error("Save-time conflict lost the draft or latest disk copy");
            }
          } finally {
            window.confirm = confirm;
          }
        })()
      `);
      if ((await readEnhancedNotes(bundle)).text !== "Second external edit.") {
        throw new Error("Save overwrote a newer revision than the one shown for comparison");
      }
      const originalFetch = globalThis.fetch;
      const generationProvider = process.argv.includes("--check-lm-studio-generation") ? "lm-studio"
        : process.argv.includes("--check-ollama-generation") ? "ollama" : undefined;
      if (generationProvider) {
        const generationModel = generationProvider === "lm-studio"
          ? process.env.STILLWATER_LM_STUDIO_MODEL ?? "openai/gpt-oss-20b"
          : process.env.STILLWATER_OLLAMA_MODEL ?? "qwen2.5:7b";
        await window.webContents.executeJavaScript(`
          (async () => {
            document.querySelector("#draft-provider").value = ${JSON.stringify(generationProvider)};
            document.querySelector("#draft-model").value = ${JSON.stringify(generationModel)};
            const button = document.querySelector("#enhance-meeting");
            button.click();
            for (let attempt = 0; attempt < 2500 && button.disabled; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (button.disabled) throw new Error("Live draft generation timed out");
          })()
        `);
        if (!(await listEnhancements(bundle)).some((draft) => draft.model === generationModel)) {
          throw new Error(`${generationProvider} draft was not saved through the desktop UI`);
        }
      }
      try {
        globalThis.fetch = async (_url, options) => {
          const input = JSON.parse(JSON.parse(String(options?.body)).messages[1].content.split("\n")[1]);
          if (!input.notes) return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({actions:[]})}}]});
          if (input.headings && input.transcript) return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({excerpts:[]})}}]});
          await writeFile(join(bundle, "enhanced.md"), "Edit during generation.");
          return Response.json({ choices: [{
            finish_reason: "stop", message: { content: JSON.stringify({
              sections: [{ heading: "Generated during the conflict.", items: [
                ...input.notes.map(({id})=>({manualId:id,text:"",segmentIds:[],children:[]})),
              ] }], actions: [],
            }) },
          }] });
        };
        await window.webContents.executeJavaScript(`
          (async () => {
            document.querySelector("#draft-provider").value = "lm-studio";
            const generate = document.querySelector("#enhance-meeting");
            generate.click();
            for (let attempt = 0; attempt < 100 && generate.disabled; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (document.querySelector("#enhanced-conflict-text").textContent !== "Edit during generation." ||
                document.querySelector("#enhanced-editor").value !== "Unsaved enhanced draft." ||
                !document.querySelector("#enhancement").textContent.includes("Generated during the conflict.")) {
              throw new Error("Generation conflict did not preserve the external edit, draft, and generation history");
            }
          })()
        `);
      } finally {
        globalThis.fetch = originalFetch;
      }
      if ((await readEnhancedNotes(bundle)).text !== "Edit during generation." ||
          !(await listEnhancements(bundle)).some(({ draft }) => draft.outline?.includes("Generated during the conflict."))) {
        throw new Error("Generation conflict changed the saved edit or lost its generation record");
      }
      const generationsBeforeCancel = (await listEnhancements(bundle)).length;
      let requestAborted = false;
      try {
        globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
          const signal = options!.signal!;
          const abort = () => {
            requestAborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
          void window.webContents.executeJavaScript(`
            const cancel = document.querySelector("#cancel-enhancement");
            if (cancel.getClientRects().length) cancel.click();
          `);
        });
        await window.webContents.executeJavaScript(`
          (async () => {
            const generate = document.querySelector("#enhance-meeting");
            const settings = document.querySelector("#draft-history-panel");
            settings.open = true;
            generate.click();
            settings.open = false;
            for (let attempt = 0; attempt < 100 && generate.disabled; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (document.querySelector("[role=status]").textContent !== "Generation canceled." ||
                document.querySelector("#enhanced-editor").value !== "Unsaved enhanced draft.") {
              throw new Error("Cancel did not return the editor to its prior state");
            }
          })()
        `);
      } finally {
        globalThis.fetch = originalFetch;
      }
      if (!requestAborted || (await listEnhancements(bundle)).length !== generationsBeforeCancel) {
        throw new Error("Cancellation did not abort the request or changed generation history");
      }
      window.setSize(1200, 800);
      await window.webContents.executeJavaScript(`
        (async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          document.querySelector("#go-home").click();
          const assertHomeLayout = () => {
            const library = document.querySelector("#vault-search").getBoundingClientRect();
            const agenda = document.querySelector("#agenda").getBoundingClientRect();
            if (library.left < agenda.right || Math.abs(agenda.top - library.top) > 2) {
              throw new Error("Home agenda is displaced from library top by " + (agenda.top - library.top) + "px");
            }
          };
          assertHomeLayout();
          const status = document.querySelector("main > [role=status]");
          if (status.textContent) throw new Error("Home retained the meeting generation status");
          document.querySelector("#recent-meetings").click();
          for (let i = 0; i < 100 && !status.textContent; i++) await new Promise(resolve => setTimeout(resolve, 25));
          if (!status.textContent.startsWith("Found ")) throw new Error("Missing library search feedback");
          assertHomeLayout();
        })()
      `);
      console.log("Native vault UI opened a historical citation, saved edits and contexts, archived, and restored a meeting.");
    } finally {
      await rm(fixtureVault, { recursive: true, force: true });
    }
    app.exit(0);
  } else if (checkCapture) {
    if (!Number.isInteger(sustainedSeconds) || sustainedSeconds < 0 || sustainedSeconds > 3600) {
      throw new Error("Capture check duration must be an integer from 0 to 3600 seconds");
    }
    if (!checkCaptureQuota && !checkCaptureDrain && !checkCaptureBacklog) fixtureVault = await mkdtemp(join(spoolRoot, "vault-"));
    window.setSize(640, 520);
    const page = window.webContents;
    const fixtureAudio = process.env.STILLWATER_CHECK_AUDIO ?? join(root, ".probe/jfk.flac");
    const faultSpeech = checkCaptureWorker || checkCaptureSpeech ? (await readFile(fixtureAudio)).toString("base64") : "";
    if (sustainedSeconds > 0 && !checkCaptureSleep) {
      // The process owns this blocker, so Electron releases it when the check exits.
      powerSaveBlocker.start("prevent-app-suspension");
    }
    try {
      await page.executeJavaScript(`
        (async () => {
          const quota = document.querySelector("#meeting-quota");
          quota.value = "1024";
          quota.dispatchEvent(new Event("input", { bubbles: true }));
          if (!document.querySelector("#audio-quota-duration").textContent.includes("4 hr 39 min")) {
            throw new Error("Storage settings did not show the recording duration");
          }
          document.querySelector("#save-audio-quotas").click();
          const language = document.querySelector('[name="language"]');
          language.value = "auto";
          language.dispatchEvent(new Event("change", { bubbles: true }));
          const selector = '#agenda-events button[aria-label^="File "]';
          for (let attempt = 0; attempt < 100 && !document.querySelector(selector); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          document.querySelector("#agenda-next").click();
          const nextOccurrence = document.querySelector(selector);
          if (!nextOccurrence || !nextOccurrence.getAttribute("aria-label").includes("Calendar recording fixture")) {
            throw new Error("Next week did not show the recurring calendar event");
          }
          document.querySelector("#agenda-previous").click();
          const currentOccurrence = document.querySelector(selector);
          currentOccurrence.click();
          document.querySelector("#event-filing textarea").value = "project: Capture fixture";
          document.querySelector('#event-filing button[value="save"]').click();
          if (currentOccurrence.textContent !== "Filed · 1") throw new Error("Agenda did not show saved event filing");
        })()
      `);
      await window.loadFile(join(root, "desktop/index.html"));
      const result = await page.executeJavaScript(`
        (async () => {
          const status = document.querySelector("#capture-status");
          const waitFor = async (pattern, attempts = 100) => {
            for (let attempt = 0; attempt < attempts; attempt++) {
              if (pattern.test(status.textContent)) return;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error(status.textContent || "Capture did not respond");
          };
          document.querySelector("#keep-recording").checked = true;
          const language = document.querySelector('[name="language"]');
          if (language.value !== "auto") throw new Error("Reload lost the transcription language");
          language.value = "en";
          if (document.querySelector("#meeting-quota").value !== "1024") {
            throw new Error("Reload lost the saved recording quota");
          }
          if (${checkCaptureQuota}) {
            document.querySelector("#meeting-quota").value = "1";
            document.querySelector("#save-audio-quotas").click();
          }
          for (let attempt = 0; attempt < 100 && !document.querySelector("#agenda-events button"); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (document.querySelector('#agenda-events button[aria-label^="File "]').textContent !== "Filed · 1") {
            throw new Error("Reload lost event filing");
          }
          document.querySelector("#agenda-events button").click();
          for (let attempt = 0; attempt < 100 && document.querySelector("#meeting-notes").hidden; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (document.querySelector("form").elements.filing.value !== "project: Capture fixture") {
            throw new Error("Linked note did not inherit event filing");
          }
          let loopbackSpeech;
          if (${checkCaptureWorker || checkCaptureSpeech}) {
            const audio = new AudioContext();
            const bytes = Uint8Array.from(atob(${JSON.stringify(faultSpeech)}), (value) => value.charCodeAt(0));
            const speech = audio.createBufferSource();
            speech.buffer = await audio.decodeAudioData(bytes.buffer);
            speech.loop = !${checkCaptureLoopback};
            const system = audio.createMediaStreamDestination();
            speech.connect(${checkCaptureLoopback} ? audio.destination : system);
            if (${checkCaptureLoopback}) loopbackSpeech = speech;
            else speech.start();
            if (!${checkCaptureLoopback}) {
              navigator.mediaDevices.getDisplayMedia = async () => system.stream;
              navigator.mediaDevices.getUserMedia = async () => audio.createMediaStreamDestination().stream;
            }
            await audio.resume();
          }
          if (${checkCaptureStartup}) {
            navigator.mediaDevices.getDisplayMedia = () => new Promise(() => {});
            const start = document.querySelector("#capture-start");
            start.click();
            await waitFor(/System audio did not open/, 400);
            if (start.disabled || document.querySelector("#recording-state").dataset.state !== "idle") {
              throw new Error("Device timeout did not restore recording controls");
            }
            const audio = new AudioContext();
            const system = audio.createMediaStreamDestination().stream;
            navigator.mediaDevices.getDisplayMedia = async () => system;
            navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
            start.click();
            await waitFor(/microphone did not open/, 400);
            if (start.disabled || system.getAudioTracks()[0].readyState !== "ended") {
              throw new Error("Microphone timeout did not restore controls and release system audio");
            }
            await audio.close();
            return "System audio and microphone timeouts restored recording controls.";
          }
          if (${checkCaptureModel}) {
            const audio = new AudioContext();
            const system = audio.createMediaStreamDestination().stream;
            const microphone = audio.createMediaStreamDestination().stream;
            navigator.mediaDevices.getDisplayMedia = async () => system;
            navigator.mediaDevices.getUserMedia = async () => microphone;
            const start = document.querySelector("#capture-start");
            start.click();
            await waitFor(/Moonshine model file is missing or empty: adapter.ort/);
            if (start.disabled || document.querySelector("#recording-state").dataset.state !== "idle" ||
                [...system.getTracks(), ...microphone.getTracks()].some((track) => track.readyState !== "ended")) {
              throw new Error("Model validation failure left recording controls or inputs active");
            }
            await audio.close();
            return "Incomplete Moonshine model restored recording controls and released both inputs.";
          }
          document.querySelector("#new-note").click();
          const captureGeneration = generation;
          document.querySelector("#new-note").click();
          if (generation !== captureGeneration) throw new Error("New note started a second capture");
          await waitFor(/^(Checking microphone|Recording[.])/, 400);
          const microphone = document.querySelector("#microphone-level");
          const system = document.querySelector("#system-level");
          const waitForFrames = async (after) => {
            for (let attempt = 0; attempt < 100; attempt++) {
              const samples = Number(microphone.dataset.capturedSamples);
              if (samples > after && samples === Number(system.dataset.capturedSamples)) return samples;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error("Two PCM channels did not advance together. " + status.textContent);
          };
          const beforePause = await waitForFrames(0);
          const state = document.querySelector("#recording-state");
          if (state.dataset.state !== "recording") throw new Error("Recording indicator missing");
          const editor = document.querySelector("#meeting-notes");
          document.querySelector("#go-home").click();
          document.querySelector("#agenda-events button").click();
          if (editor.hidden || state.dataset.state !== "recording" ||
              editor.elements.filing.value !== "project: Capture fixture") {
            throw new Error("Agenda navigation disturbed the active capture draft");
          }
          document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "F", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
          }));
          const panel = document.querySelector("#live-panel");
          const search = document.querySelector("#transcript-search");
          const bounds = panel.getBoundingClientRect();
          if (bounds.top < 0 || bounds.bottom > innerHeight || document.activeElement !== search) {
            throw new Error("Transcript panel was clipped or did not focus search");
          }
          const transcript = document.querySelector("#transcript");
          const priorTranscript = transcript.textContent;
          const fixtureText = "microphone: Atlas checkpoint\\n".repeat(100) + "system: Beacon follow-up";
          transcript.textContent = fixtureText;
          const latest = document.querySelector("#transcript-latest");
          panel.scrollTop = 0;
          panel.dispatchEvent(new Event("scroll"));
          if (latest.hidden) throw new Error("Jump to latest was unavailable above the transcript end");
          document.querySelector("#close-transcript").click();
          const transcriptToggle = document.querySelector("#toggle-transcript");
          transcriptToggle.click();
          if (panel.scrollTop !== 0 || latest.hidden) throw new Error("Reopening moved the reader away from earlier text");
          latest.click();
          if (!latest.hidden || panel.scrollTop <= 0) throw new Error("Jump to latest did not return to the transcript end");
          const oldEnd = panel.scrollTop;
          document.querySelector("#close-transcript").click();
          transcript.textContent += "\\n".repeat(30) + "microphone: New update";
          transcriptToggle.click();
          if (panel.scrollTop <= oldEnd || !latest.hidden) throw new Error("Reopening did not catch up with new transcript text");
          transcript.textContent = fixtureText;
          search.value = "Beacon";
          search.dispatchEvent(new Event("input", { bubbles: true }));
          const matches = document.querySelector("#transcript-matches");
          if (!transcript.hidden || matches.hidden || matches.textContent !== "system: Beacon follow-up") {
            throw new Error("Transcript search did not isolate the matching line");
          }
          let copied;
          const clipboard = navigator.clipboard;
          Object.defineProperty(clipboard, "writeText", {
            configurable: true, value: async (value) => { copied = value; },
          });
          try {
            document.querySelector("#copy-transcript").click();
            if (copied !== fixtureText) throw new Error("Copy omitted transcript lines");
          } finally {
            delete clipboard.writeText;
            transcript.textContent = priorTranscript;
            search.value = "";
            search.dispatchEvent(new Event("input", { bubbles: true }));
          }
          document.querySelector("#flag-live-transcript").click();
          search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          if (!panel.hidden || document.activeElement.id !== "toggle-transcript") throw new Error("Escape did not restore focus");
          const pause = document.querySelector("#capture-pause");
          pause.click();
          await waitFor(/paused/);
          if (state.dataset.state !== "paused") throw new Error("Paused indicator missing");
          pause.click();
          await waitFor(/^Recording[.]/);
          if (state.dataset.state !== "recording") throw new Error("Recording indicator did not resume");
          const afterResume = await waitForFrames(beforePause);
          if (${process.argv.includes("--check-moments")}) {
            const writing = editor.elements.notes;
            document.dispatchEvent(new KeyboardEvent("keydown",{ctrlKey:true,shiftKey:true,code:"KeyM",bubbles:true}));
            if (!writing.value.includes("#moment-") || document.activeElement!==writing) throw Error("Moment shortcut lost the cursor or timestamp");
          }
          if (${checkCaptureBacklog}) {
            for (let attempt = 0; attempt < 150 && document.querySelector("#capture-backlog").hidden; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (document.querySelector("#capture-backlog").hidden) throw new Error("Backlog warning did not appear");
            const warning = document.querySelector("#capture-backlog");
            const initial = Number(warning.textContent.match(/[0-9]+/)?.[0]);
            if (!(initial >= 2)) throw new Error("Backlog warning did not report queued seconds");
            for (let attempt = 0; attempt < 100 &&
              !(Number(warning.textContent.match(/[0-9]+/)?.[0]) > initial); attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!(Number(warning.textContent.match(/[0-9]+/)?.[0]) > initial)) {
              throw new Error("Backlog warning did not track the growing queue");
            }
            await waitFor(/processing fell behind.*Recover recording/, 500);
            return "Backlog warning and recovery instructions appeared.";
          }
          if (${checkCaptureWorker}) await waitFor(/will transcribe the audio after you finish/);
          if (${checkCaptureQuota}) {
            for (let attempt = 0; attempt < 500 && document.querySelector("#capture-quota").hidden; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (document.querySelector("#capture-quota").hidden) throw new Error("Missing audio quota warning");
            await waitFor(/temporary audio limit.*Recover recording/, 200);
            return "Recording displayed the quota warning and recovery message.";
          }
          if (${checkCaptureExit}) return "Recording ready for tray exit.";
          if (${checkCaptureDrain}) {
            if (${checkCaptureGap}) {
              await waitFor(/out of sequence.*Recover recording/);
              return "Recording displayed recovery instructions after a skipped frame.";
            }
            captureNode.port.close();
            document.querySelector("#capture-stop").click();
            await waitFor(/final audio frame.*Recover recording/);
            return "Recording displayed recovery instructions after a missing final frame.";
          }
          const target = afterResume + ${Math.max(sustainedSeconds, checkCaptureWorker || checkCaptureSpeech ? 13 : 0)} * 16000;
          let accepted = afterResume;
          let lastSpeechSample = afterResume;
          let transcriptLength = transcript.textContent.length;
          const preview = document.querySelector("#transcript-preview");
          let sawPreview = !preview.hidden && !!preview.textContent;
          const queueSamples = [];
          const peakLevels = [0, 0];
          let firstSystemTextMs;
          let firstSystemPreviewMs;
          let firstSystemSignalMs;
          const playbackStarted = performance.now();
          const playbackEpochMs = Date.now();
          const textObserver = new MutationObserver(() => {
            const elapsed = Math.round(performance.now() - playbackStarted);
            if (!preview.hidden && /^system: .+/m.test(preview.textContent)) firstSystemPreviewMs ??= elapsed;
            if (/^system: .+/m.test(transcript.textContent)) firstSystemTextMs ??= elapsed;
          });
          if (${checkCaptureLoopback}) {
            const options = { childList: true, characterData: true, subtree: true };
            textObserver.observe(preview, options);
            textObserver.observe(transcript, options);
            loopbackSpeech.start();
          }
          let queueReport = "";
          const liveSpeechDeadline = target + 10 * 16000;
          const fixturePhrase = ${checkCaptureLoopback} ? /fellow\\s+Americans?\\b/i : /fellow\\s+Americans\\b/i;
          const hasExpectedSpeech = () => fixturePhrase.test(
            (transcript.textContent.match(/^system:.*$/gm) ?? []).map((line) => line.slice(7).trim()).join(" "));
          const expectPreview = ${process.argv.includes("--check-capture-preview")};
          while (accepted < target || (${checkCaptureSpeech} && accepted < liveSpeechDeadline &&
              (!hasExpectedSpeech() || (expectPreview && !sawPreview)))) {
            accepted = await waitForFrames(accepted);
            if (${checkCaptureLoopback}) {
              const systemLevel = document.querySelector("#system-level").value;
              if (systemLevel >= 0.01) firstSystemSignalMs ??= Math.round(performance.now() - playbackStarted);
              document.querySelectorAll("#microphone-level, #system-level").forEach((meter, index) => {
                if (index < peakLevels.length) peakLevels[index] = Math.max(peakLevels[index], meter.value);
              });
            }
            sawPreview ||= !preview.hidden && !!preview.textContent;
            queueSamples.push(queuedSamples);
            if (${checkCaptureSpeech}) {
              if (transcript.textContent.length > transcriptLength) {
                transcriptLength = transcript.textContent.length;
                lastSpeechSample = accepted;
              }
              if (accepted - lastSpeechSample > 30 * 16000) {
                throw new Error("No new live transcript text during 30 seconds of fixture replay. " + status.textContent);
              }
            }
          }
          textObserver.disconnect();
          if (queueSamples.length) {
            queueSamples.sort((a, b) => a - b);
            const p95 = queueSamples[Math.ceil(queueSamples.length * 0.95) - 1] / 16000;
            const peak = queueSamples.at(-1) / 16000;
            if (p95 >= 2) throw new Error("Pending audio p95 exceeded the two-second target: " + p95);
            queueReport = " Pending audio queue p95: " + p95 + " s. Peak: " + peak + " s.";
          }
          if (${checkCaptureSpeech} && !hasExpectedSpeech() &&
              (!${checkCaptureLoopback} || !/^system: +[^ ]/im.test(transcript.textContent))) {
            let levels = "";
            if (${checkCaptureLoopback}) {
              const text = transcript.textContent;
              const microphoneLines = (text.match(/^microphone:/gm) ?? []).length;
              const systemLines = (text.match(/^system:/gm) ?? []).length;
              levels = " Peak sampled audio levels (microphone, system): " + peakLevels.join(", ") +
                ". Live lines (microphone, system): " + microphoneLines + ", " + systemLines +
                ". Expected phrase on microphone: " + /^microphone:.*fellow Americans/im.test(text) + ".";
            }
            throw new Error("Expected live speech in the transcript before stopping. " + status.textContent + levels);
          }
          if (expectPreview && !sawPreview) {
            throw new Error("Expected provisional transcript text before stopping.");
          }
          if (${checkCaptureLoopback} && !/Audio detected from .*system audio/.test(status.textContent)) {
            throw new Error("System audio was transcribed but capture status did not report the signal");
          }
          const finishFromHome = !${checkCaptureDevice || checkCaptureSleep || checkCaptureEditorFinish};
          if (${checkCombinedNotes}) document.querySelector("#meeting-notes").elements.notes.value = "- Orchid gate — pencil in Thursday (Q7)";
          if (finishFromHome) document.querySelector("#go-home").click();
          if (${checkCaptureDevice}) {
            const track = streams[1].getAudioTracks()[0];
            track.stop();
            track.dispatchEvent(new Event("ended"));
          } else if (!${checkCaptureSleep}) {
            document.querySelector("#capture-stop").click();
          }
          await waitFor(/Recording saved[.]/i, 400);
          if (${checkCaptureEditorFinish}) {
            for (let attempt = 0; attempt < 100 && document.querySelector("#saved-meeting").hidden; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (document.querySelector("#saved-meeting").hidden) throw new Error("Finishing left the editor open instead of the saved meeting");
          }
          if (finishFromHome && !document.querySelector('main > [role="status"]').textContent.startsWith("Recording saved.")) {
            throw new Error("Home did not show the recording confirmation");
          }
          if (${process.argv.includes("--check-capture-preview")} && (!preview.hidden || preview.textContent)) {
            throw new Error("Provisional transcript text remained after saving.");
          }
          if (${checkCaptureDevice} && !status.textContent.startsWith("Microphone disconnected.")) {
            throw new Error("Device interruption was not reported");
          }
          if (${checkCaptureSleep} && !status.textContent.startsWith("Windows resumed from sleep.")) {
            throw new Error("Sleep interruption was not reported");
          }
          const drained = Number(status.dataset.savedSamples);
          if (drained < accepted) throw new Error("Stop lost accepted samples.");
          document.querySelector("#go-home").click();
          let savedNote;
          for (let attempt = 0; attempt < 100 && !savedNote; attempt++) {
            savedNote = document.querySelector("#search-results button");
            if (!savedNote) await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!savedNote) throw new Error("Saved recording did not appear on Home");
          savedNote.click();
          for (let attempt = 0; attempt < 100 && document.querySelector("#saved-meeting").hidden; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (document.querySelector("#saved-meeting").hidden) throw new Error("Saved recording did not reopen");
          if (${process.argv.includes("--check-moments")}) {
            const marker = document.querySelector('#meeting-note-citations a[href^="#moment-"]');
            if (!marker) throw Error("Saved note lost its recording marker");
            marker.click();
            for(let i=0;i<100&&!document.querySelector("#saved-transcript-panel").open;i++)await new Promise(r=>setTimeout(r,25));
            if (!document.querySelector("#saved-transcript-panel").open) throw Error("Recording marker did not open saved speech");
          }
          if (${checkCombinedNotes}) {
            const original = "- Orchid gate — pencil in Thursday (Q7)";
            const editor = document.querySelector("#enhanced-editor");
            if (editor.value !== original) throw new Error("Recording finish modified the written notes before enhancement");
            const enhance = document.querySelector("#enhance-meeting");
            enhance.click();
            for (let attempt = 0; attempt < 100 && enhance.disabled; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const notes = editor.value;
            if (${checkCombinedNotesFailure}) {
              if (notes !== original || !document.querySelector('main > [role="status"]').textContent.includes("Fixture model unavailable.")) {
                throw new Error("Generation failure did not preserve the original notes or report the error");
              }
            } else {
              if (!notes.startsWith("## Release checklist\\n" + (/^[-+*] /.test(original) ? original : "- " + original) + "\\n  - ") ||
                  notes.split(original).length !== 2) throw new Error("The outline did not preserve exact manual wording");
              const reader = document.querySelector("#meeting-note-citations");
              if (!editor.hidden || !reader.querySelector("h2") || !reader.innerText.includes("fellow Americans")) {
                throw new Error("Opening the enhanced note did not render the cited transcript addition");
              }
              const source = reader.querySelector("a");
              if (!source) throw new Error("The saved outline did not expose a transcript citation");
              source.click();
              if (!document.querySelector("#saved-transcript-panel[open] " + source.hash)) {
                throw new Error("The citation did not reveal its transcript segment");
              }
              enhance.click();
              for (let attempt = 0; attempt < 100 && enhance.disabled; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              if (!editor.value.startsWith("## Updated release checklist")) {
                throw new Error("Regeneration left the previous generated outline in the editor");
              }
            }
          }
          document.querySelector("#saved-meeting").hidden = true;
          document.querySelector("#agenda-events button").click();
          for (let attempt = 0; attempt < 100 && document.querySelector("#saved-meeting").hidden; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (document.querySelector("#saved-meeting").hidden) throw new Error("Agenda did not reopen the linked note");
          return { drained, queueReport, firstSystemTextMs, firstSystemPreviewMs, firstSystemSignalMs, playbackEpochMs };
        })()
      `, true);
      if (typeof result === "object" && result !== null) {
        if (result.drained !== savedCaptureSamples) {
          throw new Error(`Saved ${savedCaptureSamples} samples per channel after draining ${result.drained}`);
        }
        console.log(`Dual-source capture drained and saved ${result.drained} aligned samples per channel.${result.queueReport}`);
        if (result.firstSystemTextMs !== undefined) {
          console.log(`First finalized system text observed ${result.firstSystemTextMs} ms after scheduling playback.`);
        }
        if (result.firstSystemPreviewMs !== undefined) {
          console.log(`Playback scheduled at ${result.playbackEpochMs} ms since epoch.`);
          console.log(`First provisional system text observed ${result.firstSystemPreviewMs} ms after scheduling playback.`);
        }
        if (result.firstSystemSignalMs !== undefined) {
          console.log(`First system meter reading at or above 0.01 RMS observed ${result.firstSystemSignalMs} ms after scheduling playback.`);
        }
      } else {
        console.log(result);
      }
      if (checkCaptureQuota || checkCaptureDrain || checkCaptureBacklog) {
        for (let attempt = 0; attempt < 100 && (spool || active); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const minimumTrackBytes = checkCaptureQuota ? 500_000 : 2;
        if (spool || active || await inspectCaptureStorage(spoolRoot) < 2 * minimumTrackBytes) {
          throw new Error("Interrupted capture did not release and preserve audio");
        }
        const [directory] = await readdir(spoolRoot);
        const tracks = await recoverCapture(spoolRoot, join(spoolRoot, directory));
        const audioBytes = await Promise.all(tracks.map(async ({ path }) => (await readFile(path)).readUInt32LE(40)));
        if (audioBytes.length !== 2 || audioBytes[0] !== audioBytes[1] || audioBytes[0] < minimumTrackBytes) {
          throw new Error("Recovered tracks did not contain aligned audio");
        }
      }
      if (checkCaptureExit) {
        const exit = tray?.menu.getMenuItemById("exit");
        if (!exit) throw new Error("Missing capture exit tray action");
        exit.click();
      } else {
        await rm(spoolRoot, { recursive: true, force: true });
        app.exit(0);
      }
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }
}
