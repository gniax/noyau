import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TmuxController, batchTmuxCommands, chainCommands, classifyAssistant, createSessionId, literalKeyCommands, validSessionId } from "../server/tmux.js";

test("session identifiers stay tmux-safe", () => {
  const id = createSessionId("codex");
  assert.match(id, /^noyau-agent-[a-z0-9]+-[a-f0-9]{4}$/);
  assert.equal(validSessionId(id), true);
  assert.equal(validSessionId("bad/name"), false);
});

test("assistant classification uses metadata first", () => {
  assert.equal(classifyAssistant("node", "claude"), "claude");
  assert.equal(classifyAssistant("codex", null), "codex");
  assert.equal(classifyAssistant("zsh", null), "shell");
});

test("switching Claude, Codex and Antigravity preserves public ID, runtime ID, aliases and metadata", async () => {
  const id = "noyau-agent-mvqmy99s-7a5f";
  const entries = { [id]: { agentId: id, agentAliases: ["noyau-claude-mvnjtlij-8737"], assistant: "claude", core: true, createdAt: "2026-10-01", threadId: "obsolete", agentSessionId: "obsolete", transcriptPath: "obsolete", model: "old-model" } };
  const store = { get: (key) => entries[key], set: async (key, value) => { entries[key] = value; } };
  const controller = new TmuxController({ store, workspaceRoot: os.tmpdir() });
  const commands = [];
  controller.run = async (args) => { commands.push(args); return { stdout: "" }; };
  controller.acceptTrustPrompt = async () => {};
  for (const assistant of ["codex", "antigravity", "claude"]) {
    const result = await controller.create({ replaceId: id, name: "Manager", assistant, cwd: os.tmpdir(), prompt: "handover", yolo: true });
    assert.equal(result.id, id);
    assert.equal(result.agentId, id);
    assert.equal(result.assistant, assistant);
    assert.equal(result.core, true);
    assert.equal(result.createdAt, "2026-10-01");
    assert.deepEqual(result.agentAliases, ["noyau-claude-mvnjtlij-8737"]);
    assert.equal(result.threadId, null);
    assert.equal(result.agentSessionId, null);
    assert.equal(result.transcriptPath, null);
    assert.equal(result.model, null);
    assert.equal(result.migratedTo, null);
  }
  const replacements = commands.filter((args) => args[0] === "respawn-pane");
  assert.equal(replacements.length, 3);
  for (const args of replacements) {
    assert.equal(args[3], `=${id}:0.0`);
    assert.ok(args.includes(`NOYAU_SESSION_ID=${id}`));
    assert.ok(args.includes("handover"));
  }
  assert.equal(commands.some((args) => ["new-session", "kill-session"].includes(args[0])), false);
});

test("failed replacement leaves previous identity and metadata intact", async () => {
  const id = "noyau-claude-mvnjtlij-8737";
  const entry = { assistant: "claude", agentId: "noyau-agent-mvnjtlij-8737" };
  let saved = false;
  const controller = new TmuxController({ store: { get: () => entry, set: async () => { saved = true; } }, workspaceRoot: os.tmpdir() });
  controller.run = async () => { throw new Error("respawn failed"); };
  await assert.rejects(controller.create({ replaceId: id, assistant: "codex", cwd: os.tmpdir() }), /respawn failed/);
  assert.equal(saved, false);
  assert.equal(entry.assistant, "claude");
  await assert.rejects(controller.create({ replaceId: "invalid/id", assistant: "codex", cwd: os.tmpdir() }), /Session à remplacer introuvable/);
});

test("missing tmux socket is an empty session list", async () => {
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir() });
  controller.run = async () => {
    const error = new Error("Command failed");
    error.stderr = "error connecting to /tmp/tmux-1000/default (No such file or directory)";
    throw error;
  };
  assert.deepEqual(await controller.list(), []);
});

test("unrestricted mode uses agent-specific CLI flag", async () => {
  const saved = [];
  const controller = new TmuxController({ store: { set: async (_id, value) => saved.push(value) }, workspaceRoot: os.tmpdir() });
  const commands = [];
  controller.run = async (args) => { commands.push(args); return { stdout: "" }; };
  const lastCreation = () => commands.filter((args) => args.includes("new-session")).at(-1);
  await controller.create({ assistant: "codex", cwd: os.tmpdir(), yolo: true });
  const codexCommand = lastCreation();
  assert.deepEqual(codexCommand.slice(codexCommand.indexOf("codex")), ["codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false", "--dangerously-bypass-hook-trust"]);
  assert.equal(saved[0].runningYolo, true);
  assert.equal(saved[0].autoRestore, true);

  await controller.create({ assistant: "claude", cwd: os.tmpdir(), yolo: true });
  const claudeCommand = lastCreation();
  assert.deepEqual(claudeCommand.slice(claudeCommand.indexOf("claude")), ["claude", "--dangerously-skip-permissions"]);
});

test("agent creation defaults projectLogo to true when projectId is set", async () => {
  const saved = [];
  const controller = new TmuxController({ store: { set: async (_id, value) => saved.push(value) }, workspaceRoot: os.tmpdir() });
  controller.run = async () => ({ stdout: "" });
  await controller.create({ assistant: "codex", cwd: os.tmpdir(), projectId: "project-1" });
  assert.equal(saved[0].projectLogo, true);
  await controller.create({ assistant: "codex", cwd: os.tmpdir() });
  assert.equal(saved[1].projectLogo, false);
});

test("new agent rejects missing working directory", async () => {
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir() });
  await assert.rejects(() => controller.create({ assistant: "codex", cwd: path.join(os.tmpdir(), "noyau-missing-directory") }), /Dossier de travail introuvable/);
});

test("agent restart targets first pane and preserves exact context", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-codex-restart-"));
  await fs.writeFile(path.join(directory, "rollout-2026-09-07T10-00-00-thread-id.jsonl"), "{}\n");
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir(), codexSessionsRoot: directory });
  let command = null;
  controller.run = async (args) => { command = args; return { stdout: "" }; };
  await controller.restartAgent({ id: "noyau-codex-safe", assistant: "codex", cwd: os.tmpdir(), threadId: "thread-id", yolo: true });
  assert.deepEqual(command, ["respawn-pane", "-k", "-t", "=noyau-codex-safe:0.0", "-c", os.tmpdir(), "codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false", "--dangerously-bypass-hook-trust", "resume", "thread-id"]);

  // Fil introuvable sur disque: on repart sur la derniere conversation plutot que de laisser codex sortir en erreur.
  await controller.restartAgent({ id: "noyau-codex-safe", assistant: "codex", cwd: os.tmpdir(), threadId: "thread-gone", yolo: true });
  assert.equal(command.at(-1), "--last");

  await fs.rm(directory, { recursive: true, force: true });
});

test("agent stop removes metadata when tmux session already ended", async () => {
  const events = [];
  const entry = { assistant: "codex", autoRestore: true };
  const store = {
    get: () => entry,
    set: async (_id, value) => events.push(["set", value.autoRestore]),
    remove: async (id) => events.push(["remove", id]),
  };
  const controller = new TmuxController({ store, workspaceRoot: os.tmpdir() });
  controller.run = async () => {
    const error = new Error("Command failed");
    error.stderr = "can't find session: noyau-codex-gone";
    throw error;
  };
  await controller.kill("noyau-codex-gone");
  assert.deepEqual(events, [["set", false], ["remove", "noyau-codex-gone"]]);
});

test("legacy restore plan keeps only live sessions", async () => {
  const data = {
    "noyau-codex-live": { assistant: "codex" },
    "noyau-codex-stale": { assistant: "codex" },
  };
  const store = {
    all: () => data,
    setMany: async (entries) => entries.forEach(([id, value]) => { data[id] = value; }),
  };
  const controller = new TmuxController({ store, workspaceRoot: os.tmpdir() });
  controller.list = async () => [{ id: "noyau-codex-live" }];
  const result = await controller.initializeRestorePlan();
  assert.deepEqual(result, { live: 1, migrated: 2 });
  assert.equal(data["noyau-codex-live"].autoRestore, true);
  assert.equal(data["noyau-codex-stale"].autoRestore, false);
});

test("boot restore resumes exact agent contexts", async () => {
  const data = {
    "noyau-codex-safe": { assistant: "codex", cwd: os.tmpdir(), yolo: true, threadId: "codex-thread", autoRestore: true },
    "noyau-claude-safe": { assistant: "claude", cwd: os.tmpdir(), yolo: true, agentSessionId: "claude-session", autoRestore: true },
    "noyau-shell-safe": { assistant: "shell", cwd: os.tmpdir(), autoRestore: true },
  };
  const store = {
    all: () => data,
    set: async (id, value) => { data[id] = value; },
  };
  const commands = [];
  const controller = new TmuxController({ store, workspaceRoot: os.tmpdir() });
  controller.list = async () => [];
  controller.run = async (args) => { commands.push(args); return { stdout: "" }; };
  const result = await controller.restorePersisted();
  assert.deepEqual(result.failed, []);
  assert.equal(result.restored.length, 3);
  assert.deepEqual(commands[0], ["new-session", "-d", "-s", "noyau-codex-safe", "-c", os.tmpdir(), "-e", "NOYAU_SESSION_ID=noyau-codex-safe", "codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false", "--dangerously-bypass-hook-trust", "resume", "codex-thread"]);
  assert.deepEqual(commands[1], ["new-session", "-d", "-s", "noyau-claude-safe", "-c", os.tmpdir(), "-e", "NOYAU_SESSION_ID=noyau-claude-safe", "claude", "--dangerously-skip-permissions", "--resume", "claude-session"]);
  assert.deepEqual(commands[2], ["new-session", "-d", "-s", "noyau-shell-safe", "-c", os.tmpdir(), "-e", "NOYAU_SESSION_ID=noyau-shell-safe"]);
});

test("a codex thread with no session file on disk never reaches the resume flag", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-codex-sessions-"));
  await fs.writeFile(path.join(directory, "rollout-2026-09-07T10-00-00-11111111-2222-3333-4444-555555555555.jsonl"), "{}\n");
  const commands = [];
  const controller = new TmuxController({
    store: { set: async () => {} },
    workspaceRoot: os.tmpdir(),
    codexSessionsRoot: directory,
  });
  controller.run = async (args) => { commands.push(args); return { stdout: "" }; };
  const lastCreation = () => commands.filter((args) => args.includes("new-session")).at(-1);

  // Un fil connu est repris tel quel.
  await controller.create({ assistant: "codex", cwd: os.tmpdir(), threadId: "11111111-2222-3333-4444-555555555555" });
  assert.ok(lastCreation().includes("resume"));

  // Un fil fantome ferait sortir codex en erreur: on demarre une session neuve.
  await controller.create({ assistant: "codex", cwd: os.tmpdir(), threadId: "99999999-9999-9999-9999-999999999999" });
  assert.ok(!lastCreation().includes("resume"));

  await fs.rm(directory, { recursive: true, force: true });
});

test("agent restart with resume=false starts fresh without resuming conversation", async () => {
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir() });
  let command = null;
  controller.run = async (args) => { command = args; return { stdout: "" }; };

  await controller.restartAgent({ id: "noyau-codex-fresh", assistant: "codex", cwd: os.tmpdir(), yolo: true, resume: false });
  assert.ok(!command.includes("resume"));
  assert.ok(!command.includes("--last"));

  await controller.restartAgent({ id: "noyau-claude-fresh", assistant: "claude", cwd: os.tmpdir(), yolo: false, resume: false });
  assert.ok(!command.includes("--continue"));
  assert.ok(!command.includes("--resume"));

  await controller.restartAgent({ id: "noyau-antigravity-fresh", assistant: "antigravity", cwd: os.tmpdir(), yolo: false, resume: false });
  assert.ok(!command.includes("--continue"));
  assert.ok(!command.includes("--conversation"));
});

test("clearHistory executes tmux clear-history", async () => {
  const commands = [];
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir() });
  controller.run = async (args) => { commands.push(args); return { stdout: "" }; };

  await controller.clearHistory("noyau-codex-test");
  assert.deepEqual(commands[0], ["clear-history", "-H", "-t", "=noyau-codex-test:0.0"]);
});

test("la saisie litterale garde un point-virgule final que tmux prendrait pour un separateur", () => {
  assert.deepEqual(literalKeyCommands("s", "ls -la"), [["send-keys", "-t", "s", "-l", "--", "ls -la"]]);
  assert.deepEqual(literalKeyCommands("s", "a;;"), [["send-keys", "-t", "s", "-l", "--", "a"], ["send-keys", "-t", "s", "-H", "3b", "3b"]]);
  assert.deepEqual(literalKeyCommands("s", ";"), [["send-keys", "-t", "s", "-H", "3b"]]);
  assert.deepEqual(literalKeyCommands("s", ""), []);
  assert.deepEqual(chainCommands([["a"], ["b", "c"]]), ["a", ";", "b", "c"]);
});


test("long unicode prompts are split into bounded tmux batches without losing text", () => {
 const text = `${"é🍜abc".repeat(4000)};`; const commands = literalKeyCommands("test", text); const batches = batchTmuxCommands(commands);
 assert.ok(batches.length > 1); assert.ok(batches.every(batch => batch.reduce((n, part) => n + Buffer.byteLength(part) + 1, 0) <= 6000));
 const rebuilt = commands.map(command => command.includes("-H") ? ";".repeat(command.filter(x => x === "3b").length) : command.at(-1)).join(""); assert.equal(rebuilt,text);
});

test("tmux output stays tab-separated without a UTF-8 locale", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-tmux-args-"));
  const binary = path.join(directory, "tmux");
  // tmux replaces -F tabs by "_" unless -u forces UTF-8: the fake mirrors that behaviour.
  await fs.writeFile(binary, `#!/bin/sh\nif [ "$1" = "-u" ]; then printf 's1\\t1793541891\\t1\\tzsh\\t/tmp\\t42\\n'; else printf 's1_1793541891_1_zsh_/tmp_42\\n'; fi\n`, { mode: 0o755 });
  const controller = new TmuxController({ binary, store: { get: () => null, all: () => ({}) }, workspaceRoot: os.tmpdir() });
  const [session] = await controller.list();
  assert.equal(session.id, "s1");
  assert.equal(session.activityAt, new Date(1793541891 * 1000).toISOString());
  await fs.rm(directory, { recursive: true, force: true });
});
