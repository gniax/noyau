import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CalendarService, generateICal, parseICal, parseICalDate } from "./calendar-service.js";

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-calendar-test-"));
  const file = path.join(dir, "calendar-subscriptions.json");
  const service = new CalendarService({ file });
  return { dir, file, service };
}

test("parseICalDate gère YYYYMMDD et ISO standard", () => {
  assert.equal(parseICalDate("20261015"), "2026-10-15");
  assert.equal(parseICalDate("20261015T143000Z"), "2026-10-15");
  assert.equal(parseICalDate("invalid"), null);
  assert.equal(parseICalDate(""), null);
});

test("parseICal extrait correctement les événements VEVENT", () => {
  const sample = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Cal
BEGIN:VEVENT
UID:evt-12345
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261021
SUMMARY:Réunion de sprint
DESCRIPTION:Point d'avancement Noyau
LOCATION:Paris
END:VEVENT
END:VCALENDAR`;

  const events = parseICal(sample);
  assert.equal(events.length, 1);
  assert.equal(events[0].uid, "evt-12345");
  assert.equal(events[0].title, "Réunion de sprint");
  assert.equal(events[0].start, "2026-10-20");
  assert.equal(events[0].end, "2026-10-21");
  assert.equal(events[0].description, "Point d'avancement Noyau");
  assert.equal(events[0].location, "Paris");
  assert.equal(events[0].allDay, true);
});

test("generateICal crée un flux VCALENDAR avec les todos avec dueDate", () => {
  const todos = [
    { id: "todo-1", text: "Déployer v0.108.0", dueDate: "2026-10-25", status: "open", project: "noyau" },
    { id: "todo-2", text: "Sans date d'échéance", status: "open" },
    { id: "todo-3", text: "Tâche finie", dueDate: "2026-10-22", status: "done" },
  ];

  const ical = generateICal(todos, { calendarName: "Mes Todos Noyau" });
  assert.ok(ical.includes("BEGIN:VCALENDAR"));
  assert.ok(ical.includes("X-WR-CALNAME:Mes Todos Noyau"));
  assert.ok(ical.includes("SUMMARY:Déployer v0.108.0"));
  assert.ok(ical.includes("STATUS:CONFIRMED"));
  assert.ok(ical.includes("STATUS:COMPLETED"));
  assert.ok(!ical.includes("Sans date d'échéance"));
});

test("CalendarService gère le CRUD des abonnements de calendrier", async () => {
  const { service } = await fixture();

  const created = await service.addSubscription({
    name: "Perso Google",
    url: "https://calendar.google.com/calendar/ical/test/basic.ics",
    color: "#4f46e5",
    profileId: "profil-alice",
  });

  assert.ok(created.id);
  assert.equal(created.name, "Perso Google");
  assert.equal(created.profileId, "profil-alice");

  const list = await service.listSubscriptions("profil-alice");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  // Update
  const updated = await service.updateSubscription(created.id, {
    name: "Perso Google Pro",
    color: "#10b981",
  });
  assert.equal(updated.name, "Perso Google Pro");
  assert.equal(updated.color, "#10b981");

  // Delete
  const deleted = await service.removeSubscription(created.id);
  assert.ok(deleted.success || deleted === true);

  const listAfter = await service.listSubscriptions("profil-alice");
  assert.equal(listAfter.length, 0);
});

test("CalendarService.getAllEvents fusionne les todos et flux externes", async () => {
  const { service } = await fixture();

  const todos = [
    { id: "todo-1", text: "Release mobile", dueDate: "2026-10-30", status: "open" }
  ];

  const result = await service.getAllEvents({ profileId: "default", todos });
  assert.equal(result.todos.length, 1);
  assert.equal(result.todos[0].uid, "todo-1");
  assert.equal(result.todos[0].type, "todo");
  assert.equal(result.todos[0].title, "Release mobile");
  assert.equal(result.todos[0].start, "2026-10-30");
});
