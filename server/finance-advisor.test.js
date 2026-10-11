import test from "node:test";
import assert from "node:assert/strict";
import { FinanceAdvisor } from "./finance-advisor.js";

test("finance falls back from Antigravity to Codex then Claude", async () => {
  const service = new FinanceAdvisor({ antigravityBinary: "agy" });
  const order = [];
  service.runPrintProvider = async (_prompt, _schema, provider) => {
    order.push(provider);
    if (provider === "antigravity") throw new Error("quota");
    return "ok";
  };
  service.runCodex = async () => { order.push("codex"); throw new Error("quota"); };
  assert.equal(await service.run("question"), "ok");
  assert.deepEqual(order, ["antigravity", "codex", "claude"]);
  assert.equal(service.lastProvider, "claude");
});

test("finance skips missing Antigravity and retries malformed JSON", async () => {
  const service = new FinanceAdvisor();
  service.runCodex = async () => "not JSON";
  service.runPrintProvider = async (_prompt, _schema, provider) => {
    assert.equal(provider, "claude");
    return '{"items":[]}';
  };
  assert.equal(await service.run("question", {}), '{"items":[]}');
});

test("successful Antigravity response does not call other providers", async () => {
  const service = new FinanceAdvisor({ antigravityBinary: "agy" });
  service.runPrintProvider = async (_prompt, _schema, provider) => {
    assert.equal(provider, "antigravity");
    return "ok";
  };
  service.runCodex = async () => assert.fail("unexpected Codex call");
  assert.equal(await service.run("question"), "ok");
  assert.equal(service.lastProvider, "antigravity");
});
