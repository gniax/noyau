import { recipeFor } from "./groceries.js";

export function parisInstant(date, time) {
  const [year, month, day] = date.split("-").map(Number); const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute); let value = target; const candidates = [];
  for (let index = 0; index < 5; index++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const actual = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    if (actual === target) return new Date(value);
    candidates.push({ value, delta: actual - target });
    value += target - actual;
  }
  // A nonexistent spring-forward time moves forward rather than firing before the requested wall time.
  return new Date(candidates.filter((candidate) => candidate.delta >= 0).sort((a, b) => a.delta - b.delta)[0]?.value ?? value);
}
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
const escape = (text) => String(text).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
export function menuCalendar(state, now = new Date(), profileId = "local") {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Noyau//Menus//FR", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Menus Noyau"];
  for (const slot of state.plan.filter((item) => item.status === "accepted")) {
    const recipe = recipeFor(state, slot.recipeId); if (!recipe) continue;
    const start = parisInstant(slot.date, slot.meal === "lunch" ? "12:30" : "19:30");
    lines.push("BEGIN:VEVENT", `UID:menu-${escape(profileId)}-${escape(slot.id)}@noyau.local`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + 3600000))}`, `SUMMARY:${escape(recipe.title)}`, `DESCRIPTION:${escape(`${slot.portions} portions · préparation ${recipe.minutes} min · Noyau`)}`, "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT60M", "DESCRIPTION:Préparer le repas", "END:VALARM", "END:VEVENT");
  }
  const fold = (line) => { const rows = []; let row = ""; let bytes = 0; for (const char of line) { const size = new TextEncoder().encode(char).length; if (bytes + size > 73) { rows.push(row); row = " "; bytes = 1; } row += char; bytes += size; } rows.push(row); return rows.join("\r\n"); };
  return lines.concat("END:VCALENDAR").map(fold).join("\r\n") + "\r\n";
}
