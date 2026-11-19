import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { recognitionRuntime } from "./import-meeting.ts";
import { requireLocalSpeechModel } from "./model-settings.ts";
import type { Segment } from "./vault.ts";

export function moonshineModelPath(root: string) {
  const bundledMoonshine = join(root, "moonshine-model", "quantized_26_11_02");
  const legacyMoonshine = join(root, "moonshine-model");
  return process.env.STILLWATER_MOONSHINE_MODEL?.trim() ||
    [bundledMoonshine, legacyMoonshine].find((path) => existsSync(join(path, "encoder.ort")));
}

export async function requireMoonshineModel(path: string) {
  if (!isAbsolute(path)) throw new Error("Set STILLWATER_MOONSHINE_MODEL to an absolute model folder.");
  const files = ["adapter.ort", "cross_kv.ort", "decoder_kv.ort", "encoder.ort",
    "frontend.model.ort", "frontend.weights.ort", "streaming_config.json", "tokenizer.bin"];
  for (const name of files) {
    const info = await stat(join(path, name)).catch(() => null);
    if (!info?.isFile() || !info.size) throw new Error(`Moonshine model file is missing or empty: ${name}`);
  }
  return path;
}

export async function startRecognition(root: string, publish: (segment: Segment) => void, language = "en",
  preview?: (source: string, text: string) => void) {
  const { python, model, env } = recognitionRuntime(root);
  const moonshine = language === "en" ? moonshineModelPath(root) : undefined;
  const modelPath = moonshine ? await requireMoonshineModel(moonshine) : await requireLocalSpeechModel(model);
  const child = spawn(python, [join(root, "worker/live_worker.py"), modelPath, language, moonshine ? "moonshine" : "whisper"], {
    env, windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const segments: Segment[] = [];
  let failure: Error | undefined;
  let listener: ((error?: Error, response?: Record<string, unknown>) => void) | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    listener?.(failure);
  };
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.on("error", fail);
  child.stdin.on("error", fail);
  lines.on("close", () => fail(new Error("Local recognition worker disconnected")));
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === "error") throw new Error(message.message);
      if (message.type === "segment") {
        const segment: Segment = {
          id: randomUUID(), source: message.source, startMs: message.startMs,
          endMs: message.endMs, text: message.text,
          engine: moonshine ? "moonshine" : "faster-whisper", model: basename(modelPath),
        };
        segments.push(segment);
        publish(segment);
      } else if (message.type === "preview") {
        preview?.(message.source, message.text);
      } else if (listener) {
        listener(undefined, message);
      } else {
        throw new Error("Unexpected recognition response");
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const cancel = async () => {
    child.kill();
    await closed;
  };
  async function request(expected: string, payload?: Buffer, samples?: number) {
    if (failure) throw failure;
    if (listener) throw new Error("Recognition request already pending");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        fail(new Error("Local recognition timed out"));
        child.kill();
      }, 30000);
      listener = (error, response) => {
        clearTimeout(timeout);
        listener = undefined;
        if (error) reject(error);
        else if (response?.type !== expected || (samples !== undefined && response.samples !== samples)) {
          reject(new Error("Unexpected recognition acknowledgement"));
        } else resolve();
      };
      if (payload) child.stdin.write(payload);
    });
  }
  try {
    await request("ready");
  } catch (error) {
    await cancel();
    throw error;
  }
  let offset = 0;
  return {
    async append(frames: Int16Array[]) {
      const samples = frames[0].length;
      const header = Buffer.from(JSON.stringify({ type: "audio", offset, samples }) + "\n");
      const data = frames.map((frame) => Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
      await request("accepted", Buffer.concat([header, ...data]), offset + samples);
      offset += samples;
    },
    async finish() {
      try {
        await request("finished", Buffer.from('{"type":"finish"}\n'), offset);
        child.stdin.end();
        if (await closed !== 0) throw new Error("Local recognition failed during shutdown");
        return segments.sort((left, right) => left.startMs - right.startMs);
      } finally {
        if (child.exitCode === null) await cancel();
      }
    },
    cancel,
  };
}
