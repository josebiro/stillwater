import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { downloadMultilingualModel, readModelSetting, requireLocalSpeechModel, writeModelSetting } from "./model-settings.ts";
import { recognitionRuntime, setRecognitionModel, transcribe } from "./import-meeting.ts";

const directory = await mkdtemp(join(process.cwd(), ".vault-check-"));
try {
  assert.equal(await readModelSetting(directory), undefined);
  const model = await realpath(".probe/tiny.en");
  assert.equal(await writeModelSetting(directory, model), model);
  await assert.rejects(writeModelSetting(directory, directory), /missing a usable config.json/);
  assert.equal(await readModelSetting(directory), model);
  assert.equal(await requireLocalSpeechModel(model), model);
  await assert.rejects(requireLocalSpeechModel(join(directory, "missing")), /download one in Settings/);
  await assert.rejects(requireLocalSpeechModel("remote/model"), /Choose a local Whisper model folder/);
  console.log("Local model settings survived an invalid selection and reopened.");
  if (process.argv.includes("--download")) {
    const root = process.cwd();
    const downloaded = await downloadMultilingualModel(join(root, ".probe"), recognitionRuntime(root).python);
    assert.equal(await downloadMultilingualModel(join(root, ".probe"), recognitionRuntime(root).python), downloaded);
    setRecognitionModel(await writeModelSetting(directory, downloaded));
    const segments = await transcribe(root, join(root, ".probe/jfk.flac"), "imported");
    assert.ok(segments.some((segment) => /fellow Americans/i.test(segment.text)));
    console.log("Downloaded multilingual snapshot, reused its cache, and transcribed the speech fixture.");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
