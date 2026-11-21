import { randomUUID } from "node:crypto";

// Folders group notes the way labels describe them: a note can sit in any number of
// folders, folders nest under a parent, and deleting a folder never deletes its notes.
// The eight colours the icon picker offers.
export const folderColors = ["gray", "black", "violet", "blue", "teal", "lime", "amber", "red"] as const;
export const folderGlyphs = ["star", "heart", "sparkles", "bookmark", "bolt", "hash", "document", "folder", "clipboard",
  "archive", "list", "tag", "chat", "mail", "phone", "mic", "video", "megaphone", "user", "people", "briefcase",
  "building", "chart", "trend", "dollar", "clock", "calendar", "rocket", "code", "terminal", "shield", "key",
  "brush", "pencil", "cap", "beaker", "lightbulb", "bell", "gear", "globe", "map", "cube", "fire", "cloud", "sun",
  "flag", "gift", "link", "music", "puzzle", "trophy"] as const;
// Subfolders go one level deep: only a top-level folder can hold folders.
export const maxFolderDepth = 2;
export const maxFolderTitle = 100;
export const maxFolderDescription = 500;

export type FolderIcon = { type: "icon"; value: string; color: string } | { type: "emoji"; value: string } | null;
export type Folder = {
  id: string; title: string; description: string; icon: FolderIcon; parent: string | null;
  notes: string[]; favorite: boolean; createdAt: string;
  // Meeting series this folder collects by itself. `seen` holds the notes already considered,
  // so a note taken out of the folder by hand is not put back.
  series: { event: string; seen: string[] }[];
};

// A new folder has no icon; it is drawn as a gray folder until one is chosen.
export const defaultFolderIcon = (): FolderIcon => null;

function title(value: unknown) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim().normalize("NFC") : "";
  if (text.length > maxFolderTitle) throw Error("Folder names can be up to " + maxFolderTitle + " characters.");
  return text || "Untitled folder";
}
function description(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxFolderDescription) {
    throw Error("Folder descriptions can be up to " + maxFolderDescription + " characters.");
  }
  return value.trim().normalize("NFC");
}
export function folderIcon(value: unknown): FolderIcon {
  if (!value || typeof value !== "object") return defaultFolderIcon();
  const icon = value as Record<string, unknown>;
  if (icon.type === "emoji") {
    const emoji = String(icon.value ?? "").trim();
    if (!emoji || [...emoji].length > 8 || /[\p{L}\p{N}\s]/u.test(emoji.replace(/️|‍/g, ""))) {
      throw Error("Choose a single emoji.");
    }
    return { type: "emoji", value: emoji };
  }
  const glyph = String(icon.value ?? "folder"), color = String(icon.color ?? "gray");
  if (!(folderGlyphs as readonly string[]).includes(glyph)) throw Error("Choose an icon from the list.");
  if (!(folderColors as readonly string[]).includes(color)) throw Error("Choose a colour from the list.");
  return { type: "icon", value: glyph, color };
}

export function readFolders(value: unknown): Folder[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Error("Unsupported journal folders.");
  return value.map((entry) => ({
    id: String(entry.id), title: title(entry.title), description: description(entry.description),
    icon: folderIcon(entry.icon), parent: typeof entry.parent === "string" ? entry.parent : null,
    notes: Array.isArray(entry.notes) ? [...new Set(entry.notes.map(String))] : [],
    favorite: entry.favorite === true, createdAt: String(entry.createdAt ?? new Date(0).toISOString()),
    series: Array.isArray(entry.series) ? entry.series.filter((rule) => rule && typeof rule.event === "string")
      .map((rule) => ({ event: rule.event, seen: Array.isArray(rule.seen) ? [...new Set(rule.seen.map(String))] : [] })) : [],
  }));
}

/** Folders a level below `id`, all the way down. */
export function descendants(folders: Folder[], id: string) {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const next = queue.shift();
    for (const folder of folders) {
      if (folder.parent === next && !found.has(folder.id)) { found.add(folder.id); queue.push(folder.id); }
    }
  }
  return found;
}
export function depth(folders: Folder[], id: string | null) {
  let level = 0;
  for (let current = folders.find((f) => f.id === id); current; current = folders.find((f) => f.id === current.parent)) {
    if (++level > folders.length) throw Error("Folder nesting loops.");
  }
  return level;
}
function subtreeHeight(folders: Folder[], id: string): number {
  const children = folders.filter((f) => f.parent === id);
  return 1 + Math.max(0, ...children.map((child) => subtreeHeight(folders, child.id)));
}

/** Alphabetical by title, ignoring case and accents, like the sidebar lists them. */
const collator = new Intl.Collator(undefined, { sensitivity: "base" });
export const compareFolders = (a: Folder, b: Folder) => collator.compare(a.title, b.title);

function find(folders: Folder[], id: unknown) {
  const folder = folders.find((f) => f.id === id);
  if (!folder) throw Error("That folder no longer exists.");
  return folder;
}
function checkParent(folders: Folder[], id: string | null, parent: unknown) {
  if (parent === null || parent === undefined || parent === "") return null;
  const target = find(folders, parent);
  if (id && (target.id === id || descendants(folders, id).has(target.id))) {
    throw Error("A folder can't go inside itself or one of its subfolders.");
  }
  const height = id ? subtreeHeight(folders, id) : 1;
  if (depth(folders, target.id) + height > maxFolderDepth) {
    throw Error("Subfolders can only go inside a top-level folder, and a folder with subfolders can't be nested.");
  }
  return target.id;
}

/** New notes from a series a folder follows go into that folder. Returns true when anything changed. */
export function applySeries(folders: Folder[], events: Map<string, string>) {
  let changed = false;
  for (const folder of folders) {
    for (const rule of folder.series) {
      for (const [note, event] of events) {
        if (event !== rule.event || rule.seen.includes(note)) continue;
        rule.seen.push(note);
        if (!folder.notes.includes(note)) folder.notes.push(note);
        changed = true;
      }
    }
  }
  return changed;
}

export function changeFolders(folders: Folder[], command: Record<string, unknown>, noteIds: Set<string>,
  events: Map<string, string> = new Map()) {
  const ids = () => {
    const list = command.ids;
    if (!Array.isArray(list) || !list.length || !list.every((id) => typeof id === "string" && noteIds.has(id))) {
      throw Error("Select notes from this vault.");
    }
    return list as string[];
  };
  switch (command.type) {
    case "folder-create": {
      const folder: Folder = {
        id: randomUUID(), title: title(command.title), description: description(command.description),
        icon: folderIcon(command.icon), parent: checkParent(folders, null, command.parent), notes: [],
        favorite: false, createdAt: new Date().toISOString(), series: [],
      };
      if (command.ids !== undefined) folder.notes = [...new Set(ids())];
      folders.push(folder);
      return folder.id;
    }
    case "folder-update": {
      const folder = find(folders, command.id);
      if (command.title !== undefined) folder.title = title(command.title);
      if (command.description !== undefined) folder.description = description(command.description);
      if (command.icon !== undefined) folder.icon = folderIcon(command.icon);
      if (command.favorite !== undefined) {
        // Favouriting a folder favourites everything inside it too.
        for (const id of [folder.id, ...descendants(folders, folder.id)]) find(folders, id).favorite = command.favorite === true;
      }
      return folder.id;
    }
    case "folder-move": {
      const folder = find(folders, command.id);
      folder.parent = checkParent(folders, folder.id, command.parent);
      return folder.id;
    }
    case "folder-delete": {
      // Subfolders move up to the deleted folder's parent; notes stay in My notes.
      const folder = find(folders, command.id);
      for (const child of folders) if (child.parent === folder.id) child.parent = folder.parent;
      folders.splice(folders.indexOf(folder), 1);
      return folder.parent;
    }
    case "folder-add":
    case "folder-remove": {
      const folder = find(folders, command.id);
      const selected = ids();
      folder.notes = command.type === "folder-add"
        ? [...new Set([...folder.notes, ...selected])]
        : folder.notes.filter((id) => !selected.includes(id));
      return folder.id;
    }
    case "folder-follow": {
      // Follow a meeting series: notes saved from it later are added without asking.
      // Notes that exist now count as seen; adding them is the caller's choice.
      const folder = find(folders, command.id);
      const event = typeof command.event === "string" ? command.event : "";
      if (!event || ![...events.values()].includes(event)) throw Error("That meeting series has no notes in this vault.");
      folder.series = folder.series.filter((rule) => rule.event !== event);
      if (command.on !== false) {
        folder.series.push({ event, seen: [...events].filter(([, e]) => e === event).map(([note]) => note) });
      }
      return folder.id;
    }
    case "folder-set": {
      // The note's folder picker: exactly these folders, no others.
      const [note] = ids();
      const wanted = new Set(Array.isArray(command.folders) ? command.folders.map(String) : []);
      for (const id of wanted) find(folders, id);
      for (const folder of folders) {
        const has = folder.notes.includes(note);
        if (wanted.has(folder.id) && !has) folder.notes.push(note);
        if (!wanted.has(folder.id) && has) folder.notes = folder.notes.filter((id) => id !== note);
      }
      return null;
    }
    default:
      return undefined;
  }
}
