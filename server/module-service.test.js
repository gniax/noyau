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

test("module chat export is exposed without paths or commands and remains project-scoped", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-module-chat-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const projectRoot = path.join(workspaceRoot, "atlas");
  const manifestDirectory = path.join(projectRoot, ".noyau/modules");
  await fs.mkdir(manifestDirectory, { recursive: true });
  await fs.writeFile(path.join(manifestDirectory, "telegram-growth.json"), JSON.stringify({
    id: "telegram-growth", project: "Atlas", controlUnits: ["telegram.service"], chat: { file: "feed.json" },
  }));
  await fs.writeFile(path.join(projectRoot, "feed.json"), JSON.stringify({ messages: [{ id: 1, text: "Hello", status: "sent" }] }));
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore(), run: async () => ({ stdout: "" }) });
  const projects = { atlas: { name: "Atlas" } };
  const [module] = await service.discover(projects);
  const payload = await service.payload(module);
  assert.equal(payload.chat.messages[0].text, "Hello");
  assert.equal(payload.chat.file, undefined);
  await service.install(module.id, projects);
  assert.equal((await service.list(projects)).modules[0].chat.messages.length, 1);
  assert.equal((await service.list({ other: { name: "Other" } })).modules.length, 0);
});

test("production modules remain project scoped and cannot start before setup", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-production-"));
  try {
    const projectRoot = path.join(workspaceRoot, "atlas");
    const moduleDir = path.join(projectRoot, ".noyau/modules");
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(path.join(moduleDir, "production.json"), JSON.stringify({
      id: "activity-production", project: "Atlas", environment: "production", executionHost: "Home PC",
      controlUnits: ["activity-bot-production.service"], setup: { status: "required", description: "API requise" },
    }));
    let controls = 0;
    const service = new ModuleService({ workspaceRoot, store: new MemoryStore(), run: async (file, args) => {
      if (args.includes("enable")) controls++;
      return { stdout: "Id=activity-bot-production.service\nActiveState=inactive\n" };
    }});
    const projects = { atlas: { name: "Atlas" } };
    const proposal = (await service.list(projects)).proposals[0];
    assert.equal(proposal.environment, "production");
    assert.equal(proposal.projectId, "atlas");
    await service.install(proposal.id, projects);
    const module = (await service.list(projects)).modules[0];
    assert.equal(module.environment, "production");
    assert.equal(module.executionHost, "Home PC");
    assert.equal(module.enabled, false);
    await assert.rejects(() => service.setEnabled(module.id, true), /API requise/);
    assert.equal(controls, 0);
    assert.equal((await service.list({ other: { name: "Other" } })).modules.length, 0);
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test("module discovery attaches manifest to project without project root", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-modules-"));
  const projectRoot = path.join(workspaceRoot, "atlas.example");
  await fs.mkdir(path.join(projectRoot, ".noyau", "modules"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "scripts", "canva"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".noyau", "modules", "canva.json"), JSON.stringify({
    id: "canva-telegram",
    project: "Atlas",
    name: "Canva Telegram",
    workingDirectory: "scripts/canva",
    primaryUnit: "canva-bot.service",
    controlUnits: ["canva-bot.service", "canva-daily.timer"],
    schedules: [{ id: "publish", label: "Publication", unit: "canva-daily.timer", defaultTime: "14:00" }],
    actions: [{ id: "next", label: "Suivant", command: { file: "/usr/bin/node", args: ["daily.js", "next"] } }],
  }));
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore(), homeDir: workspaceRoot, run: async () => ({ stdout: "" }) });
  const [module] = await service.discover({ "project-atlas": { name: "Atlas", rootPath: null } });
  assert.equal(module.id, "project-atlas--canva-telegram");
  assert.equal(module.workingDirectory, path.join(projectRoot, "scripts", "canva"));
  assert.deepEqual(module.actions[0].command.args, ["daily.js", "next"]);
});

test("link-only module exposes setup without systemd control", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-link-module-"));
  const projectRoot = path.join(workspaceRoot, "noyau");
  await fs.mkdir(path.join(projectRoot, ".noyau", "modules"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".noyau", "modules", "notion.json"), JSON.stringify({
    id: "notion",
    project: "Octanix",
    name: "Notion",
    links: [{ id: "setup", label: "Configurer", url: "https://www.notion.so/profile/integrations/internal" }],
    setup: { status: "required", label: "Connexion requise", description: "Token et page partagée requis." },
  }));
  let runs = 0;
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore(), homeDir: workspaceRoot, run: async () => { runs += 1; return { stdout: "" }; } });
  const [module] = await service.discover({ "project-octanix": { name: "Octanix", rootPath: null } });
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
    project: "Octanix",
    links: [{ id: "open", url: "javascript:alert(1)" }],
  }, workspaceRoot, path.join(workspaceRoot, "unsafe.json"), [["project-octanix", { name: "Octanix" }]]), /Lien module invalide/);
});

test("knowledge module accepts public Drive source", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-module-"));
  const service = new ModuleService({ workspaceRoot, store: new MemoryStore() });
  await fs.mkdir(path.join(workspaceRoot, "octanix"));
  const module = await service.normalize({
    id: "drive", project: "Octanix", knowledge: { provider: "google-drive-public", rootId: "folder123456789" },
  }, path.join(workspaceRoot, "octanix"), path.join(workspaceRoot, "drive.json"), [["project-octanix", { name: "Octanix" }]]);
  assert.equal(module.knowledge.provider, "google-drive-public");
});

test("systemd timer output exposes current schedule", () => {
  const [state] = parseSystemdShow("Id=canva.timer\nActiveState=active\nTimersCalendar={ OnCalendar=*-*-* 18:30:00 Europe/Paris }\n\n");
  assert.equal(state.ActiveState, "active");
  assert.equal(timerTime(state.TimersCalendar, "14:00"), "18:30");
});

test("module action state persists through completion and service reload", async () => {
  const store = new MemoryStore();
  const id = "project-atlas--canva";
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

test("runAction loads .env from project and working directories", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-env-test-"));
  const workDir = path.join(tmpDir, "sub");
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, ".env"), "FOO=bar\nOVERRIDE=base\n");
  await fs.writeFile(path.join(workDir, ".env"), "OVERRIDE=subval\nBAZ=qux\n");

  const store = new MemoryStore();
  const id = "test-env-mod";
  store.data[id] = {
    id,
    projectRoot: tmpDir,
    workingDirectory: workDir,
    actions: [{ id: "test", command: { file: "/usr/bin/node", args: ["test.js"] } }],
  };

  let capturedOptions = null;
  let finishNotification;
  const notified = new Promise((resolve) => { finishNotification = resolve; });
  const run = async (file, args, options) => {
    capturedOptions = options;
    return { stdout: "ok" };
  };

  const service = new ModuleService({ workspaceRoot: tmpDir, store, run, onActionComplete: finishNotification });
  service.runAction(id, "test");
  await notified;

  assert.equal(capturedOptions?.env?.FOO, "bar");
  assert.equal(capturedOptions?.env?.OVERRIDE, "subval");
  assert.equal(capturedOptions?.env?.BAZ, "qux");
});

test("parseAdbDevices parses USB and network devices", () => {
  const output = `List of devices attached
emulator-5554	device
10.0.0.42:5555	device
offline-device	offline
unauthorized-device	unauthorized
`;
  const devices = parseAdbDevices(output);
  assert.deepEqual(devices, [
    { serial: "emulator-5554", network: false },
    { serial: "10.0.0.42:5555", network: true },
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
      adbSerial: "10.0.0.100:5555",
    },
  }, projectRoot, path.join(projectRoot, "android.json"), [["project-myapp", { name: "MyApp" }]]);

  assert.deepEqual(androidModule.deviceBuild.platforms, ["android"]);
  assert.equal(androidModule.deviceBuild.instructions, "Build debug APK");
  assert.equal(androidModule.deviceBuild.adbSerial, "10.0.0.100:5555");
  assert.equal(androidModule.deviceBuild.outputDirectory, path.join(projectRoot, ".noyau", "builds", "app-android"));

  const dualModule = await service.normalize({
    id: "app-dual",
    project: "MyApp",
    deviceBuild: {
      platforms: ["android", "ios"],
      android: { workingDirectory: "mobile", syncScript: "android:sync", variant: "debug" },
      ios: { bundleId: "com.example.app", bundleVersion: "2.0", title: "My App" },
    },
  }, projectRoot, path.join(projectRoot, "dual.json"), [["project-myapp", { name: "MyApp" }]]);

  assert.deepEqual(dualModule.deviceBuild.platforms, ["android", "ios"]);
  assert.equal(dualModule.deviceBuild.instructions, "Produire version installable de l'application (APK signée pour Android, IPA pour iOS).");
  assert.equal(dualModule.deviceBuild.android.workingDirectory, path.join(projectRoot, "mobile"));
  assert.equal(dualModule.deviceBuild.android.variant, "debug");
  assert.equal(dualModule.deviceBuild.ios.bundleId, "com.example.app");
});

test("requestBuild compiles Android locally without available agent", async () => {
  const store = new MemoryStore();
  const id = "project-app--build";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-build-local-"));
  const webRoot = path.join(workspaceRoot, "web");
  const androidRoot = path.join(webRoot, "android");
  const apkDirectory = path.join(androidRoot, "app", "build", "outputs", "apk", "debug");
  const exportDirectory = path.join(webRoot, ".next-export", "downloads");
  const outputDirectory = path.join(workspaceRoot, ".noyau", "builds", "build");
  await fs.mkdir(apkDirectory, { recursive: true });
  await fs.mkdir(exportDirectory, { recursive: true });
  await fs.mkdir(path.join(webRoot, "node_modules", ".bin"), { recursive: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(webRoot, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await fs.writeFile(path.join(androidRoot, "gradlew"), "#!/bin/sh\n");
  await fs.writeFile(path.join(webRoot, "node_modules", ".bin", "cap"), "#!/bin/sh\n");
  await fs.writeFile(path.join(exportDirectory, "old.apk"), "must not ship");
  await fs.writeFile(path.join(exportDirectory, "keep.txt"), "web asset");

  store.data[id] = {
    id,
    moduleId: "build",
    projectId: "project-app",
    name: "Builds",
    workingDirectory: workspaceRoot,
    deviceBuild: {
      platforms: ["android", "ios"],
      android: { workingDirectory: webRoot, buildScript: "build:mobile", variant: "debug" },
      instructions: "Build app",
      outputDirectory,
    },
  };

  let completed = null;
  const commands = [];
  const service = new ModuleService({
    workspaceRoot,
    store,
    listProjectAgents: async () => [],
    findNpm: async () => "/usr/bin/npm",
    findJavaHome: async () => "/usr/lib/jvm/test-jdk",
    findAdb: async () => null,
    run: async (file, args) => {
      commands.push([file, ...args]);
      if (args.includes("rev-parse")) return { stdout: "abc1234\n" };
      if (file.endsWith("gradlew")) await fs.writeFile(path.join(apkDirectory, "app-debug.apk"), "local apk");
      return { stdout: "ok\n" };
    },
    onBuildComplete: async ({ run }) => { completed = run; },
  });

  const started = await service.requestBuild(id);
  assert.equal(started.executor, "local");
  const deadline = Date.now() + 1500;
  while (!completed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed?.state, "download-ready");
  assert.ok(commands.some(([file, ...args]) => file === "/usr/bin/npm" && args.join(" ") === "run build:mobile"));
  assert.ok(commands.some(([file, ...args]) => file.endsWith("/cap") && args.join(" ") === "sync android"));
  assert.ok(commands.some(([file, ...args]) => file.endsWith("gradlew") && args[0] === "assembleDebug"));
  await assert.rejects(() => fs.stat(path.join(exportDirectory, "old.apk")), /ENOENT/);
  assert.equal(await fs.readFile(path.join(exportDirectory, "keep.txt"), "utf8"), "web asset");
  const builds = await service.builds(store.get(id));
  assert.equal(builds[0].name, "build-1.2.3-abc1234.apk");
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

test("builds deduplicates multiple files with identical commit on same platform", async () => {
  const store = new MemoryStore();
  const id = "project-app--build";
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-dedup-"));
  const outputDirectory = path.join(workspaceRoot, ".noyau", "builds", "build");
  await fs.mkdir(outputDirectory, { recursive: true });

  const module = {
    id,
    projectId: "project-app",
    name: "App Build",
    workingDirectory: workspaceRoot,
    deviceBuild: { platforms: ["android", "ios"], instructions: "Build app", outputDirectory },
  };
  store.data[id] = module;

  // Create 2 android APKs with same commit (older app-debug.apk and newer custom named apk)
  const apk1 = path.join(outputDirectory, "app-debug.apk");
  const apk2 = path.join(outputDirectory, "octanix-dev.apk");
  await fs.writeFile(apk1, "apk 1");
  await fs.writeFile(`${apk1}.meta.json`, JSON.stringify({ version: "v1.0.0", commit: "a1b2c3d" }));
  const t1 = new Date(2026, 0, 1, 10, 0, 0);
  await fs.utimes(apk1, t1, t1);

  await fs.writeFile(apk2, "apk 2");
  await fs.writeFile(`${apk2}.meta.json`, JSON.stringify({ version: "v1.0.0", commit: "a1b2c3d" }));
  const t2 = new Date(2026, 0, 1, 12, 0, 0);
  await fs.utimes(apk2, t2, t2);

  const service = new ModuleService({ workspaceRoot, store });
  const builds = await service.builds(module);

  assert.equal(builds.length, 1);
  assert.equal(builds[0].name, "octanix-dev.apk");

  // Old duplicate file was pruned
  const remaining = await fs.readdir(outputDirectory);
  assert.ok(remaining.includes("octanix-dev.apk"));
  assert.ok(!remaining.includes("app-debug.apk"));
});

test("long-running actions run as transient units with input, progress, stop and resume", async () => {
  const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-long-"));
  try {
    const store = new MemoryStore();
    const id = "project-atlas--growth";
    const progressFile = path.join(workingDirectory, "run-state.json");
    store.data[id] = {
      id,
      controlUnits: [],
      schedules: [],
      workingDirectory,
      actions: [{
        id: "run", label: "Lancer", longRunning: true,
        input: { label: "Groupes", min: 1, max: 500, default: 100 },
        resumeArgs: ["cli.py", "resume"], progressFile,
        command: { file: "/usr/bin/python3", args: ["cli.py", "run", "{input}", "auto"], timeout: 900_000 },
      }],
    };
    let active = "inactive";
    const calls = [];
    const run = async (file, args) => {
      calls.push([file, args]);
      if (file === "/usr/bin/systemctl" && args.includes("show")) return { stdout: `ActiveState=${active}\n` };
      return { stdout: "" };
    };
    const service = new ModuleService({ workspaceRoot: os.tmpdir(), store, run });

    await assert.rejects(service.runAction(id, "run", { input: 0 }), /entre 1 et 500/);
    await service.runAction(id, "run", { input: 98 });
    const [file, args] = calls.find(([name]) => name === "/usr/bin/systemd-run");
    assert.equal(file, "/usr/bin/systemd-run");
    assert.ok(args.includes(`--unit=noyau-action-${id}-run.service`));
    assert.deepEqual(args.slice(-4), ["cli.py", "run", "98", "auto"]);

    active = "active";
    await fs.writeFile(progressFile, JSON.stringify({ state: "running", done: 3, total: 98, current: "$LUNA @luna", phase: "warmup", counts: { warmup: 3 } }));
    let [action] = (await service.payload(store.get(id))).actions;
    assert.equal(action.run.state, "running");
    assert.equal(action.run.progress.done, 3);
    assert.equal(action.run.resumable, false);
    await assert.rejects(service.runAction(id, "run", { input: 5 }), /déjà en cours/);

    await service.stopAction(id, "run");
    assert.ok(calls.some(([name, list]) => name === "/usr/bin/systemctl" && list.includes("stop")));
    active = "inactive";
    [action] = (await service.payload(store.get(id))).actions;
    assert.equal(action.run.state, "stopped");
    assert.equal(action.run.resumable, true);

    await service.runAction(id, "run", { resume: true });
    const resumed = calls.filter(([name]) => name === "/usr/bin/systemd-run").at(-1)[1];
    assert.deepEqual(resumed.slice(-2), ["cli.py", "resume"]);
  } finally {
    await fs.rm(workingDirectory, { recursive: true, force: true });
  }
});
