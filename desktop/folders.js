// Folders and labels: the sidebar tree, folder and label pages, the "Add to folder" picker,
// the icon picker, drag and drop and list keyboard moves.
(() => {
  const get = id => document.getElementById(id);
  const journal = () => window.stillwaterJournal;
  const data = () => journal()?.data ?? { meetings: [], labels: [], folders: [] };
  const key = text => text.trim().normalize("NFC").toLowerCase();
  const SVG = "http://www.w3.org/2000/svg";
  const expandedKey = "stillwater-folder-expanded", tipKey = "stillwater-dismissed-folder-tips";
  const pendingKey = "stillwater-draft-folders", sidebarKey = "stillwater-sidebar-closed";
  let page = { kind: "all" }, tab = "notes", filter = "", selecting = false;
  const selected = new Set();
  let cursor = -1, lastG = 0, dragging = null, showAllFolders = false;

  // ---------- small helpers ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  // Closed shapes get a soft tint inside, so they read as solid at small sizes.
  const filled = new Set(["star", "heart", "bookmark", "bolt", "document", "folder", "tag", "chat", "shield", "cloud", "fire",
    "cube", "bell", "trophy", "lock", "puzzle", "briefcase", "archive", "mail"]);
  function glyph(name, className = "glyph") {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", window.folderGlyphs[name] ?? window.folderGlyphs.folder);
    if (filled.has(name)) svg.dataset.fill = "";
    svg.append(path);
    return svg;
  }
  /** A folder's icon: a coloured line glyph or an emoji; no icon means a gray folder. */
  function folderIcon(icon, size = "") {
    const span = el("span", "folder-icon " + size);
    if (icon?.type === "emoji") { span.classList.add("emoji"); span.textContent = icon.value; return span; }
    const color = icon?.type === "icon" ? icon.color : "gray";
    span.style.setProperty("--icon", window.folderColors[color] ?? window.folderColors.gray);
    span.append(glyph(icon?.type === "icon" ? icon.value : "folder"));
    return span;
  }
  function button(text, onClick, className = "") {
    const b = el("button", className, text);
    b.type = "button";
    b.addEventListener("click", async event => {
      try { await onClick(event); } catch (error) { status.textContent = error.message; }
    });
    return b;
  }
  async function change(command) {
    const ok = await journal().change(command);
    return ok ? journal().data : null;
  }
  const folders = () => data().folders ?? [];
  const folderById = id => folders().find(f => f.id === id);
  const meetingIds = () => new Set(data().meetings.map(m => m.id));
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const compare = (a, b) => collator.compare(a.title, b.title);
  const children = id => folders().filter(f => f.parent === id).sort(compare);
  function descendants(id) {
    const out = [];
    for (const child of children(id)) out.push(child.id, ...descendants(child.id));
    return out;
  }
  function trail(folder) {
    const path = [];
    for (let f = folder; f; f = folderById(f.parent)) path.unshift(f);
    return path;
  }
  const liveNotes = folder => folder.notes.filter(id => meetingIds().has(id));
  /** Notes in this folder or any folder inside it (the count a folder shows). */
  function notesWithin(folder) {
    const ids = new Set(liveNotes(folder));
    for (const id of descendants(folder.id)) for (const note of liveNotes(folderById(id))) ids.add(note);
    return ids;
  }
  const foldersOf = meetingId => folders().filter(f => f.notes.includes(meetingId)).sort(compare);
  const noteDate = m => m.event?.start ?? m.date;
  // Folder visits, newest first, for the picker's "recently used" order.
  const visitsKey = "stillwater-folder-visits";
  const visits = () => { try { return JSON.parse(localStorage.getItem(visitsKey) ?? "{}"); } catch { return {}; } };
  // The last 10 visits are kept; a second visit within 5 seconds is not counted again.
  function recordVisit(id) {
    const all = visits(), mine = all[id] ?? [], now = Date.now();
    if (mine.length && now - mine[0] < 5000) return;
    all[id] = [now, ...mine].slice(0, 10);
    localStorage.setItem(visitsKey, JSON.stringify(all));
  }
  // Points per visit by age: under 4 hours 100, a day 80, 3 days 60, a week 40, 30 days 20,
  // 90 days 10, older nothing.
  function frecency(id) {
    const hour = 3600000, day = 24 * hour, now = Date.now();
    return (visits()[id] ?? []).reduce((sum, t) => {
      const age = now - t;
      return sum + (age < 4 * hour ? 100 : age < day ? 80 : age < 3 * day ? 60 : age < 7 * day ? 40 :
        age < 30 * day ? 20 : age < 90 * day ? 10 : 0);
    }, 0);
  }
  /** Picker order: recently used, then favourites, then fuller folders, then A-Z. */
  const pickerOrder = (a, b) => frecency(b.id) - frecency(a.id) || Number(b.favorite) - Number(a.favorite) ||
    notesWithin(b).size - notesWithin(a).size || compare(a, b);
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

  // ---------- sidebar ----------
  const expanded = new Set(JSON.parse(localStorage.getItem(expandedKey) ?? "[]"));
  const saveExpanded = () => localStorage.setItem(expandedKey, JSON.stringify([...expanded]));
  function folderRow(folder, level, root) {
    const li = el("li", "folder-node");
    li.setAttribute("role", "treeitem");
    li.dataset.folder = folder.id;
    const kids = children(folder.id);
    const open = expanded.has(folder.id);
    if (kids.length) li.setAttribute("aria-expanded", String(open));
    const row = el("div", "folder-row");
    row.style.setProperty("--level", level);
    if (page.kind === "folder" && page.id === folder.id && workspaceView === "folder") row.classList.add("current");
    const toggle = button("", () => {
      if (expanded.has(folder.id)) expanded.delete(folder.id); else expanded.add(folder.id);
      saveExpanded(); renderSidebar();
    }, "folder-chevron");
    toggle.title = open ? "Collapse folder" : "Expand folder";
    toggle.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + folder.title);
    toggle.append(el("span", "chevron"));
    toggle.hidden = !kids.length;
    const link = button("", () => openFolder(folder.id), "folder-link");
    link.append(folderIcon(folder.icon), el("span", "folder-name", folder.title));
    link.draggable = true;
    link.addEventListener("dragstart", event => {
      dragging = { kind: "folder", id: folder.id };
      event.dataTransfer.setData("text/plain", folder.title);
      event.dataTransfer.effectAllowed = "move";
    });
    link.addEventListener("dragend", () => { dragging = null; clearDrops(); });
    link.addEventListener("keydown", event => treeKeys(event, folder, kids));
    const count = el("span", "folder-count", String(notesWithin(folder).size || ""));
    const add = button("", () => openFolderDialog({ parent: folder.id }), "icon-button small row-action");
    add.title = "Create subfolder";
    add.append(plusGlyph(), el("span", "visually-hidden", "Create subfolder in " + folder.title));
    const more = button("", event => openFolderMenu(folder, event.currentTarget), "icon-button small row-action");
    more.title = "Folder options"; more.setAttribute("aria-haspopup", "menu");
    more.append(dotsGlyph(), el("span", "visually-hidden", "Options for " + folder.title));
    add.hidden = level > 0;
    row.append(toggle, link, count, add, more);
    dropTarget(row, folder.id);
    li.append(row);
    if (kids.length && open) {
      const group = el("ul", "folder-list");
      group.setAttribute("role", "group");
      for (const child of kids) group.append(folderRow(child, level + 1, root));
      li.append(group);
    }
    return li;
  }
  function plusGlyph() {
    const svg = glyph("folder"); svg.firstChild.setAttribute("d", "M12 5v14M5 12h14"); return svg;
  }
  function dotsGlyph() {
    const svg = glyph("folder"); svg.firstChild.setAttribute("d", "M6 12h.1M12 12h.1M18 12h.1"); svg.classList.add("dots"); return svg;
  }
  function treeKeys(event, folder, kids) {
    if (event.key === "ArrowRight" && kids.length && !expanded.has(folder.id)) {
      expanded.add(folder.id); saveExpanded(); renderSidebar(); focusFolder(folder.id); event.preventDefault();
    } else if (event.key === "ArrowLeft") {
      if (expanded.has(folder.id)) { expanded.delete(folder.id); saveExpanded(); renderSidebar(); focusFolder(folder.id); }
      else if (folder.parent) focusFolder(folder.parent);
      event.preventDefault();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const links = [...get("sidebar").querySelectorAll(".folder-link")];
      links[links.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      event.preventDefault();
    }
  }
  const focusFolder = id => get("folder-tree").querySelector(`[data-folder="${id}"] .folder-link`)?.focus();
  function renderSidebar() {
    const tree = get("folder-tree");
    const roots = children(null);
    const showTree = get("my-notes-expand").getAttribute("aria-expanded") === "true";
    // With 10 or more top-level folders, show the 5 most useful (A-Z) and a "Show all" toggle.
    let shown = roots;
    if (roots.length >= 10 && !showAllFolders) {
      const current = page.kind === "folder" ? trail(folderById(page.id) ?? { parent: null })[0]?.id : null;
      const picks = roots.filter(f => !f.favorite).sort((a, b) => frecency(b.id) - frecency(a.id) ||
        b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map(f => f.id);
      shown = roots.filter(f => picks.includes(f.id) || f.id === current);
    }
    tree.replaceChildren(...(showTree ? shown.map(f => folderRow(f, 0)) : []));
    if (showTree && roots.length >= 10) {
      const li = el("li", "show-all");
      const toggle = button(showAllFolders ? "Show fewer" : "Show all", () => { showAllFolders = !showAllFolders; renderSidebar(); }, "link");
      li.append(toggle, el("small", "", showAllFolders ? "" : "A–Z · " + roots.length)); tree.append(li);
    }
    get("folder-tree-empty").hidden = roots.length > 0 || !showTree;
    // Favourites: a favourite folder shows at the top level unless its parent is a favourite too,
    // in which case it sits under that parent.
    const favorite = (f, level) => {
      const li = el("li"), link = button("", () => openFolder(f.id), "folder-link");
      link.append(folderIcon(f.icon), el("span", "folder-name", f.title));
      const row = el("div", "folder-row"); row.style.setProperty("--level", level); row.append(link);
      if (page.kind === "folder" && page.id === f.id && workspaceView === "folder") row.classList.add("current");
      dropTarget(row, f.id); li.append(row);
      const kids = children(f.id).filter(c => c.favorite);
      if (kids.length) { const group = el("ul", "folder-list"); group.append(...kids.map(c => favorite(c, level + 1))); li.append(group); }
      return li;
    };
    const favorites = folders().filter(f => f.favorite && !folderById(f.parent)?.favorite).sort(compare);
    get("favorite-section").hidden = !favorites.length && dragging?.kind !== "folder";
    get("favorite-folders").replaceChildren(...favorites.map(f => favorite(f, 0)));
    get("my-notes-link").classList.toggle("current", page.kind === "all" && workspaceView === "folder");
    // Labels: only the ones pinned as views show here; the Labels tab on My notes lists them all.
    const list = get("sidebar-labels");
    list.replaceChildren();
    const counts = new Map();
    for (const m of data().meetings) for (const t of m.tags) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
    const views = labelViews();
    for (const name of views) {
      const [kind, ...rest] = name.split(":");
      const li = el("li", "label-view"), link = button("", () => openLabel(name), "label-link");
      link.append(el("span", "label-dot " + kind), el("span", "folder-name", rest.join(":").trim()),
        el("span", "label-kind", kind));
      if (page.kind === "label" && key(page.name) === key(name) && workspaceView === "folder") li.classList.add("current");
      link.title = name + " · " + plural(counts.get(key(name)) ?? 0, "note");
      const more = button("", event => labelViewMenu(name, event.currentTarget), "icon-button small row-action");
      more.title = "View options"; more.setAttribute("aria-haspopup", "menu");
      more.append(dotsGlyph(), el("span", "visually-hidden", "View options for " + name));
      li.append(link, more); list.append(li);
    }
    const hint = get("sidebar-labels-empty");
    hint.hidden = views.length > 0;
    hint.textContent = data().labels.length ? "Pin a label here with +." : "Labels you add to notes can be pinned here.";
  }

  // ---------- label views ----------
  // A label shows in the sidebar once it is pinned as a view. The first time, every label that
  // already exists is pinned so nothing disappears; labels made later are pinned by hand.
  const viewsKey = "stillwater-label-views";
  let journalLoaded = false;
  function labelViews() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(viewsKey) ?? "null"); } catch { saved = null; }
    if (!Array.isArray(saved)) {
      if (!journalLoaded) return [];
      saved = data().labels.map(key);
      localStorage.setItem(viewsKey, JSON.stringify(saved));
    }
    return data().labels.filter(name => saved.includes(key(name)));
  }
  function setLabelView(name, on) {
    const saved = new Set(labelViews().map(key));
    if (on) saved.add(key(name)); else saved.delete(key(name));
    localStorage.setItem(viewsKey, JSON.stringify([...saved]));
    renderSidebar();
  }
  function menuItem(menu, text, run, className = "") {
    const b = button(text, async () => { closePopovers(); await run(); }, className);
    b.setAttribute("role", "menuitem"); menu.append(b);
    return b;
  }
  function labelViewMenu(name, anchor) {
    const menu = get("folder-menu"); menu.replaceChildren();
    menuItem(menu, "Remove view", () => {
      setLabelView(name, false);
      if (page.kind === "label" && key(page.name) === key(name) && workspaceView === "folder") { page = { kind: "all" }; showPage(); }
    }, "danger");
    place(menu, anchor);
    menu.querySelector("button").focus();
  }
  function newLabelViewMenu(anchor) {
    const menu = get("folder-menu"); menu.replaceChildren();
    const pinned = new Set(labelViews().map(key));
    const rest = data().labels.filter(name => !pinned.has(key(name)));
    menu.append(el("p", "menu-title", "Create view for label"));
    for (const name of rest) {
      const [kind, ...tail] = name.split(":");
      const b = menuItem(menu, "", () => { setLabelView(name, true); openLabel(name); });
      b.append(el("span", "label-dot " + kind), el("span", "folder-name", tail.join(":").trim()), el("span", "label-kind", kind));
    }
    if (!rest.length) {
      const none = menuItem(menu, data().labels.length ? "All labels have views" : "Create labels from a note first", () => {});
      none.disabled = true;
    }
    place(menu, anchor);
    (menu.querySelector("button:not(:disabled)") ?? anchor).focus();
  }

  // ---------- toast with undo ----------
  let toastTimer = 0;
  function toast(message, undo) {
    const box = get("folder-toast");
    box.replaceChildren(el("span", "", message));
    if (undo) box.append(button("Undo", async () => { box.hidden = true; await undo(); }, "link"));
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }
  async function addNotes(folder, ids) {
    const fresh = ids.filter(id => !folder.notes.includes(id));
    if (!fresh.length) { toast("No new notes to add to " + folder.title + "."); return false; }
    if (!await change({ type: "folder-add", id: folder.id, ids: fresh })) return false;
    toast((fresh.length === 1 ? "Added note to " : "Added " + fresh.length + " notes to ") + folder.title,
      () => change({ type: "folder-remove", id: folder.id, ids: fresh }));
    return true;
  }
  async function removeNotes(folder, ids) {
    if (!await change({ type: "folder-remove", id: folder.id, ids })) return false;
    toast((ids.length === 1 ? "Removed note from " : "Removed " + ids.length + " notes from ") + folder.title,
      () => change({ type: "folder-add", id: folder.id, ids }));
    return true;
  }

  // ---------- drag and drop ----------
  function clearDrops() { for (const node of document.querySelectorAll(".drop-over")) node.classList.remove("drop-over"); }
  function canDrop(target) {
    if (!dragging) return false;
    if (dragging.kind === "notes") return target !== null;
    if (dragging.kind === "folder") {
      // One level of nesting: only into a top-level folder, and never a folder that has subfolders.
      if (target === dragging.id || folderById(dragging.id)?.parent === target) return false;
      if (target === null) return true;
      return !folderById(target)?.parent && !children(dragging.id).length;
    }
    if (dragging.kind === "favorite") return false;
    return false;
  }
  function dropTarget(node, target) {
    node.addEventListener("dragover", event => {
      if (!canDrop(target)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = dragging.kind === "notes" ? "copy" : "move";
      node.classList.add("drop-over");
    });
    node.addEventListener("dragleave", () => node.classList.remove("drop-over"));
    node.addEventListener("drop", async event => {
      event.preventDefault(); clearDrops();
      const drag = dragging; dragging = null;
      if (!drag) return;
      try {
        if (drag.kind === "notes") {
          const folder = folderById(target);
          await addNotes(folder, drag.ids);
          if (drag.ids.length > 1) { endSelect(); if (workspaceView === "folder") renderPage(); }
        } else if (drag.kind === "folder") {
          const moved = folderById(drag.id);
          if (await change({ type: "folder-move", id: drag.id, parent: target })) {
            if (target) { expanded.add(target); saveExpanded(); }
            status.textContent = "Moved " + moved.title + (target ? " into " + folderById(target).title : " to My notes") + ".";
          }
        }
      } catch (error) { status.textContent = error.message; }
    });
  }
  dropTarget(get("my-notes-row"), null);
  // Dropping a folder on Favorites favourites it (and its subfolders).
  const favoriteDrop = get("favorite-section");
  favoriteDrop.addEventListener("dragover", event => {
    if (dragging?.kind !== "folder" || event.defaultPrevented) return;
    event.preventDefault(); favoriteDrop.classList.add("drop-over");
  });
  favoriteDrop.addEventListener("dragleave", () => favoriteDrop.classList.remove("drop-over"));
  favoriteDrop.addEventListener("drop", async event => {
    if (dragging?.kind !== "folder" || event.defaultPrevented) return;
    event.preventDefault(); clearDrops();
    const id = dragging.id; dragging = null;
    if (await change({ type: "folder-update", id, favorite: true })) toast("Added " + folderById(id).title + " to favorites");
  });
  document.addEventListener("dragstart", () => requestAnimationFrame(() => {
    if (dragging?.kind === "folder") get("favorite-section").hidden = false;
  }));
  document.addEventListener("dragend", () => setTimeout(renderSidebar));

  // ---------- pages ----------
  function openFolder(id) {
    page = { kind: "folder", id }; recordVisit(id);
    // Opening a subfolder shows it in place: its parent expands.
    const parent = folderById(id)?.parent;
    if (parent && !expanded.has(parent)) { expanded.add(parent); saveExpanded(); }
    showPage();
  }
  function openLabel(name) { page = { kind: "label", name }; showPage(); }
  window.openLabelPage = openLabel;
  function showPage() {
    tab = "notes"; filter = ""; get("folder-filter").value = ""; endSelect();
    cursor = -1;
    if (workspaceView === "folder") renderPage(); else showWorkspace("folder");
    get("folder-title").focus({ preventScroll: true });
  }
  function pageNotes() {
    const all = data().meetings.filter(m => !m.archived);
    if (page.kind === "folder") {
      const folder = folderById(page.id);
      const ids = folder ? notesWithin(folder) : new Set();
      return all.filter(m => ids.has(m.id));
    }
    if (page.kind === "label") return all.filter(m => m.tags.some(t => key(t) === key(page.name)));
    return all;
  }
  function renderPage() {
    if (page.kind === "folder" && !folderById(page.id)) page = { kind: "all" };
    const hero = get("folder-icon"), actions = get("folder-actions");
    hero.replaceChildren(); actions.replaceChildren();
    const notes = pageNotes();
    const tip = get("folder-tip");
    const dismissed = new Set(JSON.parse(localStorage.getItem(tipKey) ?? "[]"));
    let tipId = "";
    if (page.kind === "all") {
      hero.append(glyph("lock", "glyph hero-glyph")); hero.style.removeProperty("--icon"); hero.className = "folder-hero-icon locked";
      get("folder-title").textContent = "My notes";
      get("folder-description").textContent = "Every note in this vault, newest first.";
      // "N folders" opens a list of every folder.
      const list = button("", event => folderListMenu(event.currentTarget), "meta-menu");
      list.setAttribute("aria-haspopup", "menu");
      list.append(glyph("folder", "glyph tiny"), el("span", "", plural(folders().length, "folder")));
      const meta = get("folder-meta"); meta.replaceChildren(glyph("lock", "glyph tiny"), el("span", "", "Stored on this computer"),
        el("span", "dot", "·"), list);
      actions.append(button("New folder", () => openFolderDialog({}), "quiet"));
      tipId = "my-notes";
      get("folder-tip-title").textContent = "Your private notes";
      get("folder-tip-text").textContent = "Folders and labels only organize what's here. A note can live in several folders, and nothing leaves this computer.";
    } else if (page.kind === "folder") {
      const folder = folderById(page.id);
      hero.className = "folder-hero-icon"; hero.append(folderIcon(folder.icon, "large"));
      hero.onclick = event => openIconPicker(event.currentTarget, folder.icon, icon => change({ type: "folder-update", id: folder.id, icon }));
      hero.title = "Change icon";
      get("folder-title").textContent = folder.title;
      get("folder-description").textContent = folder.description || "";
      const crumbs = trail(folder).slice(0, -1);
      const meta = get("folder-meta"); meta.replaceChildren();
      meta.append(button("My notes", () => { page = { kind: "all" }; showPage(); }, "crumb"));
      for (const c of crumbs) meta.append(el("span", "dot", "/"), button(c.title, () => openFolder(c.id), "crumb"));
      meta.append(el("span", "dot", "·"), el("span", "", plural(notes.length, "note")));
      const subs = children(folder.id).length;
      if (subs) meta.append(el("span", "dot", "·"), el("span", "", plural(subs, "folder")));
      for (const rule of folder.series ?? []) {
        const auto = el("span", "auto-add", "Auto-adds " + seriesTitle(rule.event));
        auto.title = "New notes from this meeting series are added to this folder. Stop it from the folder options.";
        meta.append(el("span", "dot", "·"), auto);
      }
      const star = button("", () => change({ type: "folder-update", id: folder.id, favorite: !folder.favorite }), "icon-button star");
      star.title = folder.favorite ? "Remove from favorites" : "Add to favorites";
      star.setAttribute("aria-pressed", String(folder.favorite));
      star.append(glyph("star"), el("span", "visually-hidden", star.title));
      const more = button("", event => openFolderMenu(folder, event.currentTarget, true), "icon-button");
      more.title = "Folder options"; more.append(dotsGlyph(), el("span", "visually-hidden", "Folder options"));
      actions.append(button("New note", () => newNoteIn([folder.id]), "primary"), star, more);
      if (!notes.length) { tipId = ""; }
    } else {
      const [kind, ...rest] = page.name.split(":");
      hero.className = "folder-hero-icon label " + kind; hero.append(glyph("tag", "glyph hero-glyph"));
      get("folder-title").textContent = rest.join(":").trim();
      get("folder-description").textContent = "";
      const meta = get("folder-meta"); meta.replaceChildren(el("span", "label-kind", kind + " label"),
        el("span", "dot", "·"), el("span", "", plural(notes.length, "note")));
      actions.append(button("Add to notes…", () => journal().bulk(), "quiet"),
        button("Rename", () => journal().manage(), "quiet"));
    }
    if (page.kind !== "folder") hero.onclick = null, hero.removeAttribute("title");
    tip.hidden = !tipId || dismissed.has(tipId);
    tip.dataset.tip = tipId;
    // Subfolders row (folder pages) or top folders (My notes).
    const subs = get("folder-subfolders"); subs.replaceChildren();
    if (page.kind === "folder" && !folderById(page.id).parent) {
      const list = children(page.id);
      for (const f of list) {
        const chip = button("", () => openFolder(f.id), "subfolder-chip");
        chip.append(folderIcon(f.icon), el("span", "", f.title), el("small", "", String(notesWithin(f).size)));
        dropTarget(chip, f.id);
        subs.append(chip);
      }
      const add = button("", () => openFolderDialog({ parent: page.kind === "folder" ? page.id : null }), "subfolder-chip add");
      add.append(plusGlyph(), el("span", "", "Add subfolder"));
      subs.append(add);
    }
    // People appears once these notes involve 3 or more people; Labels once any note carries one.
    const people = new Set(notes.flatMap(m => m.people)).size, labelled = notes.some(m => m.tags.length);
    get("folder-tab-people").hidden = people < 3;
    get("folder-tab-labels").hidden = !labelled || page.kind === "label";
    if (tab === "people" && people < 3 || tab === "labels" && get("folder-tab-labels").hidden) tab = "notes";
    for (const t of document.querySelectorAll(".folder-tabs [role=tab]")) t.setAttribute("aria-selected", String(t.id === "folder-tab-" + tab));
    get("folder-bulk-remove").hidden = page.kind !== "folder";
    renderList(notes);
    renderSidebar();
  }
  function matches(m) {
    if (!filter) return true;
    const q = key(filter);
    return key(m.title).includes(q) || m.people.some(p => key(p).includes(q)) || m.tags.some(t => key(t).includes(q));
  }
  function renderList(notes) {
    const list = get("folder-notes"); list.replaceChildren();
    const shown = notes.filter(matches).sort((a, b) => noteDate(b).localeCompare(noteDate(a)));
    const empty = get("folder-empty");
    if (tab === "people" || tab === "labels") {
      const counts = new Map();
      for (const m of shown) for (const v of (tab === "people" ? m.people : m.tags)) counts.set(v, (counts.get(v) ?? 0) + 1);
      for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        const li = el("li", "facet-row");
        const open = button("", () => {
          if (tab === "labels") openLabel(name);
          else { tab = "notes"; filter = name; get("folder-filter").value = name; renderPage(); }
        }, "facet");
        open.append(glyph(tab === "people" ? "user" : "tag"), el("span", "", name), el("small", "", plural(n, "note")));
        li.append(open); list.append(li);
      }
      empty.hidden = counts.size > 0;
      get("folder-empty-text").textContent = tab === "people" ? "No people in these notes yet." : "No labels on these notes yet.";
      get("folder-empty-new").hidden = true;
      return;
    }
    let day;
    for (const m of shown) {
      const date = new Date(noteDate(m));
      const heading = dayHeading(date);
      if (heading !== day) { list.append(el("li", "note-day", heading)); day = heading; }
      const li = el("li", "note-row");
      li.dataset.meeting = m.id;
      if (selected.has(m.id)) li.classList.add("selected");
      const check = el("input"); check.type = "checkbox"; check.checked = selected.has(m.id);
      check.setAttribute("aria-label", "Select " + m.title); check.hidden = !selecting;
      check.addEventListener("change", () => toggleSelect(m.id, check.checked));
      const open = button("", event => {
        if (selecting || event.ctrlKey || event.metaKey) { toggleSelect(m.id, !selected.has(m.id)); return; }
        openSavedMeeting(m.path, "", "journal");
      }, "note-open");
      open.draggable = true;
      open.addEventListener("dragstart", event => {
        const ids = selected.has(m.id) ? [...selected] : [m.id];
        dragging = { kind: "notes", ids };
        event.dataTransfer.setData("text/plain", m.title);
        event.dataTransfer.effectAllowed = "copy";
        const ghost = el("div", "drag-ghost");
        const titles = ids.map(id => data().meetings.find(x => x.id === id)?.title).filter(Boolean);
        for (const t of titles.slice(0, 3)) ghost.append(el("span", "", t));
        if (titles.length > 3) ghost.append(el("small", "", "and " + (titles.length - 3) + " more…"));
        document.body.append(ghost); event.dataTransfer.setDragImage(ghost, 12, 12);
        setTimeout(() => ghost.remove());
      });
      open.addEventListener("dragend", () => { dragging = null; clearDrops(); });
      const tile = el("span", "note-tile"); tile.append(glyph("document"));
      const text = el("span", "note-text");
      text.append(el("span", "note-title", m.title));
      const line = el("span", "note-line");
      line.append(el("span", "note-sub", m.people.join(", ") || "Me"));
      text.append(line);
      const places = foldersOf(m.id).filter(f => !(page.kind === "folder" && f.id === page.id));
      if (places.length) {
        const chips = el("span", "note-folders");
        for (const f of places.slice(0, 2)) { const c = el("span", "mini-chip"); c.append(folderIcon(f.icon), el("span", "", f.title)); chips.append(c); }
        if (places.length > 2) chips.append(el("span", "mini-chip more", "+" + (places.length - 2)));
        line.append(chips);
      }
      const time = el("time", "", date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
      time.dateTime = noteDate(m);
      open.append(tile, text, time);
      open.addEventListener("contextmenu", event => { event.preventDefault(); noteMenu(m, open); });
      open.addEventListener("keydown", event => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); noteMenu(m, open); }
      });
      li.append(check, open);
      list.append(li);
    }
    empty.hidden = shown.length > 0;
    get("folder-empty-new").hidden = page.kind !== "folder";
    get("folder-empty-text").textContent = filter ? "No notes match this filter."
      : page.kind === "folder" ? "Drag notes here to add them" : page.kind === "label" ? "No notes carry this label yet." : "Your vault has no notes yet.";
  }
  function dayHeading(date) {
    const start = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((start(new Date()) - start(date)) / 86400000);
    if (days < 0) return "Upcoming";
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric",
      ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  }
  // Right-click a note: open it, add it to a folder, take it out of one, or label it.
  function noteMenu(m, anchor) {
    const menu = get("folder-menu"); menu.replaceChildren();
    const ids = selected.has(m.id) ? [...selected] : [m.id];
    const item = (text, run, danger) => {
      const b = button(text, async () => { closePopovers(); await run(); }, danger ? "danger" : "");
      b.setAttribute("role", "menuitem"); menu.append(b);
    };
    if (ids.length === 1) item("Open note", () => openSavedMeeting(m.path, "", "journal"));
    item(ids.length > 1 ? "Add " + ids.length + " notes to folder…" : "Add to folder…", () => openPicker(anchor, { ids }));
    if (ids.length === 1) item("Labels…", () => openPicker(anchor, { labels: true, ids }));
    const here = page.kind === "folder" ? folderById(page.id) : null;
    const places = foldersOf(m.id).sort((a, b) => (b === here) - (a === here));
    for (const f of ids.length === 1 ? places : here ? [here] : []) item("Remove from " + f.title, () => removeNotes(f, ids), true);
    place(menu, anchor);
    menu.querySelector("button")?.focus();
  }
  function toggleSelect(id, on) {
    if (id !== null) { if (on) selected.add(id); else selected.delete(id); }
    if (selected.size && !selecting) startSelect();
    get("folder-bulk-count").textContent = selected.size + " selected";
    for (const b of get("folder-bulk").querySelectorAll("button:not(#folder-bulk-done)")) b.disabled = !selected.size;
    renderList(pageNotes());
  }
  function startSelect() { selecting = true; get("folder-bulk").hidden = false; get("folder-select").hidden = true; toggleSelect(null, false); }
  function endSelect() { selecting = false; selected.clear(); get("folder-bulk").hidden = true; get("folder-select").hidden = false; }
  get("folder-select").onclick = () => { startSelect(); };
  get("folder-bulk-all").onclick = () => {
    for (const row of get("folder-notes").querySelectorAll(".note-row")) selected.add(row.dataset.meeting);
    toggleSelect(null, false);
  };
  get("folder-bulk-done").onclick = () => { endSelect(); renderList(pageNotes()); };
  get("folder-bulk-move").onclick = event => openPicker(event.currentTarget, { ids: [...selected] });
  get("folder-bulk-label").onclick = () => journal().bulk();
  get("folder-bulk-remove").onclick = async () => {
    const folder = folderById(page.id), n = selected.size;
    if (await removeNotes(folder, [...selected])) { endSelect(); renderPage(); }
  };
  get("folder-filter").addEventListener("input", event => { filter = event.target.value; renderList(pageNotes()); });
  for (const t of document.querySelectorAll(".folder-tabs [role=tab]")) {
    t.addEventListener("click", () => { tab = t.id.slice(11); renderPage(); });
  }
  get("folder-tip-close").onclick = () => {
    const dismissed = new Set(JSON.parse(localStorage.getItem(tipKey) ?? "[]"));
    dismissed.add(get("folder-tip").dataset.tip); localStorage.setItem(tipKey, JSON.stringify([...dismissed]));
    get("folder-tip").hidden = true;
  };
  get("folder-empty-new").onclick = () => newNoteIn([page.id]);
  // The whole folder page accepts dropped notes.
  get("folder-view").addEventListener("dragover", event => {
    if (page.kind === "folder" && dragging?.kind === "notes" && !event.defaultPrevented) {
      event.preventDefault(); get("folder-empty").classList.add("drop-over");
    }
  });
  get("folder-view").addEventListener("drop", async event => {
    if (page.kind !== "folder" || dragging?.kind !== "notes" || event.defaultPrevented) return;
    event.preventDefault(); clearDrops();
    const ids = dragging.ids; dragging = null;
    await addNotes(folderById(page.id), ids);
  });
  // List keys: j/k (Shift extends), x selects, g g top, Shift+G bottom, Enter opens.
  document.addEventListener("keydown", event => {
    if (workspaceView !== "folder" || document.querySelector("dialog[open]") || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.target.closest("input, textarea, select, [contenteditable]") || !get("folder-picker").hidden || !get("icon-picker").hidden) return;
    const rows = [...get("folder-notes").querySelectorAll(".note-row")];
    if (!rows.length) return;
    const move = to => {
      cursor = Math.max(0, Math.min(rows.length - 1, to));
      rows[cursor].querySelector(".note-open").focus();
    };
    const current = rows.indexOf(document.activeElement?.closest(".note-row"));
    if (current >= 0) cursor = current;
    const k = event.key;
    if (k === "j" || k === "J" || k === "k" || k === "K") {
      const next = cursor + (k.toLowerCase() === "j" ? 1 : -1);
      if (event.shiftKey && cursor >= 0) toggleSelect(rows[cursor].dataset.meeting, true);
      move(cursor < 0 ? 0 : next);
      if (event.shiftKey) { toggleSelect(rows[cursor].dataset.meeting, true); move(cursor); }
    } else if (k === "x" && cursor >= 0) {
      const id = rows[cursor].dataset.meeting; toggleSelect(id, !selected.has(id)); move(cursor);
    } else if (k === "G") move(rows.length - 1);
    else if (k === "g") { if (Date.now() - lastG < 600) move(0); lastG = Date.now(); }
    else if (k === "Escape" && selecting) { endSelect(); renderList(pageNotes()); }
    else return;
    event.preventDefault();
  });

  // ---------- note folders (saved notes and the draft) ----------
  const pending = () => {
    try { return JSON.parse(localStorage.getItem(pendingKey) ?? "null"); } catch { return null; }
  };
  function setPending(ids) {
    if (ids.length) localStorage.setItem(pendingKey, JSON.stringify({ ids, since: new Date(Date.now() - 60000).toISOString() }));
    else localStorage.removeItem(pendingKey);
  }
  function newNoteIn(ids) {
    setPending(ids);
    newNoteButton.click();
    status.textContent = "This note will be added to " + ids.map(id => folderById(id)?.title).filter(Boolean).join(", ") + " when it's saved.";
  }
  function strip(container, chosen, onPick) {
    container.replaceChildren();
    for (const f of chosen.slice(0, 1)) {
      const chip = button("", () => openFolder(f.id), "folder-chip");
      chip.title = "Open " + trail(f).map(x => x.title).join(" / ");
      chip.append(folderIcon(f.icon), el("span", "", f.title));
      container.append(chip);
    }
    if (chosen.length > 1) {
      const more = button("+" + (chosen.length - 1), onPick, "folder-chip more");
      more.title = "Also in " + chosen.slice(1).map(f => f.title).join(", ");
      container.append(more);
    }
    const pick = button("", onPick, "folder-chip add");
    pick.setAttribute("aria-haspopup", "dialog");
    pick.title = chosen.length ? "Add to another folder or remove" : "Add to folder";
    pick.append(chosen.length ? plusGlyph() : glyph("folder"), el("span", chosen.length ? "visually-hidden" : "", chosen.length ? "Change folders" : "Add to folder"));
    container.append(pick);
  }
  function paintNote() {
    if (!window.stillwaterJournal) return;
    const opened = data().meetings.find(m => m.id === openedMeetingId);
    if (opened) strip(get("saved-folders"), foldersOf(opened.id), event => openPicker(event.currentTarget, { ids: [opened.id] }));
    else get("saved-folders").replaceChildren();
    paintSuggestions(opened);
    const draft = (pending()?.ids ?? []).map(folderById).filter(Boolean);
    strip(get("draft-folders"), draft, event => openPicker(event.currentTarget, { draft: true }));
  }
  // ---------- suggestions on a note ----------
  // A saved note can offer one folder and one label. The folder comes from other notes of the same
  // calendar series (5 points) or with the same title (3), plus 1 when the folder is a favourite;
  // the best folder wins and nothing is offered when the note already sits in it. A series with no
  // folder yet offers to create one.
  const dismissedKey = "stillwater-dismissed-suggestions";
  const dismissed = () => { try { return JSON.parse(localStorage.getItem(dismissedKey) ?? "{}"); } catch { return {}; } };
  const isDismissed = (kind, id) => (dismissed()[kind] ?? []).includes(id);
  function dismiss(kind, id) {
    const all = dismissed();
    all[kind] = [id, ...(all[kind] ?? []).filter(x => x !== id)].slice(0, 500);
    localStorage.setItem(dismissedKey, JSON.stringify(all));
    paintNote();
  }
  const seriesNotes = m => m.event?.id ? data().meetings.filter(o => o.event?.id === m.event.id) : [];
  const seriesTitle = event => data().meetings.filter(m => m.event?.id === event)
    .sort((a, b) => noteDate(b).localeCompare(noteDate(a)))[0]?.title ?? "a meeting series";
  function suggestedFolder(m) {
    const notes = new Map(data().meetings.map(o => [o.id, o]));
    let best = null, top = 0, series = false;
    for (const f of folders()) {
      for (const id of f.notes) {
        const other = notes.get(id);
        if (!other || other.id === m.id) continue;
        const same = Boolean(m.event?.id) && other.event?.id === m.event.id;
        let score = same ? 5 : key(other.title) === key(m.title) ? 3 : 0;
        if (!score) continue;
        if (f.favorite) score += 1;
        if (score > top) { top = score; best = f; series = same; }
      }
    }
    return best ? { folder: best, series } : null;
  }
  function suggestedLabel(m) {
    const mine = new Set(m.tags.map(key)), tally = new Map();
    const add = (name, points) => { if (!mine.has(key(name))) tally.set(name, (tally.get(name) ?? 0) + points); };
    for (const other of data().meetings) {
      if (other.id === m.id) continue;
      const points = m.event?.id && other.event?.id === m.event.id ? 5 : key(other.title) === key(m.title) ? 3 : 0;
      if (points) for (const t of other.tags) add(t, points);
    }
    for (const name of data().labels) {
      if (name.startsWith("person: ") && (m.people ?? []).some(p => key(p) === key(name.slice(8)))) add(name, 4);
    }
    return [...tally].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))[0]?.[0] ?? null;
  }
  // "Weekly design review" becomes "Design review"; a short name with "meeting" in it gets "series".
  function seriesFolderName(title) {
    let name = title.replace(/^(Weekly|Daily|Monthly|Bi-weekly)\s+/i, "").trim() || "Meeting series";
    if (name.toLowerCase().includes("meeting") && name.length < 15) name += " series";
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  function crossGlyph() {
    const svg = glyph("folder"); svg.firstChild.setAttribute("d", "m6 6 12 12M18 6 6 18"); delete svg.dataset.fill; return svg;
  }
  function suggestionBar(kind, title, choice, addText, onAdd, onDismiss) {
    const bar = el("div", "suggestion"); bar.dataset.kind = kind;
    const lead = el("span", "suggestion-lead"); lead.append(glyph("sparkles"), el("span", "", title));
    const add = button(addText, onAdd, "primary suggestion-add");
    const close = button("", onDismiss, "icon-button small");
    close.title = "Dismiss suggestion"; close.append(crossGlyph(), el("span", "visually-hidden", "Dismiss " + title.toLowerCase()));
    bar.append(lead, ...(choice ? [choice] : []), add, close);
    return bar;
  }
  function choiceButton(parts, label, onPick) {
    const b = button("", onPick, "folder-chip suggestion-choice");
    b.setAttribute("aria-haspopup", "dialog"); b.title = label;
    b.append(...parts, el("span", "chevron", ""));
    return b;
  }
  let override = { note: null, folder: null, label: null };
  function paintSuggestions(m) {
    const box = get("note-suggestions"); box.replaceChildren();
    if (!m || m.archived) return;
    if (override.note !== m.id) override = { note: m.id, folder: null, label: null };
    const found = suggestedFolder(m), event = m.event?.id;
    if (found && !found.folder.notes.includes(m.id) && !isDismissed("folder", m.id)) {
      const picked = folderById(override.folder);
      const target = picked && !picked.notes.includes(m.id) ? picked : found.folder;
      const choice = choiceButton([folderIcon(target.icon), el("span", "", target.title)], "Choose another folder",
        e => openPicker(e.currentTarget, { ids: [m.id], choose: f => { override.folder = f.id; paintNote(); } }));
      box.append(suggestionBar("folder", "Suggested folder", choice, "Add", async () => {
        // Accepting the folder a series already uses also follows the series from now on.
        const follow = found.series && target === found.folder && !(target.series ?? []).some(r => r.event === event);
        if (!await change({ type: "folder-add", id: target.id, ids: [m.id] })) return;
        if (follow) await change({ type: "folder-follow", id: target.id, event });
        recordVisit(target.id);
        toast(follow ? "Added to " + target.title + ". New notes from this series will be added too." : "Added note to " + target.title, async () => {
          if (follow) await change({ type: "folder-follow", id: target.id, event, on: false });
          await change({ type: "folder-remove", id: target.id, ids: [m.id] });
        });
      }, () => dismiss("folder", m.id)));
    } else if (!found && event && seriesNotes(m).length > 1 && !isDismissed("series", event) &&
      !folders().some(f => (f.series ?? []).some(r => r.event === event))) {
      box.append(suggestionBar("series", "Create folder for this meeting", null, "Create",
        () => openFolderDialog({ title: seriesFolderName(m.title), addIds: seriesNotes(m).map(o => o.id), follow: event }),
        () => dismiss("series", event)));
    }
    const typed = override.label && !m.tags.some(t => key(t) === key(override.label)) ? override.label : null;
    const name = typed ?? suggestedLabel(m);
    if (name && !isDismissed("label", m.id)) {
      const [kind, ...rest] = name.split(":");
      const choice = choiceButton([el("span", "label-dot " + kind), el("span", "", rest.join(":").trim())], "Choose another label",
        e => openPicker(e.currentTarget, { labels: true, ids: [m.id], choose: n => { override.label = n; paintNote(); } }));
      box.append(suggestionBar("label", "Suggested label", choice, "Add", async () => {
        if (!await change({ type: "attach", ids: [m.id], name })) return;
        toast("Added label " + rest.join(":").trim(), () => change({ type: "detach", ids: [m.id], name }));
      }, () => dismiss("label", m.id)));
    }
    // Ctrl+Enter accepts the first suggestion; the hint sits on its button.
    box.querySelector(".suggestion-add")?.append(el("kbd", "", "Ctrl ⏎"));
  }
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    if (workspaceView !== "meeting" || document.querySelector("dialog[open], .popover:not([hidden])")) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const add = get("note-suggestions").querySelector(".suggestion-add");
    if (add?.offsetParent) { event.preventDefault(); add.click(); }
  });

  async function applyPending() {
    const p = pending();
    if (!p?.ids?.length || workspaceView !== "meeting") return;
    const m = data().meetings.find(x => x.id === openedMeetingId);
    if (!m || m.date < p.since) return;
    setPending([]);
    const ids = p.ids.filter(id => folderById(id) && !folderById(id).notes.includes(m.id));
    for (const id of ids) await change({ type: "folder-add", id, ids: [m.id] });
    if (ids.length) status.textContent = "Added to " + ids.map(id => folderById(id).title).join(", ") + ".";
  }

  // ---------- popovers ----------
  let popoverOwner = null;
  function place(pop, anchor) {
    pop.hidden = false;
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(r.left, innerWidth - w - 8), top = r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = Math.max(8, left) + "px"; pop.style.top = top + "px";
    popoverOwner = anchor;
  }
  function closePopovers(restore = false) {
    for (const id of ["folder-menu", "folder-picker", "icon-picker"]) get(id).hidden = true;
    if (restore && popoverOwner?.isConnected) popoverOwner.focus();
    popoverOwner = null;
  }
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest(".popover") && !event.target.closest("[aria-haspopup]") && !event.target.closest(".folder-hero-icon")) closePopovers();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && document.querySelector(".popover:not([hidden])")) { event.preventDefault(); closePopovers(true); }
  });
  function openFolderMenu(folder, anchor, fromPage = false) {
    const menu = get("folder-menu"); menu.replaceChildren();
    const item = (text, run, danger) => {
      const b = button(text, async () => { closePopovers(); await run(); }, danger ? "danger" : "");
      b.setAttribute("role", "menuitem"); menu.append(b);
    };
    if (!folder.parent) item("Create subfolder", () => openFolderDialog({ parent: folder.id }));
    if (!fromPage) item(folder.favorite ? "Remove from favorites" : "Add to favorites",
      () => change({ type: "folder-update", id: folder.id, favorite: !folder.favorite }));
    item("Rename and settings", () => openFolderDialog({ folder }));
    if (folder.parent) item("Move to My notes", async () => {
      if (await change({ type: "folder-move", id: folder.id, parent: null })) status.textContent = "Moved " + folder.title + " to My notes.";
    });
    for (const rule of folder.series ?? []) {
      item("Stop auto-adding " + seriesTitle(rule.event), async () => {
        if (await change({ type: "folder-follow", id: folder.id, event: rule.event, on: false })) {
          status.textContent = "New notes from that series will no longer be added to " + folder.title + ".";
        }
      });
    }
    item("Delete folder", () => confirmDelete(folder), true);
    place(menu, anchor);
    menu.querySelector("button")?.focus();
  }
  get("folder-menu").addEventListener("keydown", event => {
    const items = [...get("folder-menu").querySelectorAll("button")], i = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") items[(i + 1) % items.length].focus();
    else if (event.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
    else return;
    event.preventDefault();
  });
  function folderListMenu(anchor) {
    const menu = get("folder-menu"); menu.replaceChildren();
    for (const { folder, level } of ordered()) {
      const b = button("", () => { closePopovers(); openFolder(folder.id); }, level ? "nested" : "");
      b.setAttribute("role", "menuitem");
      b.append(folderIcon(folder.icon), document.createTextNode(folder.title));
      menu.append(b);
    }
    const add = button("", () => { closePopovers(); openFolderDialog({}); });
    add.setAttribute("role", "menuitem"); add.append(plusGlyph(), document.createTextNode(" Add folder"));
    menu.append(add);
    place(menu, anchor);
    menu.querySelector("button")?.focus();
  }
  function confirmDelete(folder) {
    const j = journal();
    j.sheet("Delete " + folder.title + "?");
    const parent = folderById(folder.parent);
    const content = get("daily-content");
    content.append(el("p", "", "This folder will be deleted. The notes inside stay in My notes" +
      (children(folder.id).length ? ", and its folders move to " + (parent ? parent.title : "My notes") : "") + "."));
    const del = j.action("Delete folder", async () => {
      if (await change({ type: "folder-delete", id: folder.id })) {
        j.close();
        status.textContent = "Folder deleted.";
        if (page.kind === "folder" && page.id === folder.id) { page = parent ? { kind: "folder", id: parent.id } : { kind: "all" }; renderPage(); }
      }
    });
    del.className = "danger";
    content.append(del);
  }

  // The "Add to folder" picker: search, recently used first, one pick then it closes.
  // The same popover in label mode is a checklist that stays open.
  const labelKinds = ["project", "person", "topic", "area", "organization"];
  let pickerTarget = null, pickerIndex = 0, pickerAll = false;
  function openPicker(anchor, target) {
    pickerTarget = target; pickerIndex = 0; pickerAll = false;
    const search = get("folder-picker-search");
    search.value = "";
    search.placeholder = target.labels ? "Search labels" : "Search folders";
    get("folder-picker").setAttribute("aria-label", target.labels ? "Labels" : "Add to folder");
    renderPicker();
    place(get("folder-picker"), anchor);
    search.focus();
  }
  window.openLabelPicker = openPicker;
  function pickerChosen(folder) {
    if (pickerTarget.draft) return (pending()?.ids ?? []).includes(folder.id);
    return pickerTarget.ids.every(id => folder.notes.includes(id));
  }
  function labelChosen(name) {
    const tags = pickerTarget.draft ? journal().draftTags() : data().meetings.find(m => m.id === pickerTarget.ids[0])?.tags ?? [];
    return tags.some(t => key(t) === key(name));
  }
  function ordered(parent = null, level = 0) {
    return children(parent).flatMap(f => [{ folder: f, level }, ...ordered(f.id, level + 1)]);
  }
  function tickMark(on) {
    const tick = el("span", "tick");
    if (on) { const svg = glyph("folder"); svg.firstChild.setAttribute("d", "M5 12.5 10 17l9-10"); tick.append(svg); }
    return tick;
  }
  function pickerRow(list, index, on, parts, run) {
    const li = el("li", "picker-row"); li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(on)); li.dataset.index = index;
    li.classList.toggle("active", index === pickerIndex);
    li.append(...parts, tickMark(on));
    li.addEventListener("click", () => { pickerIndex = index; run(); });
    list.append(li);
  }
  function renderPicker() {
    const typed = get("folder-picker-search").value.trim(), q = key(typed);
    const list = get("folder-picker-list"); list.replaceChildren();
    const create = get("folder-picker-create");
    let index = 0;
    if (pickerTarget.labels) {
      create.hidden = true;
      for (const name of data().labels.filter(n => !q || key(n).includes(q))) {
        const [kind, ...rest] = name.split(":");
        pickerRow(list, index++, labelChosen(name), [el("span", "label-dot " + kind), el("span", "folder-name", rest.join(":").trim()),
          el("span", "label-kind", kind)], () => toggleLabel(name));
      }
      if (typed && !data().labels.some(n => key(n) === q || key(n.slice(n.indexOf(":") + 1)) === q)) {
        const split = typed.indexOf(":"), typedKind = split > 0 ? typed.slice(0, split).trim().toLowerCase() : "";
        const kinds = labelKinds.includes(typedKind) ? [typedKind] : labelKinds;
        const bare = labelKinds.includes(typedKind) ? typed.slice(split + 1).trim() : typed;
        for (const kind of bare ? kinds : []) {
          const name = kind + ": " + bare;
          pickerRow(list, index++, false, [plusGlyph(), el("span", "folder-name", "Create “" + bare + "”"), el("span", "label-kind", kind)],
            () => toggleLabel(name));
        }
      }
      if (!index) list.append(el("li", "picker-empty", "Type to create a label."));
      pickerIndex = Math.min(pickerIndex, Math.max(0, index - 1));
      return;
    }
    const rows = folders().filter(f => !q || key(f.title).includes(q)).sort(pickerOrder);
    const limit = !q && !pickerAll && rows.length > 4 ? 3 : rows.length;
    for (const folder of rows.slice(0, limit)) {
      const name = el("span", "folder-name", folder.title);
      if (folder.parent) name.append(el("small", "", " in " + folderById(folder.parent)?.title));
      const parts = [folderIcon(folder.icon), name, el("small", "count", String(notesWithin(folder).size))];
      pickerRow(list, index++, pickerChosen(folder), parts, () => togglePicked(folder));
    }
    if (limit < rows.length) {
      const more = el("li", "picker-more");
      more.append(button("Show " + (rows.length - limit) + " more", () => { pickerAll = true; renderPicker(); get("folder-picker-search").focus(); }, "link"));
      list.append(more);
    }
    if (!rows.length) list.append(el("li", "picker-empty", folders().length ? "No results" : "No folders yet."));
    pickerIndex = Math.min(pickerIndex, Math.max(0, index - 1));
    create.hidden = Boolean(typed) && folders().some(f => key(f.title) === q);
    create.replaceChildren(plusGlyph(), el("span", "", typed ? "Create “" + typed + "”" : "New folder"));
  }
  async function togglePicked(folder) {
    // A suggestion's dropdown only chooses; nothing changes until Add.
    if (pickerTarget.choose) { const pick = pickerTarget.choose; closePopovers(true); pick(folder); return; }
    const on = pickerChosen(folder);
    if (pickerTarget.draft) {
      const ids = new Set(pending()?.ids ?? []);
      if (on) ids.delete(folder.id); else ids.add(folder.id);
      setPending([...ids]); paintNote(); closePopovers(true); return;
    }
    const ids = pickerTarget.ids, many = ids.length > 1;
    closePopovers(true);
    recordVisit(folder.id);
    if (on ? await removeNotes(folder, ids) : await addNotes(folder, ids)) {
      if (many) { endSelect(); renderPage(); }
    }
  }
  async function toggleLabel(name) {
    if (pickerTarget.choose) { const pick = pickerTarget.choose; closePopovers(true); pick(name); return; }
    const on = labelChosen(name);
    if (pickerTarget.draft) {
      const tags = journal().draftTags();
      journal().editDraftTags(on ? tags.filter(t => key(t) !== key(name)) : [...tags, name]);
    } else if (!await journal().change({ type: on ? "detach" : "attach", ids: pickerTarget.ids, name })) return;
    if (pickerTarget.ids?.length > 1) { closePopovers(true); endSelect(); renderPage(); return; }
    get("folder-picker-search").value = "";
    renderPicker();
    get("folder-picker-search").focus();
  }
  get("folder-picker-search").addEventListener("input", () => { pickerIndex = 0; renderPicker(); });
  get("folder-picker-search").addEventListener("keydown", event => {
    const rows = [...get("folder-picker-list").querySelectorAll(".picker-row")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      pickerIndex = Math.max(0, Math.min(rows.length - 1, pickerIndex + (event.key === "ArrowDown" ? 1 : -1)));
      renderPicker(); event.preventDefault();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (rows[pickerIndex]) rows[pickerIndex].click(); else if (!get("folder-picker-create").hidden) get("folder-picker-create").click();
    }
  });
  get("folder-picker-create").onclick = async () => {
    const title = get("folder-picker-search").value.trim();
    const target = pickerTarget;
    closePopovers();
    openFolderDialog({ title, addIds: target.draft ? null : target.ids, forDraft: Boolean(target.draft) });
  };

  // ---------- icon picker ----------
  let iconChoice = null, iconDone = null, iconColor = "gray";
  function openIconPicker(anchor, icon, done) {
    iconChoice = icon; iconDone = done; iconColor = icon?.type === "icon" ? icon.color : "gray";
    showIconTab(icon?.type === "emoji" ? "emoji" : "icons");
    renderIconPicker();
    place(get("icon-picker"), anchor);
    get("icon-picker").querySelector("[aria-selected=true]")?.focus();
  }
  function showIconTab(which) {
    get("icon-tab-icons").setAttribute("aria-selected", String(which === "icons"));
    get("icon-tab-emoji").setAttribute("aria-selected", String(which === "emoji"));
    get("icon-pane-icons").hidden = which !== "icons";
    get("icon-pane-emoji").hidden = which !== "emoji";
    if (which === "emoji") { get("emoji-search").value = ""; renderEmoji(); get("emoji-search").focus(); }
  }
  get("icon-tab-icons").onclick = () => showIconTab("icons");
  get("icon-tab-emoji").onclick = () => showIconTab("emoji");
  async function choose(icon, keepOpen) {
    iconChoice = icon;
    try { await iconDone(icon); } catch (error) { status.textContent = error.message; }
    if (keepOpen) renderIconPicker(); else closePopovers(true);
  }
  function renderIconPicker() {
    const colors = get("icon-colors"); colors.replaceChildren();
    for (const [name, hex] of Object.entries(window.folderColors)) {
      const dot = button("", () => {
        iconColor = name;
        // Changing only the colour keeps the chosen icon, or uses the folder icon.
        choose({ type: "icon", value: iconChoice?.type === "icon" ? iconChoice.value : "folder", color: name }, true);
      }, "swatch");
      dot.style.setProperty("--swatch", hex); dot.setAttribute("role", "radio");
      dot.setAttribute("aria-checked", String(name === iconColor)); dot.setAttribute("aria-label", name);
      dot.title = name[0].toUpperCase() + name.slice(1);
      colors.append(dot);
    }
    const grid = get("icon-glyphs"); grid.replaceChildren();
    grid.style.setProperty("--icon", window.folderColors[iconColor]);
    for (const name of Object.keys(window.folderGlyphs)) {
      if (name === "lock") continue;
      const cell = button("", () => choose({ type: "icon", value: name, color: iconColor }), "icon-cell");
      cell.title = name; cell.setAttribute("aria-label", name + " icon");
      cell.setAttribute("aria-pressed", String(iconChoice?.type === "icon" && iconChoice.value === name));
      cell.append(glyph(name));
      grid.append(cell);
    }
  }
  function renderEmoji() {
    const q = key(get("emoji-search").value);
    const grid = get("emoji-grid"); grid.replaceChildren();
    const found = window.folderEmoji.filter(([e, words]) => !q || words.includes(q) || e === q);
    for (const [emoji, words] of found) {
      const cell = button(emoji, () => choose({ type: "emoji", value: emoji }), "icon-cell");
      cell.title = words.split(" ")[0]; cell.setAttribute("aria-label", words.split(" ")[0]);
      grid.append(cell);
    }
    get("emoji-empty").hidden = found.length > 0;
  }
  get("emoji-search").addEventListener("input", renderEmoji);
  get("icon-picker").addEventListener("keydown", event => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    const cells = [...event.currentTarget.querySelectorAll(".icon-grid:not([hidden]) .icon-cell")].filter(c => c.offsetParent);
    const i = cells.indexOf(document.activeElement); if (i < 0) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 }[event.key];
    cells[Math.max(0, Math.min(cells.length - 1, i + step))].focus(); event.preventDefault();
  });

  // ---------- create / settings dialog ----------
  const dialog = get("folder-dialog"), formEl = get("folder-form");
  let editing = null, formIcon = null, addIds = null, forDraft = false, saveTimer = 0, followEvent = null;
  function paintFormIcon() {
    get("folder-form-icon").replaceChildren(folderIcon(formIcon, "tile"), el("span", "visually-hidden", "Choose icon"));
  }
  function openFolderDialog({ folder = null, parent = null, title = "", addIds: ids = null, forDraft: draft = false, follow = null }) {
    editing = folder; addIds = ids; forDraft = draft; followEvent = follow;
    formIcon = folder ? folder.icon : null;
    get("folder-dialog-title").textContent = folder ? folder.title + " settings" : parent ? "Create subfolder" : "Create folder";
    formEl.elements.title.value = folder ? folder.title : title;
    formEl.elements.description.value = folder?.description ?? "";
    const select = formEl.elements.parent; select.replaceChildren(new Option("My notes", ""));
    // Only top-level folders can hold subfolders, and a folder with subfolders stays top-level.
    const canNest = !folder || !children(folder.id).length;
    for (const f of canNest ? children(null) : []) {
      if (f !== folder) select.add(new Option("  " + f.title, f.id));
    }
    select.value = folder ? folder.parent ?? "" : parent ?? "";
    get("folder-form-save").textContent = folder ? "Done" : "Create";
    get("folder-form-save").value = "save";
    paintFormIcon(); duplicateNote();
    dialog.showModal();
    formEl.elements.title.focus(); formEl.elements.title.select();
  }
  function duplicateNote() {
    const note = get("folder-form-note"); note.replaceChildren();
    const name = formEl.elements.title.value.trim();
    const parent = formEl.elements.parent.value || null;
    const twin = folders().find(f => f !== editing && f.parent === parent && key(f.title) === key(name || "Untitled folder"));
    if (twin) note.append(el("span", "", "“" + twin.title + "” already exists here. "), button("Go to folder", () => { dialog.close(); openFolder(twin.id); }, "link"));
  }
  function values() {
    return { title: formEl.elements.title.value, description: formEl.elements.description.value, icon: formIcon };
  }
  async function autosave() {
    if (!editing) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await change({ type: "folder-update", id: editing.id, ...values() });
        const parent = formEl.elements.parent.value || null;
        if (parent !== editing.parent) await change({ type: "folder-move", id: editing.id, parent });
        editing = folderById(editing.id);
      } catch (error) { get("folder-form-note").textContent = error.message; }
    }, 500);
  }
  for (const name of ["title", "description", "parent"]) {
    formEl.elements[name].addEventListener(name === "parent" ? "change" : "input", () => { duplicateNote(); autosave(); });
  }
  get("folder-form-icon").onclick = event => openIconPicker(event.currentTarget, formIcon, icon => { formIcon = icon; paintFormIcon(); autosave(); });
  formEl.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey || event.target.name === "description" && !event.shiftKey)) {
      event.preventDefault(); get("folder-form-save").click();
    }
  });
  formEl.addEventListener("submit", async event => {
    if (event.submitter?.value !== "save") return;
    event.preventDefault();
    try {
      if (editing) {
        clearTimeout(saveTimer);
        await change({ type: "folder-update", id: editing.id, ...values() });
        const parent = formEl.elements.parent.value || null;
        if (parent !== editing.parent) await change({ type: "folder-move", id: editing.id, parent });
        dialog.close(); renderAll(); return;
      }
      const parent = formEl.elements.parent.value || null;
      const result = await change({ type: "folder-create", ...values(), parent, ...(addIds ? { ids: addIds } : {}) });
      if (!result) return;
      dialog.close();
      if (parent) { expanded.add(parent); saveExpanded(); }
      const made = folderById(result.folder);
      if (forDraft) { setPending([...(pending()?.ids ?? []), made.id]); paintNote(); status.textContent = "Created " + made.title + "."; return; }
      if (addIds && followEvent) {
        // A folder made for a meeting series keeps collecting that series.
        await change({ type: "folder-follow", id: made.id, event: followEvent });
        toast("Created " + made.title + " with " + plural(addIds.length, "note") + ". New notes from this series will be added too.");
        renderAll(); return;
      }
      if (addIds) { status.textContent = "Created " + made.title + " and added " + plural(addIds.length, "note") + "."; endSelect(); renderAll(); return; }
      status.textContent = "Created " + made.title + ".";
      openFolder(made.id);
    } catch (error) { get("folder-form-note").textContent = error.message; }
  });
  dialog.addEventListener("close", () => {
    // Closing with Esc keeps what was typed: settings save as you go.
    if (editing && saveTimer) { clearTimeout(saveTimer); saveTimer = 0; void flushSettings(editing); }
  });
  async function flushSettings(folder) {
    try {
      await change({ type: "folder-update", id: folder.id, ...values() });
      const parent = formEl.elements.parent.value || null;
      if (parent !== folder.parent) await change({ type: "folder-move", id: folder.id, parent });
    } catch (error) { status.textContent = error.message; }
  }

  // ---------- sidebar chrome ----------
  function setSidebar(open, remember = true) {
    document.body.classList.toggle("sidebar-closed", !open);
    get("sidebar-toggle").setAttribute("aria-expanded", String(open));
    get("sidebar-open").hidden = open;
    if (remember) localStorage.setItem(sidebarKey, open ? "0" : "1");
  }
  setSidebar(localStorage.getItem(sidebarKey) !== "1" && innerWidth > 760, false);
  get("sidebar-toggle").onclick = () => { setSidebar(false); get("sidebar-open").focus(); };
  get("sidebar-open").onclick = () => { setSidebar(true); get("sidebar-toggle").focus(); };
  document.addEventListener("keydown", event => {
    if (event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "\\" || event.key.toLowerCase() === "s") && !document.querySelector("dialog[open]")) {
      event.preventDefault(); setSidebar(document.body.classList.contains("sidebar-closed"));
    }
  });
  get("sidebar-search").onclick = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  get("sidebar-new-folder").onclick = () => openFolderDialog({});
  get("sidebar-new-label-view").onclick = event => newLabelViewMenu(event.currentTarget);
  get("my-notes-link").onclick = () => { page = { kind: "all" }; showPage(); };
  get("my-notes-expand").onclick = () => {
    const btn = get("my-notes-expand"), open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open)); btn.title = open ? "Collapse My notes" : "Expand My notes";
    renderSidebar();
  };
  get("sidebar-followups").onclick = () => {
    if (workspaceView !== "home") homeButton.click();
    requestAnimationFrame(() => get("daily-home").scrollIntoView({ block: "center" }));
  };

  function renderAll() {
    renderSidebar();
    paintNote();
    if (workspaceView === "folder") renderPage();
  }
  document.addEventListener("journal-data", () => { journalLoaded = true; renderAll(); void applyPending(); });
  document.addEventListener("workspace-view", () => {
    if (workspaceView === "folder") renderPage(); else { renderSidebar(); paintNote(); }
    get("go-home").setAttribute("aria-current", workspaceView === "home" ? "page" : "false");
    closePopovers();
  });
  window.stillwaterFolders = { openFolder, openLabel, openMyNotes: () => { page = { kind: "all" }; showPage(); }, openFolderDialog, openPicker };
  renderAll();
})();
