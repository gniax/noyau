import assert from "node:assert/strict";
import test from "node:test";
import { agentStatus, paneAgentState } from "../server/agent-status.js";

test("agent status prioritizes prompts and hooks", () => {
  const session = { assistant: "codex", activityAt: "2026-08-25T10:00:00.000Z" };
  assert.equal(agentStatus(session, {}, true).state, "waiting");
  assert.equal(agentStatus(session, { agentState: "available", agentStateUpdatedAt: "2026-08-25T10:00:01.000Z" }).state, "available");
  assert.equal(agentStatus(session, { agentState: "waiting", agentStateUpdatedAt: "2026-08-25T09:59:00.000Z" }).state, "working");
});

test("pane content decides between working and idle", () => {
  assert.equal(paneAgentState("Thinking…\n  Esc to interrupt"), "working");
  assert.equal(paneAgentState("─ Worked for 11m 56s ─\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ~/projects/atlas"), "available");
  assert.equal(paneAgentState("  ⏵⏵ bypass permissions on (shift+tab to cycle)"), "available");
  assert.equal(paneAgentState("build output only"), null);
  assert.equal(paneAgentState("   "), null);
});

test("a stale working state is corrected by the pane", () => {
  const session = { assistant: "codex", activityAt: new Date().toISOString() };
  const metadata = { agentState: "working", agentStateUpdatedAt: new Date(Date.now() - 60_000).toISOString() };
  assert.equal(agentStatus(session, metadata, false, Date.now(), "› Ask Codex to do anything").state, "available");
  assert.equal(agentStatus(session, metadata, false, Date.now(), "").state, "working");
});
