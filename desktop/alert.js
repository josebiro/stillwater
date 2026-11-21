// The before-meeting alert card. The main process sends what to show; every button reports back
// one action name and the main process does the work (see meeting-alert-window.ts).
(() => {
  const get = id => document.getElementById(id);
  const menu = get("alert-menu"), more = get("alert-more");
  function setMenu(open) {
    menu.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
    window.meetingAlert.resize(document.body.scrollHeight);
    if (open) menu.querySelector("button:not([hidden])")?.focus();
  }
  window.meetingAlert.onShow(alert => {
    get("alert-title").textContent = alert.title;
    get("alert-time").textContent = alert.time;
    get("alert-primary-label").textContent = alert.label;
    // With a call to join, the main button joins it and opens the note; without one it just opens the note.
    get("alert-primary-note").textContent = alert.canJoin ? "& take notes" : "";
    get("alert-join-only").hidden = !alert.canJoin;
    get("alert-notes-only").hidden = !alert.canJoin;
    setMenu(false);
  });
  const act = name => () => window.meetingAlert.act(name);
  get("alert-primary").addEventListener("click", act("start"));
  get("alert-join-only").addEventListener("click", act("join"));
  get("alert-notes-only").addEventListener("click", act("notes"));
  get("alert-settings").addEventListener("click", act("settings"));
  get("alert-close").addEventListener("click", act("dismiss"));
  more.addEventListener("click", () => setMenu(menu.hidden));
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!menu.hidden) { setMenu(false); more.focus(); } else window.meetingAlert.act("dismiss");
  });
})();
