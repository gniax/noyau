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
