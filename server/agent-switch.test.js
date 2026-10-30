import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxController } from "./tmux.js";
import { SessionStore } from "./session-store.js";
import { AgentCommunicationService } from "./agent-tools.js";
import { AgentMemoryService } from "./agent-memory.js";

const run = promisify(execFile);

test("real tmux switches providers in place on an isolated socket", async (t) => {
  try { await run("tmux", ["-V"]); } catch { t.skip("tmux unavailable"); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-switch-test-"));
  const socket = path.join(directory, "tmux.sock");
  t.after(async () => {
    await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Stand-in providers accept all CLI arguments without running a real AI or using credentials.
  const provider = path.join(directory, "provider.sh");
  await fs.writeFile(provider, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/launch-args"\nprintf "session=%s\\n" "$NOYAU_SESSION_ID"\nexec sleep 60\n', { mode: 0o700 });
  const store = new SessionStore(path.join(directory, "sessions.json"));
  const memory = new AgentMemoryService({ root: path.join(directory, "memory"), claudeRoot: path.join(directory, "claude"), store });
  const controller = new TmuxController({ store, workspaceRoot: directory, codexBinary: provider, claudeBinary: provider, antigravityBinary: provider, memory, codexConfigFile: path.join(directory, "absent-config") });
  controller.run = (args) => run("tmux", ["-S", socket, ...args]);
  controller.acceptTrustPrompt = async () => {};
  const service = new AgentCommunicationService({ store, tmux: controller });
  const first = await controller.create({ name: "Test", assistant: "claude", cwd: directory });
  await memory.writeNotes(first.id, { text: "shared-memory-test-marker" });
  for (const assistant of ["codex", "antigravity", "claude"]) {
    // Passation longue: au-dela de la limite tmux, le lancement passe par un script.
    const replaced = await controller.create({ name: "Test", replaceId: first.id, assistant, cwd: directory, prompt: `handover 'quote' ${"é".repeat(12_000)} end-marker` });
    assert.equal(replaced.id, first.id);
    assert.equal(replaced.agentId, first.agentId);
    const sessions = await controller.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, first.id);
    assert.equal(sessions[0].assistant, assistant);
    const [agent] = await service.list();
    assert.equal(agent.id, first.agentId);
    assert.equal(agent.assistant, assistant);
    // Verify the environment belongs to the unchanged runtime after respawn-pane.
    let screen = "";
    for (let attempt = 0; attempt < 20 && !screen.includes(`session=${first.id}`); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      screen = await controller.captureVisible(first.id);
    }
    assert.ok(screen.includes(`session=${first.id}`));
    let launchArgs = "";
    const flag = assistant === "codex" ? "developer_instructions=" : assistant === "claude" ? "--append-system-prompt" : "--prompt-interactive";
    for (let attempt = 0; attempt < 20; attempt++) {
      launchArgs = await fs.readFile(path.join(directory, "launch-args"), "utf8");
      if (launchArgs.includes(flag)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(launchArgs.includes(flag));
    assert.ok(launchArgs.includes("shared-memory-test-marker"));
    assert.ok(launchArgs.includes("handover 'quote'") && launchArgs.includes("end-marker"));
  }
});
