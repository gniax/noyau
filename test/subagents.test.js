import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentReader, summarizeSubagent } from "../server/subagents.js";
import { agentStatus, paneAgentState, withSubagents } from "../server/agent-status.js";

const line = (value) => JSON.stringify(value);
const user = (text) => line({ type: "user", timestamp: "2026-11-01T10:00:00Z", message: { content: text } });
const assistant = (content, stop_reason) => line({ type: "assistant", message: { content, stop_reason } });

test("a subagent is running until its last assistant message ends the turn", () => {
  const base = { meta: { description: "Fix", agentType: "general-purpose" }, id: "a1", mtimeMs: 1000, now: 2000 };
  const going = summarizeSubagent({ ...base, head: user("Fais X"), tail: [user("Fais X"), assistant([{ type: "text", text: "Je lis" }, { type: "tool_use", name: "Bash" }], "tool_use")].join("\n") });
  assert.equal(going.running, true);
  assert.equal(going.lastTool, "Bash");
  assert.equal(going.prompt, "Fais X");
  const done = summarizeSubagent({ ...base, head: user("Fais X"), tail: assistant([{ type: "text", text: "Fini" }], "end_turn") });
  assert.equal(done.running, false);
  assert.equal(done.lastText, "Fini");
  const stopped = summarizeSubagent({ ...base, head: user("Fais X"), tail: line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }) });
  assert.equal(stopped.running, false);
  assert.equal(stopped.interrupted, true);
});

test("the reader finds subagents next to the transcript and ages out silent ones", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-sub-"));
  const transcript = path.join(root, "s.jsonl");
  await fs.mkdir(path.join(root, "s", "subagents"), { recursive: true });
  const file = path.join(root, "s", "subagents", "agent-abc.jsonl");
  await fs.writeFile(file, `${user("Tâche")}\n${assistant([{ type: "tool_use", name: "Read" }], "tool_use")}\n`);
  await fs.writeFile(file.replace(".jsonl", ".meta.json"), JSON.stringify({ description: "Lire" }));
  let now = Date.now();
  const reader = new SubagentReader({ now: () => now });
  const [first] = await reader.list(transcript);
  assert.equal(first.id, "abc");
  assert.equal(first.description, "Lire");
  assert.equal(first.running, true);
  now += 20 * 60_000;
  assert.equal((await reader.list(transcript))[0].running, false);
  assert.deepEqual(await reader.list(path.join(root, "absent.jsonl")), []);
  await fs.rm(root, { recursive: true, force: true });
});

test("waiting for subagents is shown without pretending the agent is busy", () => {
  const status = withSubagents({ state: "available", label: "Disponible" }, [{ running: true }, { running: true }, { running: false }]);
  assert.equal(status.state, "available");
  assert.equal(status.subagents, 2);
  assert.equal(status.label, "Attend ses sous-agents");
  assert.equal(withSubagents({ state: "working", label: "Travail" }, [{ running: true }]).label, "Travail");
  assert.equal(withSubagents({ state: "available", label: "Disponible" }, []).label, "Disponible");
});

test("compacting shows on the spinner line, not when the word appears in a message", () => {
  const session = { assistant: "claude" };
  const compacting = agentStatus(session, {}, false, Date.now(), "✶ Compacting conversation… (12s · esc to interrupt)\n");
  assert.equal(compacting.state, "working");
  assert.equal(compacting.label, "Compacte le contexte");
  assert.notEqual(agentStatus(session, {}, false, Date.now(), "Je vais afficher Compacting dans la barre\n? for shortcuts\n").label, "Compacte le contexte");
  assert.equal(paneAgentState("✶ Compacting conversation…\n"), "working");
});
