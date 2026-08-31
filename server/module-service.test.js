import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModuleService, parseSystemdShow, timerTime } from "./module-service.js";

class MemoryStore {
  constructor() { this.data = {}; }
  get(id) { return this.data[id] || null; }
  all() { return this.data; }
  async set(id, value) { this.data[id] = value; }
}

test("module discovery attaches manifest to project without project root", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-modules-"));
  const projectRoot = path.join(workspaceRoot, "meridian.app");
  await fs.mkdir(path.join(projectRoot, ".noyau", "modules"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "scripts", "canva"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".noyau", "modules", "canva.json"), JSON.stringify({
    id: "canva-telegram",
    project: "Meridian",
    name: "Canva Telegram",
    workingDirectory: "scripts/canva",
    primaryUnit: "canva-bot.service",
    controlUnits: ["canva-bot.service", "canva-daily.timer"],
    schedules: [{ id: "publish", label: "Publication", unit: "canva-daily.timer", defaultTime: "14:00" }],
    actions: [{ id: "next", label: "Suivant", command: { file: "/usr/bin/node", args: ["daily.js", "next"] } }],
  }));
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore(), homeDir: workspaceRoot, run: async () => ({ stdout: "" }) });
  const [module] = await service.discover({ "project-meridian": { name: "Meridian", rootPath: null } });
  assert.equal(module.id, "project-meridian--canva-telegram");
  assert.equal(module.workingDirectory, path.join(projectRoot, "scripts", "canva"));
  assert.deepEqual(module.actions[0].command.args, ["daily.js", "next"]);
});

test("link-only module exposes setup without systemd control", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-link-module-"));
  const projectRoot = path.join(workspaceRoot, "noyau");
  await fs.mkdir(path.join(projectRoot, ".noyau", "modules"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".noyau", "modules", "notion.json"), JSON.stringify({
    id: "notion",
    project: "Atlas",
    name: "Notion",
    links: [{ id: "setup", label: "Configurer", url: "https://www.notion.so/profile/integrations/internal" }],
    setup: { status: "required", label: "Connexion requise", description: "Token et page partagée requis." },
  }));
  let runs = 0;
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore(), homeDir: workspaceRoot, run: async () => { runs += 1; return { stdout: "" }; } });
  const [module] = await service.discover({ "project-atlas": { name: "Atlas", rootPath: null } });
  const payload = await service.payload(module);
  assert.equal(payload.controllable, false);
  assert.equal(payload.enabled, false);
  assert.equal(payload.state, "setup-required");
  assert.equal(payload.links[0].url, "https://www.notion.so/profile/integrations/internal");
  assert.equal(runs, 0);
});

test("link module rejects non-HTTPS URLs", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-link-safety-"));
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore() });
  await assert.rejects(() => service.normalize({
    id: "unsafe",
    project: "Atlas",
    links: [{ id: "open", url: "javascript:alert(1)" }],
  }, workspaceRoot, path.join(workspaceRoot, "unsafe.json"), [["project-atlas", { name: "Atlas" }]]), /Lien module invalide/);
});

test("knowledge module accepts public Drive source", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-module-"));
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore() });
  await fs.mkdir(path.join(workspaceRoot, "atlas"));
  const module = await service.normalize({
    id: "drive", project: "Atlas", knowledge: { provider: "google-drive-public", rootId: "folder123456789" },
  }, path.join(workspaceRoot, "atlas"), path.join(workspaceRoot, "drive.json"), [["project-atlas", { name: "Atlas" }]]);
  assert.equal(module.knowledge.provider, "google-drive-public");
});

test("systemd timer output exposes current schedule", () => {
  const [state] = parseSystemdShow("Id=canva.timer\nActiveState=active\nTimersCalendar={ OnCalendar=*-*-* 18:30:00 Europe/Paris }\n\n");
  assert.equal(state.ActiveState, "active");
  assert.equal(timerTime(state.TimersCalendar, "14:00"), "18:30");
});

test("module action state persists through completion and service reload", async () => {
  const store = new MemoryStore();
  const id = "project-meridian--canva";
  store.data[id] = {
    id,
    primaryUnit: "canva-bot.service",
    controlUnits: ["canva-bot.service"],
    schedules: [],
    workingDirectory: os.tmpdir(),
    actions: [{ id: "next", label: "Template suivant", command: { file: "/usr/bin/node", args: ["daily.js", "next"], timeout: 30_000 } }],
  };
  let finishCommand;
  let finishNotification;
  const command = new Promise((resolve) => { finishCommand = resolve; });
  const notified = new Promise((resolve) => { finishNotification = resolve; });
  const run = async (file) => file === "/usr/bin/systemctl"
    ? { stdout: "Id=canva-bot.service\nActiveState=active\n\n" }
    : command;
  const service = new ModuleService({ workspaceRoot: os.tmpdir(), store, run, onActionComplete: finishNotification });

  assert.equal(service.runAction(id, "next").state, "running");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.get(id).actionRuns.next.state, "running");
  finishCommand({ stdout: "next template ready" });
  await notified;
  assert.equal(store.get(id).actionRuns.next.state, "success");

  const reloaded = new ModuleService({ workspaceRoot: os.tmpdir(), store, run });
  const payload = await reloaded.payload(store.get(id));
  assert.equal(payload.actions[0].run.output, "next template ready");
});
