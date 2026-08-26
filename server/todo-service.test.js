import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TodoService, parseDocument } from "./todo-service.js";

async function fixture(content) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-todos-"));
  const file = path.join(directory, "TO DO.md");
  await fs.writeFile(file, content);
  return { file, service: new TodoService({ file }) };
}

test("todo service preserves Obsidian prose and syncs task metadata", async () => {
  const { file, service } = await fixture("# Notes\n\n- Texte libre\n\n- [ ] Première tâche\n- [x] Déjà faite\n");
  const tasks = await service.list();
  assert.equal(tasks.length, 2);
  assert.match(await fs.readFile(file, "utf8"), /# Notes[\s\S]*<!-- noyau:/);

  await service.update(tasks[0].id, { dueDate: "2026-08-27", projectId: "project-meridian" });
  await service.move(tasks[1].id, "up");
  const document = parseDocument(await fs.readFile(file, "utf8"));
  assert.equal(document.tasks[0].text, "Déjà faite");
  assert.equal(document.tasks[1].dueDate, "2026-08-27");
  assert.equal(document.tasks[1].projectId, "project-meridian");
});

test("todo reminders fire day before, due day, then once daily", async () => {
  const { service } = await fixture("- [ ] Livrer version 📅 2026-08-27\n");
  const [before] = await service.reminders(new Date(2026, 7, 26, 10));
  assert.equal(before.kind, "tomorrow");
  await service.markReminded(before.id, before.reminderKey);
  assert.equal((await service.reminders(new Date(2026, 7, 26, 18))).length, 0);
  const [due] = await service.reminders(new Date(2026, 7, 27, 10));
  assert.equal(due.kind, "today");
});
