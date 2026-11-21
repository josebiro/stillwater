// Before-meeting alerts: the timing rules, call-link detection, and the card's main button
// ending in a titled note that starts recording. Run: npm run check:alerts
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const electron = require("electron");
const { app, BrowserWindow } = electron;

(async () => {
  const root = process.cwd(), profile = await fs.mkdtemp(join(tmpdir(), "stillwater-alerts-"));
  app.setPath("userData", profile);
  app.setAppPath(root);
  const vault = join(profile, "vault");
  await fs.mkdir(vault);
  await fs.writeFile(join(profile, "vault-path.txt"), vault);
  const load = name => import(pathToFileURL(join(root, "desktop", name)));
  const { joinLink, planAlerts, alertable, alertKey, joinLabel } = await load("meeting-alerts.ts");
  const { parseCalendar } = await load("calendar.ts");

  // Call links: the conference field wins, then the description, then the location; pictures and http are ignored.
  assert.deepEqual(joinLink(undefined, "Agenda https://example.com/a.png and https://us02web.zoom.us/j/123456789?pwd=x.", "Room 4"),
    { url: "https://us02web.zoom.us/j/123456789?pwd=x", service: "Zoom" });
  assert.equal(joinLink("https://meet.google.com/abc-defg-hij", "https://zoom.us/j/1")?.service, "Google Meet");
  assert.equal(joinLink("http://zoom.us/j/1", "see https://example.com/notes"), undefined);
  assert.equal(joinLabel({ join: { url: "https://meet.google.com/x", service: "Google Meet" } }), "Join Meet");
  assert.equal(joinLabel({}), "Take notes");

  // Timing: planned inside 10 minutes, shown 58 seconds before the start, kept 4 minutes; late joins up to 4 minutes.
  const now = Date.parse("2026-11-20T10:00:00Z");
  const at = (minutes, extra = {}) => ({ id: "e" + minutes, title: "Sync", allDay: false, attendees: ["Maya"],
    start: new Date(now + minutes * 60000).toISOString(), end: new Date(now + (minutes + 30) * 60000).toISOString(), ...extra });
  assert.equal(planAlerts([at(11)], now, new Set()).show, undefined);
  let plan = planAlerts([at(9)], now, new Set());
  assert.equal(plan.show.delay, 9 * 60000 - 58000);
  assert.equal(plan.show.stay, 4 * 60000);
  plan = planAlerts([at(-2)], now, new Set());
  assert.deepEqual([plan.show.delay, plan.show.stay], [0, 2 * 60000]);
  assert.equal(planAlerts([at(-5)], now, new Set()).show, undefined);
  // Not for all-day events, declined ones, or a block with nobody else and no call.
  assert.ok(!alertable(at(1, { allDay: true })) && !alertable(at(1, { declined: true })) && !alertable(at(1, { attendees: undefined })));
  assert.ok(alertable(at(1, { attendees: undefined, join: { url: "https://zoom.us/j/1", service: "Zoom" } })));
  // One alert per event; an event that moves or disappears cancels its alert.
  const first = at(5), planned = new Set([alertKey(first)]);
  assert.equal(planAlerts([first], now, planned).show, undefined);
  assert.deepEqual(planAlerts([{ ...first, start: at(8).start }], now, planned).cancel, [alertKey(first)]);

  // The calendar feed: Google's conference field, a link in the description, and a declined invitation.
  const stamp = date => date.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const soon = new Date(Date.now() + 20000), later = new Date(soon.getTime() + 30 * 60000);
  const ics = ["BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:alert-fixture", "SUMMARY:Roadmap review", "DTSTART:" + stamp(soon), "DTEND:" + stamp(later),
    "DESCRIPTION:Join here: https://us02web.zoom.us/j/987654321?pwd=abc\\nAgenda to follow",
    "ATTENDEE;CN=Maya Chen;PARTSTAT=ACCEPTED:mailto:maya@example.com", "END:VEVENT",
    "BEGIN:VEVENT", "UID:declined-fixture", "SUMMARY:Skipped", "DTSTART:" + stamp(soon), "DTEND:" + stamp(later),
    "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
    "ATTENDEE;CN=Me;PARTSTAT=DECLINED:mailto:me@example.com", "END:VEVENT",
    "END:VCALENDAR"].join("\r\n");
  const parsed = parseCalendar(ics, new Date(), "me@example.com").events;
  assert.equal(parsed.find(e => e.id === "alert-fixture").join.url, "https://us02web.zoom.us/j/987654321?pwd=abc");
  const skipped = parsed.find(e => e.id === "declined-fixture");
  assert.ok(skipped.declined && skipped.join.service === "Google Meet");

  // End to end: the app shows the card for the event about to start; its button opens the call,
  // titles a note after the event and presses Start recording.
  // (An imported file has no owner, so only the first event goes in; two at once would show one card anyway.)
  await fs.writeFile(join(profile, "calendar.ics"), ics.split("BEGIN:VEVENT")[0] + "BEGIN:VEVENT" + ics.split("BEGIN:VEVENT")[1] + "END:VCALENDAR");
  const opened = [];
  electron.shell.openExternal = async url => { opened.push(url); };
  await load("main.ts");
  const main = BrowserWindow.getAllWindows()[0];
  main.webContents.setBackgroundThrottling(false);
  const until = async (test, message, tries = 400) => {
    for (let i = 0; i < tries; i++) { const value = await test(); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
    throw Error(message);
  };
  // Stand in for the recorder: note the press instead of opening the microphone.
  await until(() => main.webContents.executeJavaScript(`Boolean(document.querySelector("#capture-start") && window.stillwater)`), "main window");
  await main.webContents.executeJavaScript(`
    window.alertCheck = { pressed: 0 };
    document.querySelector("#capture-start").addEventListener("click", event => {
      event.stopImmediatePropagation(); event.preventDefault(); window.alertCheck.pressed++;
    }, true);`);
  const card = await until(() => BrowserWindow.getAllWindows().find(w => w !== main && w.isVisible()), "the alert card never showed");
  const shown = await until(() => card.webContents.executeJavaScript(
    `document.getElementById("alert-title").textContent && ({ title: document.getElementById("alert-title").textContent,
      label: document.getElementById("alert-primary").textContent, time: document.getElementById("alert-time").textContent })`), "card text");
  assert.equal(shown.title, "Roadmap review");
  assert.match(shown.label, /Join Zoom/);
  assert.match(shown.time, /\d.*–.*\d/);
  await card.webContents.executeJavaScript(`document.getElementById("alert-primary").click()`);
  await until(() => opened.length === 1 && !card.isVisible(), "the call link was not opened");
  assert.equal(opened[0], "https://us02web.zoom.us/j/987654321?pwd=abc");
  const note = await until(() => main.webContents.executeJavaScript(`window.alertCheck.pressed &&
    ({ title: document.querySelector("#meeting-form, form").elements.title?.value, pressed: window.alertCheck.pressed,
       linked: [...document.querySelectorAll("form")].some(f => f.dataset.calendarId === "alert-fixture") })`), "recording was not started");
  assert.deepEqual(note, { title: "Roadmap review", pressed: 1, linked: true });
  // Turning alerts off is remembered.
  assert.equal(await main.webContents.executeJavaScript(`window.stillwater.meetingAlerts(false)`), false);
  assert.equal(JSON.parse(await fs.readFile(join(profile, "meeting-alerts.json"), "utf8")).enabled, false);
  console.log("Meeting alerts passed call-link detection, timing, declined and solo events, and the card's join, titled note and recording start.");
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
