const startCapture = document.querySelector("#capture-start");
const pauseCapture = document.querySelector("#capture-pause");
const stopCapture = document.querySelector("#capture-stop");
const captureStatus = document.querySelector("#capture-status");
const captureQuota = document.querySelector("#capture-quota");
const captureBacklog = document.querySelector("#capture-backlog");
let captureInterruption = "";
let captureRelease = Promise.resolve();
const keepCaptureAudio = document.querySelector("#keep-recording");
const quotaKey = "stillwater-audio-quotas";
const meetingQuota = document.querySelector("#meeting-quota");
const totalQuota = document.querySelector("#total-quota");
let audioQuotas = [2048, 10240];
try {
  const savedQuotas = JSON.parse(localStorage.getItem(quotaKey) ?? "null");
  if (Array.isArray(savedQuotas) && savedQuotas.length === 2) audioQuotas = savedQuotas;
} catch (error) {
  console.error("Could not read audio limits", error);
}
[meetingQuota.value, totalQuota.value] = audioQuotas;
const quotaDuration = document.querySelector("#audio-quota-duration");
function showQuotaDuration() {
  const minutes = Math.floor((meetingQuota.valueAsNumber * 1024 ** 2 - 88) / (64000 * 60));
  if (!meetingQuota.validity.valid || !Number.isFinite(minutes)) {
    quotaDuration.textContent = "";
    return;
  }
  const hours = Math.floor(minutes / 60);
  const duration = hours ? `${hours} hr ${minutes % 60} min` : `${minutes} min`;
  quotaDuration.textContent = minutes ? `About ${duration} of microphone and system audio per recording.`
    : "Less than one minute of microphone and system audio per recording.";
}
meetingQuota.addEventListener("input", showQuotaDuration);
showQuotaDuration();
document.querySelector("#save-audio-quotas").addEventListener("click", () => {
  const status = document.querySelector("#audio-quota-status");
  if (!meetingQuota.reportValidity() || !totalQuota.reportValidity() ||
      !meetingQuota.value || !totalQuota.value || meetingQuota.valueAsNumber > totalQuota.valueAsNumber) {
    status.textContent = "Enter limits with the total at least as large as the per-recording limit.";
    return;
  }
  audioQuotas = [meetingQuota.valueAsNumber, totalQuota.valueAsNumber];
  localStorage.setItem(quotaKey, JSON.stringify(audioQuotas));
  status.textContent = "Audio limits saved for new recordings.";
});
const recordingState = document.querySelector("#recording-state");
const recordingElapsed = document.querySelector("#recording-elapsed");
function setRecordingState(state, label) {
  recordingState.dataset.state = state;
  recordingState.querySelector("span").textContent = label;
  recordingElapsed.hidden = state === "idle" || state === "starting";
}
function showElapsed(samples) {
  const seconds = Math.floor(samples / 16000);
  recordingElapsed.textContent = [Math.floor(seconds / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0")).join(":");
}
const microphone = document.querySelector("#microphone");
const meters = ["microphone", "system"].map((name) => document.querySelector(`#${name}-level`));
let context;
let captureNode;
let stopDeadline;
let spoolOpen = false;
let pending = Promise.resolve();
let backlog = 0;
let queuedSamples = 0;
function showCaptureBacklog() {
  captureBacklog.hidden = queuedSamples < 32000;
  if (!captureBacklog.hidden) {
    const message = `About ${Math.round(queuedSamples / 16000)} seconds of audio waiting to be processed.`;
    if (captureBacklog.textContent !== message) captureBacklog.textContent = message;
  }
}
const liveTranscript = document.querySelector("#transcript");
const liveReview = document.querySelector("#flag-live-transcript");
const liveReviewLabel = liveReview.querySelector("span");
liveReview.addEventListener("click", () => {
  liveReview.disabled = true;
  liveReview.title = liveReviewLabel.textContent = "Flagged for review";
});
const transcriptPanel = document.querySelector("#live-panel");
const transcriptToggle = document.querySelector("#toggle-transcript");
const transcriptSearch = document.querySelector("#transcript-search");
const transcriptMatches = document.querySelector("#transcript-matches");
const transcriptLatest = document.querySelector("#transcript-latest");
let followOnOpen = true;
function nearTranscriptEnd() {
  return liveTranscript.getBoundingClientRect().bottom <= transcriptPanel.getBoundingClientRect().bottom + 8;
}
function updateTranscriptLatest() {
  transcriptLatest.hidden = transcriptPanel.hidden || Boolean(transcriptSearch.value.trim()) || nearTranscriptEnd();
}
transcriptPanel.addEventListener("scroll", updateTranscriptLatest);
transcriptLatest.addEventListener("click", () => {
  transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
  transcriptPanel.focus({ preventScroll: true });
  updateTranscriptLatest();
});
function isFollowingTranscript() {
  return !transcriptPanel.hidden && !transcriptSearch.value.trim() &&
    transcriptPanel.scrollHeight - transcriptPanel.scrollTop - transcriptPanel.clientHeight < 24;
}
function showTranscript(expanded) {
  if (!expanded && !transcriptPanel.hidden && !transcriptSearch.value.trim()) {
    followOnOpen = nearTranscriptEnd();
  }
  transcriptPanel.hidden = !expanded;
  transcriptToggle.setAttribute("aria-expanded", String(expanded));
  transcriptToggle.textContent = expanded ? "Hide transcript" : "Show transcript";
  if (expanded) {
    transcriptSearch.focus({ preventScroll: true });
    if (followOnOpen && !transcriptSearch.value.trim()) {
      transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
    }
  }
  updateTranscriptLatest();
}
transcriptToggle.addEventListener("click", () => showTranscript(transcriptPanel.hidden));
document.querySelector("#close-transcript").addEventListener("click", () => {
  showTranscript(false);
  transcriptToggle.focus();
});
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
  if (event.key === "Escape" && !transcriptPanel.hidden) {
    event.preventDefault();
    showTranscript(false);
    transcriptToggle.focus();
  }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f" && !transcriptToggle.closest("[hidden]")) {
    event.preventDefault();
    showTranscript(true);
  }
});
function updateTranscriptMatches() {
  const query = transcriptSearch.value.trim().toLocaleLowerCase();
  liveTranscript.hidden = Boolean(query);
  transcriptMatches.hidden = !query;
  if (query) {
    const lines = liveTranscript.textContent.split("\n").filter((line) => line.toLocaleLowerCase().includes(query));
    transcriptMatches.textContent = lines.join("\n") || "No matches.";
  }
  updateTranscriptLatest();
}
transcriptSearch.addEventListener("input", updateTranscriptMatches);
new MutationObserver(updateTranscriptMatches).observe(liveTranscript, { childList: true, characterData: true, subtree: true });
document.querySelector("#copy-transcript").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(liveTranscript.textContent);
    document.querySelector("main > [role=status]").textContent = "Transcript copied.";
  } catch (error) {
    document.querySelector("main > [role=status]").textContent = error.message;
  }
});
window.stillwater.onCaptureSegment((segment) => {
  const follow = isFollowingTranscript();
  liveTranscript.textContent += `${segment.source}: ${segment.text}\n`;
  if (follow) transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
});
const previewLines = new Map();
const preview = document.querySelector("#transcript-preview");
window.stillwater.onCapturePreview((source, text) => {
  const follow = isFollowingTranscript();
  if (text) previewLines.set(source, text);
  else previewLines.delete(source);
  preview.textContent = Array.from(previewLines, ([input, line]) => `${input}: ${line}`).join("\n");
  preview.hidden = !previewLines.size;
  if (follow) transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
});
function clearPreview() {
  previewLines.clear();
  preview.textContent = "";
  preview.hidden = true;
}
let streams = [];
let generation = 0;

async function refreshMicrophones() {
  const selected = microphone.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  microphone.replaceChildren(new Option("Default", ""));
  for (const device of devices.filter((item) => item.kind === "audioinput" && item.deviceId && item.deviceId !== "default")) {
    microphone.add(new Option(device.label || "Microphone", device.deviceId));
  }
  if ([...microphone.options].some((option) => option.value === selected)) microphone.value = selected;
}

function finishCapture(message) {
  clearPreview();
  captureBacklog.hidden = true;
  keepCaptureAudio.disabled = false;
  captureQuota.hidden = true;
  setRecordingState("idle", "Ready to record");
  liveReview.disabled = true;
  clearTimeout(stopDeadline);
  captureNode?.port.close();
  captureNode = undefined;
  generation++;
  if (spoolOpen) {
    spoolOpen = false;
    captureRelease = pending.then(() => window.stillwater.endCapture(false)).catch((error) => {
      console.error("Could not release interrupted audio", error);
    });
  }
  for (const stream of streams) for (const track of stream.getTracks()) track.stop();
  streams = [];
  if (context && context.state !== "closed") void context.close();
  context = undefined;
  for (const meter of meters) {
    meter.value = 0;
    delete meter.dataset.capturedSamples;
  }
  startCapture.disabled = microphone.disabled = false;
  pauseCapture.disabled = stopCapture.disabled = true;
  pauseCapture.textContent = "Pause recording";
  captureStatus.textContent = message;
  if (document.querySelector("#meeting-notes").hidden) {
    document.querySelector('main > [role="status"]').textContent = message;
  }
}

startCapture.addEventListener("click", async () => {
  captureInterruption = "";
  showElapsed(0);
  setRecordingState("starting", "Opening audio devices");
  liveReview.title = liveReviewLabel.textContent = "Flag for review";
  const attempt = ++generation;
  startCapture.disabled = microphone.disabled = true;
  keepCaptureAudio.disabled = true;
  liveTranscript.textContent = "";
  clearPreview();
  captureStatus.textContent = "Opening system audio…";
  let deviceDeadline = setTimeout(() => {
    if (attempt === generation) finishCapture("System audio did not open. Try starting the recording again.");
  }, 15000);
  try {
    await captureRelease;
    if (attempt !== generation) return;
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    clearTimeout(deviceDeadline);
    if (attempt !== generation) {
      for (const track of display.getTracks()) track.stop();
      return;
    }
    streams.push(display);
    for (const track of display.getVideoTracks()) track.stop();
    if (!display.getAudioTracks().length) throw new Error("Windows did not provide a system audio track.");
    captureStatus.textContent = "Opening microphone…";
    deviceDeadline = setTimeout(() => {
      if (attempt === generation) finishCapture("The microphone did not open. Check microphone access and try again.");
    }, 15000);
    const input = await navigator.mediaDevices.getUserMedia({
      audio: microphone.value ? { deviceId: { exact: microphone.value } } : true,
    });
    clearTimeout(deviceDeadline);
    if (attempt !== generation) {
      for (const track of input.getTracks()) track.stop();
      return;
    }
    streams.push(input);
    captureStatus.textContent = "Starting local transcription…";
    await window.stillwater.beginCapture(document.querySelector('[name="language"]').value,
      ...audioQuotas, keepCaptureAudio.checked);
    if (attempt !== generation) {
      await window.stillwater.endCapture(false);
      return;
    }
    spoolOpen = true;
    pending = Promise.resolve();
    backlog = 0;
    queuedSamples = 0;
    context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule("pcm-capture.js");
    if (attempt !== generation) return;
    const capture = new AudioWorkletNode(context, "pcm-capture", {
      numberOfInputs: 2, channelCount: 1, channelCountMode: "explicit",
    });
    captureNode = capture;
    let nextOffset;
    let firstFrameOffset;
    let paused = false;
    let signalSeen = [false, false];
    let liveFailed = false;
    capture.port.onmessage = async ({ data }) => {
      if (attempt !== generation) return;
      if (data.clockGap) {
        const { gap, repairedSamples } = data.clockGap;
        await pending;
        if (attempt === generation) {
          finishCapture(`Audio capture clock skipped a frame (${gap} samples, ${repairedSamples} previously filled). Open Home and choose Recover recording.`);
        }
        return;
      }
      if (typeof data.paused === "boolean") {
        paused = data.paused;
        if (paused) for (const meter of meters) meter.value = 0;
        pauseCapture.textContent = paused ? "Resume recording" : "Pause recording";
        setRecordingState(paused ? "paused" : "recording", paused ? "Recording paused" : "Recording");
        captureStatus.textContent = paused ? "Recording paused." : "Recording. Listening for audio…";
        pauseCapture.disabled = false;
        return;
      }
      if (data.stopped) {
        clearTimeout(stopDeadline);
        await pending;
        if (attempt !== generation) return;
        try {
          for (const stream of streams) for (const track of stream.getTracks()) track.stop();
          captureStatus.textContent = "Finishing transcription…";
          const fields = new FormData(form);
          const { calendarId, calendarStart } = form.dataset;
          const result = await window.stillwater.endCapture(true, fields.get("title"), fields.get("notes"),
            keepCaptureAudio.checked, fields.get("participants"),
            liveReview.textContent === "Flagged for review",
            calendarId, calendarStart, fields.get("filing"), draftModel.value, draftProvider.value);
          spoolOpen = false;
          if (attempt !== generation) return;
          if (result) {
            clearSavedDraft(fields, calendarId, calendarStart);
            document.querySelector("#transcript").textContent = result.segments
              .map((segment) => `${segment.source}: ${segment.text}`).join("\n");
          }
          if (result) captureStatus.dataset.savedSamples = String(nextOffset ?? 0);
          const outcome = result
            ? "Recording saved."
            : "Recording kept temporarily. Use Recover recording to save it.";
          const message = captureInterruption ? `${captureInterruption} ${outcome}` : outcome;
          finishCapture(message);
          if (result && workspaceView === "editor") {
            await openSavedMeeting(result.meetingLink);
            status.textContent = message;
          }
          if (result) void findMeetings("", false, false);
        } catch (error) {
          if (attempt === generation) finishCapture(error.message);
        }
        return;
      }
      const { frames } = data;
      firstFrameOffset ??= data.offsetSamples;
      const offsetSamples = data.offsetSamples - firstFrameOffset;
      if (nextOffset !== undefined && offsetSamples !== nextOffset) {
        finishCapture(`Audio capture clock skipped a frame. Expected sample ${nextOffset}, received ${offsetSamples}.`);
        return;
      }
      nextOffset = offsetSamples + frames[0].length;
      showElapsed(nextOffset);
      if (backlog >= 128) {
        finishCapture("Audio processing fell behind. Open Home and choose Recover recording to save the captured audio.");
        return;
      }
      backlog++;
      queuedSamples += frames[0].length;
      showCaptureBacklog();
      pending = pending.then(async () => {
        if (attempt !== generation) return;
        const { nearQuota, liveInterrupted } = await window.stillwater.appendCapture(offsetSamples, frames);
        if (attempt !== generation) return;
        if (nearQuota) captureQuota.hidden = false;
        if (liveInterrupted && !pauseCapture.disabled && !paused) {
          liveFailed = true;
          captureStatus.textContent = "Recording continues. Stillwater will transcribe the audio after you finish.";
        }
      }).catch((error) => {
        if (attempt !== generation) return;
        const message = error.message.includes("Capture storage limit reached")
          ? "Recording stopped at the temporary audio limit. Open Home and choose Recover recording to save the captured audio."
          : error.message.includes("Invalid capture frame")
            ? "Recording stopped after an audio frame arrived out of sequence. Open Home and choose Recover recording to save the captured audio."
            : error.message;
        finishCapture(message);
      }).finally(() => {
        if (attempt === generation) {
          backlog--;
          queuedSamples -= frames[0].length;
          showCaptureBacklog();
        }
      });
      for (const [index, samples] of frames.entries()) {
        const squares = samples.reduce((sum, sample) => sum + (sample / 32768) ** 2, 0);
        const level = Math.sqrt(squares / samples.length);
        if (!paused) meters[index].value = level;
        if (level >= 0.005) signalSeen[index] = true;
        meters[index].dataset.capturedSamples = String(nextOffset);
      }
      if (!paused && !liveFailed && !stopCapture.disabled) {
        const sources = ["microphone", "system audio"].filter((_, index) => signalSeen[index]);
        const message = sources.length
          ? `Recording. Audio detected from ${sources.join(" and ")}.`
          : "Recording. No audible input detected yet.";
        if ((sources.length || nextOffset >= 48000) && captureStatus.textContent !== message) {
          captureStatus.textContent = message;
        }
      }
    };
    [input, display].forEach((stream, index) => {
      const track = stream.getAudioTracks()[0];
      track.addEventListener("ended", () => {
        if (attempt !== generation || stopCapture.disabled) return;
        captureInterruption = index === 0 ? "Microphone disconnected." : "System audio disconnected.";
        stopCapture.click();
      });
      context.createMediaStreamSource(new MediaStream([track])).connect(capture, 0, index);
    });
    capture.connect(context.destination);
    await context.resume();
    if (attempt !== generation) return;
    pauseCapture.disabled = stopCapture.disabled = false;
    setRecordingState("recording", "Recording");
    liveReview.disabled = false;
    captureStatus.textContent = "Checking microphone and system audio.";
    for (const stream of [input, display]) {
      const track = stream.getAudioTracks()[0];
      if (track.readyState === "ended") track.dispatchEvent(new Event("ended"));
    }
    void refreshMicrophones().catch(() => {});
  } catch (error) {
    if (attempt === generation) finishCapture(error.message);
  } finally {
    clearTimeout(deviceDeadline);
  }
});

pauseCapture.addEventListener("click", () => {
  if (!captureNode) return;
  pauseCapture.disabled = true;
  captureNode.port.postMessage(document.querySelector("#recording-state").dataset.state === "paused" ? "resume" : "pause");
});

stopCapture.addEventListener("click", async () => {
  setRecordingState("saving", "Finishing recording");
  const attempt = generation;
  stopCapture.disabled = pauseCapture.disabled = true;
  stopDeadline = setTimeout(() => {
    const interruption = captureInterruption ? `${captureInterruption} ` : "";
    finishCapture(interruption + "Recording stopped before the final audio frame arrived. Open Home and choose Recover recording.");
  }, 2000);
  captureNode.port.postMessage("stop");
  try {
    if (context.state === "suspended") await context.resume();
  } catch (error) {
    if (attempt === generation) finishCapture(error.message);
  }
});
window.stillwater.onCaptureResumeFromSleep(() => {
  if (stopCapture.disabled) return;
  captureInterruption = "Windows resumed from sleep.";
  stopCapture.click();
});
window.addEventListener("pagehide", () => finishCapture(""));
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", () => void refreshMicrophones().catch(() => {}));
  void refreshMicrophones().catch(() => {});
}
