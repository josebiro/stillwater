import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { promisify } from "node:util";
import { createMeeting, openMeeting, saveTranscriptRevision } from "./vault.ts";
import { requireLocalSpeechModel } from "./model-settings.ts";

const execute = promisify(execFile);
let selectedModel: string | undefined;

export function setRecognitionModel(path: string | undefined) {
  selectedModel = path;
}

export function recognitionRuntime(root: string) {
  const bundled = join(root, "python/python.exe");
  const python = process.env.STILLWATER_PYTHON ?? (existsSync(bundled) ? bundled : join(root, ".venv/Scripts/python.exe"));
  const model = selectedModel ?? process.env.STILLWATER_MODEL ?? join(root, ".probe/tiny.en");
  const cudaBins = ["cublas", "cudnn", "cuda_nvrtc"]
    .map((library) => join(root, existsSync(bundled) ? "python/Lib/site-packages/nvidia" : ".venv/Lib/site-packages/nvidia", library, "bin"))
    .filter(existsSync);
  const env = { ...process.env, HF_HUB_OFFLINE: "1" } as NodeJS.ProcessEnv;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = [...cudaBins, env[pathKey] ?? ""].join(delimiter);
  return { python, model, env };
}

export async function transcribe(root: string, audio: string, source: "imported" | "microphone" | "system", language = "en") {
  const { python, model, env } = recognitionRuntime(root);
  const output = await execute(python, [
    join(root, "tools/cuda_probe.py"), audio, await requireLocalSpeechModel(model), "--allow-empty", "--language", language,
  ], { env, windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 })
    .catch((error) => {
      let detail;
      try { detail = JSON.parse(error.stdout).error; } catch { /* No structured result. */ }
      throw new Error(detail ?? (error.killed ? "Transcription exceeded its time or output limit." : "Could not run local transcription. Check Python and model setup."));
    });
  const result = JSON.parse(output.stdout);
  return result.segments.map(
    (segment: { start: number; end: number; text: string }) => ({
      id: randomUUID(), source, startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000), text: segment.text,
      engine: `faster-whisper ${result.versions["faster-whisper"]}`, model: result.model_snapshot,
    }),
  );
}

export async function importMeeting(root: string, vault: string, audio: string, title: string, notes: string, language = "en",
  participants: string[] = [], calendarEvent?: { id: string; start: string }, filing: unknown = "") {
  const bundle = await createMeeting(vault, title, notes, await transcribe(root, audio, "imported", language),
    [], participants, false, calendarEvent, filing);
  return { bundle, ...await openMeeting(vault, bundle) };
}

export async function saveCapturedMeeting(root: string, vault: string,
  tracks: { path: string; source: "microphone" | "system" }[], title: string, notes: string, language = "en",
  keepRecording = false, participants: string[] = [], calendarEvent?: { id: string; start: string }, filing: unknown = "") {
  const segments = [];
  for (const track of tracks) segments.push(...await transcribe(root, track.path, track.source, language));
  segments.sort((left, right) => left.startMs - right.startMs);
  const bundle = await createMeeting(vault, title.trim() || "Untitled meeting", notes, segments,
    keepRecording ? tracks : [], participants, false, calendarEvent, filing);
  return { bundle, ...await openMeeting(vault, bundle) };
}

export async function refineMeeting(root: string, vault: string, bundle: string, language: string) {
  const meeting = await openMeeting(vault, bundle);
  if (meeting.metadata.recordings?.length !== 2) throw new Error("This meeting has no retained recording.");
  const folder = join(bundle, "audio");
  if (!(await lstat(folder).catch(() => null))?.isDirectory()) throw new Error("The retained audio folder is missing.");
  const tracks = ["microphone", "system"].map((source) => ({ source, path: join(folder, source + ".wav") }));
  for (const { path } of tracks) {
    if (!(await lstat(path).catch(() => null))?.isFile()) throw new Error("A retained audio track is missing.");
  }
  const segments = [];
  for (const { source, path } of tracks) segments.push(...await transcribe(root, path, source as "microphone" | "system", language));
  segments.sort((a, b) => a.startMs - b.startMs);
  return await saveTranscriptRevision(vault, bundle, meeting.metadata.transcriptRevision, segments);
}
