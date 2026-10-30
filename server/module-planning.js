import fs from "node:fs/promises";
import path from "node:path";

const ENTRY_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}$/;
const TIMER_PATTERN = /^[a-zA-Z0-9@_.:-]+\.timer$/;
const KINDS = new Set(["publication", "preparation", "queue", "boost"]);
const QUEUE_LIMIT = 1024 * 1024;

function text(value, fallback, max) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, max);
}

// Planning declare par manifest: timers qui publient, ou file d'attente lue en lecture seule.
export function planningConfig(raw, homeDir) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((entry) => {
    const kind = KINDS.has(entry?.kind) ? entry.kind : "publication";
    if (!ENTRY_PATTERN.test(String(entry?.id || ""))) throw new Error("Planning module invalide.");
    if (entry.unit && !TIMER_PATTERN.test(entry.unit)) throw new Error("Timer planning invalide.");
    if (!["queue", "boost"].includes(kind) && !entry.unit) throw new Error("Timer planning manquant.");
    const channels = (Array.isArray(entry.channels) ? entry.channels : []).slice(0, 6).map((channel) => text(channel, "", 30)).filter(Boolean);
    const homeFile = (value) => {
      const file = path.resolve(String(value || "").replace(/^~(?=\/)/, homeDir));
      if (!file.startsWith(`${path.resolve(homeDir)}${path.sep}`) || !file.endsWith(".json")) throw new Error("Fichier planning invalide.");
      return file;
    };
    const field = (value, fallback) => (/^[a-zA-Z0-9_]{1,40}$/.test(String(value || "")) ? value : fallback);
    const list = (value, fallback) => (Array.isArray(value) ? value : fallback).slice(0, 8).map(String);
    let queue = null;
    if (kind === "queue") {
      queue = {
        file: homeFile(entry.queue?.file),
        at: field(entry.queue.at, "publishAt"),
        doneAt: field(entry.queue.doneAt, "postedAt"),
        status: field(entry.queue.status, "status"),
        title: field(entry.queue.title, "caption"),
        pending: list(entry.queue.pending, ["todo", "retry"]),
        done: list(entry.queue.done, ["done"]),
        failed: list(entry.queue.failed, ["failed"]),
      };
    }
    // Etat JSON d'une proposition (ex: tournoi): apercu du texte valide et statut, lecture seule.
    const state = entry.state ? { file: homeFile(entry.state.file), preview: field(entry.state.preview, "text"), status: field(entry.state.status, "status") } : null;
    const enabledEnv = /^[A-Z][A-Z0-9_]{0,60}$/.test(String(entry.enabledEnv || "")) ? entry.enabledEnv : null;
    // Canaux/libelle propres a un creneau (ex: Arena 01:05 Telegram, 13:05 Telegram + X).
    const slots = (Array.isArray(entry.slots) ? entry.slots : []).slice(0, 24).filter((slot) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(slot?.at || ""))).map((slot) => ({
      at: slot.at,
      ...(Array.isArray(slot.channels) ? { channels: slot.channels.slice(0, 6).map((channel) => text(channel, "", 30)).filter(Boolean) } : {}),
      ...(slot.label ? { label: text(slot.label, entry.id, 60) } : {}),
    }));
    // group = boost par occurrence (occurrences["YYYY-MM-DD:group"]); keys = interrupteur global (slots[key]).
    let boost = null;
    if (entry.boost) {
      const keyPattern = /^[a-z0-9][a-z0-9-]{0,40}$/;
      const group = keyPattern.test(String(entry.boost.group || "")) ? entry.boost.group : null;
      const keys = group ? [] : (Array.isArray(entry.boost.keys) ? entry.boost.keys : []).slice(0, 8).map(String).filter((key) => keyPattern.test(key));
      if (!group && !keys.length) throw new Error("Boost planning invalide.");
      boost = { file: homeFile(entry.boost.file), group, keys, at: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(entry.boost.at || "")) ? entry.boost.at : null };
    }
    if (kind === "boost" && !boost) throw new Error("Boost planning manquant.");
    return { id: entry.id, kind, unit: entry.unit || null, label: text(entry.label, entry.id, 60), channels, slots, queue, state, enabledEnv, boost };
  });
}

// systemctl show repete TimersCalendar pour chaque OnCalendar: on les garde tous.
export function parseTimerShow(output) {
  const units = new Map();
  let current = { calendars: [] };
  const flush = () => {
    if (current.Id) units.set(current.Id, current);
    current = { calendars: [] };
  };
  for (const line of String(output).split("\n")) {
    if (!line) { flush(); continue; }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "TimersCalendar") {
      const match = value.match(/OnCalendar=(.+?) ;/);
      if (match) current.calendars.push(match[1].trim());
    } else current[key] = value;
  }
  flush();
  return units;
}

export function parseCalendarIterations(output) {
  return [...String(output).matchAll(/\(in UTC\): \w+ (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/g)]
    .map(([, day, time]) => new Date(`${day}T${time}Z`))
    .filter((date) => !Number.isNaN(date.getTime()));
}

export function delayMinutes(value) {
  const source = String(value || "0");
  let total = 0;
  for (const [, amount, unit] of source.matchAll(/(\d+(?:\.\d+)?)\s*(h|min|s|ms|us)?/g)) {
    const factor = { h: 60, min: 1, s: 1 / 60, ms: 1 / 60000, us: 1 / 6e7 }[unit || "s"] ?? 0;
    total += Number(amount) * factor;
  }
  return Math.round(total);
}

async function readJson(file) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > QUEUE_LIMIT) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function readPlanningState(entry) {
  if (!entry.state) return null;
  const value = await readJson(entry.state.file);
  if (!value || typeof value !== "object") return { missing: true };
  // byAt optionnel: apercu propre a chaque creneau, cle "YYYY-MM-DD HH:MM" heure de Paris (ex: style de chaque short).
  const byAt = value.byAt && typeof value.byAt === "object" && !Array.isArray(value.byAt)
    ? Object.fromEntries(Object.entries(value.byAt).slice(0, 200).filter(([key]) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(key)).map(([key, item]) => [key, text(item, "", 120)]))
    : null;
  return { preview: text(value[entry.state.preview], "", 120), status: text(value[entry.state.status], "", 30), ...(byAt ? { byAt } : {}) };
}

// Environment= de systemctl show: KEY=VAL separes par espaces, valeurs eventuellement entre guillemets.
export function parseEnvironment(value) {
  const env = {};
  for (const [, key, quoted, plain] of String(value || "").matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|(\S*))/g)) env[key] = quoted ?? plain;
  return env;
}

// journalctl -o json filtre JOB_TYPE=start: une ligne sans JOB_RESULT ouvre un passage, la suivante le ferme.
export function parseJournalRuns(output) {
  const runs = new Map();
  for (const line of String(output).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const unit = entry.USER_UNIT || entry.UNIT;
    const at = new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000);
    if (!unit || Number.isNaN(at.getTime())) continue;
    const list = runs.get(unit) || [];
    runs.set(unit, list);
    const open = list.findLast((run) => !run.finishedAt);
    if (!entry.JOB_RESULT) list.push({ startedAt: at.toISOString(), finishedAt: null, result: "running" });
    else if (open) Object.assign(open, { finishedAt: at.toISOString(), result: entry.JOB_RESULT === "done" ? "ok" : "failed" });
    else list.push({ startedAt: at.toISOString(), finishedAt: at.toISOString(), result: entry.JOB_RESULT === "done" ? "ok" : "failed" });
  }
  return runs;
}

export async function queuePast(entry, since, now) {
  const items = await readJson(entry.queue.file);
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const status = String(item?.[entry.queue.status]);
      const result = entry.queue.done.includes(status) ? "ok" : entry.queue.failed.includes(status) ? "failed" : null;
      const at = new Date(item?.[entry.queue.doneAt] || item?.updatedAt || 0);
      return result && at >= since && at <= now ? { at: at.toISOString(), past: true, result, preview: text(item[entry.queue.title], "", 120), queueStatus: status } : null;
    })
    .filter(Boolean);
}

export async function queueOccurrences(entry, from, until) {
  const items = await readJson(entry.queue.file);
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => entry.queue.pending.includes(String(item?.[entry.queue.status])))
    .map((item) => ({ item, at: new Date(item[entry.queue.at] || from) }))
    .filter(({ at }) => !Number.isNaN(at.getTime()) && at <= until)
    .map(({ item, at }) => ({
      at: (at < from ? from : at).toISOString(),
      late: at < from,
      preview: text(item[entry.queue.title], "", 120),
      queueStatus: String(item[entry.queue.status]),
    }));
}

const PARIS_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export async function readBoosts(file) {
  const value = await readJson(file);
  const object = (item) => (item && typeof item === "object" && !Array.isArray(item) ? item : {});
  return { slots: object(value?.slots), occurrences: object(value?.occurrences) };
}

const PARIS_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });

export function parisDate(date) {
  return PARIS_DATE.format(date);
}

// Ecriture atomique: autres cles gardees, occurrences de plus de 7 jours purgees; un JSON illisible n'est jamais ecrase.
export async function writeBoost(file, change, { now = new Date() } = {}) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Fichier boosts illisible: corrige-le avant de changer un boost.");
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Fichier boosts invalide.");
  const object = (item) => (item && typeof item === "object" && !Array.isArray(item) ? { ...item } : {});
  const slots = object(current.slots);
  const occurrences = object(current.occurrences);
  for (const key of change.slots || []) slots[key] = Boolean(change.enabled);
  if (change.occurrence) occurrences[change.occurrence] = Boolean(change.enabled);
  const oldest = parisDate(new Date(now.getTime() - 7 * 86_400_000));
  for (const key of Object.keys(occurrences)) if (key.slice(0, 10) < oldest) delete occurrences[key];
  const next = { ...current, occurrences, slots };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
  return next;
}

export function parisKey(date) {
  return `${PARIS_DATE.format(date)} ${PARIS_TIME.format(date)}`;
}

export function parisMinutes(date) {
  const [hours, minutes] = PARIS_TIME.format(date).split(":").map(Number);
  return hours * 60 + minutes;
}

export function nearTime(date, at, tolerance = 90) {
  const [hours, minutes] = at.split(":").map(Number);
  const raw = Math.abs(hours * 60 + minutes - parisMinutes(date));
  return Math.min(raw, 1440 - raw) <= tolerance;
}

// Creneau le plus proche (heure de Paris, 90 min max) pour une occurrence ou un passage reel decale.
export function slotFor(entry, date) {
  if (!entry.slots?.length) return null;
  const [hours, minutes] = PARIS_TIME.format(date).split(":").map(Number);
  const minute = hours * 60 + minutes;
  let best = null;
  for (const slot of entry.slots) {
    const [slotHours, slotMinutes] = slot.at.split(":").map(Number);
    const raw = Math.abs(slotHours * 60 + slotMinutes - minute);
    const distance = Math.min(raw, 1440 - raw);
    if (distance <= 90 && (!best || distance < best.distance)) best = { slot, distance };
  }
  return best?.slot || null;
}
