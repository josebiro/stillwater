import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMeeting } from "./vault.ts";
import { readEnhancedNotes } from "./enhanced-notes.ts";
import { listEnhancements } from "./enhance.ts";

async function directories(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

async function* vaultMeetings(vault: string, meetingId?: string) {
  for (const collection of ["meetings", "archive"]) {
    const meetings = join(vault, collection);
    for (const year of await directories(meetings)) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const name of await directories(join(meetings, year))) {
        if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+--[a-f0-9-]{36}$/.test(name)) continue;
        if (meetingId && !name.endsWith(`--${meetingId}`)) continue;
        const bundle = join(meetings, year, name);
        yield { bundle, path: relative(vault, bundle), meeting: await openMeeting(vault, bundle) };
      }
    }
  }
}

export async function resolveMeetingLink(vault: string, path: string) {
  const bundle = join(vault, path);
  try {
    await openMeeting(vault, bundle);
    return bundle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const id = /--([a-f0-9-]{36})$/.exec(basename(path))?.[1];
    if (!id) throw error;
    let match: string | undefined;
    for await (const candidate of vaultMeetings(vault, id)) {
      if (match) throw new Error("Multiple vault folders contain the linked meeting ID.");
      match = candidate.bundle;
    }
    if (!match) throw error;
    return match;
  }
}

export async function findCalendarMeeting(vault: string, event: { id: string; start: string }) {
  let latest: { bundle: string; createdAt: string } | undefined;
  for await (const { bundle, meeting } of vaultMeetings(vault)) {
    const linked = meeting.metadata.calendarEvent;
    if (!meeting.archived && linked?.id === event.id && linked.start === event.start &&
        (!latest || meeting.metadata.createdAt > latest.createdAt)) {
      latest = { bundle, createdAt: meeting.metadata.createdAt };
    }
  }
  return latest?.bundle;
}

export async function listVaultContexts(vault: string) {
  type Entry = { id: string; title: string; bundle: string; archived: boolean };
  const groups = new Map<string, { kind: string; name: string; meetings: Map<string, Entry> }>();
  for await (const { path, meeting } of vaultMeetings(vault)) {
    for (const context of meeting.metadata.contexts ?? []) {
      if (context?.status !== "confirmed") continue;
      const { kind, name } = context;
      const key = kind + ":" + name.toLowerCase();
      let group = groups.get(key);
      if (!group) {
        group = { kind, name, meetings: new Map() };
        groups.set(key, group);
      }
      const id = meeting.metadata.meetingId;
      group.meetings.set(id, { id, title: meeting.metadata.title, bundle: path, archived: meeting.archived });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group, meetings: [...group.meetings.values()].sort((a, b) => a.title.localeCompare(b.title)),
  })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export async function listRecentActions(vault: string) {
  const meetings = [];
  for await (const entry of vaultMeetings(vault)) {
    if (!entry.meeting.archived) meetings.push(entry);
  }
  meetings.sort((a, b) => b.meeting.metadata.createdAt.localeCompare(a.meeting.metadata.createdAt));
  const results = [];
  for (const { bundle, path, meeting } of meetings.slice(0, 20)) {
    const draft = (await listEnhancements(bundle, meeting)).find((record) => !record.stale &&
      record.transcriptRevision === meeting.revision);
    if (!draft) continue;
    const ids = new Set(meeting.segments.map((segment) => segment.id));
    for (const action of draft.draft.actions) {
      const anchor = action.segmentIds.find((id) => ids.has(id));
      if (anchor) results.push({ bundle: path, anchor, excerpt: action.text, meetingTitle: meeting.metadata.title });
    }
  }
  return results.slice(0, 50);
}

export async function searchVault(vault: string, query: string, anyTerm = false, contextFilter = "") {
  const filter = contextFilter.trim().normalize("NFC").toLowerCase();
  const matches = (contexts: { kind: string; name: string; status: string }[] = []) =>
    !filter || contexts.some(({ kind, name, status }) => status === "confirmed" &&
      (name.toLowerCase() === filter || `${kind}: ${name}`.toLowerCase() === filter));
  if (!query.trim()) {
    const entries = [];
    const contexts = new Map<string, { key: string; kind: string; name: string }>();
    for await (const entry of vaultMeetings(vault)) {
      if (matches(entry.meeting.metadata.contexts)) entries.push(entry);
      for (const context of entry.meeting.metadata.contexts ?? []) {
        if (context.status !== "confirmed" || !["project", "area", "topic"].includes(context.kind)) continue;
        const key = context.kind + ":" + context.name.toLowerCase();
        contexts.set(key, { key, kind: context.kind, name: context.name });
      }
    }
    const candidates = [...contexts.values()].sort((a, b) => b.name.length - a.name.length);
    return entries.sort((a, b) => b.meeting.metadata.createdAt.localeCompare(a.meeting.metadata.createdAt))
      .slice(0, 50).map(({ path, meeting }) => {
      const title = meeting.metadata.title.toLowerCase();
      const excluded = new Set(meeting.metadata.dismissedFilingSuggestions ?? []);
      for (const context of meeting.metadata.contexts ?? []) excluded.add(context.kind + ":" + context.name.toLowerCase());
      const suggestion = meeting.archived ? undefined : candidates.find((context) => {
        if (excluded.has(context.key)) return false;
        const escaped = context.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(title);
      });
      return { bundle: path, anchor: "", excerpt: meeting.metadata.title,
        date: meeting.metadata.createdAt, archived: meeting.archived,
        participants: meeting.metadata.participants ?? [], suggestion };
    });
  }
  const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 20);
  if (!terms?.length) return [];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE documents USING fts5(title, body, bundle UNINDEXED, anchor UNINDEXED, meetingTitle UNINDEXED)");
    const add = db.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?)");
    for await (const { bundle, path, meeting } of vaultMeetings(vault)) {
      if (!matches(meeting.metadata.contexts)) continue;
      const contexts = (meeting.metadata.contexts ?? []).map(({ kind, name }) => `${kind} ${name}`).join("\n");
      const title = meeting.metadata.title;
      add.run(title, [meeting.notes, contexts].join("\n"), path, "", title);
      const enhanced = await readEnhancedNotes(bundle);
      if (enhanced.text) add.run("", enhanced.text, path, "", title);
      for (const segment of meeting.segments) add.run("", segment.text, path, segment.id, title);
    }
    return db.prepare(`
      SELECT bundle, anchor, meetingTitle, snippet(documents, -1, '', '', '…', 20) AS excerpt
      FROM documents WHERE documents MATCH ? ORDER BY rank LIMIT 50
    `).all(terms.map((term) => `"${term}"`).join(anyTerm ? " OR " : " AND "));
  } finally {
    db.close();
  }
}
