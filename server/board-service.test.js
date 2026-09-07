import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BoardService } from "./board-service.js";

test("le tableau expose les trois zones de base par défaut", async () => {
  const service = new BoardService();
  const columns = await service.columns("principal");
  assert.deepEqual(columns.map((column) => column.id), ["todo", "review", "done"]);
  assert.equal(columns[2].kind, "done");
});

test("ajout, renommage, réordonnancement et suppression d'une zone personnalisée", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-board-test-"));
  const service = new BoardService({ file: path.join(directory, "todo-boards.json") });

  const { column, columns } = await service.add("principal", "En cours");
  assert.equal(column.kind, "custom");
  // La zone ajoutée se place juste avant « Terminé ».
  assert.deepEqual(columns.map((item) => item.id), ["todo", "review", column.id, "done"]);

  const renamed = await service.rename("principal", column.id, "En chantier");
  assert.equal(renamed.find((item) => item.id === column.id).name, "En chantier");

  const reordered = await service.reorder("principal", [column.id, "todo", "review", "done"]);
  assert.deepEqual(reordered.map((item) => item.id), [column.id, "todo", "review", "done"]);

  await assert.rejects(() => service.remove("principal", "todo"), /non supprimable/);

  const removed = await service.remove("principal", column.id);
  assert.deepEqual(removed.map((item) => item.id), ["todo", "review", "done"]);

  // Persistance sur disque: un nouveau service relit la même configuration.
  await service.add("principal", "Bloqué");
  const reloaded = new BoardService({ file: path.join(directory, "todo-boards.json") });
  assert.equal((await reloaded.columns("principal")).length, 4);
  assert.equal((await reloaded.columns("guest")).length, 3);

  await fs.rm(directory, { recursive: true, force: true });
});
