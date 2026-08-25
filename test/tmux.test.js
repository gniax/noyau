import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
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

test("unrestricted mode uses agent-specific CLI flag", async () => {
  const saved = [];
  const controller = new TmuxController({ store: { set: async (_id, value) => saved.push(value) }, workspaceRoot: os.tmpdir() });
  let command = null;
  controller.run = async (args) => { command = args; return { stdout: "" }; };
  await controller.create({ assistant: "codex", cwd: os.tmpdir(), yolo: true });
  assert.deepEqual(command.slice(command.indexOf("codex")), ["codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false"]);
  assert.equal(saved[0].runningYolo, true);

  await controller.create({ assistant: "claude", cwd: os.tmpdir(), yolo: true });
  assert.deepEqual(command.slice(command.indexOf("claude")), ["claude", "--dangerously-skip-permissions"]);
});

test("agent restart targets first pane and preserves exact context", async () => {
  const controller = new TmuxController({ store: {}, workspaceRoot: os.tmpdir() });
  let command = null;
  controller.run = async (args) => { command = args; return { stdout: "" }; };
  await controller.restartAgent({ id: "noyau-codex-safe", assistant: "codex", cwd: os.tmpdir(), threadId: "thread-id", yolo: true });
  assert.deepEqual(command, ["respawn-pane", "-k", "-t", "=noyau-codex-safe:0.0", "-c", os.tmpdir(), "codex", "--no-alt-screen", "--yolo", "-c", "check_for_update_on_startup=false", "resume", "thread-id"]);
});
