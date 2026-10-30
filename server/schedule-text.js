// Horaires cron / systemd OnCalendar → phrases françaises courtes, et prochain passage d'une ligne cron.
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const SYSTEMD_DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ALIASES = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

const pad = (value) => String(value).padStart(2, "0");

function parseField(field, [min, max]) {
  const values = new Set();
  for (const part of String(field).split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let [from, to] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (to === undefined) to = stepRaw ? max : from;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCronExpression(expression) {
  const text = ALIASES[String(expression || "").trim()] || String(expression || "").trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((field, index) => parseField(field, RANGES[index]));
  if (sets.some((set) => !set)) return null;
  if (sets[4].has(7)) sets[4].add(0);
  return { fields, minutes: sets[0], hours: sets[1], days: sets[2], months: sets[3], weekdays: sets[4] };
}

// Paris en clair à côté d'une heure UTC (décalage du jour, été/hiver).
export function parisTime(hour, minute, now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(date);
}

function timesText(hours, minutes, timezone, now) {
  const list = [];
  for (const hour of hours) for (const minute of minutes) list.push([hour, minute]);
  const shown = list.slice(0, 6).map(([hour, minute]) => `${pad(hour)}:${pad(minute)}`).join(", ") + (list.length > 6 ? "…" : "");
  if (timezone !== "UTC") return `${shown}${timezone ? ` ${timezone}` : ""}`;
  const paris = list.slice(0, 6).map(([hour, minute]) => parisTime(hour, minute, now)).join(", ") + (list.length > 6 ? "…" : "");
  return `${shown} UTC (${paris} Paris)`;
}

function stepOf(field) {
  const match = String(field).match(/^\*\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function describeCron(expression, { timezone = "UTC", now = new Date() } = {}) {
  const parsed = parseCronExpression(expression);
  if (!parsed) return `cron « ${expression} »`;
  const [minuteField, hourField, dayField, monthField, weekdayField] = parsed.fields;
  const minutes = [...parsed.minutes].sort((a, b) => a - b);
  const hours = [...parsed.hours].sort((a, b) => a - b);
  let base;
  if (minuteField === "*" && hourField === "*") base = "chaque minute";
  else if (stepOf(minuteField) && hourField === "*") base = `toutes les ${stepOf(minuteField)} min`;
  else if (hourField === "*") base = `toutes les heures à ${minutes.map((minute) => `:${pad(minute)}`).join(", ")}`;
  else if (stepOf(hourField) && minutes.length === 1) base = `toutes les ${stepOf(hourField)} h à :${pad(minutes[0])} (${timesText(hours, minutes, timezone, now)})`;
  else base = `à ${timesText(hours, minutes, timezone, now)}`;
  const dayStep = stepOf(dayField);
  let when = "";
  if (weekdayField !== "*") when = `le ${[...parsed.weekdays].filter((day) => day < 7).sort().map((day) => DAYS[day]).join(", ")}`;
  else if (dayStep) when = `tous les ${dayStep} jours`;
  else if (dayField !== "*") when = `le ${[...parsed.days].sort((a, b) => a - b).join(", ")} du mois`;
  else if (hourField !== "*" && !stepOf(hourField)) when = "tous les jours";
  if (monthField !== "*") when = `${when} (mois ${[...parsed.months].join(", ")})`.trim();
  return when ? `${when} ${base}` : base;
}

function cronParts(date, utc) {
  return utc
    ? { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth() + 1, weekday: date.getUTCDay() }
    : { minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(), month: date.getMonth() + 1, weekday: date.getDay() };
}

export function nextCronRun(expression, { from = new Date(), utc = true, horizonDays = 8 } = {}) {
  const parsed = parseCronExpression(expression);
  if (!parsed) return null;
  const restrictedDay = parsed.fields[2] !== "*";
  const restrictedWeekday = parsed.fields[4] !== "*";
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = horizonDays * 1440;
  for (let step = 0; step < limit; step += 1) {
    const date = new Date(start.getTime() + step * 60_000);
    const parts = cronParts(date, utc);
    if (!parsed.minutes.has(parts.minute) || !parsed.hours.has(parts.hour) || !parsed.months.has(parts.month)) continue;
    const dayMatch = parsed.days.has(parts.day);
    const weekdayMatch = parsed.weekdays.has(parts.weekday);
    const ok = restrictedDay && restrictedWeekday ? dayMatch || weekdayMatch : dayMatch && weekdayMatch;
    if (ok) return date.toISOString();
  }
  return null;
}

function calendarPart(spec, now) {
  const tokens = spec.trim().split(/\s+/);
  let timezone = null;
  if (tokens.length > 1 && /^([A-Z][A-Za-z_]+\/[A-Za-z_]+|UTC)$/.test(tokens.at(-1))) timezone = tokens.pop();
  let weekdays = null;
  if (tokens.length && /^[A-Za-z]/.test(tokens[0])) weekdays = tokens.shift();
  const time = tokens.find((token) => token.includes(":")) || "00:00:00";
  const date = tokens.find((token) => token.includes("-")) || "*-*-*";
  const [hourSpec, minuteSpec = "00"] = time.split(":");
  const zoneLabel = timezone === "Europe/Paris" || !timezone ? "Paris" : timezone;
  const minuteStep = minuteSpec.match(/^(\d+)\/(\d+)$/);
  let base;
  if (hourSpec === "*" && minuteStep) base = Number(minuteStep[1]) === 0 ? `toutes les ${minuteStep[2]} min` : `toutes les ${minuteStep[2]} min à partir de :${pad(minuteStep[1])}`;
  else if (hourSpec === "*") base = `toutes les heures à :${pad(minuteSpec)}`;
  else {
    const hours = hourSpec.split(",").map(Number);
    const minutes = minuteSpec.split(",").map(Number);
    if (hours.some(Number.isNaN) || minutes.some(Number.isNaN)) return spec.trim();
    base = `à ${timesText(hours, minutes, zoneLabel === "UTC" ? "UTC" : zoneLabel, now)}`;
  }
  let when = "";
  if (weekdays) {
    const names = weekdays.split(",").flatMap((item) => {
      const [from, to] = item.toLowerCase().split("..").map((day) => SYSTEMD_DAYS[day.slice(0, 3)]);
      if (from === undefined) return [];
      if (to === undefined) return [DAYS[from]];
      const list = [];
      for (let day = from; day !== (to + 1) % 7; day = (day + 1) % 7) list.push(DAYS[day]);
      return list;
    });
    when = names.length ? `le ${names.join(", ")}` : weekdays;
  } else if (date === "*-*-*" && hourSpec !== "*") when = "tous les jours";
  else if (date !== "*-*-*") when = `dates ${date}`;
  return when ? `${when} ${base}` : base;
}

// Valeur brute d'un ou plusieurs OnCalendar (ex. "*-*-* 09:30:00 Europe/Paris").
export function describeCalendar(specs, { now = new Date() } = {}) {
  const list = (Array.isArray(specs) ? specs : [specs]).map((spec) => String(spec || "").trim()).filter(Boolean);
  if (!list.length) return null;
  return list.map((spec) => calendarPart(spec, now)).join(" et ");
}
