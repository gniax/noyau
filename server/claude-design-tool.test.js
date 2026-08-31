import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ClaudeDesignTool } from "./claude-design-tool.js";

function createMockSpawn({ output = "Maquette et images générées", exitCode = 0, errorOutput = "" } = {}) {
  let executed = null;
  const spawnFn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end(data) {
        executed = { binary, args, options, stdin: data };
        process.nextTick(() => {
          if (output) child.stdout.emit("data", Buffer.from(output));
          if (errorOutput) child.stderr.emit("data", Buffer.from(errorOutput));
          child.emit("close", exitCode);
        });
      },
    };
    return child;
  };
  return { spawnFn, getExecuted: () => executed };
}

test("Claude Design tool exécute Claude en direct dans le dossier de l'agent et retourne réponse", async () => {
  const { spawnFn, getExecuted } = createMockSpawn({ output: "CSS et assets créés dans public/images" });
  const store = {
    get(id) {
      if (id === "agent-1") return { cwd: "/home/user/projects/my-app" };
      return null;
    },
  };
  const tool = new ClaudeDesignTool({ claudeBinary: "/usr/bin/claude", store, spawnFn });
  const result = await tool.run({ callerSessionId: "agent-1", prompt: "Crée landing page sombre" });

  assert.equal(result.success, true);
  assert.equal(result.response, "CSS et assets créés dans public/images");
  assert.equal(result.cwd, "/home/user/projects/my-app");
  const executed = getExecuted();
  assert.equal(executed.binary, "/usr/bin/claude");
  assert.equal(executed.options.cwd, "/home/user/projects/my-app");
  assert.match(executed.stdin, /Crée landing page sombre/);
});

test("Claude Design tool résout le cwd via projectId quand disponible", async () => {
  const { spawnFn, getExecuted } = createMockSpawn({ output: "Design prêt" });
  const store = {
    get(id) {
      if (id === "agent-2") return { projectId: "project-1" };
      return null;
    },
  };
  const projects = {
    get(id) {
      if (id === "project-1") return { rootPath: "/home/user/projects/atlas" };
      return null;
    },
  };
  const tool = new ClaudeDesignTool({ store, projects, spawnFn });
  const result = await tool.run({ callerSessionId: "agent-2", prompt: "Ajuste le logo" });

  assert.equal(result.cwd, "/home/user/projects/atlas");
  assert.equal(result.response, "Design prêt");
});

test("Claude Design tool gère les erreurs et retours vides proprement", async () => {
  const { spawnFn: failSpawn } = createMockSpawn({ exitCode: 1, errorOutput: "Erreur modèle" });
  const toolFail = new ClaudeDesignTool({ spawnFn: failSpawn, workspaceRoot: "/home/user" });
  await assert.rejects(() => toolFail.run({ prompt: "test" }), /Erreur modèle/);

  const { spawnFn: emptySpawn } = createMockSpawn({ output: "" });
  const toolEmpty = new ClaudeDesignTool({ spawnFn: emptySpawn, workspaceRoot: "/home/user" });
  await assert.rejects(() => toolEmpty.run({ prompt: "test" }), /réponse vide/);
});


