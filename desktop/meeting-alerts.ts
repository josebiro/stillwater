// Before-meeting alerts: which calendar event gets one, when it shows, and where its Join button goes.

export type AlertEvent = {
  id: string; start: string; end: string | null; allDay: boolean; title: string;
  attendees?: string[]; join?: { url: string; service: string }; declined?: boolean;
};

// Video services recognised in an event's conference field, description or location.
const services: [string, string][] = [
  ["teams.microsoft.com", "Microsoft Teams"], ["zoom.us", "Zoom"], ["zoomgov.com", "Zoom"], ["zoom.com", "Zoom"],
  ["meet.google.com", "Google Meet"], ["pexip.me", "Pexip"], ["calendly.com/events", "Calendly"],
  ["app.cal.com/video", "Cal.com"], ["webex.com", "Webex"], ["riverside.com", "Riverside"],
];
const notLinks = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".webp", ".svg", ".ico", ".pdf", ".zip", ".txt"];
const urls = /https?:\/\/(?:www\.)?[^\s()<>]+(?:\([\w\d]+\)|[^\s`!()[\]{};:'".,<>?«»“”‘’])/g;

function service(url: string) {
  const lower = url.toLowerCase();
  if (notLinks.some((ending) => lower.endsWith(ending))) return undefined;
  return services.find(([domain]) => lower.includes(domain))?.[1];
}

/** The first video-call link in these texts, tried in order (conference field, description, location). */
export function joinLink(...texts: (string | undefined)[]) {
  for (const text of texts) {
    for (const url of text?.match(urls) ?? []) {
      const name = service(url);
      if (!name || !url.startsWith("https://")) continue;
      try { return { url: new URL(url).href, service: name }; } catch { /* not a usable address */ }
    }
  }
  return undefined;
}

// An alert is planned for an event that starts within 10 minutes (or began up to 4 minutes ago).
// It shows 58 seconds before the start and stays for 4 minutes.
export const alertWindow = 10 * 60000;
export const alertLate = 4 * 60000;
export const alertLead = 58000;
export const alertStay = 4 * 60000;

export const alertKey = (event: AlertEvent) => JSON.stringify([event.id, event.start]);

/** Timed events you haven't declined, that involve someone else or have a call to join. */
export function alertable(event: AlertEvent) {
  return !event.allDay && !event.declined && Boolean(event.title) &&
    (Boolean(event.attendees?.length) || Boolean(event.join));
}

/**
 * One pass of the scheduler. `planned` holds the alerts already planned, by key.
 * Returns the planned alerts whose event moved or went away, and at most one new alert to plan
 * (the next pass picks up any others).
 */
export function planAlerts(events: AlertEvent[], now: number, planned: Set<string>) {
  const current = new Set(events.map(alertKey));
  const cancel = [...planned].filter((key) => !current.has(key));
  for (const event of events) {
    if (!alertable(event) || planned.has(alertKey(event))) continue;
    const until = Date.parse(event.start) - now;
    if (!(until < alertWindow && until > -alertLate)) continue;
    const delay = Math.max(0, until - alertLead);
    return { cancel, show: { event, key: alertKey(event), delay, stay: alertStay + (delay > 0 ? 0 : until) } };
  }
  return { cancel, show: undefined };
}

/** "Meet" on the button for Google Meet, otherwise the service's name. */
export function joinLabel(event: AlertEvent) {
  if (!event.join) return "Take notes";
  return "Join " + (event.join.service === "Google Meet" ? "Meet" : event.join.service);
}
