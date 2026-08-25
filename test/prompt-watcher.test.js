import test from "node:test";
import assert from "node:assert/strict";
import { detectCodexApproval, PromptWatcher } from "../server/prompt-watcher.js";

test("Codex approval prompts are detected in visible pane tail", () => {
  assert.equal(detectCodexApproval("work\nWould you like to run the following command?\n› 1. Yes\n  2. No"), true);
  assert.equal(detectCodexApproval("Do you want to approve network access to api.example.com?"), true);
  assert.equal(detectCodexApproval("Command completed successfully.\nReady for next request."), false);
});

test("prompt watcher sends once until prompt disappears", async () => {
  let screen = "Would you like to make the following edits?\nYes\nNo";
  const payloads = [];
  const watcher = new PromptWatcher({
    tmux: {
      list: async () => [{ id: "noyau-codex-test", name: "Test", assistant: "codex", managed: true }],
      captureVisible: async () => screen,
    },
    push: { send: async (payload) => payloads.push(payload) },
  });
  await watcher.tick();
  await watcher.tick();
  assert.equal(payloads.length, 1);
  screen = "Ready";
  await watcher.tick();
  screen = "Would you like to grant these permissions?\nYes\nNo";
  await watcher.tick();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].url, "/?session=noyau-codex-test");
});
