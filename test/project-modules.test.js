import test from "node:test";
import assert from "node:assert/strict";
import { groupProjectModules, projectStats } from "../shared/project-modules.js";

test("modules form one list with problems first, whatever their environment", () => {
  const groups = groupProjectModules([
    { id: "prod-ok", environment: "production" },
    { id: "prod-ko", environment: "production", state: "failed" },
    { id: "tool-setup", environment: "local", setup: { status: "required" } },
    { id: "tool", environment: "local" },
    { id: "build", environment: "local", deviceBuild: true },
  ], [{ id: "new" }]);
  assert.deepEqual(groups.attention.map((m) => m.id), ["prod-ko", "tool-setup"]);
  assert.deepEqual(groups.production.map((m) => m.id), ["prod-ok"]);
  assert.deepEqual(groups.tools.map((m) => m.id), ["build", "tool"]);
  assert.deepEqual(groups.proposals.map((m) => m.id), ["new"]);
});

test("project stats ignore finished tasks and count alerts", () => {
  const stats = projectStats({
    agents: [{ agentStatus: { state: "working" } }, { agentStatus: { state: "waiting" } }, {}],
    todos: [{ status: "todo" }, { status: "done" }, { status: "review" }, { completed: true }],
    modules: [{ enabled: true }, { enabled: true, state: "failed" }, {}],
  });
  assert.deepEqual(stats, { agents: 3, working: 1, waiting: 1, openTodos: 2, modules: 3, activeModules: 2, alerts: 1 });
});
