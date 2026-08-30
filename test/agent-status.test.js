import assert from "node:assert/strict";
import test from "node:test";
import { agentStatus, paneAgentState } from "../server/agent-status.js";

test("agent status prioritizes prompts, then fresh hooks", () => {
  const now = Date.parse("2026-08-25T10:00:00.000Z");
  const session = { assistant: "codex", activityAt: "2026-08-25T09:59:58.000Z" };
  assert.equal(agentStatus(session, {}, true, now).state, "waiting");
  assert.equal(agentStatus(session, { agentState: "waiting", agentStateUpdatedAt: "2026-08-25T09:59:30.000Z" }, false, now).state, "waiting");
  assert.equal(agentStatus(session, { agentState: "working", agentStateUpdatedAt: "2026-08-25T09:59:30.000Z" }, false, now).state, "working");
  // Hook de fin jamais recu: l'etat perime ne doit pas figer l'agent sur "Travail".
  assert.equal(agentStatus(session, { agentState: "working", agentStateUpdatedAt: "2026-08-25T09:50:00.000Z" }, false, now).state, "working");
  assert.equal(agentStatus({ ...session, activityAt: "2026-08-25T09:30:00.000Z" }, { agentState: "working", agentStateUpdatedAt: "2026-08-25T09:50:00.000Z" }, false, now).state, "available");
  assert.equal(agentStatus({ ...session, activityAt: "2026-08-25T09:58:00.000Z" }, { agentState: "working", agentStateUpdatedAt: "2026-08-25T09:59:30.000Z" }, false, now).state, "available");
});

test("pane content decides between working and idle", () => {
  assert.equal(paneAgentState("Thinking…\n  Esc to interrupt"), "working");
  assert.equal(paneAgentState("✻ Doing… (2m 52s · thought for 6s)\n❯\n  ⏵⏵ bypass permissions on (shift+tab to"), "working");
  assert.equal(paneAgentState("● Bash(npm test)\n  ⎿  Running…\n\n  ⏵⏵ bypass permissions on"), "working");
  assert.equal(paneAgentState("─ Worked for 11m 56s ─\n\n› Ask Codex to do anything\n\n  gpt-5.6-sol high · ~/projects/atlas"), "available");
  assert.equal(paneAgentState("❯\n  ? for shortcuts"), "available");
  assert.equal(paneAgentState("  ⏵⏵ bypass permissions on (shift+tab to cycle)"), null);
  assert.equal(paneAgentState("build output only"), null);
  assert.equal(paneAgentState("   "), null);
});

test("a stale working state is corrected by the pane", () => {
  const session = { assistant: "codex", activityAt: new Date().toISOString() };
  const metadata = { agentState: "working", agentStateUpdatedAt: new Date(Date.now() - 60_000).toISOString() };
  assert.equal(agentStatus(session, metadata, false, Date.now(), "› Ask Codex to do anything").state, "available");
  assert.equal(agentStatus(session, metadata, false, Date.now(), "").state, "working");
  const idle = { agentState: "working", agentStateUpdatedAt: new Date(Date.now() - 10 * 60_000).toISOString() };
  assert.equal(agentStatus({ ...session, activityAt: new Date(Date.now() - 5 * 60_000).toISOString() }, idle, false, Date.now(), "").state, "available");
});

test("Antigravity: le pane suffit a savoir s'il travaille", () => {
  const working = [
    "● Bash(node ../scripts/gen-flow-browser.mjs --inspect)",
    "⣻  Running command...",
    "──────",
    ">",
    "──────",
    "esc to cancel                                        Gemini 3.7 Flash · high",
  ].join("\n");
  assert.equal(paneAgentState(working), "working");

  const idle = [
    "  Aucune modification n'a été effectuée. Je suis prêt pour votre prochaine instruction.",
    "──────",
    ">",
    "──────",
    "? for shortcuts                                      Gemini 3.7 Flash · high",
  ].join("\n");
  assert.equal(paneAgentState(idle), "available");
});
