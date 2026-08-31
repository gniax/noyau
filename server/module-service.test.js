import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModuleService, parseAdbDevices, parseSystemdShow, timerTime } from "./module-service.js";

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

test("parseAdbDevices parses USB and network devices", () => {
  const output = `List of devices attached
emulator-5554	device
192.168.1.42:5555	device
offline-device	offline
unauthorized-device	unauthorized
`;
  const devices = parseAdbDevices(output);
  assert.deepEqual(devices, [
    { serial: "emulator-5554", network: false },
    { serial: "192.168.1.42:5555", network: true },
  ]);
});

test("deviceBuild module normalizes Android and iOS configurations", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-build-norm-"));
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore() });
  const projectRoot = path.join(workspaceRoot, "my-app");
  await fs.mkdir(projectRoot, { recursive: true });

  const androidModule = await service.normalize({
    id: "app-android",
    project: "MyApp",
    deviceBuild: {
      platforms: ["android"],
      instructions: "Build debug APK",
      adbSerial: "192.168.1.100:5555",
    },
  }, projectRoot, path.join(projectRoot, "android.json"), [["project-myapp", { name: "MyApp" }]]);

  assert.deepEqual(androidModule.deviceBuild.platforms, ["android"]);
  assert.equal(androidModule.deviceBuild.instructions, "Build debug APK");
  assert.equal(androidModule.deviceBuild.adbSerial, "192.168.1.100:5555");
  assert.equal(androidModule.deviceBuild.outputDirectory, path.join(projectRoot, ".noyau", "builds", "app-android"));

  const dualModule = await service.normalize({
    id: "app-dual",
    project: "MyApp",
    deviceBuild: {
      platforms: ["android", "ios"],
    },
  }, projectRoot, path.join(projectRoot, "dual.json"), [["project-myapp", { name: "MyApp" }]]);

  assert.deepEqual(dualModule.deviceBuild.platforms, ["android", "ios"]);
  assert.equal(dualModule.deviceBuild.instructions, "Produire version installable de l'application (APK signée pour Android, IPA pour iOS).");
});

test("requestBuild rejects when no agent is available in project", async () => {
  const store = new MemoryStore();
  const id = "project-app--build";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-build-noagent-"));
  const outputDirectory = path.join(workspaceRoot, ".noyau", "builds", "build");
  store.data[id] = {
    id,
    projectId: "project-app",
    name: "App Build",
    workingDirectory: workspaceRoot,
    deviceBuild: { platform: "android", instructions: "Build APK", outputDirectory },
  };

  const service = new ModuleService({
    workspaceRoot,
    store,
    listProjectAgents: async () => [{ id: "agent-1", name: "Codex", state: "working" }],
  });

  await assert.rejects(() => service.requestBuild(id), /Aucun agent disponible dans ce projet/);
});

test("requestBuild submits agent and finishes Android build with ADB install", async () => {
  const store = new MemoryStore();
  const id = "project-app--build";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-build-adb-"));
  const outputDirectory = path.join(workspaceRoot, ".noyau", "builds", "build");
  await fs.mkdir(outputDirectory, { recursive: true });

  store.data[id] = {
    id,
    projectId: "project-app",
    name: "App Build",
    workingDirectory: workspaceRoot,
    deviceBuild: { platform: "android", instructions: "Build APK", outputDirectory },
  };

  let submittedMessage = "";
  let buildCompletedRun = null;
  const executedCommands = [];

  const service = new ModuleService({
    workspaceRoot,
    store,
    listProjectAgents: async () => [{ id: "agent-avail", name: "Codex Agent", state: "available" }],
    submitAgent: async (agentId, message) => { submittedMessage = message; },
    findAdb: async () => "/usr/bin/adb",
    run: async (file, args) => {
      executedCommands.push([file, ...args]);
      if (args[0] === "devices") return { stdout: "List of devices attached\ndevice-123\tdevice\n" };
      if (args.includes("install")) return { stdout: "Success\n" };
      return { stdout: "" };
    },
    onBuildComplete: async ({ run }) => { buildCompletedRun = run; },
    buildPollInterval: 10,
    buildTimeout: 1000,
  });

  const run = await service.requestBuild(id);
  assert.equal(run.state, "building");
  assert.match(submittedMessage, /Demande Noyau: produis dernière version APK/);

  // Simulate agent dropping APK
  const apkPath = path.join(outputDirectory, "app-debug.apk");
  await fs.writeFile(apkPath, "dummy apk content");

  // Wait for monitor to pick it up
  let deadline = Date.now() + 1500;
  while (!buildCompletedRun && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(buildCompletedRun, "onBuildComplete was called");
  assert.equal(buildCompletedRun.state, "installed");
  assert.equal(buildCompletedRun.device.serial, "device-123");

  const payload = await service.payload(store.get(id));
  assert.equal(payload.deviceBuild.builds.length, 1);
  assert.equal(payload.deviceBuild.builds[0].name, "app-debug.apk");
  assert.equal(payload.deviceBuild.builds[0].downloadUrl, `/api/modules/${encodeURIComponent(id)}/builds/app-debug.apk`);
});

test("build retention keeps only 3 latest builds and deletes older ones", async () => {
  const store = new MemoryStore();
  const id = "project-app--build";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-retention-"));
  const outputDirectory = path.join(workspaceRoot, ".noyau", "builds", "build");
  await fs.mkdir(outputDirectory, { recursive: true });

  const module = {
    id,
    projectId: "project-app",
    name: "App Build",
    workingDirectory: workspaceRoot,
    deviceBuild: { platform: "android", instructions: "Build APK", outputDirectory },
  };
  store.data[id] = module;

  // Create 5 build files with stepped timestamps
  for (let i = 1; i <= 5; i++) {
    const file = path.join(outputDirectory, `app-v${i}.apk`);
    await fs.writeFile(file, `content v${i}`);
    const time = new Date(2026, 0, i, 12, 0, 0);
    await fs.utimes(file, time, time);
  }

  const service = new ModuleService({ workspaceRoot, store });
  const builds = await service.builds(module);

  assert.equal(builds.length, 3);
  assert.deepEqual(builds.map((b) => b.name), ["app-v5.apk", "app-v4.apk", "app-v3.apk"]);

  const remainingFiles = await fs.readdir(outputDirectory);
  assert.deepEqual(remainingFiles.sort(), ["app-v3.apk", "app-v4.apk", "app-v5.apk"]);

  // Test buildFile
  const artifact = await service.buildFile(id, "app-v5.apk");
  assert.equal(artifact.name, "app-v5.apk");

  // Unsafe buildId rejection
  await assert.rejects(() => service.buildFile(id, "../../../etc/passwd"), /Build introuvable/);
  await assert.rejects(() => service.buildFile(id, "missing.apk"), /Build introuvable/);
});

test("requestBuild cancels if current commit is already built", async () => {
  const store = new MemoryStore();
  const id = "project-app--build";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-dup-check-"));
  const outputDirectory = path.join(workspaceRoot, ".noyau", "builds", "build");
  await fs.mkdir(outputDirectory, { recursive: true });

  const apkFile = path.join(outputDirectory, "app-release.apk");
  await fs.writeFile(apkFile, "apk content");
  await fs.writeFile(`${apkFile}.meta.json`, JSON.stringify({ version: "v1.0.0", commit: "abcdef1", createdAt: new Date().toISOString() }));

  store.data[id] = {
    id,
    projectId: "project-app",
    name: "App Build",
    workingDirectory: workspaceRoot,
    deviceBuild: { platform: "android", instructions: "Build APK", outputDirectory },
  };

  const service = new ModuleService({
    workspaceRoot,
    store,
    listProjectAgents: async () => [{ id: "agent-1", name: "Codex", state: "available" }],
    run: async (file, args) => {
      if (args.includes("rev-parse")) return { stdout: "abcdef1\n" };
      return { stdout: "" };
    },
  });

  await assert.rejects(() => service.requestBuild(id), /Dernier build.*déjà disponible/);
});

test("refreshBuilds discovers external build and imports it with metadata", async () => {
  const store = new MemoryStore();
  const id = "project-app--build";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-refresh-"));
  const outputDirectory = path.join(workspaceRoot, ".noyau", "builds", "build");
  const distDir = path.join(workspaceRoot, "dist");
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });

  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await fs.writeFile(path.join(distDir, "my-app.apk"), "compiled apk data");

  store.data[id] = {
    id,
    projectId: "project-app",
    name: "App Build",
    workingDirectory: workspaceRoot,
    deviceBuild: { platform: "android", instructions: "Build APK", outputDirectory },
  };

  const service = new ModuleService({
    workspaceRoot,
    store,
    run: async (file, args) => {
      if (args.includes("rev-parse")) return { stdout: "c0ffee7\n" };
      return { stdout: "" };
    },
  });

  const result = await service.refreshBuilds(id);
  assert.equal(result.imported, "my-app.apk");
  assert.equal(result.builds.length, 1);
  assert.equal(result.builds[0].name, "my-app.apk");
  assert.equal(result.builds[0].version, "v1.2.3");
  assert.equal(result.builds[0].commit, "c0ffee7");
});


