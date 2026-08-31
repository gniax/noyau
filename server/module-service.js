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
  constructor({ workspaceRoot, store, homeDir = os.homedir(), run = defaultRun, onActionComplete = null }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.store = store;
    this.homeDir = path.resolve(homeDir);
    this.run = run;
    this.onActionComplete = onActionComplete;
    this.actionRuns = new Map();
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
    if (!controlUnits.length && !links.length && !knowledge) throw new Error("Module sans contrôle, lien ni connaissance.");
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
      const refreshed = { ...candidate, installedAt: installed.installedAt, actionRuns: installed.actionRuns || {} };
      if (JSON.stringify(refreshed) !== JSON.stringify(installed)) await this.store.set(candidate.id, refreshed);
    }
    const installed = Object.values(this.store.all()).filter((module) => projectIds.has(module.projectId));
    const proposals = discovered.filter((candidate) => !this.store.get(candidate.id)).map((candidate) => ({ id: candidate.id, projectId: candidate.projectId, name: candidate.name, description: candidate.description, glyph: candidate.glyph, accent: candidate.accent }));
    return { modules: await Promise.all(installed.map((module) => this.payload(module))), proposals };
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
