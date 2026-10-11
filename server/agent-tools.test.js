import assert from "node:assert/strict";
import test from "node:test";
import { AgentCommunicationService } from "./agent-tools.js";

test("AgentCommunicationService transmet le modèle Claude demandé", async () => {
  let created;
  const tmux = { async create(options) { created = options; return { id: "noyau-claude-test", name: options.name, assistant: options.assistant, projectId: null, cwd: options.cwd, yolo: false, agentState: "working" }; } };
  const service = new AgentCommunicationService({ tmux });
  await service.create({ name: "Octanix Marketing", assistant: "claude", model: "claude-opus-5-5", cwd: process.cwd(), prompt: "brief", yolo: false });
  assert.equal(created.model, "claude-opus-5-5");
});

test("AgentCommunicationService list enrichit et filtre les agents actifs", async () => {
  const tmux = {
    async list() {
      return [
        { id: "noyau-codex-1", managed: true, assistant: "codex", cwd: "/projects/octanix-faker", activityAt: "2026-09-02T10:00:00Z" },
        { id: "noyau-claude-2", managed: true, assistant: "claude", cwd: "/projects/octanix-scraper", activityAt: "2026-09-02T11:00:00Z" },
        { id: "external-tmux", managed: false, assistant: "shell", cwd: "/home", activityAt: "2026-09-02T09:00:00Z" },
      ];
    },
    async captureVisible() { return "prompt>"; }
  };
  const store = {
    get(id) {
      if (id === "noyau-codex-1") return { name: "Octanix Faker", projectId: "p1" };
      if (id === "noyau-claude-2") return { name: "Octanix Scraper", projectId: "p1", favorite: true };
      return null;
    }
  };
  const projects = {
    get(id) {
      if (id === "p1") return { name: "Octanix" };
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
  assert.equal(list[0].name, "Octanix Scraper");
  assert.equal(list[0].projectName, "Octanix");
  assert.equal(list[0].favorite, true);
  assert.equal(list[1].name, "Octanix Faker");
});

test("AgentCommunicationService resolve trouve par nom, id, projet et substring", async () => {
  const tmux = {
    async list() {
      return [
        { id: "noyau-codex-1", managed: true, assistant: "codex", cwd: "/projects/octanix-faker", activityAt: "2026-09-02T10:00:00Z" },
        { id: "noyau-claude-2", managed: true, assistant: "claude", cwd: "/projects/octanix-scraper", activityAt: "2026-09-02T11:00:00Z" },
        { id: "noyau-antigravity-3", managed: true, assistant: "antigravity", cwd: "/projects/atlas.example", activityAt: "2026-09-02T12:00:00Z" },
      ];
    },
    async captureVisible() { return ""; }
  };
  const store = {
    get(id) {
      if (id === "noyau-codex-1") return { name: "Octanix Faker", projectId: "p1" };
      if (id === "noyau-claude-2") return { name: "Octanix Scraper", projectId: "p1" };
      if (id === "noyau-antigravity-3") return { name: "Atlas App", projectId: "p2" };
      return null;
    }
  };
  const projects = {
    get(id) {
      if (id === "p1") return { name: "Octanix" };
      if (id === "p2") return { name: "Atlas" };
      return null;
    }
  };

  const service = new AgentCommunicationService({ tmux, store, projects });

  const exactName = await service.resolve("Octanix Faker");
  assert.equal(exactName.id, "noyau-codex-1");

  const partialName = await service.resolve("scraper");
  assert.equal(partialName.id, "noyau-claude-2");

  const byProject = await service.resolve("atlas");
  assert.equal(byProject.id, "noyau-antigravity-3");

  const byId = await service.resolve("noyau-codex-1");
  assert.equal(byId.name, "Octanix Faker");

  await assert.rejects(() => service.resolve("agent-inconnu"), /Agent introuvable pour « agent-inconnu »/);
});

test("AgentCommunicationService send injecte message formaté dans la session cible", async () => {
  let submitted = null;
  const tmux = {
    async list() {
      return [
        { id: "noyau-codex-1", managed: true, assistant: "codex", cwd: "/projects/octanix-faker", activityAt: "2026-09-02T10:00:00Z" },
        { id: "noyau-claude-2", managed: true, assistant: "claude", cwd: "/projects/octanix-scraper", activityAt: "2026-09-02T11:00:00Z" },
      ];
    },
    async captureVisible() { return ""; },
    async submit(id, text) {
      submitted = { id, text };
    }
  };
  const store = {
    get(id) {
      if (id === "noyau-codex-1") return { name: "Octanix Faker", projectId: "p1" };
      if (id === "noyau-claude-2") return { name: "Octanix Scraper", projectId: "p1" };
      return null;
    }
  };
  const projects = {
    get(id) {
      if (id === "p1") return { name: "Octanix" };
      return null;
    }
  };

  const service = new AgentCommunicationService({ tmux, store, projects });
  const result = await service.send("Octanix Faker", {
    message: "Voici les détails de l API : POST /api/scrape",
    callerSessionId: "noyau-claude-2"
  });

  assert.equal(result.success, true);
  assert.equal(result.target.name, "Octanix Faker");
  assert.equal(submitted.text.includes("[Message inter-agent de « Octanix Scraper (Projet Octanix) »]:"), true);
  assert.equal(submitted.text.includes("Voici les détails de l API : POST /api/scrape"), true);
});

test("un profil peut lire et piloter un agent partagé mais pas un agent privé d'un autre profil", async () => {
  let submitted = false;
  const tmux = {
    async list() { return [
      { id: "agent-private", managed: true, profileId: "owner", shared: false, assistant: "codex", activityAt: "2026-09-02T10:00:00Z" },
      { id: "agent-shared", managed: true, profileId: "owner", shared: true, assistant: "claude", activityAt: "2026-09-02T11:00:00Z" },
    ]; },
    async captureVisible() { return "contenu"; },
    async submit() { submitted = true; },
  };
  const service = new AgentCommunicationService({ tmux });
  // L'agent privé est invisible pour le visiteur
  await assert.rejects(() => service.context("agent-private", { profileId: "visitor" }), /Agent introuvable/);
  await assert.rejects(() => service.send("agent-private", { profileId: "visitor", message: "reprends" }), /Agent introuvable/);
  assert.equal(submitted, false);

  // L'agent partagé est visible et accessible
  const list = await service.list({ profileId: "visitor" });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "agent-shared");
  const ctx = await service.context("agent-shared", { profileId: "visitor" });
  assert.equal(ctx.agent.id, "agent-shared");
});

test("AgentCommunicationService context inclut les fichiers de projet partagés", async () => {
  const tmux = {
    async list() {
      return [{ id: "noyau-codex-1", managed: true, assistant: "codex", cwd: "/tmp", activityAt: "2026-09-02T10:00:00Z" }];
    },
    async captureVisible() { return ""; },
  };
  const store = {
    get(id) {
      if (id === "noyau-codex-1") return { name: "Agent Test", projectId: "proj-1" };
      return null;
    },
  };
  const projectFiles = {
    async list(projectId) {
      if (projectId === "proj-1") return [{ name: "doc.pdf", size: 1024 }];
      return [];
    },
  };
  const service = new AgentCommunicationService({ tmux, store, projectFiles });
  const ctx = await service.context("noyau-codex-1");
  assert.equal(ctx.projectFiles.length, 1);
  assert.equal(ctx.projectFiles[0].name, "doc.pdf");
});
