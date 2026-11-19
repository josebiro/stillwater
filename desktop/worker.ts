import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

type Reply = Record<string, unknown>;

export async function fixtureRoundTrip(root: string) {
  const python = process.env.STILLWATER_PYTHON ?? resolve(root, ".venv/Scripts/python.exe");
  const child = spawn(python, ["-u", resolve(root, "worker/fixture_worker.py")], {
    stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    pending?.reject(error);
    pending = undefined;
  };
  const closed = new Promise<number | null>((done) => child.once("close", done));
  child.on("error", fail);
  child.stdin.on("error", fail);
  lines.on("close", () => fail(new Error("Worker output closed")));
  lines.on("line", (line) => {
    try {
      if (!pending || line.length > 4096) throw new Error("Unexpected worker message");
      const reply = JSON.parse(line);
      if (reply.version !== 1) throw new Error("Unsupported worker protocol");
      if (reply.type === "error") throw new Error(`${reply.code}: ${reply.message}`);
      const receiver = pending;
      pending = undefined;
      receiver.resolve(reply);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const timeout = setTimeout(() => {
    fail(new Error("Worker timed out"));
    child.kill();
  }, 10000);
  const receive = () => new Promise<Reply>((resolve, reject) => {
    if (failure) reject(failure);
    else pending = { resolve, reject };
  });
  const session = randomUUID();
  const send = async (type: string, expected: string, fields: Reply = {}, pcm = Buffer.alloc(0)) => {
    const request = randomUUID();
    const response = receive();
    const header = Buffer.from(JSON.stringify({ version: 1, type, request, session, ...fields }) + "\n");
    child.stdin.write(Buffer.concat([header, pcm]));
    const reply = await response;
    if (reply.request !== request || reply.type !== expected ||
        (type !== "shutdown" && reply.session !== session)) {
      throw new Error(`Unexpected response to ${type}`);
    }
    return reply;
  };

  try {
    if ((await receive()).type !== "ready") throw new Error("Worker failed handshake");
    await send("start", "started");
    for (const [sequence, source] of ["microphone", "system"].entries()) {
      const pcm = Buffer.alloc(3200);
      for (let sample = 0; sample < 1600; sample++) {
        pcm.writeInt16LE(((sample * (sequence + 31)) % 8192) - 4096, sample * 2);
      }
      const fields = { sequence, source, offsetSamples: 0, bytes: pcm.length };
      const reply = await send("audio", "accepted", fields, pcm);
      if (Object.entries(fields).some(([key, value]) => reply[key] !== value) ||
          reply.sha256 !== createHash("sha256").update(pcm).digest("hex")) {
        throw new Error("Worker returned a mismatched audio acknowledgement");
      }
    }
    await send("finish", "finished");
    await send("start", "started");
    await send("cancel", "cancelled");
    await send("shutdown", "stopped");
    child.stdin.end();
    if (await closed !== 0) throw new Error("Worker did not exit cleanly");
    return { frames: 2, bytes: 6400, cancelled: true };
  } finally {
    clearTimeout(timeout);
    lines.close();
    if (child.exitCode === null) child.kill();
    await closed;
  }
}
