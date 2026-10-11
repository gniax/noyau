import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BoardService } from "./board-service.js";

test("le tableau expose les trois zones de base par défaut", async () => {
  const service = new BoardService();
  const columns = await service.columns("main");
  assert.deepEqual(columns.map((column) => column.id), ["todo", "review", "done"]);
  assert.equal(columns[1].name, "À valider");
  assert.equal(columns[2].kind, "done");

  const toggled = await service.update("main", "review", { enabled: false });
  assert.equal(toggled.find((c) => c.id === "review").enabled, false);

  const reenabled = await service.update("main", "review", { enabled: true });
  assert.equal(reenabled.find((c) => c.id === "review").enabled, true);
});

test("ajout, renommage, réordonnancement et suppression d'une zone personnalisée", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-board-test-"));
  const service = new BoardService({ file: path.join(directory, "todo-boards.json") });

  const { column, columns } = await service.add("main", "En cours");
  assert.equal(column.kind, "custom");
  // La zone ajoutée se place juste avant « Terminé ».
  assert.deepEqual(columns.map((item) => item.id), ["todo", "review", column.id, "done"]);

  const renamed = await service.rename("main", column.id, "En chantier");
  assert.equal(renamed.find((item) => item.id === column.id).name, "En chantier");

  const reordered = await service.reorder("main", [column.id, "todo", "review", "done"]);
  assert.deepEqual(reordered.map((item) => item.id), [column.id, "todo", "review", "done"]);

  await assert.rejects(() => service.remove("main", "todo"), /non supprimable/);

  const removed = await service.remove("main", column.id);
  assert.deepEqual(removed.map((item) => item.id), ["todo", "review", "done"]);

  // Persistance sur disque: un nouveau service relit la même configuration.
  await service.add("main", "Bloqué");
  const reloaded = new BoardService({ file: path.join(directory, "todo-boards.json") });
  assert.equal((await reloaded.columns("main")).length, 4);
  assert.equal((await reloaded.columns("aurora")).length, 3);

  await fs.rm(directory, { recursive: true, force: true });
});

test("la reformulation LLM se coupe par profil sans perdre les zones", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-board-correction-"));
  const service = new BoardService({ file: path.join(directory, "todo-boards.json") });

  // La relecture locale ne coute aucun quota: active par defaut.
  assert.equal((await service.settings("main")).correction, true);
  const { column } = await service.add("main", "Bloqué");

  await service.setCorrection("main", false);
  const settings = await service.settings("main");
  assert.equal(settings.correction, false);
  assert.ok(settings.columns.some((item) => item.id === column.id));

  // Le reglage survit au rechargement, et reste propre a ce profil.
  const reloaded = new BoardService({ file: path.join(directory, "todo-boards.json") });
  assert.equal((await reloaded.settings("main")).correction, false);
  assert.equal((await reloaded.settings("aurora")).correction, true);

  await fs.rm(directory, { recursive: true, force: true });
});

test("la zone À valider peut être désactivée et son statut enabled survit au rechargement", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-board-review-"));
  const service = new BoardService({ file: path.join(directory, "todo-boards.json") });

  const toggled = await service.update("main", "review", { enabled: false });
  assert.equal(toggled.find((c) => c.id === "review").enabled, false);

  const reloaded = new BoardService({ file: path.join(directory, "todo-boards.json") });
  const settings = await reloaded.settings("main");
  assert.equal(settings.columns.find((c) => c.id === "review").enabled, false);

  await fs.rm(directory, { recursive: true, force: true });
});

