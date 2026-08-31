import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODULE_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}$/;
const UNIT_PATTERN = /^[a-zA-Z0-9@_.:-]+\.(?:service|timer)$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DRIVE_ID_PATTERN = /^[a-zA-Z0-9_-]{10,200}$/;
const EXECUTABLE_ROOTS = ["/bin/", "/usr/bin/", "/usr/local/bin/"];
const ADB_SERIAL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;
const BUILD_PLATFORMS = new Set(["android", "ios"]);
const BUILD_RUNNING_STATES = new Set(["queued", "building", "installing"]);

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function cleanText(value, fallback, limit = 120) {
  return String(value || fallback).trim().slice(0, limit);
}

function validateUnits(units) {
  const normalized = [...new Set(Array.isArray(units) ? units : [])];
  if (normalized.length > 20 || normalized.some((unit) => !UNIT_PATTERN.test(unit))) throw new Error("Unités systemd module invalides.");
  return normalized;
}

function externalLinks(links) {
  return (Array.isArray(links) ? links : []).slice(0, 12).map((link) => {
    let url;
    try { url = new URL(String(link.url || "")); } catch { throw new Error("Lien module invalide."); }
    if (!MODULE_PATTERN.test(link.id) || url.protocol !== "https:" || url.href.length > 2048) throw new Error("Lien module invalide.");
    return {
      id: link.id,
      label: cleanText(link.label, link.id, 50),
      description: cleanText(link.description, "", 140),
      url: url.href,
      tone: ["primary", "neutral"].includes(link.tone) ? link.tone : "neutral",
    };
  });
}

function knowledgeSource(value) {
  if (!value) return null;
  if (value.provider === "google-drive-public" && DRIVE_ID_PATTERN.test(String(value.rootId || ""))) {
    return { provider: value.provider, rootId: value.rootId, label: cleanText(value.label, "Contenu Drive", 50), agentCommand: cleanText(value.agentCommand, "atlas-knowledge", 80) };
  }
  if (value.provider === "notion") return { provider: value.provider, rootId: null, label: cleanText(value.label, "Contenu Notion", 50), agentCommand: cleanText(value.agentCommand, "atlas-knowledge", 80) };
  throw new Error("Source connaissances module invalide.");
}

function deviceBuildConfig(value, moduleId, projectRoot) {
  if (!value) return null;
  let platforms = [];
  if (Array.isArray(value.platforms)) {
    platforms = value.platforms.map((p) => String(p).toLowerCase()).filter((p) => BUILD_PLATFORMS.has(p));
  } else if (value.platform) {
    const p = String(value.platform).toLowerCase();
    if (p === "both" || p === "all") platforms = ["android", "ios"];
    else if (BUILD_PLATFORMS.has(p)) platforms = [p];
  }
  if (!platforms.length) platforms = ["android", "ios"];
  const adbSerial = value.adbSerial ? String(value.adbSerial).trim() : null;
  if (adbSerial && !ADB_SERIAL_PATTERN.test(adbSerial)) throw new Error("Build appareil ADB invalide.");
  return {
    platforms,
    instructions: cleanText(value.instructions, "Produire version installable de l'application (APK signée pour Android, IPA pour iOS).", 2000),
    adbSerial,
    outputDirectory: path.join(projectRoot, ".noyau", "builds", moduleId),
  };
}

export function parseAdbDevices(output) {
  return String(output || "").split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter(([serial, state]) => serial && state === "device").map(([serial]) => ({ serial, network: serial.includes(":") }));
}

function parseSystemdShow(output) {
  const states = [];
  let current = {};
  const flush = () => {
    if (current.Id) states.push(current);
    current = {};
  };
  for (const line of String(output).split("\n")) {
    if (!line) {
      flush();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator > 0) current[line.slice(0, separator)] = line.slice(separator + 1);
  }
  flush();
  return states;
}

function timerTime(value, fallback) {
  const match = String(value || "").match(/\b(\d{2}:\d{2}):\d{2}\b/);
  return match?.[1] || fallback;
}

async function defaultRun(file, args, options = {}) {
  return execFileAsync(file, args, { cwd: options.cwd, timeout: options.timeout || 300_000, maxBuffer: 1024 * 1024 });
}

export class ModuleService {
  constructor({ workspaceRoot, store, homeDir = os.homedir(), run = defaultRun, onActionComplete = null, onBuildComplete = null, listProjectAgents = async () => [], submitAgent = async () => {}, findAdb = null, sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)), buildPollInterval = 2000, buildTimeout = 15 * 60_000 }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.store = store;
    this.homeDir = path.resolve(homeDir);
    this.run = run;
    this.onActionComplete = onActionComplete;
    this.onBuildComplete = onBuildComplete;
    this.listProjectAgents = listProjectAgents;
    this.submitAgent = submitAgent;
    this.findAdb = findAdb || (() => this.defaultAdbPath());
    this.sleep = sleep;
    this.buildPollInterval = buildPollInterval;
    this.buildTimeout = buildTimeout;
    this.actionRuns = new Map();
    this.buildMonitors = new Map();
  }

  async normalize(raw, projectRoot, manifestPath, projectEntries) {
    if (!raw || !MODULE_PATTERN.test(raw.id)) throw new Error("Identifiant module invalide.");
    const projectMatch = projectEntries.find(([, project]) => project.name.toLocaleLowerCase("fr-FR") === String(raw.project || "").trim().toLocaleLowerCase("fr-FR"));
    if (!projectMatch) return null;
    const [projectId] = projectMatch;
    const resolvedRoot = path.resolve(projectRoot);
    const workingDirectory = path.resolve(resolvedRoot, raw.workingDirectory || ".");
    if (!within(resolvedRoot, workingDirectory)) throw new Error("Dossier module hors projet.");
    const stat = await fs.stat(workingDirectory);
    if (!stat.isDirectory()) throw new Error("Dossier module invalide.");
    const controlUnits = validateUnits(raw.controlUnits);
    const links = externalLinks(raw.links);
    const knowledge = knowledgeSource(raw.knowledge);
    const deviceBuild = deviceBuildConfig(raw.deviceBuild, raw.id, resolvedRoot);
    if (!controlUnits.length && !links.length && !knowledge && !deviceBuild) throw new Error("Module sans contrôle, lien, connaissance ni build appareil.");
    const primaryUnit = raw.primaryUnit || controlUnits[0] || null;
    if (primaryUnit && !controlUnits.includes(primaryUnit)) throw new Error("Unité principale module invalide.");
    const schedules = (Array.isArray(raw.schedules) ? raw.schedules : []).slice(0, 12).map((schedule) => {
      if (!MODULE_PATTERN.test(schedule.id) || !UNIT_PATTERN.test(schedule.unit) || !controlUnits.includes(schedule.unit) || !TIME_PATTERN.test(schedule.defaultTime)) throw new Error("Horaire module invalide.");
      return { id: schedule.id, label: cleanText(schedule.label, schedule.id, 50), unit: schedule.unit, defaultTime: schedule.defaultTime };
    });
    const actions = (Array.isArray(raw.actions) ? raw.actions : []).slice(0, 12).map((action) => {
      const file = path.resolve(String(action.command?.file || ""));
      const args = action.command?.args;
      if (!MODULE_PATTERN.test(action.id) || !path.isAbsolute(String(action.command?.file || "")) || !EXECUTABLE_ROOTS.some((root) => file.startsWith(root)) || !Array.isArray(args) || args.length > 30 || args.some((arg) => typeof arg !== "string" || arg.length > 300)) throw new Error("Action module invalide.");
      return {
        id: action.id,
        label: cleanText(action.label, action.id, 50),
        description: cleanText(action.description, "", 140),
        confirm: action.confirm ? cleanText(action.confirm, "", 180) : null,
        tone: ["primary", "neutral", "danger"].includes(action.tone) ? action.tone : "neutral",
        command: { file, args: [...args], timeout: Math.min(Math.max(Number(action.command.timeout) || 300_000, 1000), 900_000) },
      };
    });
    return {
      id: `${projectId}--${raw.id}`,
      moduleId: raw.id,
      projectId,
      name: cleanText(raw.name, raw.id, 60),
      description: cleanText(raw.description, "Module projet", 160),
      glyph: cleanText(raw.glyph, raw.name?.[0] || "M", 3).toUpperCase(),
      accent: /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent : "#b8ff5e",
      projectRoot: resolvedRoot,
      workingDirectory,
      manifestPath,
      primaryUnit,
      controlUnits,
      schedules,
      actions,
      links,
      knowledge,
      deviceBuild,
      setup: raw.setup ? {
        status: raw.setup.status === "required" ? "required" : "ready",
        label: cleanText(raw.setup.label, raw.setup.status === "required" ? "Configuration requise" : "Prêt", 60),
        description: cleanText(raw.setup.description, "", 220),
      } : null,
    };
  }

  async discover(projects) {
    const projectEntries = Object.entries(projects);
    const roots = await fs.readdir(this.workspaceRoot, { withFileTypes: true }).catch(() => []);
    const discovered = [];
    for (const rootEntry of roots.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))) {
      const projectRoot = path.join(this.workspaceRoot, rootEntry.name);
      const modulesDir = path.join(projectRoot, ".noyau", "modules");
      const files = await fs.readdir(modulesDir, { withFileTypes: true }).catch(() => []);
      for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
        const manifestPath = path.join(modulesDir, file.name);
        const stat = await fs.stat(manifestPath);
        if (stat.size > 64 * 1024) continue;
        try {
          const normalized = await this.normalize(JSON.parse(await fs.readFile(manifestPath, "utf8")), projectRoot, manifestPath, projectEntries);
          if (normalized) discovered.push(normalized);
        } catch { /* invalid manifests stay invisible */ }
      }
    }
    return discovered;
  }

  async install(id, projects) {
    const candidate = (await this.discover(projects)).find((module) => module.id === id);
    if (!candidate) throw new Error("Proposition module introuvable.");
    await this.store.set(candidate.id, { ...candidate, installedAt: new Date().toISOString() });
    return candidate;
  }

  get(id) {
    const module = this.store.get(id);
    if (!module) throw new Error("Module introuvable.");
    return module;
  }

  async systemctl(args) {
    return this.run("/usr/bin/systemctl", ["--user", ...args], { timeout: 30_000 });
  }

  async inspect(module) {
    if (!module.controlUnits?.length) return [];
    try {
      const { stdout } = await this.systemctl(["show", ...module.controlUnits, "--no-pager", "--property=Id,ActiveState,UnitFileState,NextElapseUSecRealtime,TimersCalendar"]);
      return parseSystemdShow(stdout);
    } catch {
      return [];
    }
  }

  async payload(module) {
    const states = await this.inspect(module);
    const primary = states.find((state) => state.Id === module.primaryUnit);
    const controllable = Boolean(module.controlUnits?.length);
    const setupRequired = module.setup?.status === "required";
    const builds = module.deviceBuild ? await this.builds(module) : [];
    if (module.deviceBuild && BUILD_RUNNING_STATES.has(module.buildRun?.state) && !this.buildMonitors.has(module.id)) {
      const requestedAt = new Date(module.buildRun.requestedAt || 0).getTime();
      const artifact = builds.find((build) => new Date(build.createdAt).getTime() >= requestedAt);
      if (artifact) void this.finishBuild(module, artifact).catch(() => {});
    }
    return {
      id: module.id,
      projectId: module.projectId,
      name: module.name,
      description: module.description,
      glyph: module.glyph,
      accent: module.accent,
      controllable,
      enabled: controllable ? primary?.ActiveState === "active" : !setupRequired,
      state: controllable ? primary?.ActiveState || "unknown" : setupRequired ? "setup-required" : "ready",
      setup: module.setup || null,
      links: module.links || [],
      knowledge: module.knowledge || null,
      deviceBuild: module.deviceBuild ? {
        platforms: module.deviceBuild.platforms || ["android", "ios"],
        run: this.buildMonitors.get(module.id)?.run || module.buildRun || null,
        builds,
      } : null,
      schedules: (module.schedules || []).map((schedule) => {
        const state = states.find((item) => item.Id === schedule.unit);
        return { id: schedule.id, label: schedule.label, time: timerTime(state?.TimersCalendar, schedule.defaultTime), active: state?.ActiveState === "active", nextRun: state?.NextElapseUSecRealtime || null };
      }),
      actions: (module.actions || []).map(({ id, label, description, confirm, tone }) => ({ id, label, description, confirm, tone, run: this.actionRuns.get(`${module.id}:${id}`) || module.actionRuns?.[id] || null })),
    };
  }

  async list(projects) {
    const projectIds = new Set(Object.keys(projects));
    const discovered = await this.discover(projects);
    for (const candidate of discovered) {
      const installed = this.store.get(candidate.id);
      if (!installed) continue;
      const refreshed = { ...candidate, installedAt: installed.installedAt, actionRuns: installed.actionRuns || {}, buildRun: installed.buildRun || null };
      if (JSON.stringify(refreshed) !== JSON.stringify(installed)) await this.store.set(candidate.id, refreshed);
    }
    const installed = Object.values(this.store.all()).filter((module) => projectIds.has(module.projectId));
    const payloads = await Promise.all(installed.map((module) => this.payload(module)));
    payloads.sort((a, b) => (b.deviceBuild ? 1 : 0) - (a.deviceBuild ? 1 : 0));
    const proposals = discovered.filter((candidate) => !this.store.get(candidate.id)).map((candidate) => ({ id: candidate.id, projectId: candidate.projectId, name: candidate.name, description: candidate.description, glyph: candidate.glyph, accent: candidate.accent }));
    proposals.sort((a, b) => (b.id.includes("build") ? 1 : 0) - (a.id.includes("build") ? 1 : 0));
    return { modules: payloads, proposals };
  }

  async setEnabled(id, enabled) {
    const module = this.get(id);
    if (!module.controlUnits?.length) throw new Error("Module sans service contrôlable.");
    await this.systemctl([enabled ? "enable" : "disable", "--now", ...module.controlUnits]);
    return this.payload(module);
  }

  async setSchedule(id, scheduleId, time) {
    if (!TIME_PATTERN.test(String(time))) throw new Error("Heure invalide.");
    const module = this.get(id);
    const schedule = module.schedules.find((item) => item.id === scheduleId);
    if (!schedule) throw new Error("Horaire introuvable.");
    const overrideDir = path.join(this.homeDir, ".config", "systemd", "user", `${schedule.unit}.d`);
    await fs.mkdir(overrideDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(overrideDir, "noyau.conf"), `[Timer]\nOnCalendar=\nOnCalendar=*-*-* ${time}:00 Europe/Paris\n`, { mode: 0o600 });
    await this.systemctl(["daemon-reload"]);
    await this.systemctl(["try-restart", schedule.unit]);
    return this.payload(module);
  }

  async saveActionRun(moduleId, actionId, run) {
    const current = this.get(moduleId);
    await this.store.set(moduleId, { ...current, actionRuns: { ...current.actionRuns, [actionId]: run } });
  }

  async defaultAdbPath() {
    const candidates = [
      "/usr/bin/adb",
      "/usr/local/bin/adb",
      "/bin/adb",
      path.join(this.homeDir, "Android", "Sdk", "platform-tools", "adb"),
      path.join(this.homeDir, "Library", "Android", "sdk", "platform-tools", "adb"),
    ];
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch { /* prochain chemin connu */ }
    }
    return null;
  }

  async currentCommit(dir) {
    try {
      const { stdout } = await this.run("/usr/bin/git", ["-C", dir, "rev-parse", "--short", "HEAD"], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async currentVersion(dir) {
    try {
      const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
      const json = JSON.parse(raw);
      if (json.version) return `v${String(json.version).replace(/^v/, "")}`;
    } catch { /* pas de package.json */ }
    try {
      const raw = await fs.readFile(path.join(dir, "version.json"), "utf8");
      const json = JSON.parse(raw);
      if (json.version) return `v${String(json.version).replace(/^v/, "")}`;
    } catch { /* pas de version.json */ }
    return null;
  }

  async artifactMeta(file) {
    try {
      const content = await fs.readFile(`${file}.meta.json`, "utf8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  async saveArtifactMeta(file, meta) {
    try {
      await fs.writeFile(`${file}.meta.json`, JSON.stringify(meta, null, 2), "utf8");
    } catch { /* ignore metadata write errors */ }
  }

  async artifactEntries(module) {
    const directory = module.deviceBuild.outputDirectory;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const artifacts = await Promise.all(entries.filter((entry) => entry.isFile() && (entry.name.toLowerCase().endsWith(".apk") || entry.name.toLowerCase().endsWith(".ipa"))).map(async (entry) => {
      const file = path.join(directory, entry.name);
      const stat = await fs.stat(file);
      const meta = await this.artifactMeta(file);
      const isAndroid = entry.name.toLowerCase().endsWith(".apk");
      return {
        id: entry.name,
        name: entry.name,
        file,
        size: stat.size,
        createdAt: meta.createdAt || stat.mtime.toISOString(),
        modifiedAtMs: stat.mtimeMs,
        version: meta.version || null,
        commit: meta.commit || null,
        platform: isAndroid ? "android" : "ios",
      };
    }));
    return artifacts.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  }

  async builds(module) {
    const artifacts = await this.artifactEntries(module);
    const androids = artifacts.filter((a) => a.platform === "android");
    const ioses = artifacts.filter((a) => a.platform === "ios");
    const toDelete = [...androids.slice(3), ...ioses.slice(3)];
    await Promise.all(toDelete.map(async (artifact) => {
      await fs.unlink(artifact.file).catch(() => {});
      await fs.unlink(`${artifact.file}.meta.json`).catch(() => {});
    }));
    const kept = [...androids.slice(0, 3), ...ioses.slice(0, 3)].sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
    return kept.map(({ file: _file, modifiedAtMs: _modifiedAtMs, ...artifact }) => ({
      ...artifact,
      downloadUrl: artifact.platform === "android" ? `/api/modules/${encodeURIComponent(module.id)}/builds/${encodeURIComponent(artifact.id)}` : null,
    }));
  }

  async saveBuildRun(moduleId, run) {
    const current = this.get(moduleId);
    await this.store.set(moduleId, { ...current, buildRun: run });
    const monitor = this.buildMonitors.get(moduleId);
    if (monitor) monitor.run = run;
  }

  buildPrompt(module, targetPlatform = "android") {
    const kind = targetPlatform === "ios" ? "IPA" : "APK";
    const install = targetPlatform === "android"
      ? "Noyau tentera ensuite installation ADB; ne lance pas adb install."
      : "IPA ne sera pas proposée par lien. Prépare version signée et installation appareil si configuration projet le permet.";
    return [
      `Demande Noyau: produis dernière version ${kind} installable du projet « ${module.name} ».`,
      `Travaille dans ${module.workingDirectory}.`,
      `Consignes module: ${module.deviceBuild.instructions}`,
      `Copie artefact final dans ${module.deviceBuild.outputDirectory} avec nom unique finissant par .${kind.toLowerCase()}.`,
      "Ce dossier sert seulement copie de livraison; garde sorties build originales. Ne supprime aucune version ici: Noyau garde trois dernières de chaque plateforme.",
      install,
      "Termine build et copie avant réponse finale. En cas d'échec, explique erreur exacte dans ta session.",
    ].join("\n");
  }

  async requestBuild(id, { platform = "android", force = false } = {}) {
    const module = this.get(id);
    if (!module.deviceBuild) throw new Error("Module sans build appareil.");
    const targetPlatform = String(platform || "android").toLowerCase();
    if (!BUILD_PLATFORMS.has(targetPlatform)) throw new Error("Plateforme invalide.");
    if (BUILD_RUNNING_STATES.has(module.buildRun?.state) || this.buildMonitors.has(id)) throw new Error("Build déjà en cours.");

    const currentCommit = await this.currentCommit(module.workingDirectory);
    const existingBuilds = await this.builds(module);
    const matchingPlatformBuilds = existingBuilds.filter((b) => b.platform === targetPlatform);
    if (!force && currentCommit && matchingPlatformBuilds.some((b) => b.commit === currentCommit)) {
      const matching = matchingPlatformBuilds.find((b) => b.commit === currentCommit);
      const label = [matching.version, currentCommit].filter(Boolean).join(" · ");
      throw new Error(`Dernier build ${targetPlatform === "android" ? "APK" : "IPA"} déjà disponible (${label || "à jour"}).`);
    }

    const agents = await this.listProjectAgents(module.projectId);
    const agent = agents.find((candidate) => candidate.state === "available");
    if (!agent) throw new Error("Aucun agent disponible dans ce projet.");
    await fs.mkdir(module.deviceBuild.outputDirectory, { recursive: true, mode: 0o700 });
    const before = new Map((await this.artifactEntries(module)).map((artifact) => [artifact.id, artifact.modifiedAtMs]));
    let run = { state: "queued", requestedAt: new Date().toISOString(), agent: { id: agent.id, name: agent.name }, platform: targetPlatform };
    await this.saveBuildRun(module.id, run);
    try {
      await this.submitAgent(agent.id, this.buildPrompt(module, targetPlatform));
      run = { ...run, state: "building", startedAt: new Date().toISOString(), output: `${agent.name} produit ${targetPlatform === "android" ? "APK" : "IPA"}.` };
      await this.saveBuildRun(module.id, run);
    } catch (error) {
      run = { ...run, state: "error", finishedAt: new Date().toISOString(), output: String(error.message || error).slice(-500) };
      await this.saveBuildRun(module.id, run);
      throw error;
    }
    void this.monitorBuild(module, before, run, targetPlatform).catch(() => {});
    return run;
  }

  async monitorBuild(module, before, initialRun, targetPlatform) {
    if (this.buildMonitors.has(module.id)) return;
    const monitor = { run: initialRun };
    this.buildMonitors.set(module.id, monitor);
    try {
      const deadline = Date.now() + this.buildTimeout;
      const extension = targetPlatform === "ios" ? ".ipa" : ".apk";
      while (Date.now() <= deadline) {
        const artifact = (await this.artifactEntries(module)).find((candidate) => candidate.name.toLowerCase().endsWith(extension) && (!before.has(candidate.id) || candidate.modifiedAtMs > before.get(candidate.id)));
        if (artifact) {
          await this.finishBuild(module, artifact, targetPlatform);
          return;
        }
        await this.sleep(this.buildPollInterval);
      }
      const run = { ...monitor.run, state: "error", finishedAt: new Date().toISOString(), output: "Build non reçu après 15 minutes. Consulter session agent." };
      await this.saveBuildRun(module.id, run);
      await this.onBuildComplete?.({ module, run });
    } finally {
      this.buildMonitors.delete(module.id);
    }
  }

  async connectedAndroidDevice(module) {
    const adb = await this.findAdb();
    if (!adb) return { adb: null, device: null, devices: [] };
    const serial = module.deviceBuild.adbSerial;
    if (serial?.includes(":")) await this.run(adb, ["connect", serial], { timeout: 15_000 }).catch(() => {});
    const { stdout = "" } = await this.run(adb, ["devices"], { timeout: 15_000 });
    const devices = parseAdbDevices(stdout);
    const device = serial ? devices.find((candidate) => candidate.serial === serial) || null : devices[0] || null;
    return { adb, device, devices };
  }

  async finishBuild(module, artifact, targetPlatform = "android") {
    const current = this.get(module.id);
    if (!BUILD_RUNNING_STATES.has(current.buildRun?.state)) return current.buildRun;

    const commit = await this.currentCommit(module.workingDirectory);
    const version = await this.currentVersion(module.workingDirectory);
    await this.saveArtifactMeta(artifact.file, {
      version,
      commit,
      createdAt: artifact.createdAt || new Date().toISOString(),
    });

    const isIos = artifact.name.toLowerCase().endsWith(".ipa") || targetPlatform === "ios";
    let run = { ...current.buildRun, state: "installing", artifact: artifact.id, platform: isIos ? "ios" : "android", output: "Build reçu. Traitement…" };
    await this.saveBuildRun(module.id, run);
    if (isIos) {
      run = { ...run, state: "installation-requested", finishedAt: new Date().toISOString(), output: "IPA prête. Demande d'installation transmise à l'agent." };
    } else {
      try {
        const { adb, device } = await this.connectedAndroidDevice(module);
        if (!adb) run = { ...run, state: "download-ready", finishedAt: new Date().toISOString(), output: "ADB absent. APK prête au téléchargement." };
        else if (!device) run = { ...run, state: "download-ready", finishedAt: new Date().toISOString(), output: "Aucun appareil ADB accessible. APK prête au téléchargement." };
        else {
          const { stdout = "", stderr = "" } = await this.run(adb, ["-s", device.serial, "install", "-r", artifact.file], { timeout: 5 * 60_000 });
          run = { ...run, state: "installed", finishedAt: new Date().toISOString(), device, output: String(stdout || stderr || `Installé sur ${device.serial}`).trim().slice(-500) };
        }
      } catch (error) {
        run = { ...run, state: "error", finishedAt: new Date().toISOString(), output: `${String(error.stderr || error.message || error).trim().slice(-430)} · APK disponible au téléchargement.` };
      }
    }
    await this.saveBuildRun(module.id, run);
    await this.builds(this.get(module.id));
    await this.onBuildComplete?.({ module, run });
    return run;
  }

  async refreshBuilds(id) {
    const module = this.get(id);
    if (!module.deviceBuild) throw new Error("Module sans build appareil.");
    await fs.mkdir(module.deviceBuild.outputDirectory, { recursive: true, mode: 0o700 });

    const searchPaths = [
      module.workingDirectory,
      path.join(module.workingDirectory, "android", "app", "build", "outputs", "apk", "release"),
      path.join(module.workingDirectory, "android", "app", "build", "outputs", "apk", "debug"),
      path.join(module.workingDirectory, "build", "outputs", "apk", "release"),
      path.join(module.workingDirectory, "build", "outputs", "ipa"),
      path.join(module.workingDirectory, "dist"),
      path.join(module.workingDirectory, "ios", "build"),
    ];

    const existing = new Set((await this.artifactEntries(module)).map((a) => a.id));
    const commit = await this.currentCommit(module.workingDirectory);
    const version = await this.currentVersion(module.workingDirectory);
    let imported = [];

    for (const searchDir of searchPaths) {
      const entries = await fs.readdir(searchDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const lower = entry.name.toLowerCase();
        if (entry.isFile() && (lower.endsWith(".apk") || lower.endsWith(".ipa"))) {
          const srcFile = path.join(searchDir, entry.name);
          const destFile = path.join(module.deviceBuild.outputDirectory, entry.name);
          const srcStat = await fs.stat(srcFile).catch(() => null);
          if (srcStat && srcStat.size > 0) {
            if (!existing.has(entry.name) || srcFile !== destFile) {
              if (srcFile !== destFile) {
                await fs.copyFile(srcFile, destFile);
              }
              await this.saveArtifactMeta(destFile, {
                version,
                commit,
                createdAt: srcStat.mtime.toISOString(),
              });
              imported.push(entry.name);
              existing.add(entry.name);
            } else {
              const meta = await this.artifactMeta(destFile);
              if (!meta.commit && commit) {
                await this.saveArtifactMeta(destFile, { version: meta.version || version, commit, createdAt: meta.createdAt || srcStat.mtime.toISOString() });
              }
            }
          }
        }
      }
    }

    const builds = await this.builds(module);
    return { builds, imported: imported.join(", ") || null };
  }

  async buildFile(id, buildId) {
    const module = this.get(id);
    if (!module.deviceBuild || path.basename(String(buildId)) !== String(buildId)) throw new Error("Build introuvable.");
    const artifact = (await this.artifactEntries(module)).find((candidate) => candidate.id === buildId);
    if (!artifact) throw new Error("Build introuvable.");
    return artifact;
  }

  runAction(id, actionId) {
    const module = this.get(id);
    const action = module.actions.find((item) => item.id === actionId);
    if (!action) throw new Error("Action introuvable.");
    const key = `${module.id}:${action.id}`;
    if (this.actionRuns.get(key)?.state === "running") throw new Error("Action déjà en cours.");
    const run = { state: "running", startedAt: new Date().toISOString() };
    this.actionRuns.set(key, run);
    void this.saveActionRun(module.id, action.id, run).catch(() => {});
    void (async () => {
      let result;
      try {
        const { stdout = "", stderr = "" } = await this.run(action.command.file, action.command.args, { cwd: module.workingDirectory, timeout: action.command.timeout });
        result = { state: "success", startedAt: run.startedAt, finishedAt: new Date().toISOString(), output: String(stdout || stderr).trim().slice(-500) };
      } catch (error) {
        result = { state: "error", startedAt: run.startedAt, finishedAt: new Date().toISOString(), output: String(error.stderr || error.message).trim().slice(-500) };
      }
      this.actionRuns.set(key, result);
      await this.saveActionRun(module.id, action.id, result).catch(() => {});
      try {
        await this.onActionComplete?.({ module, action, result });
      } catch { /* notification failure does not change action result */ }
    })();
    return run;
  }
}

export { parseSystemdShow, timerTime };
