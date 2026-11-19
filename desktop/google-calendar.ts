import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCalendar } from "./calendar.ts";

type Agenda = ReturnType<typeof parseCalendar>;
type Feed = {address: string; syncedAt: number; agenda: Agenda};
type Storage = {seal: (value:string) => Promise<Buffer>; open: (value:Buffer) => Promise<string>};
const maxBytes = 5 * 1024 * 1024;

function googleAddress(value: unknown) {
  const invalid = () => new Error("Paste the Google Calendar address from Integrate calendar → Secret address in iCal format.");
  if (typeof value !== "string" || value.length > 4096) throw invalid();
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.origin !== "https://calendar.google.com" || url.username || url.password || url.search || url.hash ||
      !/^\/calendar\/ical\/[^/]+\/(?:private-[\w-]+|public)\/basic\.ics$/.test(url.pathname)) throw invalid();
  return url.href;
}

async function download(address: string) {
  const response = await fetch(address, {redirect:"error",signal:AbortSignal.timeout(20000)}).catch(() => {
    throw new Error("Could not reach Google Calendar. Check your connection and try again.");
  });
  if (!response.ok || !response.body) throw new Error("Google Calendar could not provide this feed. Check the calendar address.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const {value,done} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("The Google calendar feed exceeds 5 MB.");
    }
    chunks.push(value);
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^BEGIN:VCALENDAR\r?\n/i.test(source) || !/\nEND:VCALENDAR$/i.test(source)) {
    throw new Error("Google returned an invalid calendar feed.");
  }
  return parseCalendar(source);
}

export class GoogleCalendarFeed {
  private file: string;
  private storage: Storage;
  private feed?: Feed;
  private busy = false;
  private unreadable = false;

  constructor(directory:string, storage:Storage) {
    this.file = join(directory,"google-calendar.bin");
    this.storage = storage;
  }

  async load() {
    try {
      const saved: Feed = JSON.parse(await this.storage.open(await readFile(this.file)));
      googleAddress(saved.address);
      if (!Number.isFinite(saved.syncedAt) || !Array.isArray(saved.agenda.events)) throw Error();
      this.feed = saved;
    } catch (error) {
      this.unreadable = error.code !== "ENOENT";
    }
  }

  agenda(imported: Agenda) {
    const google = this.feed?.agenda;
    const events = new Map<string,Agenda["events"][number]>();
    for (const event of [...imported.events, ...(google?.events ?? [])]) {
      events.set(JSON.stringify([event.id,event.start]),event);
    }
    return {events:[...events.values()].sort((a,b)=>a.start.localeCompare(b.start)),
      unsupported:imported.unsupported + (google?.unsupported ?? 0),
      connected:Boolean(this.feed), syncedAt:this.feed?.syncedAt ?? 0, unreadable:this.unreadable};
  }

  async change(action: "connect" | "sync" | "disconnect", value?: unknown) {
    if (this.busy) throw Error("Calendar sync is already in progress.");
    this.busy = true;
    try {
      if (action === "disconnect") {
        await rm(this.file,{force:true});
        this.feed = undefined;
        this.unreadable = false;
        return;
      }
      const address = action === "connect" ? googleAddress(value) : this.feed?.address;
      if (!address) throw Error("Connect a Google calendar first.");
      const next: Feed = {address,agenda:await download(address),syncedAt:Date.now()};
      const bytes = await this.storage.seal(JSON.stringify(next));
      const temp = this.file + "." + randomUUID();
      try {
        await writeFile(temp, bytes, {flag:"wx",mode:0o600});
        await rename(temp,this.file);
      } finally { await rm(temp,{force:true}); }
      this.feed = next;
      this.unreadable = false;
    } finally { this.busy = false; }
  }
}
