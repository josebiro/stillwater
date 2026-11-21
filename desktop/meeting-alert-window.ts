import { BrowserWindow, ipcMain, powerMonitor, screen, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AlertEvent, joinLabel, planAlerts } from "./meeting-alerts.ts";

// Shows a small card in the corner of the screen about a minute before a calendar event starts.
// Its main button opens the event's call link in the browser and hands the event to the editor,
// which starts a note with the event's title and begins recording. Timing rules: meeting-alerts.ts.

type Options = {
  root: string;
  settingsDirectory: string;
  window: BrowserWindow;
  /** Today's calendar, read fresh on every pass. */
  events: () => AlertEvent[];
  /** Bring the main window forward and start a note for this event. */
  start: (event: AlertEvent) => void;
  openSettings: () => void;
};

const width = 400, height = 92, margin = 12;

export async function installMeetingAlerts(options: Options) {
  const file = join(options.settingsDirectory, "meeting-alerts.json");
  let enabled = true;
  try { enabled = JSON.parse(await readFile(file, "utf8")).enabled !== false; } catch { /* first run: on */ }

  const planned = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  let card: BrowserWindow | undefined;
  let ready: Promise<void> | undefined;
  let showing: { event: AlertEvent; key: string } | undefined;
  let hideTimer: NodeJS.Timeout | undefined;

  function place(tall = height) {
    const area = screen.getPrimaryDisplay().workArea;
    card?.setBounds({ x: area.x + area.width - width - margin, y: area.y + margin, width, height: tall });
  }
  function ensureCard() {
    if (card && !card.isDestroyed()) return ready!;
    card = new BrowserWindow({
      width, height, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true,
      alwaysOnTop: true, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
      title: "Meeting starting",
      webPreferences: { preload: join(options.root, "desktop/alert-preload.cjs") },
    });
    card.setAlwaysOnTop(true, "floating");
    card.webContents.on("will-navigate", (event) => event.preventDefault());
    card.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    ready = card.loadFile(join(options.root, "desktop/alert.html"));
    return ready;
  }
  function hide() {
    clearTimeout(hideTimer);
    showing = undefined;
    if (card && !card.isDestroyed()) card.hide();
  }
  const clock = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  /** Ask the editor whether it is already recording this very event; if so the alert would only be noise. */
  function alreadyRecording(event: AlertEvent) {
    return new Promise<boolean>((resolve) => {
      if (options.window.isDestroyed()) return resolve(false);
      const done = (_event: unknown, id: unknown, start: unknown, busy: unknown) => {
        if (id !== event.id || start !== event.start) return;
        clearTimeout(timeout);
        ipcMain.removeListener("alert:recording", done);
        resolve(busy === true);
      };
      const timeout = setTimeout(() => { ipcMain.removeListener("alert:recording", done); resolve(false); }, 1000);
      ipcMain.on("alert:recording", done);
      options.window.webContents.send("alert:ask-recording", event.id, event.start);
    });
  }

  async function present(event: AlertEvent, key: string, stay: number) {
    timers.delete(key);
    // One card at a time: with two meetings at once, the first keeps the screen.
    if (!enabled || (showing && key !== "preview") || await alreadyRecording(event)) return;
    await ensureCard();
    if (!card || card.isDestroyed()) return;
    showing = { event, key };
    place();
    card.webContents.send("alert:show", {
      title: event.title,
      time: clock(event.start) + (event.end ? " – " + clock(event.end) : ""),
      label: joinLabel(event),
      canJoin: Boolean(event.join),
    });
    // Shown without taking the keyboard away from whatever the person is typing in.
    card.showInactive();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, Math.max(5000, stay));
  }

  function pass() {
    if (!enabled) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear(); planned.clear(); hide();
      return;
    }
    for (;;) {
      const plan = planAlerts(options.events(), Date.now(), planned);
      for (const key of plan.cancel) {
        // The event moved or was removed since its alert was planned.
        clearTimeout(timers.get(key)); timers.delete(key); planned.delete(key);
        if (showing?.key === key) hide();
      }
      if (!plan.show) break;
      const { event, key, delay, stay } = plan.show;
      planned.add(key);
      timers.set(key, setTimeout(() => void present(event, key, stay), delay));
    }
  }

  async function openCall(event: AlertEvent) {
    const address = event.join?.url;
    if (!address || new URL(address).protocol !== "https:") return;
    await shell.openExternal(address);
  }
  const fromCard = (event: Electron.IpcMainEvent) => Boolean(card && !card.isDestroyed() && event.sender === card.webContents);
  ipcMain.on("alert:act", (event, action) => {
    if (!fromCard(event) || !showing) return;
    const current = showing.event;
    hide();
    if (action === "start" || action === "join") void openCall(current).catch(() => undefined);
    if (action === "start" || action === "notes") options.start(current);
    if (action === "settings") options.openSettings();
  });
  ipcMain.on("alert:resize", (event, tall) => {
    if (fromCard(event) && Number.isFinite(tall)) place(Math.max(height, Math.min(260, Math.ceil(tall))));
  });

  const interval = setInterval(pass, 30000);
  const first = setTimeout(pass, 2000);
  powerMonitor.on("resume", pass);
  options.window.once("closed", () => {
    clearInterval(interval); clearTimeout(first); clearTimeout(hideTimer);
    for (const timer of timers.values()) clearTimeout(timer);
    powerMonitor.removeListener("resume", pass);
    if (card && !card.isDestroyed()) card.destroy();
  });

  return {
    /** Call after the calendar changes. */
    refresh: pass,
    enabled: () => enabled,
    async setEnabled(value: boolean) {
      enabled = value;
      await writeFile(file, JSON.stringify({ enabled }));
      pass();
    },
    /** Show the card now for this event (the Settings test button and screenshots). */
    async preview(event: AlertEvent) {
      const was = enabled; enabled = true;
      await present(event, "preview", 20000);
      enabled = was;
      return card;
    },
  };
}
