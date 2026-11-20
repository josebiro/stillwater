const form = document.querySelector("form");
const button = form.querySelector('button[type="submit"]');
const notesEditor = form.elements.notes;
const draftProvider = document.querySelector("#draft-provider");
const draftModel = document.querySelector("#draft-model");
const storedProvider = localStorage.getItem("stillwater-draft-provider");
if ([...draftProvider.options].some((option) => option.value === storedProvider)) {
  draftProvider.value = storedProvider;
}
const modelPreference = provider => "stillwater-draft-model-" + provider;
const defaultModel = provider => provider === "ollama" ? "qwen2.5:7b" : "";
const storedModel = localStorage.getItem(modelPreference(draftProvider.value)) ??
  localStorage.getItem("stillwater-draft-model") ?? defaultModel(draftProvider.value);
draftModel.value = storedModel.slice(0,draftModel.maxLength);
localStorage.setItem(modelPreference(draftProvider.value), draftModel.value);
draftModel.addEventListener("input", rememberModel);
draftModel.addEventListener("change", rememberModel);
function rememberModel() {
  localStorage.setItem(modelPreference(draftProvider.value),draftModel.value.trim());
}
const transcriptionLanguage = form.elements.language;
const transcriptionLanguageKey = "stillwater-transcription-language";
const preferredLanguage = localStorage.getItem(transcriptionLanguageKey);
if ([...transcriptionLanguage.options].some((option) => option.value === preferredLanguage)) {
  transcriptionLanguage.value = preferredLanguage;
}
transcriptionLanguage.addEventListener("change", () => {
  localStorage.setItem(transcriptionLanguageKey, transcriptionLanguage.value);
});
const draftKey = "stillwater-note-draft-v1";
function rememberDraft() {
  document.querySelector("#draft-save-state").textContent = form.elements.title.value || notesEditor.value ? "Draft saved locally" : "";
  localStorage.setItem(draftKey, JSON.stringify({
    title: form.elements.title.value, notes: notesEditor.value, participants: form.elements.participants.value,
    filing: form.elements.filing.value, calendarId: form.dataset.calendarId, calendarStart: form.dataset.calendarStart,
  }));
}
try {
  const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null");
  if (draft) {
    for (const field of ["title", "notes", "participants", "filing"]) form.elements[field].value = draft[field] ?? "";
    if (draft.calendarId && draft.calendarStart) {
      form.dataset.calendarId = draft.calendarId;
      form.dataset.calendarStart = draft.calendarStart;
    }
  }
} catch (error) {
  console.error("Could not restore the note draft", error);
}
form.addEventListener("input", rememberDraft);
function clearSavedDraft(fields, calendarId, calendarStart) {
  const names = ["title", "notes", "participants", "filing"];
  if (names.some((name) => form.elements[name].value !== fields.get(name)) ||
      form.dataset.calendarId !== calendarId || form.dataset.calendarStart !== calendarStart) return;
  for (const name of names) form.elements[name].value = "";
  delete form.dataset.calendarId;
  delete form.dataset.calendarStart;
  rememberDraft();
}
const homeButton = document.querySelector("#go-home");
const newNoteButton = document.querySelector("#new-note");
const recordingBar = document.querySelector("#recording-bar");
const libraryTools = document.querySelector("#library-tools");
libraryTools.addEventListener("click", event => {
  if (event.target.closest("button")) libraryTools.open = false;
});
libraryTools.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    libraryTools.open = false;
    libraryTools.querySelector("summary").focus();
  }
});
document.querySelector("#calendar-link").addEventListener("click", () => document.querySelector("#agenda-previous").focus());
document.querySelector("#journal-create").addEventListener("click", () => newNoteButton.click());
const settings = document.querySelector("#speech-settings");
settings.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !settings.open) return;
  event.preventDefault();
  settings.open = false;
  settings.querySelector("summary").focus();
});
document.addEventListener("pointerdown", event => {
  if (!libraryTools.contains(event.target)) libraryTools.open = false;
  if (settings.open && !settings.contains(event.target)) settings.open = false;
});
const homeControls = ["#journal-mast", "#feature", "#journal-columns", "#calendar-link", "#agenda", "#vault-search", "#meeting-results", "#vault-question", "#context-results",
  "#library-tools"].map((selector) => document.querySelector(selector));
let workspaceView = "home";
function showWorkspace(view, message = "") {
  const changed = workspaceView !== view;
  if (changed) status.textContent = message;
  workspaceView = view;
  const editor = view === "editor";
  form.hidden = !editor;
  recordingBar.hidden = !editor && document.querySelector("#capture-start").disabled === false;
  for (const control of homeControls) control.hidden = view !== "home";
  if (view === "home" && document.querySelector("#library-title").textContent === "Contexts") {
    document.querySelector("#meeting-results").hidden = true;
  }
  document.querySelector("#saved-meeting").hidden = view !== "meeting";
  if (view !== "home") settings.open = false;
  homeButton.setAttribute("aria-current", view === "home" ? "page" : "false");
  newNoteButton.setAttribute("aria-current", editor ? "page" : "false");
  if (editor) notesEditor.focus();
  if (view === "meeting") document.querySelector("#rename-title").focus();
  if (changed) window.scrollTo(0, 0);
  document.dispatchEvent(new Event("workspace-view"));
}
homeButton.addEventListener("click", async () => {
  let message = "";
  if (workspaceView === "editor" && !document.querySelector("#capture-start").disabled &&
      (form.elements.title.value.trim() || notesEditor.value.trim())) {
    homeButton.disabled = true;
    try {
      message = await fileWrittenNote();
      if (!message) return;
    }
    finally { homeButton.disabled = false; }
  }
  showWorkspace("home", message);
});
function startNewNote() {
  showWorkspace("editor");
  const start = document.querySelector("#capture-start");
  if (!start.disabled) start.click();
}
const prepareImport = document.querySelector("#prepare-import");
prepareImport.addEventListener("click", () => {
  showWorkspace("editor");
  form.elements.title.focus();
  status.textContent = "Enter the meeting title, then choose Import recording.";
});
newNoteButton.addEventListener("click", startNewNote);
const emptyNewNoteButton = document.querySelector("#empty-new-note");
emptyNewNoteButton.addEventListener("click", () => newNoteButton.click());
document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k" ||
      document.querySelector("dialog[open]")) return;
  event.preventDefault();
  showWorkspace("home");
  const search = document.querySelector('#vault-search input[name="query"]');
  search.focus();
  search.select();
});
window.stillwater.onTrayNavigate((view) => {
  if (view === "editor") startNewNote();
  if (view === "question") document.dispatchEvent(new Event("daily-question"));
  if (view === "settings") {
    settings.open = true;
    settings.querySelector("summary").focus();
  }
});
const agenda = document.querySelector("#agenda-events");
const agendaStatus = document.querySelector("#agenda-status");
const eventFiling = document.querySelector("#event-filing");
const eventContexts = eventFiling.querySelector("textarea");
let filingEventKey;
let filingButton;
function showEventFiling(button, value) {
  button.textContent = value ? "Filed · " + value.split(/\r?\n/).filter((line) => line.trim()).length : "File event";
  button.title = value || "Assign contexts to this event";
}
eventContexts.addEventListener("input", () => eventContexts.setCustomValidity(""));
eventFiling.querySelector("form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  const value = eventContexts.value.trim();
  if (value.split(/\r?\n/).some((line) => line.trim() &&
      !/^(project|area|topic|person|organization):\s*\S.{0,99}$/i.test(line.trim()))) {
    event.preventDefault();
    eventContexts.setCustomValidity("Use one context per line, such as project: Launch.");
    eventContexts.reportValidity();
    return;
  }
  if (value) localStorage.setItem(filingEventKey, value);
  else localStorage.removeItem(filingEventKey);
  showEventFiling(filingButton, value);
});
eventFiling.querySelector('button[value="cancel"]').formNoValidate = true;
let calendarData = { events: [], unsupported: 0 };
let agendaOffset = 0;
let staleGoogleCalendar = false;
let renderedAgendaDay = "";
function eventKey(event) {
  return "stillwater-event-contexts:" + JSON.stringify([event.id, event.start]);
}
async function openEvent(event, open) {
  if (document.querySelector("#capture-start").disabled) {
    showWorkspace("editor");
    status.textContent = "Finish the current recording before opening another calendar event.";
    return;
  }
  if (form.dataset.calendarId === event.id && form.dataset.calendarStart === event.start) {
    showWorkspace("editor");
    return;
  }
  open.disabled = true;
  await initialLibraryLoad;
  const opened = await openSavedMeeting(undefined, undefined, false, undefined, event);
  open.disabled = false;
  if (opened !== false) return;
  if ((notesEditor.value || form.elements.title.value || form.elements.participants.value || form.elements.filing.value) &&
      !window.confirm("Replace the current unsaved note?")) return;
  form.elements.title.value = event.title.slice(0, 200);
  notesEditor.value = "";
  form.elements.participants.value = (event.attendees ?? []).join(", ").slice(0,1000);
  form.elements.filing.value = localStorage.getItem(eventKey(event)) ?? "";
  form.dataset.calendarId = event.id;
  form.dataset.calendarStart = event.start;
  rememberDraft();
  showWorkspace("editor");
}

let featuredEvent;
function updateFeature(now) {
  featuredEvent = calendarData.events.find(event => new Date(event.end || event.start) > now ||
    (event.allDay && !event.end && new Date(event.start).toDateString() === now.toDateString()));
  document.querySelector("#journal-date").textContent = now.toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric" });
  document.querySelector("#feature-title").textContent = featuredEvent?.title || "No upcoming events";
  document.querySelector("#feature-time").textContent = featuredEvent
    ? new Date(featuredEvent.start).toLocaleString(undefined, { dateStyle: "medium",
        ...(featuredEvent.allDay ? {} : { timeStyle: "short" }) }) : "";
  document.querySelector("#feature-open").textContent = featuredEvent ? "Open meeting" : "Import calendar";
}
document.querySelector("#feature-open").addEventListener("click", event => {
  if (featuredEvent) void openEvent(featuredEvent, event.currentTarget);
  else document.querySelector("#agenda-import").click();
});
function renderAgenda() {
  agenda.replaceChildren();
  const today = new Date();
  updateFeature(today);
  renderedAgendaDay = today.toDateString();
  today.setHours(0, 0, 0, 0);
  const first = new Date(today);
  first.setDate(first.getDate() + agendaOffset * 7);
  const last = new Date(first);
  last.setDate(last.getDate() + 7);
  const events = calendarData.events.filter((event) => {
    const start = new Date(event.start);
    return start < last && (start >= first || (event.end && new Date(event.end) > first));
  });
  let previousDay = "";
  let dayEvents;
  for (const event of events) {
    const start = new Date(event.start);
    const date = start < first ? first : start;
    const day = date.toDateString();
    if (day !== previousDay) {
      const heading = document.createElement("li");
      heading.className = "meeting-day";
      const label = document.createElement("div");
      label.className = "agenda-date";
      const number = document.createElement("strong");
      number.textContent = date.toLocaleDateString(undefined, { day: "numeric" });
      const month = document.createElement("span");
      month.textContent = date.toLocaleDateString(undefined, { weekday: "short", month: "short" });
      label.append(number, month);
      dayEvents = document.createElement("ul");
      heading.append(label, dayEvents);
      agenda.append(heading);
      previousDay = day;
    }
    const item = document.createElement("li");
    const filingKey = eventKey(event);
    const open = document.createElement("button");
    open.type = "button";
    const time = (date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const title = document.createElement("span");
    title.textContent = event.title;
    const eventTime = document.createElement("small");
    eventTime.textContent = event.allDay ? "All day" : time(start) + (event.end ? " – " + time(new Date(event.end)) : "");
    open.append(title, eventTime);
    open.addEventListener("click", () => openEvent(event, open));
    const file = document.createElement("button");
    file.type = "button";
    showEventFiling(file, localStorage.getItem(filingKey));
    file.setAttribute("aria-label", "File " + event.title);
    file.addEventListener("click", () => {
      filingEventKey = filingKey;
      filingButton = file;
      eventContexts.value = localStorage.getItem(filingKey) ?? "";
      eventContexts.setCustomValidity("");
      eventFiling.showModal();
      eventContexts.focus();
    });
    item.append(open, file);
    dayEvents.append(item);
  }
  const now = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const emptyToday = agendaOffset === 0 && !events.some((event) => {
    const start = new Date(event.start);
    return start < tomorrow && (start >= now || (event.end && new Date(event.end) > now) ||
      (event.allDay && !event.end && start >= today));
  });
  const range = first.toLocaleDateString() + " – " + new Date(last.getTime() - 1).toLocaleDateString();
  agendaStatus.textContent = range + (emptyToday ? " · No more events today" : events.length ? "" : " · No events") +
    (calendarData.unsupported ? ` · ${calendarData.unsupported} unsupported calendar entries skipped` : "") +
    (staleGoogleCalendar && calendarData.connected ? " · Last synced " + new Date(calendarData.syncedAt).toLocaleString() : "");
}
const googleAddress = document.querySelector("#google-address");
const googleConnect = document.querySelector("#google-connect");
const googleSync = document.querySelector("#google-sync");
const googleDisconnect = document.querySelector("#google-disconnect");
const googleStatus = document.querySelector("#google-status");
let syncingGoogle = false;
let lastGoogleAttempt = 0;

function showCalendar(data) {
  calendarData = data;
  googleSync.hidden = !data.connected;
  googleDisconnect.hidden = !data.connected && !data.unreadable;
  googleConnect.textContent = data.connected ? "Replace calendar" : "Connect calendar";
  googleStatus.textContent = data.unreadable ? "Could not unlock the saved calendar. Reconnect or disconnect it." :
    data.connected ? "Last synced " + new Date(data.syncedAt).toLocaleString() + ". Refreshes every 15 minutes." : "";
  renderAgenda();
}

async function updateGoogle(action) {
  if (syncingGoogle) return;
  syncingGoogle = true;
  lastGoogleAttempt = Date.now();
  googleConnect.disabled = googleSync.disabled = googleDisconnect.disabled = true;
  googleStatus.textContent = action === "disconnect" ? "Disconnecting…" : "Syncing calendar…";
  try {
    const data = await window.stillwater.googleCalendar(action, action === "connect" ? googleAddress.value.trim() : undefined);
    googleAddress.value = "";
    staleGoogleCalendar = false;
    showCalendar(data);
    if (action === "disconnect") googleStatus.textContent = "Calendar disconnected.";
  } catch (error) {
    googleStatus.textContent = error.message;
    if (calendarData.connected) {
      staleGoogleCalendar = true;
      renderAgenda();
    }
  } finally {
    syncingGoogle = false;
    googleConnect.disabled = googleSync.disabled = googleDisconnect.disabled = false;
  }
}

function refreshCalendarIfDue() {
  if (renderedAgendaDay !== new Date().toDateString()) renderAgenda();
  else updateFeature(new Date());
  if (calendarData.connected && Date.now() - Math.max(lastGoogleAttempt, calendarData.syncedAt) >= 15 * 60000) {
    void updateGoogle("sync");
  }
}
googleConnect.addEventListener("click", () => void updateGoogle("connect"));
googleSync.addEventListener("click", () => void updateGoogle("sync"));
googleDisconnect.addEventListener("click", () => void updateGoogle("disconnect"));
setInterval(refreshCalendarIfDue, 60000);
window.addEventListener("focus", refreshCalendarIfDue);
for (const [selector, direction] of [["#agenda-previous", -1], ["#agenda-next", 1]]) {
  document.querySelector(selector).addEventListener("click", () => {
    agendaOffset += direction;
    renderAgenda();
  });
}
document.querySelector("#agenda-import").addEventListener("click", async () => {
  try {
    const data = await window.stillwater.importCalendar();
    if (data) {
      agendaOffset = 0;
      showCalendar(data);
    }
  } catch (error) {
    agendaStatus.textContent = error.message;
  }
});
window.stillwater.readCalendar().then((data) => {
  showCalendar(data);
  if (data.connected) void updateGoogle("sync");
}).catch((error) => { agendaStatus.textContent = error.message; });
new MutationObserver(() => {
  const capturing = document.querySelector("#capture-start").disabled;
  recordingBar.hidden = workspaceView !== "editor" && !capturing;
  prepareImport.disabled = capturing;
  button.disabled = capturing;
}).observe(document.querySelector("#capture-start"), { attributes: true, attributeFilter: ["disabled"] });

const templatePicker = document.querySelector("#template-picker");
const templates = {
  meeting: "## Agenda\n\n## Discussion\n\n## Decisions\n\n## Action items\n",
  "one-on-one": "## Check-in\n\n## Topics\n\n## Follow-ups\n",
  interview: "## Background\n\n## Questions\n\n## Observations\n\n## Follow-ups\n",
};
function openTemplates() {
  templatePicker.returnValue = "";
  templatePicker.showModal();
}
document.querySelector("#note-templates").addEventListener("click", openTemplates);
notesEditor.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
  const before = notesEditor.value.slice(0, notesEditor.selectionStart);
  if (before && !before.endsWith("\n")) return;
  event.preventDefault();
  openTemplates();
});
templatePicker.addEventListener("close", () => {
  const template = templates[templatePicker.returnValue];
  if (template) {
    notesEditor.setRangeText(template, notesEditor.selectionStart, notesEditor.selectionEnd, "end");
    rememberDraft();
  }
  notesEditor.focus();
});
const status = document.querySelector("main > [role=status]");
async function fileWrittenNote() {
  const fields = new FormData(form);
  const { calendarId, calendarStart } = form.dataset;
  try {
    const meeting = await window.stillwater.createNote(fields.get("title"), fields.get("notes"),
      fields.get("participants"), calendarId, calendarStart, fields.get("filing"));
    if (!meeting) return false;
    clearSavedDraft(fields, calendarId, calendarStart);
    await findMeetings("", false);
    return `Saved ${meeting.metadata.title}.`;
  } catch (error) {
    status.textContent = error.message;
    return false;
  }
}
const transcript = document.querySelector("#transcript");
const modelPath = document.querySelector("#speech-model");
const selectModel = document.querySelector("#select-model");
const downloadModel = document.querySelector("#download-model");
downloadModel.addEventListener("click", async () => {
  downloadModel.disabled = selectModel.disabled = true;
  status.textContent = "Downloading multilingual Whisper tiny…";
  try {
    modelPath.textContent = await window.stillwater.downloadModel();
    status.textContent = "Multilingual model ready.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    downloadModel.disabled = selectModel.disabled = false;
  }
});
window.stillwater.currentModel().then(({ moonshine, whisper }) => {
  document.querySelector("#english-engine").textContent = moonshine === "available"
    ? "English recording uses Moonshine."
    : moonshine === "invalid"
    ? "Check the configured Moonshine model folder before recording in English."
    : "Moonshine model unavailable. English recording requires a local Whisper model.";
  modelPath.textContent = whisper ?? "No Whisper model selected.";
}).catch((error) => {
  modelPath.textContent = error.message;
});
selectModel.addEventListener("click", async () => {
  selectModel.disabled = true;
  try {
    const path = await window.stillwater.selectModel();
    if (path) modelPath.textContent = path;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    selectModel.disabled = false;
  }
});
const recover = document.querySelector("#recover-capture");
const searchForm = document.querySelector("#vault-search");
const searchButtons = [...searchForm.querySelectorAll("button"), ...document.querySelectorAll("#recent-actions, #recent-meetings, #browse-contexts")];
function selectLibraryView(id) {
  for (const button of document.querySelectorAll("#recent-actions, #recent-meetings, #browse-contexts")) {
    button.setAttribute("aria-current", button.id === id ? "page" : "false");
  }
}
async function findMeetings(query, announce = true, prompt = true, actions = false, contextFilter = "") {
  for (const button of searchButtons) button.disabled = true;
  try {
    const results = actions ? await window.stillwater.recentActions() : await window.stillwater.searchVault(query, prompt, contextFilter);
    if (!results) return;
    const list = document.querySelector("#search-results");
    list.replaceChildren();
    document.querySelector("#meeting-results").hidden = workspaceView !== "home";
    const filtered = Boolean(query.trim() || contextFilter.trim());
    selectLibraryView(actions ? "recent-actions" : filtered ? "" : "recent-meetings");
    document.querySelector("#library-title").textContent = actions ? "Recent action items" : filtered ? "Search results" : "Recent meetings";
    document.querySelector("#context-results").replaceChildren();
    emptyNewNoteButton.hidden = actions || filtered;
    document.querySelector("#meeting-empty-message").textContent = actions
      ? "No recent action items."
      : filtered
        ? "No meetings match your search."
        : "Your meeting library is empty.";
    let previousDay;
    for (const result of results) {
      const date = result.date ? new Date(result.date) : null;
      const day = date?.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      if (day && day !== previousDay) {
        const heading = document.createElement("li");
        heading.className = "meeting-day";
        heading.textContent = day;
        list.append(heading);
        previousDay = day;
      }
      const item = document.createElement("li");
      const open = document.createElement("button");
      open.type = "button";
      const title = result.meetingTitle ?? result.excerpt;
      const label = document.createElement("span");
      label.dataset.titleBundle = result.bundle;
      label.dataset.archived = String(Boolean(result.archived));
      label.textContent = title + (result.archived ? " · Archived" : "");
      open.append(label);
      if (date) {
        open.classList.add("dated-meeting");
        const detail = document.createElement("small");
        detail.textContent = result.participants.join(", ") || "Me";
        const time = document.createElement("time");
        time.dateTime = result.date;
        time.textContent = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        open.append(detail, time);
      } else if (result.excerpt !== title) {
        const detail = document.createElement("small");
        detail.textContent = result.excerpt;
        open.append(detail);
      }
      open.addEventListener("click", () => void openSavedMeeting(result.bundle, result.anchor));
      item.append(open);
      if (result.suggestion) {
        const controls = document.createElement("div");
        controls.className = "filing-suggestion";
        const label = document.createElement("span");
        label.textContent = `Add to ${result.suggestion.name}?`;
        controls.append(label);
        for (const [text, accept] of [["Accept", true], ["Dismiss", false]]) {
          const action = document.createElement("button");
          action.type = "button";
          action.textContent = text;
          action.addEventListener("click", async () => {
            for (const button of controls.querySelectorAll("button")) button.disabled = true;
            try {
              await window.stillwater.resolveSuggestion(result.bundle, result.suggestion.key, accept);
              controls.remove();
              status.textContent = accept ? `Filed in ${result.suggestion.name}.` : "Suggestion dismissed.";
            } catch (error) {
              status.textContent = error.message;
              for (const button of controls.querySelectorAll("button")) button.disabled = false;
            }
          });
          controls.append(action);
        }
        item.append(controls);
      }
      list.append(item);
    }
    if (announce) status.textContent = actions
      ? (results.length ? `Found ${results.length} action items.` : "No recent cited action items.")
      : (results.length ? `Found ${results.length} results.` : "No matching meetings.");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    for (const button of searchButtons) button.disabled = false;
  }
}
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = new FormData(searchForm);
  void findMeetings(fields.get("query"), true, true, false, fields.get("context"));
});
document.querySelector("#recent-meetings").addEventListener("click", () => { searchForm.reset(); void findMeetings(""); });
document.querySelector("#recent-actions").addEventListener("click", () => void findMeetings("", true, true, true));
const initialLibraryLoad = findMeetings("", false, false);
document.querySelector("#select-vault").addEventListener("click", async () => {
  try {
    const path = await window.stillwater.selectVault();
    if (path) { await findMeetings(""); document.dispatchEvent(new Event("workspace-view")); }
  } catch (error) {
    status.textContent = error.message;
  }
});
const openSaved = document.querySelector("#open-meeting");
const enhance = document.querySelector("#enhance-meeting");
const discoverModels = document.querySelector("#discover-models");
const localModels = document.querySelector("#local-models");
const discoveryStatus = document.querySelector("#model-discovery-status");
const availableModel = document.querySelector("#available-model");
const availableLabel = document.querySelector("#available-model-label");
availableModel.addEventListener("change", () => {
  if (availableModel.value) {
    draftModel.value = availableModel.value;
    rememberModel();
  }
});
const keyInput = document.querySelector("#provider-key");
const keyStatus = document.querySelector("#provider-key-status");
const keySave = document.querySelector("#save-provider-key");
const keyRemove = document.querySelector("#remove-provider-key");
const isHostedProvider = () => ["openai","anthropic"].includes(draftProvider.value);
let statusRequest = 0;
async function refreshProvider() {
  const version = ++statusRequest;
  const provider = draftProvider.value;
  localModels.replaceChildren();
  discoveryStatus.textContent = "";
  availableLabel.hidden = true;
  keyInput.value = "";
  keyRemove.hidden = true;
  keyStatus.textContent = "";
  document.querySelector("#hosted-settings").hidden = !isHostedProvider();
  if (!isHostedProvider()) return;
  const name = draftProvider.selectedOptions[0].textContent;
  document.querySelector("#hosted-disclosure").textContent = "Enhancing notes or asking a question sends relevant meeting text to " + name + ". Recording and transcription stay on this device.";
  try {
    const saved = await window.stillwater.hasProviderKey(provider);
    if (version !== statusRequest) return;
    keyStatus.textContent = saved ? "API key saved on this device." : "Add an API key to use " + name + ".";
    keyInput.placeholder = saved ? "Replace saved key" : "Enter API key";
    keyRemove.hidden = !saved;
  } catch (error) {
    if (version === statusRequest) { keyStatus.textContent = error.message; keyRemove.hidden = false; }
  }
}
draftProvider.addEventListener("change", () => {
  localStorage.setItem("stillwater-draft-provider", draftProvider.value);
  draftModel.value = localStorage.getItem(modelPreference(draftProvider.value)) ?? defaultModel(draftProvider.value);
  void refreshProvider();
});
async function updateKey(remove) {
  const key = remove ? null : keyInput.value.trim();
  if (!remove && !key) { keyStatus.textContent = "Enter an API key."; keyInput.focus(); return; }
  keySave.disabled = keyRemove.disabled = draftProvider.disabled = discoverModels.disabled = true;
  try {
    await window.stillwater.saveProviderKey(draftProvider.value,key);
    await refreshProvider();
    if (remove) keyStatus.textContent = "API key removed.";
  } catch (error) {
    keyStatus.textContent = error.message;
  } finally {
    keySave.disabled = keyRemove.disabled = draftProvider.disabled = discoverModels.disabled = false;
  }
}
keySave.addEventListener("click", () => void updateKey(false));
keyRemove.addEventListener("click", () => void updateKey(true));
void refreshProvider();
discoverModels.addEventListener("click", async () => {
  discoverModels.disabled = draftProvider.disabled = keySave.disabled = keyRemove.disabled = true;
  localModels.replaceChildren();
  discoveryStatus.textContent = "Finding available models…";
  try {
    const models = await window.stillwater.listLocalModels(draftProvider.value);
    localModels.replaceChildren(...models.map((model) => new Option(model, model)));
    availableModel.replaceChildren(new Option("Select a model", ""), ...models.map(id => new Option(id,id)));
    availableModel.value = models.includes(draftModel.value) ? draftModel.value : "";
    availableLabel.hidden = !models.length;
    discoveryStatus.textContent = models.length
      ? "Found " + models.length + " available models."
      : "No compatible models were listed. You can enter a model ID.";
  } catch (error) {
    discoveryStatus.textContent = error.message;
  } finally {
    discoverModels.disabled = draftProvider.disabled = keySave.disabled = keyRemove.disabled = false;
  }
});
const enhancement = document.querySelector("#enhancement");
const historySelect = document.querySelector("#draft-history");
let drafts = [];
const editor = document.querySelector("#enhanced-editor");
const useDraft = document.querySelector("#use-draft");
const noteState = document.querySelector("#note-save-state");
let openedBundle;
let openedMeetingId;
let transcriptRevision = 1;
let displayedRevision = 1;
const refine = document.querySelector("#refine-meeting");
const currentTranscript = document.querySelector("#current-transcript");
const reviewFlag = document.querySelector("#flag-transcript");
reviewFlag.addEventListener("click", async () => {
  const bundle = openedBundle;
  const revision = displayedRevision;
  reviewFlag.disabled = true;
  try {
    await window.stillwater.flagTranscript(bundle, revision);
    if (bundle === openedBundle && revision === displayedRevision) reviewFlag.textContent = "Flagged for review";
    status.textContent = "Transcript flagged for local review.";
  } catch (error) {
    if (bundle === openedBundle && revision === displayedRevision) reviewFlag.disabled = false;
    status.textContent = error.message;
  }
});
const savedSearch = document.querySelector("#saved-transcript-search");
function filterSavedTranscript() {
  const query = savedSearch.value.trim().toLocaleLowerCase();
  let matches = 0;
  for (const line of document.querySelector("#saved-transcript").children) {
    line.hidden = Boolean(query) && !line.textContent.toLocaleLowerCase().includes(query);
    if (!line.hidden) matches++;
  }
  document.querySelector("#saved-transcript-matches").textContent = query
    ? matches + (matches === 1 ? " matching passage" : " matching passages") : "";
}
savedSearch.addEventListener("input", filterSavedTranscript);
document.querySelector("#copy-saved-transcript").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#saved-transcript").textContent);
    status.textContent = "Transcript copied.";
  } catch (error) { status.textContent = error.message; }
});
function showSavedTranscript(meeting) {
  savedSearch.value = "";
  document.querySelector("#saved-transcript-matches").textContent = meeting.segments.length ? "" : "No transcript passages.";
  document.querySelector("#copy-saved-transcript").disabled = !meeting.segments.length;
  transcriptRevision = meeting.metadata.transcriptRevision;
  displayedRevision = meeting.revision;
  reviewFlag.disabled = meeting.flagged || !meeting.segments.length;
  reviewFlag.textContent = meeting.flagged ? "Flagged for review" : "Flag for review";
  document.querySelector("#transcript-revision").textContent = `Revision ${displayedRevision}`;
  currentTranscript.hidden = displayedRevision === transcriptRevision;
  refine.disabled = meeting.metadata.recordings?.length !== 2;
  document.querySelector("#refine-unavailable").hidden = !refine.disabled;
  document.querySelector("#saved-transcript").replaceChildren(...meeting.segments.map((segment) => {
    const line = document.createElement("span");
    line.id = "segment-" + segment.id;
    line.dataset.startMs = String(segment.startMs);
    line.dataset.endMs = String(segment.endMs);
    line.textContent = `${(segment.startMs / 1000).toFixed(1)} s · ${segment.source}: ${segment.text}\n`;
    return line;
  }));
}
async function showTranscriptRevision(revision, anchor) {
  const bundle = openedBundle;
  try {
    if (displayedRevision !== revision) {
      const meeting = await window.stillwater.transcriptRevision(bundle, revision);
      if (openedBundle !== bundle) return;
      showSavedTranscript(meeting);
    }
    if (anchor) revealTranscriptSegment(anchor);
  } catch (error) {
    status.textContent = error.message;
  }
}
currentTranscript.addEventListener("click", () => void showTranscriptRevision(transcriptRevision));
const questionForm = document.querySelector("#meeting-question");
const vaultQuestion = document.querySelector("#vault-question");
vaultQuestion.addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#vault-answer");
  const button = vaultQuestion.querySelector("button");
  button.disabled = true;
  output.textContent = "Asking the selected model…";
  try {
    const answer = await window.stillwater.askVault(
      vaultQuestion.elements.question.value, draftModel.value, draftProvider.value);
    renderMarkdown(output, answer?.text ?? "");
    for (const citation of answer?.citations ?? []) {
      const source = document.createElement("button");
      source.type = "button";
      source.textContent = citation.title;
      source.title = citation.text;
      source.addEventListener("click", () => void openSavedMeeting(citation.bundle, citation.anchor, false, citation.revision));
      output.append(source);
    }
  } catch (error) {
    output.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
const meetingAnswer = document.querySelector("#meeting-answer");
questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = questionForm.querySelector("button");
  button.disabled = true;
  meetingAnswer.textContent = "Asking the selected model…";
  try {
    const answer = await window.stillwater.askMeeting(
      questionForm.elements.question.value, draftModel.value, draftProvider.value);
    renderMarkdown(meetingAnswer, answer.text);
    for (const citation of answer.citations) {
      const source = document.createElement("button");
      source.type = "button";
      source.textContent = citation.anchor ? "Transcript " + citation.ref : "Meeting notes";
      source.title = citation.text;
      source.addEventListener("click", () => {
        if (citation.anchor) void showTranscriptRevision(answer.revision, citation.anchor);
        else editor.scrollIntoView({ block: "center" });
      });
      meetingAnswer.append(source);
    }
  } catch (error) {
    meetingAnswer.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
refine.addEventListener("click", async () => {
  refine.disabled = true;
  status.textContent = "Refining transcript with the selected local speech model…";
  try {
    const meeting = await window.stillwater.refineMeeting(openedBundle, form.elements.language.value);
    showSavedTranscript(meeting);
    showHistory(meeting.enhancements);
    status.textContent = `Saved transcript revision ${transcriptRevision}.`;
  } catch (error) {
    refine.disabled = false;
    status.textContent = error.message;
  }
});
let archivedMeeting = false;
const archiveButton = document.querySelector("#archive-meeting");
archiveButton.addEventListener("click", async () => {
  archiveButton.disabled = true;
  try {
    openedBundle = await window.stillwater.archiveMeeting(openedBundle, !archivedMeeting);
    archivedMeeting = !archivedMeeting;
    archiveButton.textContent = archivedMeeting ? "Restore meeting" : "Archive meeting";
    status.textContent = archivedMeeting ? "Meeting archived." : "Meeting restored.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    archiveButton.disabled = false;
  }
});
const contextEditor = document.querySelector("#meeting-contexts");
const savedTitle = document.querySelector("#saved-title");
const renameTitle = document.querySelector("#rename-title");
const titleEditor = document.querySelector("#title-editor");
const titleStatus = document.querySelector("#title-status");

function displayMeetingTitle(title) {
  savedTitle.textContent = title;
  renameTitle.setAttribute("aria-label", "Edit meeting title: " + title);
  renameTitle.hidden = false;
  titleEditor.hidden = true;
  titleEditor.readOnly = false;
  titleStatus.textContent = "";
}
renameTitle.addEventListener("click", () => {
  titleEditor.value = savedTitle.textContent;
  renameTitle.hidden = true;
  titleEditor.hidden = false;
  titleEditor.focus();
  titleEditor.select();
});
async function commitMeetingTitle(restoreFocus) {
  if (titleEditor.hidden || titleEditor.readOnly) return;
  const bundle = openedBundle;
  const proposed = titleEditor.value.trim();
  if (!proposed) {
    titleStatus.textContent = "Enter a meeting title, or press Escape to keep the original.";
    return;
  }
  titleEditor.readOnly = true;
  try {
    if (proposed === savedTitle.textContent) {
      displayMeetingTitle(proposed);
      if (restoreFocus) renameTitle.focus();
      return;
    }
    const meetingId = openedMeetingId;
    const title = await window.stillwater.renameMeeting(bundle, proposed);
    for (const label of document.querySelectorAll("[data-title-bundle]")) {
      if (label.dataset.titleBundle.endsWith("--" + meetingId)) {
        label.textContent = title + (label.dataset.archived === "true" ? " · Archived" : "");
      }
    }
    if (bundle !== openedBundle) return;
    displayMeetingTitle(title);
    titleStatus.textContent = "Title saved";
    if (restoreFocus && workspaceView === "meeting") renameTitle.focus();
  } catch (error) {
    if (bundle !== openedBundle) return;
    titleEditor.readOnly = false;
    titleStatus.textContent = error.message.replace(/^Error invoking remote method 'meeting:rename': Error: /, "");
  }
}
titleEditor.addEventListener("blur", () => void commitMeetingTitle(false));
titleEditor.addEventListener("keydown", event => {
  if (event.isComposing || titleEditor.readOnly) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void commitMeetingTitle(true);
  } else if (event.key === "Escape") {
    event.preventDefault();
    displayMeetingTitle(savedTitle.textContent);
    renameTitle.focus();
  }
});

const saveContexts = document.querySelector("#save-contexts");
saveContexts.addEventListener("click", async () => {
  saveContexts.disabled = true;
  try {
    await window.stillwater.saveMeetingContexts(openedBundle, contextEditor.value);
    document.dispatchEvent(new Event("workspace-view"));
    status.textContent = "Saved meeting contexts.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    saveContexts.disabled = false;
  }
});
let savedNotes = { text: "", revision: null };
let enhancedDraftKey;
let enhancedDraftBase = null;
const enhancedConflict = document.querySelector("#enhanced-conflict");
function showEnhancedConflict() {
  const conflict = editor.value !== savedNotes.text && enhancedDraftBase !== savedNotes.revision;
  enhancedConflict.hidden = !conflict;
  document.querySelector("#enhanced-conflict-text").textContent = conflict ? savedNotes.text : "";
}
function rememberEnhancedDraft() {
  if (!enhancedDraftKey) return;
  if (editor.value === savedNotes.text) {
    localStorage.removeItem(enhancedDraftKey);
    enhancedDraftBase = savedNotes.revision;
  } else {
    localStorage.setItem(enhancedDraftKey, JSON.stringify({ text: editor.value, revision: enhancedDraftBase }));
  }
  showEnhancedConflict();
  renderNoteCitations();
}
const reader = document.querySelector("#meeting-note-citations");
const editNotes = document.querySelector("#edit-meeting-notes");
function setNoteEditing(editing) {
  editor.hidden = !editing;
  editNotes.textContent = editing ? "Read notes" : "Edit notes";
  reader.hidden = editing;
  if (!editing) renderNoteCitations();
}
editNotes.addEventListener("click", () => {
  const editing = editor.hidden;
  setNoteEditing(editing);
  if (editing) editor.focus();
});
const markdown = window.markdownit({ html: false, breaks: true, linkify: false });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
function renderMarkdown(container, text) {
  container.innerHTML = markdown.render(text);
  let citationNumber = 0;
  for (const link of container.querySelectorAll("a")) {
    const target = link.getAttribute("href");
    const citation = /^transcript(?:-r(\d+))?\.md#([\w-]+)$/.exec(target);
    const moment = /^#moment-(\d+)$/.exec(target);
    if (moment) {
      link.addEventListener("click", async event => {
        event.preventDefault();
        await showTranscriptRevision(transcriptRevision);
        const ms = Number(moment[1]);
        const distance = line => Math.max(0, Number(line.dataset.startMs)-ms, ms-Number(line.dataset.endMs));
        const lines = [...document.querySelectorAll("#saved-transcript [data-start-ms]")];
        const nearest = lines.sort((a,b)=>distance(a)-distance(b))[0];
        if (nearest) revealTranscriptSegment(nearest.id.slice(8));
        else status.textContent = "No transcript passages in this meeting.";
      });
      continue;
    }
    if (!citation) {
      link.replaceWith(document.createTextNode(link.textContent + " (" + target + ")"));
      continue;
    }
    link.href = "#segment-" + citation[2];
    if (container === reader && link.textContent === "Transcript") {
      link.className = "note-citation";
      const number = ++citationNumber;
      link.textContent = String(number);
      link.setAttribute("aria-label", "Open transcript citation " + number);
      link.title = "Open transcript citation " + number;
    }
    link.addEventListener("click", event => {
      event.preventDefault();
      void showTranscriptRevision(Number(citation[1] ?? 1), citation[2]);
    });
  }
}
function renderNoteCitations() {
  if (reader.hidden) return;
  renderMarkdown(reader, editor.value);
  if (!reader.childElementCount) reader.textContent = "No written notes yet.";
}
let saveTimer;
let saveInFlight;
function queueNoteSave() {
  rememberEnhancedDraft();
  clearTimeout(saveTimer);
  noteState.textContent = "Saving…";
  saveTimer = setTimeout(() => void flushNoteSave(), 450);
}
async function flushNoteSave() {
  clearTimeout(saveTimer);
  if (saveInFlight) return saveInFlight.then(ok => ok ? flushNoteSave() : false);
  if (editor.value === savedNotes.text) {
    if (noteState.textContent === "Saving…") noteState.textContent = "Saved";
    return true;
  }
  if (!openedBundle || enhancedDraftBase !== savedNotes.revision) {
    noteState.textContent = "Review conflicting edits";
    return false;
  }
  if (noteWritePaused) { noteState.textContent = "Draft saved locally"; return false; }
  const bundle = openedBundle;
  const text = editor.value;
  saveInFlight = (async () => {
    try {
      const result = await window.stillwater.saveEnhancedNotes(bundle, text, savedNotes.revision);
      if (bundle !== openedBundle) return false;
      if (result.busy) {
        noteState.textContent = "Draft saved locally";
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void flushNoteSave(), 800);
        return false;
      }
      if (result.conflict) {
        savedNotes = result.conflict;
        rememberEnhancedDraft();
        noteState.textContent = "Review conflicting edits";
        return false;
      }
      savedNotes = result.saved;
      enhancedDraftBase = savedNotes.revision;
      rememberEnhancedDraft();
      noteState.textContent = "Saved";
      if (workspaceView === "meeting") status.textContent = "Saved meeting notes.";
      return true;
    } catch (error) {
      noteState.textContent = "Draft saved locally";
      status.textContent = error.message;
      return false;
    }
  })();
  const ok = await saveInFlight;
  saveInFlight = undefined;
  if (ok && bundle === openedBundle && editor.value !== savedNotes.text) return flushNoteSave();
  return ok;
}
let noteWritePaused = false;
editor.addEventListener("input", queueNoteSave);

useDraft.addEventListener("click", () => {
  const record = drafts.find((item) => item.id === historySelect.value);
  if (!record) return;
  const transcriptFile = record.transcriptRevision === 1 ? "transcript.md" : `transcript-r${record.transcriptRevision}.md`;
  const draft = record.draft.outline ?? [record.draft.summary, ...record.draft.actions.map((action) =>
    `- ${action.text} ${action.segmentIds.map((id) => `[Transcript](${transcriptFile}#${id})`).join(" ")}`)].join("\n\n");
  if (editor.value.trim() && !window.confirm("Replace the current meeting notes with this draft?")) return;
  setNoteEditing(true);
  editor.value = draft;
  queueNoteSave();
  editor.focus();
});

document.querySelector("#resolve-note-conflict").addEventListener("click", async () => {
  if (!window.confirm("Replace the saved version with your edits?")) return;
  enhancedDraftBase = savedNotes.revision;
  await flushNoteSave();
});

function showDraft() {
  enhancement.replaceChildren();
  const record = drafts.find((item) => item.id === historySelect.value);
  useDraft.disabled = !record;
  if (!record) return;
  const summary = document.createElement("div");
  summary.className = "note-document";
  renderMarkdown(summary, record.draft.outline ?? record.draft.summary);
  if (record.draft.outline) { enhancement.append(summary); return; }
  const actions = document.createElement("ul");
  for (const action of record.draft.actions) {
    const item = document.createElement("li");
    item.append(action.text);
    for (const [index, id] of action.segmentIds.entries()) {
      const link = document.createElement("a");
      link.href = "#segment-" + id;
      link.textContent = `[${index + 1}]`;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void showTranscriptRevision(record.transcriptRevision, id);
      });
      item.append(" ", link);
    }
    actions.append(item);
  }
  enhancement.append(summary, actions);
}

function showHistory(records) {
  drafts = records;
  historySelect.replaceChildren(...drafts.map((record) =>
    new Option(`${new Date(record.createdAt).toLocaleString()} · ${record.model}${record.stale ? " · Older inputs" : ""}`, record.id)));
  historySelect.disabled = !drafts.length;
  showDraft();
}

historySelect.addEventListener("change", showDraft);

const cancelEnhancement = document.querySelector("#cancel-enhancement");
cancelEnhancement.addEventListener("click", () => void window.stillwater.cancelEnhancement());
enhance.addEventListener("click", async () => {
  const bundle = openedBundle;
  const report = message => {
    if (workspaceView === "meeting" && openedBundle === bundle) status.textContent = message;
  };
  enhance.disabled = true;
  await flushNoteSave();
  noteWritePaused = true;
  cancelEnhancement.hidden = false;
  report("Analyzing transcript and building the outline…");
  try {
    const result = await window.stillwater.enhanceMeeting(
      draftModel.value, draftProvider.value);
    if (!result) {
      report("Generation canceled.");
      return;
    }
    const { record, current } = result;
    const isUneditedOutline = drafts.some(({ draft }) => draft.outline === savedNotes.text);
    showHistory([record, ...drafts]);
    if (current.revision !== savedNotes.revision) {
      if (editor.value === savedNotes.text) editor.value = current.text;
      savedNotes = current;
      rememberEnhancedDraft();
      report("Saved a new generation draft. The saved enhanced notes also changed on disk.");
    } else if (record.draft.transcriptSegmentCount > 0 && !record.draft.generatedLines.length) {
      const count = record.draft.transcriptSegmentCount;
      report(`Reviewed ${count} transcript ${count === 1 ? "passage" : "passages"}. No new supported details to add. Your notes were kept.`);
    } else if (editor.value === savedNotes.text && (savedNotes.revision === null || isUneditedOutline || result.usedSavedWriting)) {
      editor.value = record.draft.outline;
      rememberEnhancedDraft();
      noteWritePaused = false;
      if (await flushNoteSave()) {
        setNoteEditing(false);
        const additions = record.draft.generatedLines.length;
        report(additions ? `Enhanced with ${additions} cited transcript ${additions === 1 ? "addition" : "additions"}.`
          : "Notes organized. No additional transcript findings were included.");
      }
    } else {
      document.querySelector("#draft-history-panel").open = true;
      report("New outline is ready in Draft history. Your edited notes were kept.");
    }
  } catch (error) {
    report(error.message);
  } finally {
    noteWritePaused = false;
    if (editor.value !== savedNotes.text && enhancedDraftBase === savedNotes.revision) queueNoteSave();
    enhance.disabled = false;
    cancelEnhancement.hidden = true;
  }
});

async function openSavedMeeting(result, anchor, contextBrowser = false, revision, calendarEvent) {
  if (openedBundle && editor.value !== savedNotes.text) await flushNoteSave();
  openSaved.disabled = true;
  try {
    rememberEnhancedDraft();
    const meeting = calendarEvent
      ? await window.stillwater.openCalendarMeeting(calendarEvent.id, calendarEvent.start)
      : await window.stillwater.openMeeting(result, contextBrowser);
    if (!meeting) return false;
    openedBundle = meeting.bundle;
    openedMeetingId = meeting.metadata.meetingId;
    meetingAnswer.replaceChildren();
    archivedMeeting = meeting.archived;
    archiveButton.textContent = archivedMeeting ? "Restore meeting" : "Archive meeting";
    contextEditor.value = (meeting.metadata.contexts ?? []).filter((context) => context.status === "confirmed")
      .map(({ kind, name }) => `${kind}: ${name}`).join("\n");
    savedNotes = meeting.enhancedNotes.revision === null
      ? { ...meeting.enhancedNotes, text: meeting.notes.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/, "") }
      : meeting.enhancedNotes;
    enhancedDraftKey = "stillwater-enhanced-draft:" + meeting.metadata.meetingId;
    const draft = JSON.parse(localStorage.getItem(enhancedDraftKey) ?? "null");
    editor.value = draft?.text ?? savedNotes.text;
    enhancedDraftBase = draft ? draft.revision : savedNotes.revision;
    showEnhancedConflict();
    noteState.textContent = draft ? "Draft saved locally" : "";
    setNoteEditing(Boolean(draft));
    if (draft && enhancedDraftBase === savedNotes.revision) queueNoteSave();
    showHistory(meeting.enhancements);
    displayMeetingTitle(meeting.metadata.title);
    const date = document.querySelector("#saved-date");
    date.dateTime = meeting.metadata.createdAt;
    date.textContent = new Date(meeting.metadata.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" });
    document.querySelector("#saved-participants").textContent = meeting.metadata.participants?.join(", ") || "Me";
    showSavedTranscript(meeting);
    document.querySelector("#saved-transcript-panel").open = false;
    showWorkspace("meeting");
    if (revision && revision !== displayedRevision) await showTranscriptRevision(revision, anchor);
    else if (anchor) revealTranscriptSegment(anchor);
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    openSaved.disabled = false;
  }
}
function revealTranscriptSegment(anchor) {
  const segment = document.getElementById("segment-" + anchor);
  if (!segment) return;
  if (segment.hidden) { savedSearch.value = ""; filterSavedTranscript(); }
  document.querySelector("#saved-transcript-panel").open = true;
  segment.scrollIntoView({ block: "center" });
}
openSaved.addEventListener("click", () => void openSavedMeeting());
const browseContexts = document.querySelector("#browse-contexts");
browseContexts.addEventListener("click", async () => {
  browseContexts.disabled = true;
  try {
    const groups = await window.stillwater.browseContexts();
    if (!groups) return;
    selectLibraryView("browse-contexts");
    document.querySelector("#library-title").textContent = "Contexts";
    document.querySelector("#meeting-results").hidden = true;
    document.querySelector("#context-results").replaceChildren(...groups.map((group) => {
      const details = document.createElement("details");
      const title = document.createElement("summary");
      title.textContent = `${group.kind}: ${group.name}`;
      const meetings = document.createElement("ul");
      for (const meeting of group.meetings) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.dataset.titleBundle = meeting.bundle;
        button.dataset.archived = String(Boolean(meeting.archived));
        button.textContent = meeting.title + (meeting.archived ? " · Archived" : "");
        button.addEventListener("click", () => void openSavedMeeting(meeting.bundle, undefined, true));
        item.append(button);
        meetings.append(item);
      }
      details.append(title, meetings);
      return details;
    }));
    status.textContent = groups.length ? `Found ${groups.length} contexts.` : "No meeting contexts yet.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    browseContexts.disabled = false;
  }
});

recover.addEventListener("click", async () => {
  recover.disabled = true;
  status.textContent = "Choose an interrupted recording and a vault folder.";
  try {
    await captureRelease;
    const fields = new FormData(form);
    const { calendarId, calendarStart } = form.dataset;
    const result = await window.stillwater.recoverCapture(fields.get("title"), fields.get("notes"), fields.get("language"),
      fields.get("participants"), calendarId, calendarStart, fields.get("filing"));
    if (result) {
      transcript.textContent = result.segments.map((segment) => `${segment.source}: ${segment.text}`).join("\n");
      clearSavedDraft(fields, calendarId, calendarStart);
      await findMeetings("", false);
    }
    status.textContent = result ? "Recording recovered and saved." : "Recovery cancelled.";
    if (result?.temporaryAudioRemains) status.textContent += ". Stillwater could not remove the temporary audio.";
  } catch (error) {
    status.textContent = error.message.replace(/^Error invoking remote method 'capture:recover': Error: /, "");
  } finally {
    recover.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = "Choose a recording and vault folder to transcribe locally.";
  try {
    const fields = new FormData(form);
    const { calendarId, calendarStart } = form.dataset;
    const result = await window.stillwater.importMeeting(fields.get("title"), fields.get("notes"), fields.get("language"),
      fields.get("participants"), calendarId, calendarStart, fields.get("filing"));
    if (!result) {
      status.textContent = "Import cancelled.";
      return;
    }
    transcript.textContent = result.segments.map((segment) => segment.text).join("\n");
    clearSavedDraft(fields, calendarId, calendarStart);
    await findMeetings("", false);
    status.textContent = "Recording imported and saved.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const ribbon = document.querySelector("#feature canvas");
new ResizeObserver(() => {
  const { width, height } = ribbon.getBoundingClientRect();
  if (!width || !height) return;
  const scale = window.devicePixelRatio;
  ribbon.width = Math.round(width * scale);
  ribbon.height = Math.round(height * scale);
  const context = ribbon.getContext("2d");
  context.scale(scale, scale);
  const ink = context.createLinearGradient(width * .42, 0, width, 0);
  ink.addColorStop(0, "transparent");
  ink.addColorStop(.45, "#dab2d0aa");
  ink.addColorStop(1, "#ffd9b6bb");
  context.strokeStyle = ink;
  for (let line = 0; line < 78; line++) {
    context.beginPath();
    for (let step = 0; step <= 120; step++) {
      const t = step / 120;
      const x = width * (.4 + t * .72);
      const y = height * (.18 + line * .011 + .29 * Math.sin(5.5*t + line*.019) + .18 * Math.cos(9*t - line*.023));
      if (!step) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }
}).observe(ribbon);
