// Folder rules and the folder UI, against a throwaway vault. Run: npm run check:folders
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

(async () => {
  const root = process.cwd(), profile = await fs.mkdtemp(join(tmpdir(), "stillwater-folders-"));
  app.setPath("userData", profile);
  app.setAppPath(root);
  const vault = join(profile, "vault");
  await fs.mkdir(vault);
  await fs.writeFile(join(profile, "vault-path.txt"), vault);
  const load = name => import(pathToFileURL(join(root, "desktop", name)));
  const { createMeeting, openMeeting } = await load("vault.ts");
  const { changeDaily, readDaily } = await load("daily.ts");
  const ids = [];
  for (const [title, label] of [["Kickoff", "project: Atlas"], ["Retro", ""], ["Budget review", "topic: Money"]]) {
    ids.push((await openMeeting(vault, await createMeeting(vault, title, "Notes.", [], [], ["Maya"], false, undefined, label))).metadata.meetingId);
  }
  // Rules: create, nest one level, refuse deeper nesting and cycles, many folders per note.
  let state = await changeDaily(vault, { type: "folder-create", title: "  Clients  ", icon: { type: "icon", value: "briefcase", color: "blue" } });
  const clients = state.folder;
  state = await changeDaily(vault, { type: "folder-create", title: "", parent: clients, ids: [ids[0]] });
  const untitled = state.folder;
  assert.equal(state.folders.find(f => f.id === untitled).title, "Untitled folder");
  assert.equal(state.folders.find(f => f.id === clients).title, "Clients");
  await assert.rejects(changeDaily(vault, { type: "folder-create", title: "Too deep", parent: untitled }), /top-level folder/);
  await assert.rejects(changeDaily(vault, { type: "folder-move", id: clients, parent: untitled }), /inside itself/);
  state = await changeDaily(vault, { type: "folder-create", title: "archive" });
  const archive = state.folder;
  await assert.rejects(changeDaily(vault, { type: "folder-move", id: clients, parent: archive }), /top-level folder/);
  await changeDaily(vault, { type: "folder-add", id: archive, ids: [ids[0], ids[1]] });
  await changeDaily(vault, { type: "folder-add", id: clients, ids: [ids[0]] });
  state = await readDaily(vault);
  assert.deepEqual(state.folders.filter(f => f.notes.includes(ids[0])).map(f => f.title).sort(), ["Clients", "Untitled folder", "archive"]);
  await assert.rejects(changeDaily(vault, { type: "folder-add", id: archive, ids: ["not-a-note"] }), /Select notes/);
  await assert.rejects(changeDaily(vault, { type: "folder-update", id: archive, icon: { type: "icon", value: "nope", color: "blue" } }), /icon/);
  // Favouriting a folder favourites its subfolders.
  state = await changeDaily(vault, { type: "folder-update", id: clients, favorite: true });
  assert.ok(state.folders.find(f => f.id === untitled).favorite);
  // Deleting moves subfolders up and keeps notes.
  state = await changeDaily(vault, { type: "folder-delete", id: clients });
  assert.equal(state.folders.find(f => f.id === untitled).parent, null);
  assert.equal(state.meetings.length, 3);
  // Older journals without folders still open.
  const file = join(vault, "stillwater-journal.json"), saved = JSON.parse(await fs.readFile(file, "utf8"));
  delete saved.folders; await fs.writeFile(file, JSON.stringify(saved));
  assert.deepEqual((await readDaily(vault)).folders, []);
  state = await changeDaily(vault, { type: "folder-create", title: "Research", icon: { type: "emoji", value: "🔬" } });
  await changeDaily(vault, { type: "folder-add", id: state.folder, ids: [ids[1]] });

  // A folder that follows a meeting series collects its later notes once; a note taken out stays out.
  const held = async (title, event, start, label = "") => (await openMeeting(vault, await createMeeting(vault, title, "Notes.", [], [],
    ["Maya"], false, { id: event, start }, label))).metadata.meetingId;
  const notesIn = async id => (await readDaily(vault)).folders.find(f => f.id === id).notes;
  const s1 = await held("Weekly standup", "series-standup", "2026-11-02T10:00:00.000Z", "topic: Standup");
  const standups = (await changeDaily(vault, { type: "folder-create", title: "Standups", ids: [s1] })).folder;
  await assert.rejects(changeDaily(vault, { type: "folder-follow", id: standups, event: "no-such-series" }), /series/);
  await changeDaily(vault, { type: "folder-follow", id: standups, event: "series-standup" });
  const s2 = await held("Weekly standup", "series-standup", "2026-11-09T10:00:00.000Z");
  assert.ok((await notesIn(standups)).includes(s2), "a followed series adds its next note");
  await changeDaily(vault, { type: "folder-remove", id: standups, ids: [s2] });
  assert.ok(!(await notesIn(standups)).includes(s2), "a note taken out is not added again");
  await changeDaily(vault, { type: "folder-follow", id: standups, event: "series-standup", on: false });
  const s3 = await held("Weekly standup", "series-standup", "2026-11-16T10:00:00.000Z");
  assert.ok(!(await notesIn(standups)).includes(s3), "an unfollowed series adds nothing");
  const p1 = await held("Weekly planning", "series-planning", "2026-11-03T10:00:00.000Z");
  const p2 = await held("Weekly planning", "series-planning", "2026-11-10T10:00:00.000Z");

  await load("main.ts");
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  const js = code => win.webContents.executeJavaScript(code);
  const note = (await readDaily(vault)).meetings.find(m => m.title === "Retro");
  const pathOf = id => state.meetings.find(m => m.id === id).path;
  state = await readDaily(vault);
  const paths = { s2: pathOf(s2), s3: pathOf(s3), p2: pathOf(p2) };
  await js(`(async () => {
    const get = id => document.getElementById(id);
    const wait = async (test, message) => { for (let i = 0; i < 240; i++) { if (test()) return; await new Promise(r => setTimeout(r, 25)); }
      throw Error(message + " · " + document.querySelector("main > [role=status]").textContent); };
    await wait(() => get("folder-tree").textContent.includes("Research"), "sidebar folder");
    get("my-notes-link").click();
    await wait(() => !get("folder-view").hidden && get("folder-notes").querySelectorAll(".note-row").length === 8, "My notes lists every note");
    // Create a folder from the dialog; it opens.
    get("sidebar-new-folder").click();
    const form = get("folder-form"); form.elements.title.value = "Partners"; form.elements.title.dispatchEvent(new Event("input"));
    get("folder-form-save").click();
    await wait(() => get("folder-title").textContent === "Partners", "new folder opens");
    if (!get("folder-empty").textContent.includes("Drag notes here")) throw Error("empty folder hint");
    // Add a note through its picker; the picker closes after one pick.
    await openSavedMeeting(${JSON.stringify(note.path)}, undefined, "journal");
    await wait(() => get("saved-folders").textContent.includes("Research") && get("saved-folders").querySelector(".add"), "note folder button");
    get("saved-folders").querySelector(".add").click();
    await wait(() => !get("folder-picker").hidden, "picker");
    const search = get("folder-picker-search"); search.value = "part"; search.dispatchEvent(new Event("input"));
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await wait(() => get("saved-folders").textContent.includes("Partners") && get("folder-picker").hidden, "added through picker");
    if (!get("saved-folders").textContent.includes("+1")) throw Error("first folder plus count: " + get("saved-folders").textContent);
    get("saved-folders").querySelector(".folder-chip").click();
    await wait(() => get("folder-title").textContent && get("folder-notes").textContent.includes("Retro"), "chip opens folder");
    // Label page from the sidebar.
    [...get("sidebar-labels").querySelectorAll("button")].find(b => b.textContent.includes("Atlas")).click();
    await wait(() => get("folder-notes").textContent.includes("Kickoff") && !get("folder-notes").textContent.includes("Retro"), "label page");
    // Label views: removing one takes it out of the sidebar; the + menu pins it again and opens it.
    const atlas = () => [...get("sidebar-labels").querySelectorAll("li")].find(li => li.textContent.includes("Atlas"));
    atlas().querySelector(".row-action").click();
    await wait(() => !get("folder-menu").hidden && get("folder-menu").textContent.includes("Remove view"), "view options");
    get("folder-menu").querySelector("button").click();
    await wait(() => !atlas() && get("folder-title").textContent === "My notes", "view removed");
    get("sidebar-new-label-view").click();
    await wait(() => !get("folder-menu").hidden && get("folder-menu").textContent.includes("Create view for label"), "create view menu");
    [...get("folder-menu").querySelectorAll("button")].find(b => b.textContent.includes("Atlas")).click();
    await wait(() => atlas() && get("folder-title").textContent === "Atlas", "view pinned and opened");
    // A note from a series offers the folder and the label its earlier notes use.
    const bar = kind => get("note-suggestions").querySelector('[data-kind="' + kind + '"]');
    await openSavedMeeting(${JSON.stringify(paths.s3)}, undefined, "journal");
    await wait(() => bar("folder")?.textContent.includes("Standups") && bar("label")?.textContent.includes("Standup"), "series suggestions");
    if (!bar("folder").querySelector(".suggestion-add").textContent.includes("Ctrl")) throw Error("shortcut hint");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await wait(() => !bar("folder") && get("saved-folders").textContent.includes("Standups"), "suggested folder added with Ctrl+Enter");
    await wait(() => get("folder-toast").textContent.includes("series"), "series toast");
    bar("label").querySelector(".suggestion-add").click();
    await wait(() => !bar("label") && get("saved-labels").textContent.includes("Standup"), "suggested label added");
    // Dismissing is remembered for the note.
    await openSavedMeeting(${JSON.stringify(paths.s2)}, undefined, "journal");
    await wait(() => bar("folder") && bar("label"), "second note suggestions");
    bar("label").querySelector(".icon-button").click();
    await wait(() => !bar("label") && bar("folder"), "label suggestion dismissed");
    // A series with no folder offers to make one, named after the meeting without "Weekly".
    await openSavedMeeting(${JSON.stringify(paths.p2)}, undefined, "journal");
    await wait(() => bar("series")?.textContent.includes("Create folder for this meeting"), "create folder suggestion");
    bar("series").querySelector(".suggestion-add").click();
    await wait(() => get("folder-dialog").open && get("folder-form").elements.title.value === "Planning", "series folder name");
    get("folder-form-save").click();
    await wait(() => !get("folder-dialog").open && get("saved-folders").textContent.includes("Planning") && !bar("series"), "series folder made");
    // The toast appears once the folder has started following the series.
    await wait(() => get("folder-toast").textContent.includes("Created Planning"), "series folder follows");
  })()`);
  state = await readDaily(vault);
  assert.ok(state.folders.find(f => f.title === "Partners").notes.includes(note.id));
  const after = title => state.folders.find(f => f.title === title);
  assert.ok(after("Standups").notes.includes(s3) && after("Standups").series.some(r => r.event === "series-standup"), "accepting follows the series");
  assert.ok(state.meetings.find(m => m.id === s3).tags.includes("topic: Standup"));
  assert.deepEqual([...after("Planning").notes].sort(), [p1, p2].sort());
  assert.equal(after("Planning").series[0].event, "series-planning");
  console.log("Folders passed nesting limits, multiple folders per note, favourites, deletion, the picker, folder and label pages, " +
    "series auto-add, folder and label suggestions and label views.");
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
