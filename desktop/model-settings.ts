import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const tinyRevision = "d90ca5fe260221311c53c58e660288d3deb8d356";

export async function downloadMultilingualModel(directory: string, python: string) {
  const models = join(directory, "models");
  await mkdir(models, { recursive: true });
  const target = join(models, `whisper-tiny-${tinyRevision}`);
  if (await stat(target).then(() => true, (error) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  })) return await validateModelSnapshot(target);
  const temporary = join(models, `.download-${randomUUID()}`);
  try {
    await promisify(execFile)(python, [
      "-c", "import sys; from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-tiny', revision=sys.argv[1], local_dir=sys.argv[2], allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.txt'], token=False)",
      tinyRevision, temporary,
    ], { windowsHide: true, timeout: 10 * 60 * 1000 });
    await validateModelSnapshot(temporary);
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function validateModelSnapshot(path: string) {
  const resolved = await realpath(path);
  for (const name of ["config.json", "model.bin", "tokenizer.json"]) {
    const file = await stat(join(resolved, name)).catch(() => null);
    if (!file?.isFile() || file.size === 0) throw new Error(`Model folder is missing a usable ${name}.`);
  }
  return resolved;
}

export async function requireLocalSpeechModel(path: string) {
  if (!isAbsolute(path)) throw new Error("Choose a local Whisper model folder in Settings.");
  try {
    return await validateModelSnapshot(path);
  } catch (error) {
    throw new Error("Local Whisper model is unavailable. Choose a model folder or download one in Settings.", { cause: error });
  }
}

export async function readModelSetting(directory: string) {
  try {
    const setting = JSON.parse(await readFile(join(directory, "speech-model.json"), "utf8"));
    if (setting.version !== 1 || typeof setting.model !== "string" || !isAbsolute(setting.model)) {
      throw new Error("Invalid speech model settings");
    }
    return setting.model as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeModelSetting(directory: string, path: string) {
  const model = await validateModelSnapshot(path);
  const temporary = join(directory, `speech-model-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, model }) + "\n", { flag: "wx", flush: true });
    await rename(temporary, join(directory, "speech-model.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return model;
}
