import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentDirectory } from "../server/agent-directory.js";

test("the working folder follows from the path, the project or the name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-dir-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-out-"));
  const resolve = (args) => resolveAgentDirectory({ workspaceRoot: root, ...args });
  assert.equal(await resolve({ project: { rootPath: outside, name: "X" } }), outside);
  assert.equal(await resolve({ project: { name: "Mon Été" } }), path.join(root, "mon-ete"));
  assert.ok((await fs.stat(path.join(root, "mon-ete"))).isDirectory());
  assert.equal(await resolve({ name: "Refonte Dashboard" }), path.join(root, "refonte-dashboard"));
  assert.equal(await resolve({ cwd: "sous/dossier" }), path.join(root, "sous", "dossier"));
  assert.equal(await resolve({}), root);
  assert.equal(await resolve({ cwd: outside, name: "ignoré" }), outside);
  await assert.rejects(resolve({ cwd: path.join(outside, "absent") }), /introuvable/);
  await assert.rejects(resolve({ cwd: "../hors-racine" }), /introuvable/);
  const file = path.join(root, "fichier");
  await fs.writeFile(file, "x");
  await assert.rejects(resolve({ cwd: "fichier" }), /invalide/);
  await Promise.all([root, outside].map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
