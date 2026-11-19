import { app, contentTracing, dialog, Menu, nativeImage, Tray, type BrowserWindow } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { checkLocalRelease } from "./update-check.ts";

export function stillwaterIcon() {
  const size = 24;
  const pixels = Buffer.alloc(size * size * 4);
  const heights = [4, 9, 15, 10, 5];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - 11.5) ** 2 + (y - 11.5) ** 2 > 121) continue;
      const offset = (y * size + x) * 4;
      const bar = Math.floor((x - 5) / 3);
      const mark = x >= 5 && x <= 18 && (x - 5) % 3 < 2 && Math.abs(y - 11.5) < heights[bar] / 2;
      pixels.set(mark ? [33, 49, 18, 255] : [199, 222, 138, 255], offset);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}

export async function recordPerformanceTrace(folder: string) {
  await mkdir(folder, { recursive: true });
  await contentTracing.startRecording({ included_categories: ["toplevel", "disabled-by-default-toplevel.flow"] });
  await setTimeout(10000);
  return await contentTracing.stopRecording(join(folder, `performance-${randomUUID()}.pftrace`));
}

export function installTray(window: BrowserWindow, prepareExit: () => Promise<boolean>) {
  const tray = new Tray(stillwaterIcon());
  tray.setToolTip("Stillwater");
  let tracing = false;
  let quitting = false;
  let preparingExit = false;
  let updateStatus = "Updates haven’t been checked";
  let checkingUpdates = false;
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  function show(view?: "editor" | "settings") {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (view) window.webContents.send("tray:navigate", view);
  }
  async function trace() {
    if (tracing) return;
    tracing = true;
    try {
      const folder = join(app.getPath("userData"), "diagnostics");
      const path = await recordPerformanceTrace(folder);
      show();
      await dialog.showMessageBox(window, { message: "Performance trace saved locally", detail: path });
    } catch (error) {
      show();
      await dialog.showMessageBox(window, { type: "error", message: "Could not save performance trace", detail: String(error) });
    } finally {
      tracing = false;
    }
  }
  async function exit(restart: boolean) {
    if (preparingExit || quitting) return;
    preparingExit = true;
    try {
      if (tracing || !(await prepareExit())) {
        show();
        await dialog.showMessageBox(window, { message: "Finish the current operation before closing Stillwater." });
        return;
      }
      window.webContents.session.flushStorageData();
      quitting = true;
      if (restart) app.relaunch();
      app.quit();
    } catch (error) {
      quitting = false;
      show();
      await dialog.showMessageBox(window, {
        type: "error", message: "Could not close Stillwater", detail: String(error),
      });
    } finally {
      preparingExit = false;
    }
  }
  async function checkUpdates() {
    if (checkingUpdates) return;
    checkingUpdates = true;
    show();
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: "Choose a Stillwater release manifest",
        properties: ["openFile"], filters: [{ name: "Release manifest", extensions: ["json"] }],
      });
      if (selected.canceled) return;
      const result = await checkLocalRelease(selected.filePaths[0], app.getVersion());
      updateStatus = result.available ? `Update available · v${result.version}` : "Up to date with selected release";
      await dialog.showMessageBox(window, { message: updateStatus });
    } catch (error) {
      updateStatus = "Update check failed";
      await dialog.showMessageBox(window, { type: "error", message: updateStatus, detail: String(error) });
    } finally {
      checkingUpdates = false;
      refreshMenu();
    }
  }
  function refreshMenu() {
    const menu = Menu.buildFromTemplate([
    { label: "Open Stillwater", click: () => show() },
    { id: "new-note", label: "New Note", click: () => show("editor") },
    { id: "settings", label: "Settings", click: () => show("settings") },
    { type: "separator" },
    { label: `Stillwater v${app.getVersion()}`, enabled: false },
    { label: updateStatus, enabled: false },
    { label: "Check for updates…", click: () => void checkUpdates() },
    { label: "Troubleshooting", submenu: [{ label: "Record Performance Trace (10s)", click: () => void trace() }] },
    { type: "separator" },
    { label: "Hide window", click: () => window.hide() },
    { id: "restart", label: "Restart Stillwater", click: () => void exit(true) },
    { id: "exit", label: "Exit Stillwater", click: () => void exit(false) },
    ]);
    tray.setContextMenu(menu);
    return menu;
  }
  const menu = refreshMenu();
  tray.on("click", () => show());
  window.once("closed", () => tray.destroy());
  return { tray, menu };
}
