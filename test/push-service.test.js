import test from "node:test";
import assert from "node:assert/strict";
import { PushService } from "../server/push-service.js";

test("push subscriptions require HTTPS endpoint and keys", () => {
  const push = new PushService({ dataDir: "/tmp/noyau-test-unused" });
  assert.equal(push.valid({ endpoint: "http://push.test", keys: { p256dh: "a", auth: "b" } }), false);
  assert.equal(push.valid({ endpoint: "https://push.test/device", keys: { p256dh: "a", auth: "b" } }), true);
});
