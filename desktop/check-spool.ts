import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { captureSpool, inspectCaptureStorage, recoverCapture } from "./capture-spool.ts";

const root = await mkdtemp(join(process.cwd(), ".vault-check-"));
try {
  const spool = await captureSpool(root);
  const frame = new Int16Array(2048).fill(17);
  try {
    for (let sequence = 0; sequence < 9; sequence++) {
      await spool.append(sequence * frame.length, [frame, frame]);
    }
    await assert.rejects(spool.append(0, [frame, frame]), /Invalid capture frame/);
    await assert.rejects(spool.append(10 * frame.length, [frame, frame]), /Invalid capture frame/);
  } finally {
    await spool.release();
  }
  for (const source of ["microphone", "system"]) {
    const wav = await readFile(join(spool.directory, source + ".wav"));
    assert.equal(wav.readUInt32LE(40), 9 * frame.byteLength);
    assert.equal(wav.readInt16LE(44), 17);
  }
  assert.equal(await inspectCaptureStorage(root), 2 * (44 + 9 * frame.byteLength));
  const interruptedTrack = join(spool.directory, "microphone.wav");
  await appendFile(interruptedTrack, Buffer.alloc(frame.byteLength));
  assert.deepEqual((await recoverCapture(root, spool.directory)).map((track) => track.source), ["microphone", "system"]);
  assert.equal((await readFile(interruptedTrack)).length, 44 + 9 * frame.byteLength);
  await assert.rejects(recoverCapture(root, process.cwd()), /Choose a Stillwater capture folder/);
  const alternateRoot = await mkdtemp(join(root, "picker-"));
  const linkedCapture = join(alternateRoot, basename(spool.directory));
  await symlink(spool.directory, linkedCapture, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(recoverCapture(alternateRoot, linkedCapture), /Choose a Stillwater capture folder/);
  } finally {
    await unlink(linkedCapture);
  }
  await assert.rejects(recoverCapture(alternateRoot, linkedCapture), /recording folder is no longer available/);
  const incomplete = await captureSpool(alternateRoot);
  try {
    await incomplete.append(0, [frame, frame]);
  } finally {
    await incomplete.release();
  }
  const survivingTrack = join(incomplete.directory, "microphone.wav");
  const microphoneAudio = await readFile(survivingTrack);
  await unlink(join(incomplete.directory, "system.wav"));
  await assert.rejects(recoverCapture(alternateRoot, incomplete.directory), /system audio track is missing/);
  assert.deepEqual(await readFile(survivingTrack), microphoneAudio);
  assert.equal(await inspectCaptureStorage(root, Date.now() + 25 * 3600 * 1000), 0);
  await assert.rejects(readFile(join(spool.directory, "microphone.wav")), { code: "ENOENT" });
  const kept = await captureSpool(root, undefined, true);
  await kept.append(0, [frame, frame]);
  await kept.release();
  assert.equal(await inspectCaptureStorage(root, Date.now() + 25 * 3600 * 1000), 2 * (44 + frame.byteLength));
  assert.equal((await recoverCapture(root, kept.directory)).length, 2);
  const microphonePath = join(kept.directory, "microphone.wav");
  const systemPath = join(kept.directory, "system.wav");
  const microphoneBefore = await readFile(microphonePath);
  const malformedSystem = await readFile(systemPath);
  malformedSystem.write("junk", 36, "ascii");
  await writeFile(systemPath, malformedSystem);
  await assert.rejects(recoverCapture(root, kept.directory), /Invalid capture header/);
  assert.deepEqual(await readFile(microphonePath), microphoneBefore);
  assert.deepEqual(await readFile(systemPath), malformedSystem);
  const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { captureSpool } from "./desktop/capture-spool.ts";
    const spool = await captureSpool(process.argv[1]);
    const frame = new Int16Array(2048);
    for (let index = 0; index < 9; index++) {
      await spool.append(index * frame.length, [frame, frame]);
    }
    process.stdout.write(spool.directory, () => process.kill(process.pid, "SIGKILL"));
  `, root], { encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.ifError(crash.error);
  assert.ok(crash.signal === "SIGKILL" || (process.platform === "win32" && crash.status === 1), crash.stderr);
  const recovered = await recoverCapture(root, crash.stdout.trim());
  for (const { path } of recovered) {
    assert.equal((await readFile(path)).length, 44 + 8 * frame.byteLength);
  }
  console.log("Interrupted audio checkpoint, byte accounting, and expiry passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
