import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const STATUSES = new Set(["sent", "failed", "pending", "received", "skipped", "unknown"]);
const DIRECTIONS = new Set(["outgoing", "incoming", "system"]);
const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const within = (root, file) => file.startsWith(`${root}${path.sep}`);

export function chatConfig(value, workingDirectory) {
  if (value == null) return null;
  if (typeof value.file !== "string" || path.isAbsolute(value.file)) throw new Error("Fichier chat module invalide.");
  const file = path.resolve(workingDirectory, value.file);
  if (!within(workingDirectory, file) || !file.endsWith(".json")) throw new Error("Fichier chat module invalide.");
  return { file };
}

const FEED_LIMIT = 5000;
const DAY_LIMIT = 500;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Jour local du serveur (Europe/Paris sur la machine): cle de navigation jour par jour.
export function chatDayKey(value) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

// Une journee a la fois (aujourd'hui, sinon le dernier jour actif); prevDay/nextDay = jours voisins ayant des messages.
export function normalizeChatFeed(value, { day = null, now = new Date() } = {}) {
  if (!value || !Array.isArray(value.messages)) throw new Error("Historique chat invalide.");
  const seen = new Set();
  const all = value.messages.slice(-FEED_LIMIT).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = typeof item.id === "number" && Number.isFinite(item.id) ? String(item.id) : text(item.id, 160);
    if (!id || seen.has(id) || typeof item.text !== "string") return [];
    seen.add(id);
    return [{
      id, text: text(item.text, 8192), sender: text(item.sender, 100), chat: text(item.chat, 160),
      timestamp: date(item.timestamp),
      direction: DIRECTIONS.has(item.direction) ? item.direction : "system",
      status: STATUSES.has(item.status) ? item.status : "unknown",
    }];
  }).sort((left, right) => (Date.parse(left.timestamp) || 0) - (Date.parse(right.timestamp) || 0));
  const days = [...new Set(all.map((message) => chatDayKey(message.timestamp)).filter(Boolean))].sort();
  const today = chatDayKey(now);
  const latestDay = days.includes(today) ? today : days.at(-1) || today;
  const selected = DAY_PATTERN.test(String(day || "")) ? day : latestDay;
  // Messages sans date: rattaches au dernier jour pour ne pas disparaitre.
  const messages = all.filter((message) => (chatDayKey(message.timestamp) ?? latestDay) === selected).slice(-DAY_LIMIT);
  return {
    messages,
    day: selected,
    latestDay,
    prevDay: days.filter((key) => key < selected).at(-1) || null,
    nextDay: days.find((key) => key > selected) || null,
    updatedAt: date(value.updatedAt),
    availability: "ready",
    total: all.length,
  };
}

// Read only the configured, project-contained JSON export; never execute a command to refresh chat.
export async function readModuleChat(module, options = {}) {
  if (!module.chat) return null;
  let handle;
  try {
    const [root, file] = await Promise.all([fs.realpath(module.workingDirectory), fs.realpath(module.chat.file)]);
    if (!within(root, file)) throw new Error("Fichier chat hors module.");
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Historique chat trop volumineux.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("Historique chat trop volumineux.");
    return normalizeChatFeed(JSON.parse(buffer.toString("utf8", 0, size)), options);
  } catch (error) {
    return { messages: [], updatedAt: null, availability: error.code === "ENOENT" ? "waiting" : "unavailable" };
  } finally {
    await handle?.close();
  }
}
