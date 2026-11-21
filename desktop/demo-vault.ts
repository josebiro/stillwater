import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createMeeting } from "./vault.ts";

// A small made-up vault for `--screenshot`, so a picture never shows anyone's real meetings.
// Title, people, days ago, hour, label, and the calendar series the note came from (if any).
const notes: [string, string[], number, number, string, string?][] = [
  ["Orchid release: go/no-go, rollback and budget", [], 0, 19.7, "project: Orchid"],
  ["Orchid approval checkpoint", [], 0, 19.6, "project: Orchid"],
  ["Pricing page interviews", ["Maya Chen", "Sam Lee"], 1, 15.5, "topic: Pricing"],
  ["Weekly design review", ["Avery Kim", "Oliver Park", "Maya Chen"], 7, 11, "area: Design", "demo-design-review"],
  ["Advisor check-in", ["Jordan Blake"], 3, 16, "person: Jordan Blake"],
  ["Seed round prep", ["Riley Fox"], 4, 10.25, ""],
  ["Partner onboarding call", ["Dana Ortiz", "Sam Lee"], 6, 14, "organization: Northwind"],
  ["Hiring sync: platform engineer", ["Avery Kim"], 8, 9.5, ""],
  // This week's review is filed nowhere yet, so its note offers the series' folder and label.
  ["Weekly design review", ["Avery Kim", "Oliver Park", "Maya Chen"], 0, 11, "", "demo-design-review"],
];
const folders = [
  { title: "Advisory", icon: { type: "icon", value: "bolt", color: "violet" }, notes: [4] },
  { title: "Customer calls", icon: null, notes: [2, 6] },
  { title: "Design reviews", icon: null, notes: [3] },
  { title: "Fundraising", icon: { type: "emoji", value: "💵" }, notes: [5] },
  { title: "Hiring", icon: { type: "icon", value: "people", color: "blue" }, notes: [7] },
  { title: "Launches", icon: { type: "emoji", value: "🚀" }, notes: [], favorite: true },
  { title: "Orchid", icon: { type: "icon", value: "sparkles", color: "amber" }, notes: [0, 1], parent: "Launches", favorite: true },
  { title: "Partnerships", icon: null, notes: [6] },
  { title: "Research", icon: { type: "icon", value: "beaker", color: "teal" }, notes: [2] },
  { title: "Team rituals", icon: { type: "icon", value: "calendar", color: "red" }, notes: [3] },
];

export async function seedDemoVault(vault: string) {
  const ids: string[] = [];
  const today = new Date();
  for (const [title, people, daysAgo, hour, label, series] of notes) {
    const when = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, Math.floor(hour), Math.round((hour % 1) * 60));
    const event = series ? { id: series, start: when.toISOString() } : undefined;
    const bundle = await createMeeting(vault, title, "Sample notes.", [], [], people, false, event, label);
    const file = join(bundle, "meeting.yaml");
    const metadata = JSON.parse(await readFile(file, "utf8"));
    metadata.createdAt = when.toISOString();
    await writeFile(file, JSON.stringify(metadata, null, 2) + "\n");
    ids.push(metadata.meetingId);
  }
  const made = new Map<string, string>();
  for (const folder of folders) made.set(folder.title, randomUUID());
  const journal = {
    version: 1, labels: [], questions: [], decisions: [], commitments: [],
    folders: folders.map((folder) => ({
      id: made.get(folder.title), title: folder.title, description: folder.title === "Launches" ? "Everything we ship, start to finish." : "",
      icon: folder.icon, parent: folder.parent ? made.get(folder.parent) : null, notes: folder.notes.map((n) => ids[n]),
      favorite: folder.favorite === true, createdAt: today.toISOString(),
    })),
  };
  await writeFile(join(vault, "stillwater-journal.json"), JSON.stringify(journal, null, 2));
}
