import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeDesignTool } from "./claude-design-tool.js";

class MemoryStore {
  constructor(data) { this.data = data; }
  get(id) { return this.data[id] || null; }
  async set(id, value) { this.data[id] = value; }
}

test("Claude Design tool appelle agent disponible du même projet et retourne réponse", async () => {
  let now = 1_000;
  let submitted = "";
  const store = new MemoryStore({
    caller: { projectId: "project-a" },
    design: { name: "Studio", projectId: "project-a", agentState: "available", agentStateUpdatedAt: new Date(0).toISOString(), response: "ancienne" },
    foreign: { projectId: "project-b", agentState: "available" },
  });
  const tmux = {
    async list() {
      return [
        { id: "design", name: "Studio", assistant: "claude-design", managed: true, activityAt: new Date(0).toISOString() },
        { id: "foreign", assistant: "claude-design", managed: true, activityAt: new Date(0).toISOString() },
      ];
    },
    async capture() { return "Claude ready\n? for shortcuts"; },
    async submit(_id, prompt) { submitted = prompt; },
  };
  const tool = new ClaudeDesignTool({
    tmux,
    store,
    readResponse: async (metadata) => metadata.response || "",
    now: () => now,
    wait: async () => {
      now += 1_000;
      await store.set("design", { ...store.get("design"), agentState: "available", agentStateUpdatedAt: new Date(now).toISOString(), response: "maquette créée" });
    },
    pollInterval: 1,
    timeout: 5_000,
  });
  const result = await tool.run({ callerSessionId: "caller", prompt: "Crée landing page" });
  assert.equal(submitted, "Crée landing page");
  assert.equal(result.sessionId, "design");
  assert.equal(result.response, "maquette créée");
});

test("Claude Design tool refuse agent d'un autre projet", async () => {
  const store = new MemoryStore({ caller: { projectId: "project-a" }, foreign: { projectId: "project-b", agentState: "available" } });
  const tool = new ClaudeDesignTool({
    store,
    tmux: { async list() { return [{ id: "foreign", assistant: "claude-design", managed: true }]; } },
    readResponse: async () => "",
  });
  await assert.rejects(() => tool.run({ callerSessionId: "caller", prompt: "test" }), /Aucun agent Claude Design actif/);
});
