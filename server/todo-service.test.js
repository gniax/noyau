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

test("glisser-deposer: la tache se pose avant une autre du meme dossier", async () => {
  const { service } = await fixture("- [ ] Une\n- [ ] Deux\n- [ ] Trois\n");
  const { todos } = await service.list();
  const moved = await service.placeBefore(todos[2].id, todos[0].id);
  assert.deepEqual(moved.todos.map((todo) => todo.text), ["Trois", "Une", "Deux"]);

  const last = await service.placeBefore(moved.todos[0].id, null);
  assert.deepEqual(last.todos.map((todo) => todo.text), ["Une", "Deux", "Trois"]);
});

test("trois états de tâche: todo, review (à tester), done", async () => {
  const { file, service } = await fixture("- [ ] À faire\n- [/] À vérifier\n- [x] Terminé\n");
  const { todos } = await service.list();
  assert.equal(todos.length, 3);
  assert.equal(todos[0].status, "todo");
  assert.equal(todos[0].completed, false);
  assert.equal(todos[1].status, "review");
  assert.equal(todos[1].completed, false);
  assert.equal(todos[2].status, "done");
  assert.equal(todos[2].completed, true);

  // Passage en review
  const reviewed = await service.update(todos[0].id, { status: "review" });
  assert.equal(reviewed.todo.status, "review");
  assert.equal(reviewed.todo.completed, false);

  const content = await fs.readFile(file, "utf8");
  assert.match(content, /- \[\/\] À faire/);

  // Passage en done
  const finished = await service.update(todos[0].id, { status: "done" });
  assert.equal(finished.todo.status, "done");
  assert.equal(finished.todo.completed, true);

  // Retour en todo
  const reopened = await service.update(todos[0].id, { status: "todo" });
  assert.equal(reopened.todo.status, "todo");
  assert.equal(reopened.todo.completed, false);
});

test("commentaires sur les tâches: ajout, suppression et persistance à l'infini", async () => {
  const { file, service } = await fixture("- [ ] Tâche avec discussion\n");
  const { todos } = await service.list();
  const todoId = todos[0].id;

  const added1 = await service.addComment(todoId, { text: "Premier retour de test", author: "Camille" });
  assert.equal(added1.todo.comments.length, 1);
  assert.equal(added1.todo.comments[0].text, "Premier retour de test");
  assert.equal(added1.todo.comments[0].author, "Camille");

  const added2 = await service.addComment(todoId, { text: "Deuxième note de suivi", author: "Antigravity" });
  assert.equal(added2.todo.comments.length, 2);
  assert.equal(added2.todo.comments[1].text, "Deuxième note de suivi");

  const content = await fs.readFile(file, "utf8");
  assert.match(content, /Premier retour de test/);
  assert.match(content, /Deuxième note de suivi/);

  // Relecture du fichier depuis une nouvelle instance
  const fresh = new TodoService({ file });
  const reloaded = await fresh.list();
  assert.equal(reloaded.todos[0].comments.length, 2);

  // Suppression d'un commentaire
  const removed = await service.removeComment(todoId, added1.comment.id);
  assert.equal(removed.todo.comments.length, 1);
  assert.equal(removed.todo.comments[0].text, "Deuxième note de suivi");
});

test("les zones personnalisées survivent au fichier Markdown", async () => {
  const { file, service } = await fixture("- [ ] Tâche déplacée dans une zone maison\n");
  const { todos } = await service.list();
  const todoId = todos[0].id;

  const moved = await service.update(todoId, { status: "col-abcdef12" });
  assert.equal(moved.todo.status, "col-abcdef12");
  assert.equal(moved.todo.completed, false);

  // La case Markdown reste lisible a la main: statut intermediaire = [/]
  const content = await fs.readFile(file, "utf8");
  assert.match(content, /^- \[\/\] Tâche déplacée/m);

  const fresh = new TodoService({ file });
  const reloaded = await fresh.list();
  assert.equal(reloaded.todos[0].status, "col-abcdef12");

  // Un statut invalide retombe sur « a faire » plutot que de casser la tache.
  const rejected = await service.update(todoId, { status: "ZONE INVALIDE" });
  assert.equal(rejected.todo.status, "col-abcdef12");
});
