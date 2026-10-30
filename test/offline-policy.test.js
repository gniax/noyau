import test from "node:test";
import assert from "node:assert/strict";
import { canQueueOffline } from "../src/offline-policy.js";
test("offline outbox never persists credentials, permissions, purchases or deferred agent commands", () => {
  for (const path of ["/api/auth", "/api/auth/switch", "/api/logout", "/api/profiles/owner", "/api/agent-tools/agents/test/send", "/api/agent-tools/agents/test/stop", "/api/sessions/a/migrate", "/api/groceries/checkout", "/api/mobile/push", "/api/todos/../auth"]) assert.equal(canQueueOffline(path, "POST"), false, path);
});
test("only explicit Todo and calendar subscription edits can enter the legacy offline outbox", () => { assert.equal(canQueueOffline("/api/todos", "POST"), true); assert.equal(canQueueOffline("/api/todos/a", "PATCH"), true); assert.equal(canQueueOffline("/api/calendar/subscriptions/a", "DELETE"), true); assert.equal(canQueueOffline("/api/todos", "GET"), false); });
