import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const channels = ["microphone", "system"] as const;
const headerSize = 44;
const limit = 2 * 1024 ** 3;
const totalLimit = 10 * 1024 ** 3;
const expiry = 24 * 60 * 60 * 1000;
const captureName = /^capture-[a-zA-Z0-9]{6}$/;

export async function captureKeepsRecording(directory: string) {
  try {
    return (await lstat(join(directory, "keep-recording"))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

export async function inspectCaptureStorage(parent: string, now = Date.now()) {
  await mkdir(parent, { recursive: true });
  let bytes = 0;
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !captureName.test(entry.name)) continue;
    const directory = join(parent, entry.name);
    const readTrackStats = () => Promise.all(channels.map(async (channel) => {
      try {
        const stat = await lstat(join(directory, channel + ".wav"));
        return stat.isFile() ? stat : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }));
    let stats = await readTrackStats();
    const activity = Math.max((await lstat(directory)).mtimeMs, ...stats.map((stat) => stat?.mtimeMs ?? 0));
    if (now - activity >= expiry && !await captureKeepsRecording(directory)) {
      try {
        await rm(directory, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        console.error("Could not remove expired recording", error);
        stats = await readTrackStats();
      }
    }
    bytes += stats.reduce((total, stat) => total + (stat?.size ?? 0), 0);
  }
  return bytes;
}

export async function validateCaptureDirectory(parent: string, selected: string) {
  const directory = resolve(selected);
  if (dirname(directory) !== resolve(parent) || !captureName.test(basename(directory))) {
    throw new Error("Choose a Stillwater capture folder");
  }
  const info = await lstat(directory).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    throw new Error("This recording folder is no longer available. Choose another interrupted recording.", { cause: error });
  });
  if (!info.isDirectory()) throw new Error("Choose a Stillwater capture folder");
  return directory;
}

export async function recoverCapture(parent: string, selected: string) {
  const directory = await validateCaptureDirectory(parent, selected);
  const tracks = channels.map((source) => ({ source, path: join(directory, source + ".wav") }));
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  try {
    const lengths = [];
    for (const track of tracks) {
      const info = await lstat(track.path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        throw new Error(`The ${track.source} audio track is missing from this recording.`, { cause: error });
      });
      if (!info.isFile()) throw new Error("Invalid capture track");
      const file = await open(track.path, "r+");
      handles.push(file);
      const header = Buffer.alloc(headerSize);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.toString("ascii", 0, 4) !== "RIFF" ||
          !header.subarray(8, 40).equals(wavHeader(0).subarray(8, 40))) {
        throw new Error("Invalid capture header");
      }
      lengths.push(Math.min(header.readUInt32LE(40), (await file.stat()).size - headerSize));
    }
    const bytes = Math.floor(Math.min(...lengths) / 2) * 2;
    if (!bytes) throw new Error("This capture has no completed audio checkpoint");
    for (const file of handles) {
      const header = wavHeader(bytes);
      const { bytesWritten } = await file.write(header, 0, header.length, 0);
      if (bytesWritten !== header.length) throw new Error("Short audio header write");
      await file.truncate(headerSize + bytes);
      await file.sync();
    }
    return tracks;
  } finally {
    await Promise.all(handles.map((file) => file.close()));
  }
}

function wavHeader(bytes: number) {
  const header = Buffer.alloc(headerSize);
  header.write("RIFF");
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

export async function captureSpool(parent: string, quotas = { meeting: limit, total: totalLimit }, keepRecording = false) {
  const existing = await inspectCaptureStorage(parent);
  if (existing + 2 * headerSize >= quotas.total) throw new Error("Capture storage is full");
  const directory = await mkdtemp(join(parent, "capture-"));
  const paths = channels.map((channel) => join(directory, channel + ".wav"));
  let samples = 0;
  let closed = false;
  let busy = false;
  let checkpointSamples = 0;
  const files: Awaited<ReturnType<typeof open>>[] = [];
  async function close() {
    closed = true;
    await Promise.all(files.map((file) => file.close()));
  }
  async function checkpoint() {
    for (const file of files) {
      const header = wavHeader(samples * 2);
      const { bytesWritten } = await file.write(header, 0, header.length, 0);
      if (bytesWritten !== header.length) throw new Error("Short audio header write");
      await file.sync();
    }
    checkpointSamples = samples;
  }
  try {
    for (const path of paths) {
      const file = await open(path, "wx");
      files.push(file);
      await file.writeFile(wavHeader(0));
    }
    if (keepRecording) await writeFile(join(directory, "keep-recording"), "", { flag: "wx", flush: true });
  } catch (error) {
    await close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    async release() {
      if (closed) return;
      try {
        if (samples > checkpointSamples) await checkpoint();
      } finally {
        await close();
      }
    },
    async append(offset: number, frames: unknown) {
      if (busy || closed || offset !== samples || !Array.isArray(frames) || frames.length !== 2 ||
          frames.some((frame) => !(frame instanceof Int16Array) || !frame.length || frame.length > 2048) ||
          frames[0].length !== frames[1].length) throw new Error("Invalid capture frame");
      const bytes = (samples + frames[0].length) * 4 + 2 * headerSize;
      if (bytes > quotas.meeting || existing + bytes > quotas.total) throw new Error("Capture storage limit reached");
      busy = true;
      try {
        for (const [index, frame] of frames.entries()) {
          const data = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
          const { bytesWritten } = await files[index].write(data, 0, data.length, headerSize + samples * 2);
          if (bytesWritten !== data.length) throw new Error("Short audio write");
        }
        samples += frames[0].length;
        if (samples - checkpointSamples >= 16000) await checkpoint();
        return bytes >= quotas.meeting * 0.8 || existing + bytes >= quotas.total * 0.8;
      } finally {
        busy = false;
      }
    },
    async finish() {
      if (busy || closed || !samples) throw new Error("No complete capture to transcribe");
      await checkpoint();
      await close();
      return paths.map((path, index) => ({ path, source: channels[index] }));
    },
    async discard() {
      if (!closed) await close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
