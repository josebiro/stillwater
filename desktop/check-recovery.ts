import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { captureKeepsRecording, captureSpool, recoverCapture } from "./capture-spool.ts";
import { refineMeeting, saveCapturedMeeting } from "./import-meeting.ts";
import { openMeeting } from "./vault.ts";

export async function checkRecovery(root: string) {
  const fixture = join(root, ".probe/jfk.flac");
  const python = process.env.STILLWATER_PYTHON ?? join(root, ".venv/Scripts/python.exe");
  const pcm = execFileSync(python, [
    "-c",
    "import sys; from faster_whisper.audio import decode_audio; sys.stdout.buffer.write((decode_audio(sys.argv[1]).clip(-1, 1) * 32767).astype('<i2').tobytes())",
    fixture,
  ], { windowsHide: true, timeout: 15000 });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  const directory = await mkdtemp(join(root, ".vault-check-"));
  try {
    const spool = await captureSpool(directory, undefined, true);
    try {
      for (let offset = 0; offset < samples.length; offset += 2048) {
        const system = samples.subarray(offset, offset + 2048);
        await spool.append(offset, [new Int16Array(system.length), system]);
      }
    } finally {
      await spool.release();
    }
    const tracks = await recoverCapture(directory, spool.directory);
    const originalAudio = await Promise.all(tracks.map(({ path }) => readFile(path)));
    await assert.rejects(saveCapturedMeeting(root, join(directory, "missing-vault"), tracks,
      "Recovered fixture", "Recovery notes", "en", true), { code: "ENOENT" });
    assert.deepEqual(await Promise.all(tracks.map(({ path }) => readFile(path))), originalAudio);
    const meeting = await saveCapturedMeeting(root, directory, tracks, "Recovered fixture", "Recovery notes", "en",
      await captureKeepsRecording(spool.directory), ["Morgan"], { id: "recovery-fixture", start: "2026-11-12T16:00:00.000Z" },
      "project: Recovery");
    assert.deepEqual(meeting.metadata.participants, ["Morgan"]);
    assert.equal(meeting.metadata.calendarEvent.id, "recovery-fixture");
    assert.equal(meeting.metadata.contexts[0].name, "Recovery");
    assert.match(meeting.notes, /Recovery notes/);
    assert.ok(meeting.segments.some((segment) =>
      segment.source === "system" && /fellow Americans/i.test(segment.text)));
    console.log("Recovered and reopened the system speech fixture in a saved meeting.");
    const { bundle } = meeting;
    for (const { source } of tracks) {
      assert.equal((await stat(join(bundle, "audio", source + ".wav"))).size, 44 + pcm.byteLength);
    }
    const refined = await refineMeeting(root, directory, bundle, "en");
    assert.equal(refined.revision, 2);
    assert.ok(refined.segments.some((segment) => segment.source === "system" && /fellow Americans/i.test(segment.text)));
    const original = await openMeeting(directory, bundle, 1);
    assert.deepEqual(original.segments.map((segment) => segment.id), meeting.segments.map((segment) => segment.id));
    assert.ok(refined.segments.every((segment) => !original.segments.some((prior) => prior.id === segment.id)));
    console.log("Native CUDA refinement saved a new revision and preserved the original segment IDs.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
