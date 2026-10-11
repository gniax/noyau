import test from "node:test";
import assert from "node:assert/strict";
import { AgentCommunicationService } from "../server/agent-tools.js";

test("AgentCommunicationService.create creates agent inheriting caller project and yolo permission", async () => {
  let createdParams = null;
  const mockTmux = {
    create: async (params) => {
      createdParams = params;
      return {
        id: "noyau-codex-test-123",
        ...params,
        agentState: params.prompt ? "working" : "available",
      };
    },
    list: async () => [],
  };

  const mockStore = {
    get: (id) => {
      if (id === "caller-agent-1") {
        return {
          id: "caller-agent-1",
          name: "Parent Agent",
          assistant: "codex",
          projectId: "proj-abc",
          cwd: "/path/to/project",
          yolo: true,
          runningYolo: true,
          profileId: "prof-xyz",
          shared: false,
        };
      }
      return null;
    },
  };

  const mockProjects = {
    get: (id) => {
      if (id === "proj-abc") {
        return { id: "proj-abc", name: "Alpha Project", rootPath: "/path/to/project", shared: false };
      }
      return null;
    },
    all: () => ({
      "proj-abc": { id: "proj-abc", name: "Alpha Project", rootPath: "/path/to/project" },
    }),
  };

  const service = new AgentCommunicationService({
    tmux: mockTmux,
    store: mockStore,
    projects: mockProjects,
    workspaceRoot: "/fallback/root",
  });

  const res = await service.create({
    name: "Sub Worker",
    prompt: "Génère les mocks de test",
    callerSessionId: "caller-agent-1",
  });

  assert.equal(res.success, true);
  assert.equal(res.agent.id, "noyau-codex-test-123");
  assert.equal(res.agent.name, "Sub Worker");
  assert.equal(res.agent.projectId, "proj-abc");
  assert.equal(res.agent.projectName, "Alpha Project");
  assert.equal(res.agent.cwd, "/path/to/project");
  assert.equal(res.agent.yolo, true);
  assert.equal(res.agent.prompt, "Génère les mocks de test");

  assert.equal(createdParams.name, "Sub Worker");
  assert.equal(createdParams.projectId, "proj-abc");
  assert.equal(createdParams.projectLogo, true);
  assert.equal(createdParams.yolo, true);
  assert.equal(createdParams.prompt, "Génère les mocks de test");
});

test("AgentCommunicationService resolves project by name and assigns agent", async () => {
  let killed = null;
  const mockTmux = {
    kill: async (id) => { killed = id; },
    list: async () => [{ id: "agent-123", managed: true }],
  };
  const sessions = {
    "agent-123": { id: "agent-123", name: "Traductions", projectId: null },
  };
  const mockStore = {
    get: (id) => sessions[id] || null,
    set: async (id, data) => { sessions[id] = data; },
  };
  const mockProjects = {
    get: (id) => id === "project-mt8ac94v-aeb626" ? { id: "project-mt8ac94v-aeb626", name: "Atlas" } : null,
    all: () => ({
      "project-mt8ac94v-aeb626": { id: "project-mt8ac94v-aeb626", name: "Atlas" },
    }),
  };
  const service = new AgentCommunicationService({
    tmux: mockTmux,
    store: mockStore,
    projects: mockProjects,
  });

  const assignRes = await service.assignProject("Traductions", "Atlas");
  assert.equal(assignRes.success, true);
  assert.equal(assignRes.agent.projectId, "project-mt8ac94v-aeb626");
  assert.equal(sessions["agent-123"].projectId, "project-mt8ac94v-aeb626");

  const stopRes = await service.stop("Traductions");
  assert.equal(stopRes.success, true);
  assert.equal(killed, "agent-123");
});
