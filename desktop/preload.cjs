const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stillwater", {
  onTrayNavigate: (callback) => {
    ipcRenderer.on("tray:navigate", (_event, view) => callback(view));
  },
  googleCalendar: (action,address) => ipcRenderer.invoke("calendar:google",action,address),
  readCalendar: () => ipcRenderer.invoke("calendar:read"),
  importCalendar: () => ipcRenderer.invoke("calendar:import"),
  selectVault: () => ipcRenderer.invoke("vault:select"),
  currentModel: () => ipcRenderer.invoke("model:current"),
  hasProviderKey: provider => ipcRenderer.invoke("model:key-status",provider),
  saveProviderKey: (provider,key) => ipcRenderer.invoke("model:save-key",provider,key),
  listLocalModels: (provider) => ipcRenderer.invoke("model:list-local", provider),
  selectModel: () => ipcRenderer.invoke("model:select"),
  downloadModel: () => ipcRenderer.invoke("model:download"),
  openMeeting: (result, contextBrowser) => ipcRenderer.invoke("meeting:open", result, contextBrowser),
  openCalendarMeeting: (id, start) => ipcRenderer.invoke("meeting:open-calendar", id, start),
  createNote: (title, notes, participants, calendarId, calendarStart, filing) =>
    ipcRenderer.invoke("meeting:create-note", title, notes, participants, calendarId, calendarStart, filing),
  browseContexts: () => ipcRenderer.invoke("meeting:browse-contexts"),
  archiveMeeting: (bundle, archived) => ipcRenderer.invoke("meeting:archive", bundle, archived),
  refineMeeting: (bundle, language) => ipcRenderer.invoke("meeting:refine", bundle, language),
  transcriptRevision: (bundle, revision) => ipcRenderer.invoke("meeting:transcript", bundle, revision),
  flagTranscript: (bundle, revision) => ipcRenderer.invoke("meeting:flag-transcript", bundle, revision),
  renameMeeting: (bundle, title) => ipcRenderer.invoke("meeting:rename", bundle, title),
  saveMeetingContexts: (bundle, value) => ipcRenderer.invoke("meeting:contexts", bundle, value),
  searchVault: (query, prompt, contextFilter) => ipcRenderer.invoke("meeting:search", query, prompt, false, contextFilter),
  recentActions: () => ipcRenderer.invoke("meeting:search", "", true, true),
  resolveSuggestion: (path, key, accept) => ipcRenderer.invoke("meeting:resolve-suggestion", path, key, accept),
  enhanceMeeting: (model, provider) => ipcRenderer.invoke("meeting:enhance", model, provider),
  cancelEnhancement: () => ipcRenderer.invoke("meeting:cancel-enhancement"),
  askMeeting: (question, model, provider) => ipcRenderer.invoke("meeting:ask", question, model, false, provider),
  askVault: (question, model, provider) => ipcRenderer.invoke("meeting:ask", question, model, true, provider),
  saveEnhancedNotes: (bundle, text, revision) => ipcRenderer.invoke("meeting:save-enhanced", bundle, text, revision),
  importMeeting: (title, notes, language, participants, calendarId, calendarStart, filing) =>
    ipcRenderer.invoke("meeting:import", title, notes, language, participants, calendarId, calendarStart, filing),
  beginCapture: (language, meetingMiB, totalMiB, keepRecording) =>
    ipcRenderer.invoke("capture:begin", language, meetingMiB, totalMiB, keepRecording),
  appendCapture: (offset, frames) => ipcRenderer.invoke("capture:frame", offset, frames),
  onCaptureSegment: (callback) => ipcRenderer.on("capture:segment", (_event, segment) => callback(segment)),
  onCapturePreview: (callback) => ipcRenderer.on("capture:preview", (_event, source, text) => callback(source, text)),
  onCaptureResumeFromSleep: (callback) => ipcRenderer.on("capture:resume-from-sleep", () => callback()),
  endCapture: (complete, title, notes, keepRecording, participants, review, calendarId, calendarStart, filing, model, provider) =>
    ipcRenderer.invoke("capture:end", complete, title, notes, keepRecording, participants, review, calendarId, calendarStart, filing, model, provider),
  recoverCapture: (title, notes, language, participants, calendarId, calendarStart, filing) =>
    ipcRenderer.invoke("capture:recover", title, notes, language, participants, calendarId, calendarStart, filing),
});
