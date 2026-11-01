import test from "node:test";
import assert from "node:assert/strict";
import { agentNotificationTitle, detectCodexApproval, PromptWatcher } from "../server/prompt-watcher.js";

test("Codex approval prompts are detected in visible pane tail", () => {
  assert.equal(detectCodexApproval("work\nWould you like to run the following command?\n› 1. Yes\n  2. No"), true);
  assert.equal(detectCodexApproval("Do you want to approve network access to api.example.com?\n1. Yes\n2. No"), true);
  assert.equal(detectCodexApproval("Command completed successfully.\nReady for next request."), false);
  assert.equal(detectCodexApproval("The report mentioned: Would you like to run the following command?\nWorked for 10s\n› Ask Codex to do anything"), false);
  // Discussing prompts while working or idle must never look like one.
  assert.equal(detectCodexApproval("Would you like to run the following command?\nyes or no, that is what it prints\n• Working (3s • esc to interrupt)"), false);
  assert.equal(detectCodexApproval("Would you like to make the following edits?\n1. Yes 2. No\nDone.\n› \ntab to queue message   50% context left"), false);
  assert.equal(detectCodexApproval("› 1. Yes\n  2. No\nWould you like to run the following command?"), false);
});

test("agent notification title includes project source", () => {
  assert.equal(agentNotificationTitle("Octanix", "Codex a terminé"), "[Octanix] Codex a terminé");
  assert.equal(agentNotificationTitle(" Octanix\nprod ", "Claude attend"), "[Octanix prod] Claude attend");
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
    sessionLabel: () => "Octanix",
  });
  await watcher.tick();
  await watcher.tick();
  assert.equal(payloads.length, 1);
  screen = "Ready";
  await watcher.tick();
  screen = "Would you like to grant these permissions?\nYes\nNo";
  await watcher.tick();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].title, "Octanix");
  assert.equal(payloads[0].body, "Test attend votre validation.");
  assert.equal(payloads[0].url, "/?session=noyau-codex-test");
});

test('false-positive dismissal lasts only until the prompt disappears',async()=>{let screen='Would you like to run the following command?\n1. Yes\n2. No';let sent=0;const watcher=new PromptWatcher({tmux:{list:async()=>[{id:'x',assistant:'codex',managed:true}],captureVisible:async()=>screen},push:{send:async()=>sent++}});await watcher.tick();assert.equal(watcher.isWaiting('x'),true);watcher.dismiss('x');await watcher.tick();assert.equal(watcher.isWaiting('x'),false);screen='Ready';await watcher.tick();screen='Would you like to run the following command?\n1. Yes\n2. No';await watcher.tick();assert.equal(watcher.isWaiting('x'),true);assert.equal(sent,2);});
