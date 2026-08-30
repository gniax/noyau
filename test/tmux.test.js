import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { TmuxController, classifyAssistant, createSessionId, validSessionId } from "../server/tmux.js";

test("session identifiers stay tmux-safe", () => {
  const id = createSessionId("codex");
  assert.match(id, /^noyau-codex-[a-z0-9]+-[a-f0-9]{4}$/);
  assert.equal(validSessionId(id), true);
  assert.equal(validSessionId("bad/name"), false);
});

test("assistant classification uses metadata first", () => {
  assert.equal(classifyAssistant("node", "claude"), "claude");
  assert.equal(classifyAssistant("codex", null), "codex");
  assert.equal(classifyAssistant("zsh", null), "shell");
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
  assert.deepEqual(codexCommand.slice(codexCommand.indexOf("codex")), ["codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false"]);
  assert.equal(saved[0].runningYolo, true);
  assert.equal(saved[0].autoRestore, true);

  await controller.create({ assistant: "claude", cwd: os.tmpdir(), yolo: true });
  const claudeCommand = lastCreation();
  assert.deepEqual(claudeCommand.slice(claudeCommand.indexOf("claude")), ["claude", "--dangerously-skip-permissions"]);
});

test("new agent rejects missing working directory", async () => {
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir() });
  await assert.rejects(() => controller.create({ assistant: "codex", cwd: path.join(os.tmpdir(), "noyau-missing-directory") }), /Dossier de travail introuvable/);
});

test("agent restart targets first pane and preserves exact context", async () => {
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir() });
  let command = null;
  controller.run = async (args) => { command = args; return { stdout: "" }; };
  await controller.restartAgent({ id: "noyau-codex-safe", assistant: "codex", cwd: os.tmpdir(), threadId: "thread-id", yolo: true });
  assert.deepEqual(command, ["respawn-pane", "-k", "-t", "=noyau-codex-safe:0.0", "-c", os.tmpdir(), "codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false", "resume", "thread-id"]);
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
  assert.deepEqual(commands[0], ["new-session", "-d", "-s", "noyau-codex-safe", "-c", os.tmpdir(), "-e", "NOYAU_SESSION_ID=noyau-codex-safe", "codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false", "resume", "codex-thread"]);
  assert.deepEqual(commands[1], ["new-session", "-d", "-s", "noyau-claude-safe", "-c", os.tmpdir(), "-e", "NOYAU_SESSION_ID=noyau-claude-safe", "claude", "--dangerously-skip-permissions", "--resume", "claude-session"]);
  assert.deepEqual(commands[2], ["new-session", "-d", "-s", "noyau-shell-safe", "-c", os.tmpdir(), "-e", "NOYAU_SESSION_ID=noyau-shell-safe"]);
});
