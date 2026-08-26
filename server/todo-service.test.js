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
  const { todos } = await service.list();
  assert.equal(todos.length, 2);
  assert.match(await fs.readFile(file, "utf8"), /# Notes[\s\S]*<!-- noyau:/);

  await service.update(todos[0].id, { dueDate: "2026-08-27", projectId: "project-meridian" });
  await service.move(todos[1].id, "up");
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

test("chaque projet recoit son dossier et les taches suivent leur projet", async () => {
  const { service } = await fixture("- [ ] Ranger bureau\n");
  const synced = await service.syncProjectFolders([{ id: "project-noyau", name: "Noyau" }, { id: "project-jardin", name: "Jardin" }]);
  assert.deepEqual(synced.folders.map((folder) => folder.name), ["Noyau", "Jardin", "Sans dossier"]);

  const jardin = synced.folders.find((folder) => folder.projectId === "project-jardin");
  const moved = await service.update(synced.todos[0].id, { projectId: "project-jardin" });
  assert.equal(moved.todo.folderId, jardin.id);

  // Renommer le projet renomme son dossier, sans recreer de doublon.
  const renamed = await service.syncProjectFolders([{ id: "project-noyau", name: "Noyau" }, { id: "project-jardin", name: "Potager" }]);
  assert.equal(renamed.folders.filter((folder) => folder.projectId === "project-jardin").length, 1);
  assert.equal(renamed.folders.find((folder) => folder.projectId === "project-jardin").name, "Potager");
});

test("dossier libre: creation, taches dedans, suppression sans perte", async () => {
  const { service } = await fixture("");
  const { folders } = await service.addFolder({ name: "Maison" });
  const maison = folders.find((folder) => folder.name === "Maison");
  const created = await service.add({ text: "Changer ampoule", folderId: maison.id });
  assert.equal(created.todo.folderId, maison.id);

  const removed = await service.removeFolder(maison.id);
  assert.equal(removed.folders.some((folder) => folder.name === "Maison"), false);
  assert.equal(removed.todos.length, 1);
  assert.equal(removed.todos[0].folderId, "root");
});

test("tache barree: elle descend en bas du dossier et garde sa date de fin", async () => {
  const { service } = await fixture("- [ ] Une\n- [ ] Deux\n- [ ] Trois\n");
  const { todos } = await service.list();
  const done = await service.update(todos[0].id, { completed: true });
  assert.deepEqual(done.todos.map((todo) => todo.text), ["Deux", "Trois", "Une"]);
  assert.equal(done.todo.completed, true);
  assert.match(done.todo.completedAt, /^\d{4}-\d{2}-\d{2}T/);

  const undone = await service.update(todos[0].id, { completed: false });
  assert.equal(undone.todo.completedAt, null);
});

test("deplacements haut/bas et envoi direct en bas restent dans le dossier", async () => {
  const { service } = await fixture("- [ ] Une\n- [ ] Deux\n\n## Maison\n\n- [ ] Balai\n");
  const { todos } = await service.list();
  const top = await service.move(todos[1].id, "top");
  assert.deepEqual(top.todos.map((todo) => todo.text), ["Deux", "Une", "Balai"]);

  const bottom = await service.move(top.todos[0].id, "bottom");
  assert.deepEqual(bottom.todos.map((todo) => todo.text), ["Une", "Deux", "Balai"]);

  // Le balai est seul dans Maison: il ne doit pas remonter hors de son dossier.
  const stuck = await service.move(bottom.todos[2].id, "up");
  assert.deepEqual(stuck.todos.map((todo) => todo.text), ["Une", "Deux", "Balai"]);
});
