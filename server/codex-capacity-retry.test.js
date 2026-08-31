import assert from "node:assert/strict";
import test from "node:test";
import { CAPACITY_ERROR, CodexCapacityRetry, codexQuotaAvailable } from "./codex-capacity-retry.js";

test("capacity retry only submits Codex with quota remaining", async () => {
  assert.match("Selected model is at capacity. Please try a different model.", CAPACITY_ERROR);
  assert.equal(codexQuotaAvailable({ windows: [{ remainingPercent: 0 }] }), false);
  const submitted = [];
  const tmux = {
    list: async () => [{ id: "codex", assistant: "codex", managed: true }, { id: "claude", assistant: "claude", managed: true }],
    capture: async () => "Selected model is at capacity. Please try a different model.",
    submit: async (id, value) => submitted.push([id, value]),
  };
  const providerState = { get: () => ({ windows: [{ remainingPercent: 20 }] }) };
  const retry = new CodexCapacityRetry({ tmux, providerState, now: () => 100_000 });
  assert.equal(await retry.check(), 1);
  assert.deepEqual(submitted, [["codex", "continue"]]);
  assert.equal(await retry.check(), 0);
});

test("capacity retry stays idle at zero quota", async () => {
  let listed = false;
  const retry = new CodexCapacityRetry({ tmux: { list: async () => { listed = true; return []; } }, providerState: { get: () => ({ windows: [{ remainingPercent: 0 }] }) } });
  assert.equal(await retry.check(), 0);
  assert.equal(listed, false);
});
