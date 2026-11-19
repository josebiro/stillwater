import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

export type Segment = {
  id: string;
  source: "microphone" | "system" | "imported";
  engine?: string;
  model?: string;
  startMs: number;
  endMs: number;
  text: string;
};

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const bundleName = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+--([0-9a-f-]{36})$/;

async function directory(parent: string, name: string) {
  const path = join(parent, name);
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe vault directory");
  return path;
}

export async function createMeeting(vault: string, title: string, notes: string, segments: Segment[],
  recordings: { source: "microphone" | "system"; path: string }[] = [], participants: string[] = [],
  flagged = false, calendarEvent?: { id: string; start: string }, filing: unknown = "") {
  const contexts = parseMeetingContexts(filing);
  const root = await realpath(vault);
  const meetingId = randomUUID();
  const now = new Date();
  const timestamp = now.toISOString();
  const day = timestamp.slice(0, 10);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64).replace(/^-+|-+$/g, "") || "meeting";
  const year = await directory(await directory(root, "meetings"), day.slice(0, 4));
  const target = join(year, `${day}-${slug}--${meetingId}`);
  const staging = join(year, `.pending-${meetingId}`);
  const metadata = {
    schemaVersion: 1, meetingId, title, createdAt: timestamp, timezone: "UTC",
    transcriptRevision: 1, transcriptStatus: "complete", retention: "temporary",
    participants, tags: [], contexts, generations: [], calendarEvent,
    recordings: recordings.map(({ source }) => ({ source, file: `audio/${source}.wav` })),
  };
  // JSON flow syntax is valid YAML and can be reopened without an index.
  const transcript = segments.map((segment) => ({ ...segment, revision: 1, final: true }));
  const projection = ["# Transcript", "", "Generated from transcript.jsonl.", ""];
  for (const segment of transcript) {
    if (!uuid.test(segment.id) || !Number.isFinite(segment.startMs) ||
        !Number.isFinite(segment.endMs) || segment.startMs < 0 || segment.endMs < segment.startMs ||
        !["microphone", "system", "imported"].includes(segment.source)) {
      throw new Error("Invalid transcript segment");
    }
    projection.push(`<a id="${segment.id}"></a>`,
      `**${segment.source} · ${(segment.startMs / 1000).toFixed(3)}s**`,
      "", ...segment.text.split(/\r?\n/).map((line) => `> ${line}`), "");
  }
  await mkdir(staging);
  try {
    const files = {
      "meeting.yaml": JSON.stringify(metadata, null, 2) + "\n",
      "notes.md": `---\ndocumentId: ${randomUUID()}\nmeetingId: ${meetingId}\ntype: raw-notes\ncreatedAt: ${timestamp}\n---\n\n${notes}`,
      "transcript.jsonl": transcript.map((segment) => JSON.stringify(segment) + "\n").join(""),
      "transcript.md": projection.join("\n"),
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(staging, name), content, { flag: "wx" });
    }
    if (flagged) {
      await writeFile(join(staging, "transcript-review-r1.json"),
        JSON.stringify({ revision: 1, flaggedAt: timestamp }) + "\n", { flag: "wx", flush: true });
    }
    if (recordings.length) {
      const audio = await directory(staging, "audio");
      for (const { source, path } of recordings) await copyFile(path, join(audio, source + ".wav"));
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(staging, target);
        break;
      } catch (error) {
        if (process.platform !== "win32" || attempt === 4 || !["EPERM", "EBUSY"].includes(error.code)) throw error;
        await setTimeout(50 * (attempt + 1));
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return target;
}

export async function openMeeting(vault: string, bundle: string, requestedRevision?: number) {
  const root = await realpath(vault);
  const path = await realpath(bundle);
  const match = bundleName.exec(basename(path));
  const year = dirname(path);
  if (!match || !uuid.test(match[1]) || basename(year) !== basename(path).slice(0, 4) ||
      !["meetings", "archive"].some((collection) => dirname(year) === resolve(root, collection))) {
    throw new Error("Meeting path is outside the vault or malformed");
  }
  const read = async (name: string) => {
    const file = join(path, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe meeting file");
    return readFile(file, "utf8");
  };
  const metadata = JSON.parse(await read("meeting.yaml"));
  if (metadata.schemaVersion !== 1 || metadata.meetingId !== match[1]) {
    throw new Error("Unsupported meeting metadata or mismatched ID");
  }
  const notes = await read("notes.md");
  const revision = requestedRevision ?? metadata.transcriptRevision;
  if (!Number.isSafeInteger(metadata.transcriptRevision) || !Number.isSafeInteger(revision) ||
      revision < 1 || revision > metadata.transcriptRevision) throw new Error("Invalid transcript revision");
  const transcriptFile = revision === 1 ? "transcript.jsonl" : `transcript-r${revision}.jsonl`;
  const segments = (await read(transcriptFile)).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
  const flagged = await lstat(join(path, `transcript-review-r${revision}.json`)).then(
    (file) => file.isFile(),
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  return { metadata, notes, segments, revision, flagged, archived: dirname(year) === resolve(root, "archive") };
}

export async function flagTranscript(vault: string, bundle: string, revision: number) {
  const meeting = await openMeeting(vault, bundle, revision);
  if (!meeting.segments.length) throw new Error("This revision has no transcript to flag.");
  const file = join(await realpath(bundle), `transcript-review-r${revision}.json`);
  try {
    await writeFile(file, JSON.stringify({ revision, flaggedAt: new Date().toISOString() }) + "\n",
      { flag: "wx", flush: true });
  } catch (error) {
    if (error.code !== "EEXIST" || !(await lstat(file)).isFile()) throw error;
  }
}

export async function saveTranscriptRevision(vault: string, bundle: string, previous: number, segments: Segment[]) {
  const { metadata } = await openMeeting(vault, bundle);
  if (metadata.transcriptRevision !== previous) throw new Error("Transcript changed while refinement was running");
  const revision = previous + 1;
  const stem = `transcript-r${revision}`;
  const records = segments.map((segment) => ({ ...segment, revision, final: true }));
  const projection = ["# Transcript", "", ...records.flatMap((segment) => [
    `<a id="${segment.id}"></a>`,
    `**${segment.source} · ${(segment.startMs / 1000).toFixed(3)}s**`,
    "", ...segment.text.split(/\r?\n/).map((line) => `> ${line}`), "",
  ])].join("\n");
  const written: string[] = [];
  const temporary = join(bundle, `.meeting-${randomUUID()}.tmp`);
  try {
    for (const [name, text] of [
      [stem + ".jsonl", records.map((segment) => JSON.stringify(segment) + "\n").join("")],
      [stem + ".md", projection],
      [basename(temporary), JSON.stringify({ ...metadata, transcriptRevision: revision }, null, 2) + "\n"],
    ]) {
      const path = join(bundle, name);
      const file = await open(path, "wx");
      written.push(path);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await rename(temporary, join(bundle, "meeting.yaml"));
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw error;
  }
  return await openMeeting(vault, bundle);
}

export async function archiveMeeting(vault: string, bundle: string, archived: boolean) {
  const meeting = await openMeeting(vault, bundle);
  if (meeting.archived === archived) return bundle;
  const root = await realpath(vault);
  const source = await realpath(bundle);
  const collection = await directory(root, archived ? "archive" : "meetings");
  const year = await directory(collection, basename(dirname(source)));
  const target = join(year, basename(source));
  if (await lstat(target).then(() => true, (error) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  })) throw new Error("A meeting with this ID already exists at the destination");
  await rename(source, target);
  return target;
}

function parseMeetingContexts(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) throw new Error("Enter valid meeting contexts");
  const contexts = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(project|area|topic|person|organization):\s*(.+)$/i.exec(line.trim());
    if (!match || match[2].length > 100) throw new Error("Use one context per line, such as project: Launch");
    const kind = match[1].toLowerCase();
    const name = match[2].trim().normalize("NFC");
    const key = kind + ":" + name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    contexts.push({ kind, name, status: "confirmed" });
  }
  return contexts;
}

export async function renameMeeting(vault: string, bundle: string, value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200 || /[\r\n]/.test(value)) {
    throw new Error("Enter a meeting title of 1 to 200 characters on one line.");
  }
  const title = value.trim();
  const { metadata } = await openMeeting(vault, bundle);
  if (metadata.title !== title) await writeMeetingMetadata(bundle, { ...metadata, title });
  return title;
}

export async function saveMeetingContexts(vault: string, bundle: string, value: unknown) {
  const contexts = parseMeetingContexts(value);
  const { metadata } = await openMeeting(vault, bundle);
  await writeMeetingMetadata(bundle, {
    ...metadata, contexts: [...contexts, ...(metadata.contexts ?? []).filter((context) => context?.status === "suggested")],
  });
  return contexts;
}

export async function resolveFilingSuggestion(vault: string, bundle: string,
  suggestion: { kind: string; name: string; key: string }, accept: boolean) {
  const { metadata } = await openMeeting(vault, bundle);
  const contexts = metadata.contexts ?? [];
  const dismissed = metadata.dismissedFilingSuggestions ?? [];
  if (accept && !contexts.some((context) => context.kind + ":" + context.name.toLowerCase() === suggestion.key &&
      context.status === "confirmed")) {
    contexts.push({ kind: suggestion.kind, name: suggestion.name, status: "confirmed" });
  }
  await writeMeetingMetadata(bundle, {
    ...metadata, contexts, dismissedFilingSuggestions: accept ? dismissed : [...new Set([...dismissed, suggestion.key])],
  });
}

async function writeMeetingMetadata(bundle: string, metadata: Record<string, unknown>) {
  const target = join(bundle, "meeting.yaml");
  const temporary = join(bundle, `.meeting-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(metadata, null, 2) + "\n", { flag: "wx", flush: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
