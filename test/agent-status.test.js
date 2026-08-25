import assert from "node:assert/strict";
import test from "node:test";
import { agentStatus } from "../server/agent-status.js";

test("agent status prioritizes prompts and hooks", () => {
  const session = { assistant: "codex", activityAt: "2026-08-25T10:00:00.000Z" };
  assert.equal(agentStatus(session, {}, true).state, "waiting");
  assert.equal(agentStatus(session, { agentState: "available", agentStateUpdatedAt: "2026-08-25T10:00:01.000Z" }).state, "available");
  assert.equal(agentStatus(session, { agentState: "waiting", agentStateUpdatedAt: "2026-08-25T09:59:00.000Z" }).state, "working");
});
