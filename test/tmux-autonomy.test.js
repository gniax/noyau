import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TmuxController } from "../server/tmux.js";
import { newAutonomy } from "../server/autonomy.js";

const id = "noyau-autonome1";

async function fixture(t, entry) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-tmux-autonomy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = entry ? { [id]: { cwd: directory, ...entry } } : {};
  const store = { get: (key) => data[key] || null, all: () => data, async set(key, value) { data[key] = value; }, async setMany() {}, async remove(key) { delete data[key]; } };
  const controller = new TmuxController({ store, workspaceRoot: directory });
  const commands = [];
  controller.run = async (args) => { commands.push(args); return { stdout: "" }; };
  controller.acceptTrustPrompt = async () => {};
  controller.list = async () => [];
  controller.codexThreadResumable = async () => true;
  return { controller, commands, store, directory };
}
const launch = (commands, verb) => commands.filter((args) => args[0] === verb).at(-1);
const hasPair = (args, first, second) => args.some((value, index) => value === first && args[index + 1] === second);

test("create: le niveau choisit le modèle Claude et est mémorisé", async (t) => {
  const { controller, commands, store, directory } = await fixture(t);
  const { id: created } = await controller.create({ name: "A", assistant: "claude", cwd: directory, model: "ignored", autonomy: newAutonomy({ level: "eco" }) });
  assert.ok(hasPair(launch(commands, "new-session"), "--model", "haiku"));
  assert.ok(!launch(commands, "new-session").includes("ignored"));
  assert.equal(store.get(created).autonomy.appliedLevel, "eco");
});

test("create: effort Codex placé avant le sous-commande de reprise", async (t) => {
  const { controller, commands, directory } = await fixture(t);
  await controller.create({ name: "A", assistant: "codex", cwd: directory, threadId: "thread-1", autonomy: newAutonomy({ level: "max" }) });
  const args = launch(commands, "new-session");
  assert.ok(hasPair(args, "-c", "model_reasoning_effort=high"));
  assert.ok(args.indexOf("-c") < args.indexOf("resume"));
});

test("restartAgent: le niveau courant prime et la conversation est reprise", async (t) => {
  const { controller, commands, store } = await fixture(t, { assistant: "claude", autonomy: { ...newAutonomy({ level: "max" }), appliedLevel: "eco" } });
  await controller.restartAgent({ id, assistant: "claude", model: "old", cwd: store.get(id).cwd, threadId: "conv-9" });
  const args = launch(commands, "respawn-pane");
  assert.ok(hasPair(args, "--model", "opus"));
  assert.ok(hasPair(args, "--resume", "conv-9"));
  assert.equal(store.get(id).autonomy.appliedLevel, "max");
});

test("restartAgent Codex: effort appliqué, reprise conservée", async (t) => {
  const { controller, commands, store } = await fixture(t, { assistant: "codex", autonomy: newAutonomy({ level: "eco" }) });
  await controller.restartAgent({ id, assistant: "codex", cwd: store.get(id).cwd, threadId: "thread-7" });
  const args = launch(commands, "respawn-pane");
  assert.ok(hasPair(args, "-c", "model_reasoning_effort=low"));
  assert.ok(hasPair(args, "resume", "thread-7"));
});

test("sans autonomie, les lancements restent inchangés", async (t) => {
  const { controller, commands, store } = await fixture(t, { assistant: "claude" });
  await controller.restartAgent({ id, assistant: "claude", model: "sonnet", cwd: store.get(id).cwd, threadId: "c" });
  assert.ok(hasPair(launch(commands, "respawn-pane"), "--model", "sonnet"));
  assert.ok(!launch(commands, "respawn-pane").join(" ").includes("model_reasoning_effort"));
});

test("restorePersisted: le niveau survit à un redémarrage du serveur, Claude et Codex", async (t) => {
  const { controller, commands, store, directory } = await fixture(t, { assistant: "claude", autoRestore: true, agentSessionId: "conv-2", autonomy: newAutonomy({ level: "normal" }) });
  await store.set("noyau-autonome2", { assistant: "codex", cwd: directory, autoRestore: true, threadId: "t-2", autonomy: newAutonomy({ level: "eco" }) });
  const result = await controller.restorePersisted();
  assert.equal(result.restored.length, 2);
  const [claude, codex] = commands.filter((args) => args[0] === "new-session");
  assert.ok(hasPair(claude, "--model", "sonnet"));
  assert.ok(hasPair(claude, "--resume", "conv-2"));
  assert.ok(hasPair(codex, "-c", "model_reasoning_effort=low"));
  assert.ok(hasPair(codex, "resume", "t-2"));
});

test("restoreOne: l'échec est mémorisé et remonté", async (t) => {
  const { controller, store } = await fixture(t, { assistant: "claude", cwd: "/n-existe-pas-autonomy" });
  await assert.rejects(() => controller.restoreOne(id));
  assert.ok(store.get(id).restoreError);
});

test("bascule de fournisseur: l'autonomie suit et le niveau est traduit", async (t) => {
  const { controller, commands, store, directory } = await fixture(t, { assistant: "claude", name: "A", autonomy: newAutonomy({ level: "max" }) });
  await controller.create({ name: "A", assistant: "codex", cwd: directory, replaceId: id });
  assert.ok(hasPair(launch(commands, "respawn-pane"), "-c", "model_reasoning_effort=high"));
  assert.equal(store.get(id).autonomy.enabled, true);
});
