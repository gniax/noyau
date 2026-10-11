import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CALENDAR_ID = /^cal-[a-z0-9]+-[a-f0-9]{6}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function newId() {
  return `cal-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function parseICalDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  // Format YYYYMMDD
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  // Format YYYYMMDDTHHMMSSZ ou YYYYMMDDTHHMMSS
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return null;
}

export function parseICal(text) {
  const events = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\n /g, "").split("\n");
  let inEvent = false;
  let current = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      current = {};
    } else if (line === "END:VEVENT") {
      if (inEvent && (current.title || current.summary) && current.start) {
        events.push({
          uid: current.uid || newId(),
          title: current.summary || current.title || "Événement sans titre",
          start: current.start,
          end: current.end || current.start,
          description: current.description || "",
          location: current.location || "",
          allDay: Boolean(current.allDay),
        });
      }
      inEvent = false;
    } else if (inEvent) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx);
      const val = line.slice(colonIdx + 1).trim();
      const mainKey = keyPart.split(";")[0].toUpperCase();

      if (mainKey === "UID") {
        current.uid = val;
      } else if (mainKey === "SUMMARY") {
        current.summary = val.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, "\n");
      } else if (mainKey === "DESCRIPTION") {
        current.description = val.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, "\n");
      } else if (mainKey === "LOCATION") {
        current.location = val.replace(/\\,/g, ",").replace(/\\;/g, ";");
      } else if (mainKey === "DTSTART") {
        current.start = parseICalDate(val);
        current.allDay = keyPart.includes("VALUE=DATE") || /^\d{8}$/.test(val);
      } else if (mainKey === "DTEND") {
        current.end = parseICalDate(val);
      }
    }
  }

  return events;
}

export function generateICal(todos = [], { calendarName = "Noyau Todos" } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Noyau//Calendrier//FR",
    `X-WR-CALNAME:${calendarName}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  const nowStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  for (const todo of todos) {
    if (!todo?.dueDate || !DATE_PATTERN.test(todo.dueDate)) continue;
    const compactDate = todo.dueDate.replace(/-/g, "");
    const summary = String(todo.text || "Tâche Noyau").replace(/[,;\n]/g, " ");
    const isDone = todo.status === "done" || Boolean(todo.completed);

    lines.push(
      "BEGIN:VEVENT",
      `UID:${todo.id}@noyau.local`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART;VALUE=DATE:${compactDate}`,
      `SUMMARY:${isDone ? "✓ " : ""}${summary}`,
      `STATUS:${isDone ? "COMPLETED" : "CONFIRMED"}`,
      todo.comments?.length ? `DESCRIPTION:${todo.comments.map((c) => c.text).join("\\n")}` : "DESCRIPTION:Tâche issue de Noyau",
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export class CalendarService {
  constructor({ storagePath, file, fetchImpl = fetch } = {}) {
    this.storagePath = storagePath || file;
    this.fetchImpl = fetchImpl;
    this.cache = new Map(); // url -> { timestamp, events }
  }

  async loadSubscriptions() {
    if (!this.storagePath) return [];
    try {
      const raw = await fs.readFile(this.storagePath, "utf8");
      return JSON.parse(raw) || [];
    } catch {
      return [];
    }
  }

  async saveSubscriptions(subscriptions) {
    if (!this.storagePath) return;
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, `${JSON.stringify(subscriptions, null, 2)}\n`, "utf8");
  }

  async listSubscriptions(profileId = null) {
    const all = await this.loadSubscriptions();
    if (!profileId) return all;
    return all.filter((sub) => !sub.profileId || sub.profileId === profileId);
  }

  async addSubscription({ name, url, color = "#3b82f6", profileId = null }) {
    const cleanUrl = String(url || "").trim().replace(/^webcal:\/\//i, "https://");
    if (!cleanUrl || !/^https?:\/\/.+/i.test(cleanUrl)) {
      throw new Error("URL de calendrier iCal / Webcal invalide.");
    }
    const cleanName = String(name || "").trim().slice(0, 80) || "Calendrier perso";
    const sub = {
      id: newId(),
      name: cleanName,
      url: cleanUrl,
      color: String(color || "#3b82f6").slice(0, 20),
      enabled: true,
      profileId: profileId || null,
      createdAt: new Date().toISOString(),
    };
    const current = await this.loadSubscriptions();
    current.push(sub);
    await this.saveSubscriptions(current);
    return sub;
  }

  async updateSubscription(id, { name, url, color, enabled }) {
    const current = await this.loadSubscriptions();
    const idx = current.findIndex((item) => item.id === id);
    if (idx === -1) throw new Error("Abonnement calendrier introuvable.");
    if (name !== undefined) current[idx].name = String(name).trim().slice(0, 80) || current[idx].name;
    if (url !== undefined) {
      const cleanUrl = String(url).trim().replace(/^webcal:\/\//i, "https://");
      if (!/^https?:\/\/.+/i.test(cleanUrl)) throw new Error("URL de calendrier invalide.");
      current[idx].url = cleanUrl;
      this.cache.delete(current[idx].url);
    }
    if (color !== undefined) current[idx].color = String(color).slice(0, 20);
    if (enabled !== undefined) current[idx].enabled = Boolean(enabled);
    await this.saveSubscriptions(current);
    return current[idx];
  }

  async removeSubscription(id) {
    const current = await this.loadSubscriptions();
    const filtered = current.filter((item) => item.id !== id);
    if (filtered.length === current.length) throw new Error("Abonnement introuvable.");
    await this.saveSubscriptions(filtered);
    return { success: true };
  }

  async fetchSubscriptionEvents(subscription) {
    if (!subscription.enabled || !subscription.url) return [];
    const cached = this.cache.get(subscription.url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.events;
    }

    try {
      const response = await this.fetchImpl(subscription.url, {
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Noyau/1.0" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const parsed = parseICal(text);
      const events = parsed.map((event) => ({
        ...event,
        calendarId: subscription.id,
        calendarName: subscription.name,
        color: subscription.color,
      }));
      this.cache.set(subscription.url, { timestamp: Date.now(), events });
      return events;
    } catch {
      return cached ? cached.events : [];
    }
  }

  async getAllEvents({ profileId = null, todos = [] } = {}) {
    const subs = await this.listSubscriptions(profileId);
    const subEventsPromises = subs.filter((s) => s.enabled).map((s) => this.fetchSubscriptionEvents(s));
    const subEventsArrays = await Promise.all(subEventsPromises);
    const externalEvents = subEventsArrays.flat();

    const todoEvents = (todos || []).filter((t) => t.dueDate && DATE_PATTERN.test(t.dueDate)).map((t) => ({
      uid: t.id,
      title: t.text,
      start: t.dueDate,
      end: t.dueDate,
      allDay: true,
      type: "todo",
      status: t.status || (t.completed ? "done" : "todo"),
      folderId: t.folderId,
      commentsCount: t.comments?.length || 0,
      unread: t.unread || 0,
    }));

    return {
      subscriptions: subs,
      events: externalEvents,
      todos: todoEvents,
    };
  }
}
