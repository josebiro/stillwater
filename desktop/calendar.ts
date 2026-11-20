function eventDate(value: string, zone?: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.toUpperCase());
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00", utc] = match;
  const wallTime = year + "-" + month + "-" + day + "T" + hour + ":" + minute + ":" + second;
  const calendarDate = new Date(wallTime + "Z");
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 19) !== wallTime) return null;
  let date = new Date(wallTime + (utc || zone ? "Z" : ""));
  if (!Number.isFinite(date.getTime())) return null;
  if (zone && !utc) {
    try {
      const formatter = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" });
      const wallMs = date.getTime();
      for (let attempt = 0; attempt < 3; attempt++) {
        const label = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
        const offset = /^GMT([+-])(\d{2}):(\d{2})$/.exec(label ?? "");
        const minutes = offset ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "-" ? -1 : 1) : 0;
        const adjusted = wallMs - minutes * 60000;
        if (date.getTime() === adjusted) return date.toISOString();
        date = new Date(adjusted);
      }
      return null;
    } catch {
      return null;
    }
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function ruleDates(rule: string, start: string, zone: string | undefined, now: Date) {
  const parts = new Map(rule.toUpperCase().split(";").map((part) => {
    const [key, value] = part.split("=");
    return [key, value];
  }));
  const frequency = parts.get("FREQ");
  if (!frequency || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency) ||
      [...parts.keys()].some((key) => !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYSETPOS", "WKST"].includes(key))) return null;
  const interval = Number(parts.get("INTERVAL") ?? 1);
  const count = Number(parts.get("COUNT") ?? Infinity);
  const until = parts.has("UNTIL") ? eventDate(parts.get("UNTIL") ?? "", zone) : undefined;
  if (!Number.isSafeInteger(interval) || interval < 1 || count < 1 ||
      (parts.has("COUNT") && !Number.isSafeInteger(count)) || until === null) return null;
  const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const weekStart = weekdays.indexOf(parts.get("WKST") ?? "MO");
  if (weekStart < 0) return null;
  const dateBased = frequency === "MONTHLY" || frequency === "YEARLY";
  if (frequency === "YEARLY" && parts.has("BYDAY")) return null;
  const startDay = new Date(start.slice(0, 8).replace(/^(....)(..)(..)$/, "$1-$2-$3") + "T00:00:00Z");
  const days = parts.get("BYDAY")?.split(",") ?? (frequency === "WEEKLY" ? [weekdays[startDay.getUTCDay()]] : weekdays);
  const monthlyWeekdays = frequency === "MONTHLY" && parts.has("BYDAY");
  const monthDays = parts.get("BYMONTHDAY")?.split(",").map(Number);
  const positions = parts.get("BYSETPOS")?.split(",").map(Number);
  if (positions && (frequency !== "MONTHLY" || (!monthlyWeekdays && !monthDays) ||
      positions.some((position) => !Number.isInteger(position) || position === 0 || Math.abs(position) > 366))) return null;
  if (monthDays && (frequency !== "MONTHLY" ||
      monthDays.some((date) => !Number.isInteger(date) || date === 0 || Math.abs(date) > 31))) return null;
  const dayPattern = monthlyWeekdays ? /^(?:[+-]?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/ : /^(SU|MO|TU|WE|TH|FR|SA)$/;
  if (days.some((day) => !dayPattern.test(day))) return null;
  const dayMs = 86400000;
  const lower = now.getTime() - 365 * dayMs;
  const upper = now.getTime() + 365 * dayMs;
  const dates = [];
  let matched = 1;
  const weekOffset = (startDay.getUTCDay() - weekStart + 7) % 7;
  function matchesMonthlyDate(date: number, lastDate: number, weekday: string) {
    if (monthDays && !monthDays.includes(date) && !monthDays.includes(date - lastDate - 1)) return false;
    return !monthlyWeekdays || days.some((entry) => {
      if (!entry.endsWith(weekday)) return false;
      const ordinal = Number(entry.slice(0, -2));
      return ordinal === 0 || ordinal === Math.ceil(date / 7) ||
        ordinal === -Math.ceil((lastDate - date + 1) / 7);
    });
  }
  // COUNT needs every match from DTSTART. Unbounded series can start just before the visible range.
  const firstOffset = parts.has("COUNT") ? 1 : Math.max(1, Math.floor((lower - startDay.getTime()) / dayMs) - 1);
  for (let offset = firstOffset; startDay.getTime() + offset * dayMs <= upper && matched < count; offset++) {
    const day = new Date(startDay.getTime() + offset * dayMs);
    if (dateBased && !monthlyWeekdays && !monthDays && day.getUTCDate() !== startDay.getUTCDate()) continue;
    if (frequency === "YEARLY" && day.getUTCMonth() !== startDay.getUTCMonth()) continue;
    const yearOffset = day.getUTCFullYear() - startDay.getUTCFullYear();
    const monthOffset = yearOffset * 12 + day.getUTCMonth() - startDay.getUTCMonth();
    const period = frequency === "YEARLY" ? yearOffset : frequency === "MONTHLY" ? monthOffset
      : frequency === "DAILY" ? offset : Math.floor((offset + weekOffset) / 7);
    if (period % interval) continue;
    const weekday = weekdays[day.getUTCDay()];
    if (monthlyWeekdays || monthDays) {
      const date = day.getUTCDate();
      const last = new Date(day.getTime() + (32 - date) * dayMs);
      last.setUTCDate(0);
      const lastDate = last.getUTCDate();
      if (!matchesMonthlyDate(date, lastDate, weekday)) continue;
      if (positions) {
        const firstWeekday = (day.getUTCDay() - (date - 1) % 7 + 7) % 7;
        const candidates = [];
        for (let candidate = 1; candidate <= lastDate; candidate++) {
          if (matchesMonthlyDate(candidate, lastDate, weekdays[(firstWeekday + candidate - 1) % 7])) {
            candidates.push(candidate);
          }
        }
        if (!positions.some((position) => candidates.at(position > 0 ? position - 1 : position) === date)) continue;
      }
    } else if (!days.includes(weekday)) continue;
    const occurrence = eventDate(day.toISOString().slice(0, 10).replaceAll("-", "") + start.slice(8), zone);
    if (!occurrence) continue;
    if (until && occurrence > until) break;
    matched++;
    if (Date.parse(occurrence) >= lower) dates.push(occurrence);
  }
  return dates;
}

export function parseCalendar(text: string, now = new Date()) {
  const events: { id: string; start: string; end: string | null; allDay: boolean; title: string; attendees?: string[] }[] = [];
  const exceptions = new Set<string>();
  const replacements: typeof events = [];
  let fields: Map<string, string> | undefined;
  let extraDates: (string | null)[] = [];
  let excludedDates: (string | null)[] = [];
  let attendees: string[] = [];
  let nested = 0;
  let unsupported = 0;
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const marker = line.toUpperCase();
    if (marker === "BEGIN:VEVENT") {
      fields = new Map();
      attendees = [];
      extraDates = [];
      excludedDates = [];
      nested = 0;
    } else if (marker === "END:VEVENT" && fields) {
      const id = fields.get("UID");
      const start = eventDate(fields.get("DTSTART") ?? "", fields.get("DTSTART-zone"));
      const end = eventDate(fields.get("DTEND") ?? "", fields.get("DTEND-zone"));
      const recurrence = fields.get("RECURRENCE-ID");
      const originalStart = recurrence && eventDate(recurrence, fields.get("RECURRENCE-ID-zone"));
      const cancelled = fields.get("STATUS")?.toUpperCase() === "CANCELLED";
      const rule = fields.get("RRULE");
      const generated = rule && start ? ruleDates(rule, fields.get("DTSTART")!, fields.get("DTSTART-zone"), now) : [];
      if (id && originalStart && cancelled) exceptions.add(JSON.stringify([id, originalStart]));
      if (!cancelled) {
        if (!id || !start || (fields.has("DTEND") && (!end || end <= start)) ||
            (recurrence && !originalStart) || generated === null || extraDates.includes(null) || excludedDates.includes(null)) unsupported++;
        else {
          if (originalStart) exceptions.add(JSON.stringify([id, originalStart]));
          const title = (fields.get("SUMMARY") ?? "Untitled event").replace(/\\[nN]/g, " ").replace(/\\([,;\\])/g, "$1");
          const duration = end ? Date.parse(end) - Date.parse(start) : 0;
          for (const occurrence of new Set([start, ...extraDates, ...generated])) {
            if (!occurrence || excludedDates.includes(occurrence)) continue;
            (originalStart ? replacements : events).push({ id, start: occurrence,
              end: end ? new Date(Date.parse(occurrence) + duration).toISOString() : null,
              allDay: fields.get("DTSTART")?.length === 8, ...(attendees.length ? { attendees } : {}), title });
          }
        }
      }
      fields = undefined;
    } else if (fields) {
      if (marker.startsWith("BEGIN:")) {
        nested++;
        continue;
      }
      if (nested) {
        if (marker.startsWith("END:")) nested--;
        continue;
      }
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      const property = line.slice(0, separator);
      const name = property.split(";")[0].toUpperCase();
      if (name === "ATTENDEE") {
        const cn = /;CN=(?:"([^"]+)"|([^;]+))/i.exec(property);
        const person = (cn?.[1] ?? cn?.[2] ?? line.slice(separator+1).replace(/^mailto:/i,"")).trim();
        if (person && !attendees.includes(person)) attendees.push(person);
        continue;
      }
      const zone = /;TZID=(?:"([^"]+)"|([^;]+))/i.exec(property);
      if (name === "RDATE" || name === "EXDATE") {
        const dates = name === "RDATE" ? extraDates : excludedDates;
        for (const value of line.slice(separator + 1).split(",")) {
          dates.push(eventDate(value, zone?.[1] ?? zone?.[2]));
        }
        continue;
      }
      if ((name === "DTSTART" || name === "DTEND" || name === "RECURRENCE-ID") && zone) {
        fields.set(name + "-zone", zone[1] ?? zone[2]);
      }
      fields.set(name, line.slice(separator + 1));
    }
  }
  const visible = events.filter(({ id, start }) => !exceptions.has(JSON.stringify([id, start])));
  return { events: [...visible, ...replacements].sort((a, b) => a.start.localeCompare(b.start)), unsupported };
}
