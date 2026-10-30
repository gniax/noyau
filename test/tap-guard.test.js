import test from "node:test";
import assert from "node:assert/strict";
import { createTapGuard } from "../src/tap-guard.js";
test("synthetic click after slow native permission never repeats an action", async () => {
  let now = 0, finish, calls = 0; const guard = createTapGuard(() => now); const button = {};
  guard.run(button, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  now = 3000; assert.equal(guard.allowClick(button), false); finish(); await Promise.resolve();
  assert.equal(guard.allowClick(button), false); now += 701; assert.equal(guard.allowClick(button), true); assert.equal(calls, 1);
});
