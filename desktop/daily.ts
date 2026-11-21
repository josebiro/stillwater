import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listEnhancements } from "./enhance.ts";
import { vaultPaths } from "./vault-search.ts";
import { openMeeting, openMeetingHeader, saveMeetingContexts } from "./vault.ts";
import { applySeries, changeFolders, type Folder, readFolders } from "./folders.ts";

const kinds = new Set(["project", "person", "topic", "area", "organization"]);
function text(value: unknown, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit || /[\r\n]/.test(value)) {
    throw Error("Enter a nonempty value on one line, up to " + limit + " characters.");
  }
  return value.trim().normalize("NFC");
}
export function label(value: unknown) {
  const input = text(value, 120);
  const split = input.indexOf(":");
  const kind = input.slice(0, split).toLowerCase();
  if (split < 0 || !kinds.has(kind)) throw Error("Choose a label type.");
  return kind + ": " + text(input.slice(split + 1), 100);
}
type Question = { id: string; person: string; text: string; discussed: boolean };
type Decision = { id: string; meeting: string; project: string; subject: string; text: string; reason: string; anchor: string; revision: number; date: string };
type Commitment = { id: string; meeting: string; text: string; anchor: string; revision: number; recipient: string; status: string };
type Journal = { labels: string[]; questions: Question[]; decisions: Decision[]; commitments: Commitment[]; folders: Folder[] };
async function readJournal(vault: string): Promise<Journal> {
  const file = join(vault, "stillwater-journal.json");
  try {
    if (!(await lstat(file)).isFile()) throw Error("Invalid journal file.");
    const data = JSON.parse(await readFile(file, "utf8"));
    if (data.version !== 1 || !["labels","questions","decisions","commitments"].every(key => Array.isArray(data[key]))) throw Error("Unsupported journal.");
    return { ...data, folders: readFolders(data.folders) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { labels: [], questions: [], decisions: [], commitments: [], folders: [] };
  }
}
async function saveJournal(vault: string, journal: Journal) {
  const file = join(vault, ".journal-" + randomUUID() + ".tmp");
  try {
    await writeFile(file, JSON.stringify({ ...journal, version: 1 }, null, 2), {flag:"wx",flush:true});
    await rename(file, join(vault,"stillwater-journal.json"));
  } finally { await rm(file,{force:true}); }
}

async function indexJournal(vault: string, journal: Journal) {
  const meetings = [];
  const candidates: Commitment[] = [];
  const labels = new Map(journal.labels.map(name => [name.toLowerCase(), name]));
  for await (const { path, bundle } of vaultPaths(vault)) {
    const {metadata:m, archived} = await openMeetingHeader(vault,bundle);
    const tags = (m.contexts ?? []).filter(c => c.status === "confirmed").map(c => c.kind + ": " + c.name);
    for (const name of tags) labels.set(name.toLowerCase(), name);
    meetings.push({id:m.meetingId, title:m.title, path, bundle, tags, event:m.calendarEvent, people:m.participants ?? [], date:m.createdAt, archived});
    if (archived) continue;
    const records = (await listEnhancements(bundle)).filter(r => r.transcriptRevision===m.transcriptRevision);
    if (!records.length) continue;
    const meeting = await openMeeting(vault,bundle);
    const hash = createHash("sha256").update(JSON.stringify({notes:meeting.notes,transcript:meeting.segments})).digest("hex");
    const latest = records.find(r=>r.inputHash===hash);
    for (const action of latest?.draft.actions ?? []) {
      const anchor = action.segmentIds.find(id => meeting.segments.some(s=>s.id===id));
      if (!anchor) continue;
      const id = createHash("sha256").update(JSON.stringify([m.meetingId,anchor,action.text])).digest("hex");
      if (!journal.commitments.some(c=>c.id===id) && !candidates.some(c=>c.id===id)) candidates.push({
        id, meeting:m.meetingId, text:action.text, anchor, revision:meeting.revision, status:"suggested", recipient:""
      });
    }
  }
  return { meetings, labels:[...labels.values()].sort(), questions:journal.questions, decisions:journal.decisions,
    commitments:[...journal.commitments,...candidates], folders:journal.folders };
}

/** Note id -> the calendar series it was saved from. */
const seriesOf = (meetings: { id: string; event?: { id?: string } }[]) =>
  new Map(meetings.filter(m => m.event?.id).map(m => [m.id, m.event!.id!] as [string, string]));
export async function readDaily(vault:string) {
  const journal = await readJournal(vault);
  const index = await indexJournal(vault,journal);
  // Folders that follow a series pick up its new notes here, once per note.
  if (applySeries(journal.folders, seriesOf(index.meetings))) await saveJournal(vault,journal);
  return index;
}
export async function changeDaily(vault:string, command: Record<string,unknown>) {
  const journal = await readJournal(vault);
  const index = await indexJournal(vault,journal);
  if (String(command.type).startsWith("folder-")) {
    const folder = changeFolders(journal.folders, command, new Set(index.meetings.map(m=>m.id)), seriesOf(index.meetings));
    if (folder === undefined) throw Error("Unknown journal operation.");
    await saveJournal(vault,journal);
    return { ...(await readDaily(vault)), folder };
  }
  switch(command.type) {
    case "label":
    case "rename":
    case "attach":
    case "detach": {
      const name = label(command.name), key = name.toLowerCase();
      const original = command.type === "rename" ? label(command.original).toLowerCase() : key;
      if (command.type==="rename" && name.split(":")[0]!==original.split(":")[0]) throw Error("Keep the original label type when renaming.");
      const ids = command.ids;
      const batch = command.type==="attach" || command.type==="detach";
      if (batch && (!Array.isArray(ids) || !ids.length || !ids.every(id=>index.meetings.some(m=>m.id===id)))) throw Error("Select notes from this vault.");
      const updates = [];
      for (const m of index.meetings) {
        const has = m.tags.some(t=>t.toLowerCase()===original);
        if (batch ? !(ids as string[]).includes(m.id) : command.type!=="rename" || !has) continue;
        const next = m.tags.filter(t=>t.toLowerCase()!==original && (command.type==="detach" || t.toLowerCase()!==key));
        if (command.type!=="detach") next.push(name);
        const contexts = next.join("\n");
        if (contexts.length>2000) throw Error("Label limit exceeded on "+m.title);
        updates.push({bundle:m.bundle,contexts});
      }
      for (const update of updates) {
        await saveMeetingContexts(vault,update.bundle,update.contexts);
      }
      if (command.type==="rename") {
        journal.labels=journal.labels.filter(t=>t.toLowerCase()!==original);
        for (const d of journal.decisions) if (("project: "+d.project).toLowerCase()===original) d.project=name.slice(name.indexOf(":")+2);
        for (const q of journal.questions) if (("person: "+q.person).toLowerCase()===original) q.person=name.slice(name.indexOf(":")+2);
      }
      if (!journal.labels.some(t=>t.toLowerCase()===key)) journal.labels.push(name);
      break;
    }
    case "question":
      journal.questions.push({id:randomUUID(), person:text(command.person,100),text:text(command.text,500),discussed:false});
      break;
    case "discussed": {
      const q=journal.questions.find(q=>q.id===command.id);
      if (!q) throw Error("Question unavailable.");
      q.discussed=true;
      break;
    }
    case "commitment": {
      const item=index.commitments.find(c=>c.id===command.id);
      if (!item || !["confirmed","dismissed","done"].includes(String(command.status))) throw Error("Invalid commitment.");
      item.status=String(command.status);
      if(item.status==="confirmed") item.recipient=text(command.recipient,100);
      journal.commitments=journal.commitments.filter(c=>c.id!==item.id).concat(item);
      break;
    }
    case "decision": {
      const m=index.meetings.find(m=>m.id===command.meeting);
      const project=text(command.project,100);
      if (!m || !m.tags.some(t=>t.toLowerCase()===("project: "+project).toLowerCase())) throw Error("Add the project label to this note first.");
      const revision = command.revision;
      if (revision !== undefined && !Number.isSafeInteger(revision)) throw Error("Invalid source revision.");
      const meeting=await openMeeting(vault,m.bundle,revision as number | undefined);
      const anchor=String(command.anchor ?? "");
      if (anchor && !meeting.segments.some(s=>s.id===anchor)) throw Error("Transcript passage unavailable.");
      journal.decisions.push({id:randomUUID(),meeting:m.id,project,subject:text(command.subject,150),text:text(command.text,500),
        reason:command.reason ? text(command.reason,500) : "",anchor,revision:meeting.revision,date:m.event?.start ?? m.date});
      break;
    }
    default: throw Error("Unknown journal operation.");
  }
  await saveJournal(vault,journal);
  return readDaily(vault);
}
