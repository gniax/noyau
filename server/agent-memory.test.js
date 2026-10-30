import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentMemoryService, redactMemory } from "./agent-memory.js";
import { AgentCommunicationService } from "./agent-tools.js";
import { SessionStore } from "./session-store.js";
import { TmuxController } from "./tmux.js";

const id = "noyau-agent-memory-beef";
const alias = "noyau-claude-memory-beef";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-memory-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(path.join(directory, "sessions.json"));
  const metadata = { agentId: id, agentAliases: [alias], name: "Test", cwd: directory, assistant: "claude", projectId: "project-one", profileId: "owner" };
  await store.set(id, metadata);
  const options = { root: path.join(directory, "memory"), claudeRoot: path.join(directory, "claude"), store, script: "/noyau/scripts/noyau-agent.mjs" };
  const memory = new AgentMemoryService(options);
  const tmux = { list: async () => [{ ...store.get(id), id, managed: true, activityAt: "2026-10-27T10:00:00Z" }] };
  const communication = new AgentCommunicationService({ store, tmux, memory });
  return { directory, store, metadata, options, memory, communication };
}

test("durable notes survive engine changes, service reload and runtime replacement", async (t) => {
  const { memory, store, metadata, options, communication } = await fixture(t);
  await communication.writeMemory(alias, { text: "Production interdite sans validation." }, { profileId: "owner" });
  for (const assistant of ["codex", "antigravity", "claude"]) {
    await store.set(id, { ...metadata, assistant });
    assert.match((await memory.prepare(id, store.get(id))).instructions, /Production interdite sans validation/);
    assert.match((await communication.readMemory(alias, { profileId: "owner" })).notes, /Production interdite/);
  }
  const fresh = new AgentMemoryService(options);
  assert.equal((await fresh.read(id)).notes, "Production interdite sans validation.");
  await store.set("noyau-agent-restored-abcd", { ...metadata, assistant: "codex" });
  assert.equal((await fresh.read("noyau-agent-restored-abcd")).notes, "Production interdite sans validation.");
});

test("memory is isolated by agent, project, workspace and owner profile", async (t) => {
  const { memory, store, metadata } = await fixture(t);
  await memory.writeNotes(id, { text: "private state" });
  const other = "noyau-agent-other-abcd";
  await store.set(other, { ...metadata, agentId: other });
  assert.equal((await memory.read(other)).notes, "");
  for (const scope of [{ projectId: "project-two" }, { cwd: path.dirname(metadata.cwd) }, { profileId: "other" }]) {
    assert.equal((await memory.read(id, { ...metadata, ...scope })).notes, "");
  }
  await assert.rejects(memory.read(id, { ...metadata, agentId: "../outside" }), /Identifiant mémoire invalide/);
});

test("concurrent appends are serialized and stale edits cannot erase newer notes", async (t) => {
  const { memory } = await fixture(t);
  await Promise.all(Array.from({ length: 15 }, (_, index) => memory.writeNotes(id, { text: `decision-${index}`, append: true })));
  const state = await memory.read(id);
  assert.equal(state.revision, 15);
  for (let index = 0; index < 15; index++) assert.ok(state.notes.includes(`decision-${index}`));
  await assert.rejects(memory.writeNotes(id, { text: "overwrite", revision: 1 }), /modifiée entre-temps/);
  await assert.rejects(memory.writeNotes(id, { text: "", append: true }), /Note mémoire vide/);
  await assert.rejects(memory.writeNotes(id, { text: "x".repeat(32_001) }), /32 000/);
  assert.equal((await memory.read(id)).notes, state.notes);
});

test("automatic checkpoints are bounded, deduplicated and separate from durable notes", async (t) => {
  const { memory } = await fixture(t);
  await memory.writeNotes(id, { text: "long-term decision" });
  for (let index = 0; index < 9; index++) await memory.checkpoint(id, { assistant: "codex", text: `response-${index}` });
  const state = await memory.read(id);
  assert.equal(state.checkpoints.length, 6);
  assert.equal(state.checkpoints[0].text, "response-3");
  await memory.checkpoint(id, { assistant: "codex", text: "response-8" });
  assert.equal((await memory.read(id)).revision, state.revision);
  await memory.writeNotes(id, { text: "edited durable note" });
  assert.deepEqual((await memory.read(id)).checkpoints, state.checkpoints);
});

test("history purge removes automatic context across this profile's scopes without erasing durable notes or other profiles", async (t) => {
  const { memory, store, metadata } = await fixture(t);
  await memory.writeNotes(id, { text: "explicit durable note" });
  await memory.checkpoint(id, { assistant: "codex", text: "historical response" });
  const oldScope = { ...metadata, projectId: "former-project" };
  await memory.checkpoint(id, { assistant: "claude", text: "former conversation" }, oldScope);
  const other = "noyau-agent-other-abcd";
  await store.set(other, { ...metadata, agentId: other, profileId: "other" });
  await memory.checkpoint(other, { assistant: "claude", text: "other owner's conversation" });
  await memory.clearProfileContext("owner");
  assert.equal((await memory.read(id)).checkpoints.length, 0);
  assert.equal((await memory.read(id, oldScope)).checkpoints.length, 0);
  assert.equal((await memory.read(id)).notes, "explicit durable note");
  assert.equal((await memory.read(other)).checkpoints.length, 1);
});

test("capture uses only the identified conversation and preserves notes when history is missing", async (t) => {
  const { memory, store, metadata } = await fixture(t);
  await memory.writeNotes(id, { text: "durable" });
  let requested;
  memory.handover = { messages: async (options) => { requested = options; return [{ role: "user", text: "current task" }, { role: "assistant", text: "result" }]; } };
  await store.set(id, { ...metadata, conversationId: "identified-conversation" });
  await memory.capture(id);
  assert.equal(requested.strict, true);
  assert.equal(requested.conversationId, "identified-conversation");
  assert.match((await memory.read(id)).snapshot, /current task/);
  memory.handover.messages = async () => [];
  await memory.capture(id);
  assert.equal((await memory.read(id)).notes, "durable");
  assert.match((await memory.read(id)).snapshot, /current task/);
});

test("Claude legacy memory import is bounded to this project and never overwrites agent notes", async (t) => {
  const { memory, metadata, options, directory } = await fixture(t);
  const native = path.join(options.claudeRoot, directory.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
  await fs.mkdir(native, { recursive: true });
  await fs.writeFile(path.join(native, "MEMORY.md"), "Decision Claude historique.");
  await fs.writeFile(path.join(native, "deploy.md"), "Validation fondateur avant production.");
  await fs.writeFile(path.join(native, "décisions.md"), "Note avec un nom de fichier français.");
  await fs.writeFile(path.join(directory, "not-memory.txt"), "unrelated secret source");
  await fs.symlink(path.join(directory, "not-memory.txt"), path.join(native, "unsafe.md"));
  await memory.writeNotes(id, { text: "manual agent note" });
  const context = await memory.prepare(id, metadata);
  assert.match(context.instructions, /Decision Claude historique/);
  assert.match(context.instructions, /Validation fondateur/);
  assert.match(context.instructions, /nom de fichier français/);
  assert.doesNotMatch(context.instructions, /unrelated secret/);
  assert.equal((await memory.read(id)).notes, "manual agent note");
  await fs.writeFile(path.join(native, "MEMORY.md"), "Nouvelle decision Claude.");
  await memory.prepare(id, metadata);
  assert.match((await memory.read(id)).claudeMemory, /Nouvelle decision/);
  assert.equal((await fs.stat(context.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(context.file))).mode & 0o777, 0o700);
});

test("prompt excerpts preserve recent context and stay bounded; full memory remains readable", async (t) => {
  const { memory, metadata } = await fixture(t);
  await memory.writeNotes(id, { text: "N".repeat(30_000) });
  await memory.checkpoint(id, { assistant: "claude", text: "latest-recovery-point" });
  const context = await memory.prepare(id, metadata);
  assert.ok(context.instructions.length < 14_000);
  assert.match(context.instructions, /latest-recovery-point/);
  assert.match(context.instructions, /memory noyau-agent-memory-beef read/);
  assert.match(context.instructions, /après compaction/);
  assert.ok((await memory.read(id)).notes.length === 30_000);
});

test("memory access respects visibility and shared-agent edits remain owner-only", async (t) => {
  const { memory, store, metadata, communication } = await fixture(t);
  await memory.writeNotes(id, { text: "owner note" });
  await assert.rejects(communication.readMemory(alias, { profileId: "visitor" }), /Aucun agent actif/);
  await store.set(id, { ...metadata, shared: true });
  assert.equal((await communication.readMemory(alias, { profileId: "visitor" })).notes, "owner note");
  await assert.rejects(communication.writeMemory(alias, { text: "overwrite" }, { profileId: "visitor" }), /autre profil/);
});

test("obvious credentials are redacted in memory notes, imports and checkpoints", async (t) => {
  const { memory } = await fixture(t);
  const fake = "sk-" + "a".repeat(30);
  assert.doesNotMatch(redactMemory(`key ${fake} password=hunter2`), /hunter2|sk-/);
  await memory.writeNotes(id, { text: `Use API_KEY=${fake}` });
  await memory.checkpoint(id, { assistant: "codex", text: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----" });
  const state = await memory.read(id);
  assert.doesNotMatch(JSON.stringify(state), /not-a-real-key|sk-/);
  assert.match(state.notes, /REDACTED/);
});

test("launch integrations preserve custom Codex instructions and use engine-native flags", async (t) => {
  const { memory, store, metadata, directory } = await fixture(t);
  await memory.writeNotes(id, { text: "shared decision" });
  const config = path.join(directory, "codex-config.toml");
  const controller = new TmuxController({ store, workspaceRoot: directory, memory, codexConfigFile: config });
  let launch = await controller.memoryLaunch(id, { ...metadata, assistant: "codex" });
  assert.equal(launch.args[0], "-c");
  assert.match(launch.args[1], /^developer_instructions=/);
  assert.match(launch.args[1], /shared decision/);
  await fs.writeFile(config, 'developer_instructions = "keep my instructions"\n');
  launch = await controller.memoryLaunch(id, { ...metadata, assistant: "codex" });
  assert.deepEqual(launch.args, []);
  assert.match(launch.initial, /shared decision/);
  await fs.writeFile(config, 'profiles.personal."developer_instructions" = "preserve dotted keys too"\n');
  assert.deepEqual((await controller.memoryLaunch(id, { ...metadata, assistant: "codex" })).args, []);
  launch = await controller.memoryLaunch(id, metadata);
  assert.equal(launch.args[0], "--append-system-prompt");
  launch = await controller.memoryLaunch(id, { ...metadata, assistant: "antigravity" });
  assert.equal(launch.args[0], "--add-dir");
  assert.match(launch.initial, /shared decision/);
  assert.deepEqual(await controller.memoryLaunch(id, { ...metadata, assistant: "shell" }), { args: [], initial: "" });
});

test("create, restart and boot restore all inject memory for each engine", async (t) => {
  const { memory, store, metadata, directory } = await fixture(t);
  await memory.writeNotes(id, { text: "common memory" });
  const controller = new TmuxController({ store, workspaceRoot: directory, memory, codexConfigFile: path.join(directory, "absent-config") });
  const commands = [];
  controller.run = async (args) => { commands.push(args); return { stdout: "" }; };
  controller.acceptTrustPrompt = async () => {};
  controller.list = async () => [];
  for (const assistant of ["codex", "claude", "antigravity"]) {
    await store.set(id, { ...metadata, assistant, autoRestore: true });
    await controller.create({ name: "Test", replaceId: id, assistant, cwd: directory, profileId: "owner", projectId: "project-one" });
    let command = commands.filter((args) => args[0] === "respawn-pane").at(-1);
    assert.match(command.join(" "), /common memory/);
    assert.equal(command.includes("--last"), false);
    assert.equal(command.includes("--continue"), false);
    await controller.restartAgent({ id, assistant, cwd: directory, resume: true });
    command = commands.filter((args) => args[0] === "respawn-pane").at(-1);
    assert.match(command.join(" "), /common memory/);
    await controller.restartAgent({ id, assistant, cwd: directory, resume: false });
    command = commands.filter((args) => args[0] === "respawn-pane").at(-1);
    assert.match(command.join(" "), /common memory/);
    assert.equal(command.includes("resume"), false);
    assert.equal(command.includes("--continue"), false);
    const restored = await controller.restorePersisted();
    assert.deepEqual(restored.failed, []);
    assert.match(commands.filter((args) => args[0] === "new-session").at(-1).join(" "), /common memory/);
    assert.equal(commands.filter((args) => args[0] === "new-session").at(-1).includes("--last"), false);
    assert.equal(commands.filter((args) => args[0] === "new-session").at(-1).includes("--continue"), false);
  }
});
