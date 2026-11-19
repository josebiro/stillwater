import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { recognitionRuntime, refineMeeting } from "./import-meeting.ts";
import { captureSpool } from "./capture-spool.ts";
import { startRecognition } from "./live-recognition.ts";
import type { Segment } from "./vault.ts";
import { createMeeting, openMeeting } from "./vault.ts";

const root = process.cwd();
const meetingFixturePath = process.env.STILLWATER_CHECK_MEETING_AUDIO;
const meetingFixture = process.argv.includes("--meeting-fixture") || !!meetingFixturePath;
const dualSpeech = process.argv.includes("--dual-speech");
const distinctSpeech = process.argv.includes("--distinct-speech");
const autoLanguage = process.argv.includes("--auto-language");
const spanishFixture = process.argv.includes("--spanish-fixture");
const { python, env } = recognitionRuntime(root);
const pcm = execFileSync(python, [
  "-c",
  "import sys; from faster_whisper.audio import decode_audio; sys.stdout.buffer.write((decode_audio(sys.argv[1]).clip(-1, 1) * 32767).astype('<i2').tobytes())",
  meetingFixturePath ?? join(root, spanishFixture ? ".probe/whisper/inst/audio/allende.mp3" :
    meetingFixture ? ".probe/ami-es2004a-180s.wav" : ".probe/jfk.flac"),
], { env, timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
const microphonePcm = distinctSpeech
  ? execFileSync(python, [
    "-c",
    "import sys; from faster_whisper.audio import decode_audio; sys.stdout.buffer.write((decode_audio(sys.argv[1])[16*16000:28*16000].clip(-1, 1) * 32767).astype('<i2').tobytes())",
    join(root, ".probe/ami-es2004a-180s.wav"),
  ], { env, timeout: 15000 })
  : undefined;
const published: Segment[] = [];
const realtime = process.argv.includes("--realtime");
const delays: number[] = [];
const previews: string[] = [];
let started = 0;
let draining = false;
const recognizer = await startRecognition(root, (segment) => {
  published.push(segment);
  if (realtime && !draining) delays.push(performance.now() - started - segment.endMs);
}, autoLanguage ? "auto" : spanishFixture ? "es" : "en", (source, text) => {
  if (source === "system") previews.push(text);
});
try {
  started = performance.now();
  for (let offset = 0; offset < pcm.length; offset += 4096) {
    const bytes = pcm.subarray(offset, offset + 4096);
    const frame = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    if (realtime) {
      const due = started + (offset + bytes.length) / 32;
      const wait = due - performance.now();
      if (wait > 0) await setTimeout(wait);
    }
    const microphoneFrame = new Int16Array(frame.length);
    if (microphonePcm) Buffer.from(microphoneFrame.buffer).set(microphonePcm.subarray(offset, offset + bytes.length));
    await recognizer.append([dualSpeech ? frame : microphoneFrame, frame]);
  }
  const liveIds = published.map((segment) => segment.id);
  assert.ok(liveIds.length, "Expected speech before drain");
  draining = true;
  const segments = await recognizer.finish();
  if (process.argv.includes("--check-preview")) {
    assert.ok(previews.some(Boolean), "Expected provisional system speech");
    assert.equal(previews.at(-1), "", "Expected preview to clear after drain");
  }
  const moonshineModel = process.env.STILLWATER_MOONSHINE_MODEL;
  if (autoLanguage || spanishFixture) {
    assert.ok(segments.length && segments.every((segment) => segment.engine === "faster-whisper"));
  } else if (moonshineModel) {
    assert.ok(segments.every((segment) =>
      segment.engine === "moonshine" && segment.model === basename(moonshineModel)));
  }
  if (!meetingFixture && !spanishFixture) assert.ok(segments.length > liveIds.length, "Expected additional speech during drain");
  const finalIds = new Set(segments.map((segment) => segment.id));
  assert.equal(finalIds.size, segments.length);
  assert.ok(liveIds.every((id) => finalIds.has(id)));
  assert.ok(segments.every((segment) => segment.endMs > segment.startMs));
  const transcript = segments.filter((segment) => segment.source === "system").map((segment) => segment.text).join(" ");
  const microphone = segments.filter((segment) => segment.source === "microphone");
  if (dualSpeech) {
    assert.match(microphone.map((segment) => segment.text).join(" "), /fellow Americans/i);
    assert.ok(microphone.some((segment) => liveIds.includes(segment.id)), "Expected live microphone speech");
  } else if (distinctSpeech) {
    assert.ok(microphone.some((segment) => liveIds.includes(segment.id)), "Expected live microphone speech");
    assert.match(microphone.map((segment) => segment.text).join(" "), /standing up there/i);
    assert.doesNotMatch(microphone.map((segment) => segment.text).join(" "), /fellow Americans/i);
    assert.doesNotMatch(transcript, /standing up there/i);
  } else {
    assert.equal(microphone.length, 0);
  }
  if (spanishFixture) {
    assert.match(transcript, /para construir una sociedad mejor/i);
  } else if (meetingFixture) {
    assert.ok(liveIds.length >= 20, "Expected at least 20 live segments from the meeting excerpt");
  } else {
    assert.match(transcript, /fellow Americans/i);
    assert.match(transcript, /what you can do for your country/i);
    assert.equal([...transcript.matchAll(/fellow Americans/gi)].length, 1);
  }
  console.log("Live recognition worker preserved segment IDs and drained the final audio.");
  const transcriptPath = process.env.STILLWATER_CHECK_TRANSCRIPT_OUTPUT;
  const refinedPath = process.env.STILLWATER_CHECK_REFINED_OUTPUT;
  if (refinedPath) {
    const vault = await mkdtemp(join(root, ".refinement-check-"));
    try {
      const spool = await captureSpool(vault, undefined, true);
      for (let offset = 0; offset < pcm.length; offset += 4096) {
        const bytes = pcm.subarray(offset, offset + 4096);
        const system = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        const microphone = new Int16Array(system.length);
        if (microphonePcm) Buffer.from(microphone.buffer).set(microphonePcm.subarray(offset, offset + bytes.length));
        await spool.append(offset / 2, [dualSpeech ? system : microphone, system]);
      }
      const tracks = await spool.finish();
      const bundle = await createMeeting(vault, "Refinement fixture", "", segments, tracks);
      const original = await openMeeting(vault, bundle, 1);
      const refined = await refineMeeting(root, vault, bundle, autoLanguage ? "auto" : spanishFixture ? "es" : "en");
      assert.equal(refined.revision, 2);
      assert.deepEqual((await openMeeting(vault, bundle, 1)).segments, original.segments);
      const refinedText = (await openMeeting(vault, bundle, 2)).segments.filter((segment) => segment.source === "system")
        .map((segment) => segment.text).join(" ");
      assert.ok(refinedText, "Expected refined system transcript");
      if (transcriptPath) {
        const originalText = original.segments.filter((segment) => segment.source === "system")
          .map((segment) => segment.text).join(" ");
        await writeFile(transcriptPath, originalText + "\n", { flag: "wx" });
      }
      await writeFile(refinedPath, refinedText + "\n", { flag: "wx" });
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  } else if (transcriptPath) {
    await writeFile(transcriptPath, transcript + "\n", { flag: "wx" });
  }
  if (realtime) {
    delays.sort((a, b) => a - b);
    console.log(JSON.stringify({ liveSegments: delays.length, p95DelayMs: Math.round(delays[Math.ceil(delays.length * 0.95) - 1]) }));
  }
} finally {
  await recognizer.cancel();
}
