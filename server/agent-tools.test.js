import assert from "node:assert/strict";
import test from "node:test";
import { AgentCommunicationService } from "./agent-tools.js";

test("AgentCommunicationService list enrichit et filtre les agents actifs", async () => {
  const tmux = {
    async list() {
      return [
        { id: "noyau-codex-1", managed: true, assistant: "codex", cwd: "/projects/atlas-faker", activityAt: "2026-09-02T10:00:00Z" },
        { id: "noyau-claude-2", managed: true, assistant: "claude", cwd: "/projects/atlas-scraper", activityAt: "2026-09-02T11:00:00Z" },
        { id: "external-tmux", managed: false, assistant: "shell", cwd: "/home", activityAt: "2026-09-02T09:00:00Z" },
      ];
    },
    async captureVisible() { return "prompt>"; }
  };
  const store = {
    get(id) {
      if (id === "noyau-codex-1") return { name: "Atlas Faker", projectId: "p1" };
      if (id === "noyau-claude-2") return { name: "Atlas Scraper", projectId: "p1", favorite: true };
      return null;
    }
  };
  const projects = {
    get(id) {
      if (id === "p1") return { name: "Atlas" };
      return null;
    }
  };
  const agentStatus = {
    status(id) {
      return { state: "available", label: "Disponible" };
    }
  };

  const service = new AgentCommunicationService({ tmux, store, projects, agentStatus });
  const list = await service.list();

  assert.equal(list.length, 2);
  assert.equal(list[0].name, "Atlas Scraper");
  assert.equal(list[0].projectName, "Atlas");
  assert.equal(list[0].favorite, true);
  assert.equal(list[1].name, "Atlas Faker");
});

test("AgentCommunicationService resolve trouve par nom, id, projet et substring", async () => {
  const tmux = {
    async list() {
      return [
        { id: "noyau-codex-1", managed: true, assistant: "codex", cwd: "/projects/atlas-faker", activityAt: "2026-09-02T10:00:00Z" },
        { id: "noyau-claude-2", managed: true, assistant: "claude", cwd: "/projects/atlas-scraper", activityAt: "2026-09-02T11:00:00Z" },
        { id: "noyau-antigravity-3", managed: true, assistant: "antigravity", cwd: "/projects/meridian.app", activityAt: "2026-09-02T12:00:00Z" },
      ];
    },
    async captureVisible() { return ""; }
  };
  const store = {
    get(id) {
      if (id === "noyau-codex-1") return { name: "Atlas Faker", projectId: "p1" };
      if (id === "noyau-claude-2") return { name: "Atlas Scraper", projectId: "p1" };
      if (id === "noyau-antigravity-3") return { name: "Meridian App", projectId: "p2" };
      return null;
    }
  };
  const projects = {
    get(id) {
      if (id === "p1") return { name: "Atlas" };
      if (id === "p2") return { name: "Meridian" };
      return null;
    }
  };

  const service = new AgentCommunicationService({ tmux, store, projects });

  const exactName = await service.resolve("Atlas Faker");
  assert.equal(exactName.id, "noyau-codex-1");

  const partialName = await service.resolve("scraper");
  assert.equal(partialName.id, "noyau-claude-2");

  const byProject = await service.resolve("meridian");
  assert.equal(byProject.id, "noyau-antigravity-3");

  const byId = await service.resolve("noyau-codex-1");
  assert.equal(byId.name, "Atlas Faker");

  await assert.rejects(() => service.resolve("agent-inconnu"), /Agent introuvable pour « agent-inconnu »/);
});

test("AgentCommunicationService send injecte message formaté dans la session cible", async () => {
  let submitted = null;
  const tmux = {
    async list() {
      return [
        { id: "noyau-codex-1", managed: true, assistant: "codex", cwd: "/projects/atlas-faker", activityAt: "2026-09-02T10:00:00Z" },
        { id: "noyau-claude-2", managed: true, assistant: "claude", cwd: "/projects/atlas-scraper", activityAt: "2026-09-02T11:00:00Z" },
      ];
    },
    async captureVisible() { return ""; },
    async submit(id, text) {
      submitted = { id, text };
    }
  };
  const store = {
    get(id) {
      if (id === "noyau-codex-1") return { name: "Atlas Faker", projectId: "p1" };
      if (id === "noyau-claude-2") return { name: "Atlas Scraper", projectId: "p1" };
      return null;
    }
  };
  const projects = {
    get(id) {
      if (id === "p1") return { name: "Atlas" };
      return null;
    }
  };

  const service = new AgentCommunicationService({ tmux, store, projects });
  const result = await service.send("Atlas Faker", {
    message: "Voici les détails de l API : POST /api/scrape",
    callerSessionId: "noyau-claude-2"
  });

  assert.equal(result.success, true);
  assert.equal(result.target.name, "Atlas Faker");
  assert.equal(submitted.text.includes("[Message inter-agent de « Atlas Scraper (Projet Atlas) »]:"), true);
  assert.equal(submitted.text.includes("Voici les détails de l API : POST /api/scrape"), true);
});
