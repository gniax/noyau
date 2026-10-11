import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Ce qui gonfle le contexte d'un agent Claude avant meme sa premiere phrase: les plugins,
// leurs skills et les serveurs MCP charges pour ce dossier. On mesure ce qui sert vraiment,
// puis on propose de retirer le reste au niveau du projet, jamais ailleurs.

const TOOL_USE = /"type"\s*:\s*"tool_use"[^\n]*?"name"\s*:\s*"([^"]+)"/g;
const SKILL_CALL = /"name"\s*:\s*"Skill"[^\n]*?"skill"\s*:\s*"([^"]+)"/g;
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

// Un caractere du prompt systeme vaut environ un quart de jeton.
export function estimateTokens(characters) {
  return Math.max(0, Math.round(Number(characters || 0) / 4));
}

export function projectSlug(cwd) {
  return String(cwd || "").replace(/[/.]/g, "-");
}

export function parseUsage(text) {
  const tools = {};
  const skills = {};
  for (const match of String(text || "").matchAll(TOOL_USE)) tools[match[1]] = (tools[match[1]] || 0) + 1;
  for (const match of String(text || "").matchAll(SKILL_CALL)) skills[match[1]] = (skills[match[1]] || 0) + 1;
  return { tools, skills };
}

export function mergeUsage(left, right) {
  const merge = (a = {}, b = {}) => {
    const out = { ...a };
    for (const [key, count] of Object.entries(b)) out[key] = (out[key] || 0) + count;
    return out;
  };
  return { tools: merge(left.tools, right.tools), skills: merge(left.skills, right.skills) };
}

// Le nom d'un skill de plugin s'ecrit `plugin:skill` cote appel, `skill` cote fichier.
function skillCalled(usage, plugin, skill) {
  const names = [skill, plugin ? `${plugin}:${skill}` : null].filter(Boolean);
  return names.some((name) => (usage.skills[name] || 0) > 0);
}

function serverCalled(usage, server) {
  const needle = server.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Object.entries(usage.tools).some(([name, count]) => count > 0 && name.startsWith("mcp__") && name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle));
}

// Rien n'est propose sans preuve d'inutilite: un seul appel suffit a proteger un outil.
export function auditProposals({ plugins = [], skills = [], servers = [], usage = { tools: {}, skills: {} } }) {
  const proposals = [];

  for (const plugin of plugins) {
    if (plugin.enabled === false) continue;
    const used = (plugin.skills || []).filter((skill) => skillCalled(usage, plugin.shortName, skill.name));
    const usedServers = (plugin.servers || []).filter((server) => serverCalled(usage, server));
    if (used.length || usedServers.length) continue;
    const weight = (plugin.skills || []).reduce((total, skill) => total + skill.weight, 0) + (plugin.servers || []).length * 400;
    proposals.push({
      id: `plugin:${plugin.name}`,
      kind: "plugin",
      target: plugin.name,
      label: plugin.name,
      detail: `${(plugin.skills || []).length} skill${(plugin.skills || []).length > 1 ? "s" : ""}${plugin.servers?.length ? ` · ${plugin.servers.length} serveur MCP` : ""}`,
      savedTokens: estimateTokens(weight),
      risk: plugin.servers?.length ? "medium" : "low",
      reason: "Jamais appelé dans ce projet.",
    });
  }

  for (const skill of skills) {
    if (skill.hidden) continue;
    if (skillCalled(usage, skill.plugin, skill.name)) continue;
    proposals.push({
      id: `skill:${skill.name}`,
      kind: "skill",
      target: skill.name,
      label: skill.name,
      detail: skill.plugin ? `Skill du plugin ${skill.plugin}` : "Skill personnel",
      savedTokens: estimateTokens(skill.weight),
      risk: "low",
      reason: "Jamais appelé dans ce projet.",
    });
  }

  for (const server of servers) {
    if (server.disabled) continue;
    if (serverCalled(usage, server.name)) continue;
    proposals.push({
      id: `mcp:${server.name}`,
      kind: "mcp",
      target: server.name,
      label: server.name,
      detail: "Serveur MCP déclaré pour ce dossier",
      savedTokens: estimateTokens(server.weight || 1600),
      risk: "medium",
      reason: "Aucun de ses outils n'a été appelé.",
    });
  }

  // Un plugin retire emporte deja ses skills: seuls les skills personnels restent listes a part.
  return proposals.sort((left, right) => right.savedTokens - left.savedTokens);
}

export class ContextAudit {
  constructor({ homeDir = os.homedir(), localLlm = null, now = () => new Date() } = {}) {
    this.homeDir = homeDir;
    this.localLlm = localLlm;
    this.now = now;
  }

  get claudeDir() {
    return path.join(this.homeDir, ".claude");
  }

  async readJson(file, fallback = null) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  // Poids d'un skill: son nom et sa description partent dans le prompt systeme a chaque tour.
  async skillWeight(file) {
    try {
      const head = (await fs.readFile(file, "utf8")).slice(0, 4000);
      const frontmatter = head.match(FRONTMATTER);
      return frontmatter ? frontmatter[1].length : 200;
    } catch {
      return 200;
    }
  }

  async pluginSkills(installPath) {
    const root = path.join(installPath, "skills");
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "SKILL.md");
      skills.push({ name: entry.name, weight: await this.skillWeight(file) });
    }
    return skills;
  }

  async inventory(cwd, file = null, assistant = "claude") {
    const target = this.settingsFile(cwd, file);
    const targetSettings = await this.readJson(target, {}) || {};
    const disabledSkills = new Set(targetSettings.disabledSkills || []);
    const disabledServers = new Set(targetSettings.disabledMcpjsonServers || []);

    const plugins = [];
    const skills = [];
    const servers = [];
    let projectSettings = targetSettings;

    if (["claude", "claude-design"].includes(assistant)) {
      const settings = await this.readJson(path.join(this.claudeDir, "settings.json"), {}) || {};
      const project = await this.readJson(path.join(cwd, ".claude", "settings.local.json"), {}) || {};
      projectSettings = target === path.join(cwd, ".claude", "settings.local.json") ? project : targetSettings;
      const installed = await this.readJson(path.join(this.claudeDir, "plugins", "installed_plugins.json"), { plugins: {} });
      const enabled = { ...(settings.enabledPlugins || {}), ...(project.enabledPlugins || {}), ...(projectSettings.enabledPlugins || {}) };
      const overrides = { ...(project.skillOverrides || {}), ...(projectSettings.skillOverrides || {}) };

      for (const [name, on] of Object.entries(enabled)) {
        if (on === false) continue;
        const installPath = installed?.plugins?.[name]?.[0]?.installPath;
        if (!installPath) continue;
        const mcp = await this.readJson(path.join(installPath, ".mcp.json"), null);
        plugins.push({
          name,
          shortName: name.split("@")[0],
          enabled: true,
          skills: await this.pluginSkills(installPath),
          servers: Object.keys(mcp?.mcpServers || {}),
        });
      }

      const personalRoot = path.join(this.claudeDir, "skills");
      for (const entry of await fs.readdir(personalRoot, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        skills.push({
          name: entry.name,
          plugin: null,
          hidden: overrides[entry.name]?.visibility === "hidden" || disabledSkills.has(entry.name),
          weight: await this.skillWeight(path.join(personalRoot, entry.name, "SKILL.md")),
        });
      }

      const claudeConfig = await this.readJson(path.join(this.homeDir, ".claude.json"), {}) || {};
      const projectConfig = claudeConfig.projects?.[cwd] || {};
      const declared = { ...(projectConfig.mcpServers || {}), ...((await this.readJson(path.join(cwd, ".mcp.json"), {}) || {}).mcpServers || {}) };
      const disabled = new Set([...(project.disabledMcpjsonServers || []), ...(projectSettings.disabledMcpjsonServers || []), ...(projectConfig.disabledMcpjsonServers || [])]);
      for (const name of Object.keys(declared)) {
        servers.push({ name, disabled: disabled.has(name) });
      }
    } else if (assistant === "codex") {
      const codexSkillRoots = [path.join(this.homeDir, ".codex", "skills"), path.join(cwd, ".codex", "skills")];
      const seenSkills = new Set();
      for (const root of codexSkillRoots) {
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (entry.name.startsWith(".") || seenSkills.has(entry.name)) continue;
          seenSkills.add(entry.name);
          const skillFile = path.join(root, entry.name, "SKILL.md");
          skills.push({
            name: entry.name,
            plugin: null,
            hidden: disabledSkills.has(entry.name),
            weight: await this.skillWeight(skillFile),
          });
        }
      }
      const declared = (await this.readJson(path.join(cwd, ".mcp.json"), {}) || {}).mcpServers || {};
      for (const name of Object.keys(declared)) {
        servers.push({ name, disabled: disabledServers.has(name) });
      }
    } else if (assistant === "antigravity") {
      const agySkillRoots = [
        path.join(this.homeDir, ".gemini", "config", "skills"),
        path.join(cwd, ".agents", "skills"),
        path.join(cwd, ".gemini", "skills"),
      ];
      const seenSkills = new Set();
      for (const root of agySkillRoots) {
        for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (entry.name.startsWith(".") || seenSkills.has(entry.name)) continue;
          seenSkills.add(entry.name);
          const skillFile = path.join(root, entry.name, "SKILL.md");
          skills.push({
            name: entry.name,
            plugin: null,
            hidden: disabledSkills.has(entry.name),
            weight: await this.skillWeight(skillFile),
          });
        }
      }
      const mcpConfig = await this.readJson(path.join(this.homeDir, ".gemini", "antigravity-cli", "mcp_config.json"), {}) || {};
      const declared = { ...(mcpConfig.mcpServers || {}), ...((await this.readJson(path.join(cwd, ".mcp.json"), {}) || {}).mcpServers || {}) };
      for (const name of Object.keys(declared)) {
        servers.push({ name, disabled: disabledServers.has(name) });
      }
    }

    return { plugins, skills, servers, projectSettings };
  }

  // Les transcriptions disent ce qui a reellement servi dans ce dossier, toutes sessions confondues.
  async usage(cwd, { maxFiles = 12, maxBytes = 2_000_000, assistant = "claude" } = {}) {
    let recent = [];
    if (["claude", "claude-design"].includes(assistant)) {
      const root = path.join(this.claudeDir, "projects", projectSlug(cwd));
      const entries = await fs.readdir(root).catch(() => []);
      const files = entries.filter((name) => name.endsWith(".jsonl"));
      const stats = await Promise.all(files.map(async (name) => {
        const file = path.join(root, name);
        const stat = await fs.stat(file).catch(() => null);
        return stat ? { file, mtime: stat.mtimeMs, size: stat.size } : null;
      }));
      recent = stats.filter(Boolean).sort((left, right) => right.mtime - left.mtime).slice(0, maxFiles);
    } else if (assistant === "codex") {
      const root = path.join(this.homeDir, ".codex", "sessions");
      const files = [];
      try {
        const entries = await fs.readdir(root, { recursive: true });
        for (const entry of entries) {
          if (typeof entry === "string" && entry.endsWith(".jsonl")) files.push(path.join(root, entry));
        }
      } catch {}
      const stats = await Promise.all(files.slice(-20).map(async (file) => {
        const stat = await fs.stat(file).catch(() => null);
        return stat ? { file, mtime: stat.mtimeMs, size: stat.size } : null;
      }));
      recent = stats.filter(Boolean).sort((left, right) => right.mtime - left.mtime).slice(0, maxFiles);
    } else if (assistant === "antigravity") {
      const root = path.join(this.homeDir, ".gemini", "antigravity-cli", "brain");
      const files = [];
      try {
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isDirectory()) {
            files.push(path.join(root, entry.name, ".system_generated", "logs", "transcript.jsonl"));
          }
        }
      } catch {}
      const stats = await Promise.all(files.map(async (file) => {
        const stat = await fs.stat(file).catch(() => null);
        return stat ? { file, mtime: stat.mtimeMs, size: stat.size } : null;
      }));
      recent = stats.filter(Boolean).sort((left, right) => right.mtime - left.mtime).slice(0, maxFiles);
    }

    let usage = { tools: {}, skills: {} };
    for (const entry of recent) {
      const handle = await fs.open(entry.file, "r").catch(() => null);
      if (!handle) continue;
      try {
        const length = Math.min(entry.size, maxBytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, Math.max(0, entry.size - length));
        usage = mergeUsage(usage, parseUsage(buffer.toString("utf8")));
      } finally {
        await handle.close().catch(() => {});
      }
    }
    return { ...usage, transcripts: recent.length };
  }

  // Le modele local ne decide rien: il relit la liste et signale ce qui merite d'etre garde.
  async review(proposals) {
    if (!this.localLlm || !proposals.length) return proposals;
    const listing = proposals.map((item) => `${item.id} · ${item.label} · ${item.detail}`).join("\n");
    const reply = await this.localLlm.chat([
      { role: "system", content: "Tu juges si retirer un outil d'un agent de code est risqué. Réponds uniquement en JSON: {\"garder\":[\"id\"],\"raisons\":{\"id\":\"phrase courte\"}}." },
      { role: "user", content: `Projet: agent de développement local. Éléments jamais utilisés récemment:\n${listing}\n\nLesquels garder malgré tout, car ils servent rarement mais restent indispensables ?` },
    ], { temperature: 0, maxTokens: 300 }).catch(() => "");
    const match = String(reply || "").match(/\{[\s\S]*\}/);
    if (!match) return proposals;
    let verdict = null;
    try { verdict = JSON.parse(match[0]); } catch { return proposals; }
    const keep = new Set(Array.isArray(verdict?.garder) ? verdict.garder : []);
    return proposals.map((item) => ({
      ...item,
      advised: !keep.has(item.id),
      reason: verdict?.raisons?.[item.id] ? String(verdict.raisons[item.id]).slice(0, 160) : item.reason,
    }));
  }

  async audit(cwd, file = null, assistant = "claude") {
    const [inventory, usage] = await Promise.all([this.inventory(cwd, file, assistant), this.usage(cwd, { assistant })]);
    const proposals = await this.review(auditProposals({ ...inventory, usage }));
    const savedTokens = proposals.filter((item) => item.advised !== false).reduce((total, item) => total + item.savedTokens, 0);
    return {
      proposals: proposals.map((item) => ({ ...item, advised: item.advised !== false })),
      savedTokens,
      transcripts: usage.transcripts,
      revertible: Boolean(inventory.projectSettings?.noyauOptimization),
    };
  }

  settingsFile(cwd, file = null) {
    return file || path.join(cwd, ".claude", "settings.local.json");
  }

  // Toute modification est reversible: l'etat precedent voyage avec le reglage ecrit.
  async apply(cwd, ids, catalog, target = null) {
    const chosen = catalog.filter((item) => ids.includes(item.id));
    if (!chosen.length) throw new Error("Aucune optimisation sélectionnée.");
    const file = this.settingsFile(cwd, target);
    const current = await this.readJson(file, {}) || {};
    const next = {
      ...current,
      enabledPlugins: { ...(current.enabledPlugins || {}) },
      skillOverrides: { ...(current.skillOverrides || {}) },
      disabledMcpjsonServers: [...(current.disabledMcpjsonServers || [])],
      disabledSkills: [...(current.disabledSkills || [])],
    };

    for (const item of chosen) {
      if (item.kind === "plugin") next.enabledPlugins[item.target] = false;
      else if (item.kind === "skill") {
        next.skillOverrides[item.target] = { visibility: "hidden" };
        if (!next.disabledSkills.includes(item.target)) next.disabledSkills.push(item.target);
      }
      else if (item.kind === "mcp" && !next.disabledMcpjsonServers.includes(item.target)) next.disabledMcpjsonServers.push(item.target);
    }

    next.noyauOptimization = {
      appliedAt: this.now().toISOString(),
      applied: chosen.map(({ id, kind, target, label, savedTokens }) => ({ id, kind, target, label, savedTokens })),
      previous: current.noyauOptimization ? current.noyauOptimization.previous : {
        enabledPlugins: current.enabledPlugins || null,
        skillOverrides: current.skillOverrides || null,
        disabledMcpjsonServers: current.disabledMcpjsonServers || null,
        disabledSkills: current.disabledSkills || null,
      },
    };

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return { applied: next.noyauOptimization.applied, savedTokens: chosen.reduce((total, item) => total + item.savedTokens, 0) };
  }

  async revert(cwd, target = null) {
    const file = this.settingsFile(cwd, target);
    const current = await this.readJson(file, null);
    if (!current?.noyauOptimization) throw new Error("Aucune optimisation à annuler.");
    const previous = current.noyauOptimization.previous || {};
    const next = { ...current };
    delete next.noyauOptimization;
    for (const key of ["enabledPlugins", "skillOverrides", "disabledMcpjsonServers", "disabledSkills"]) {
      if (previous[key]) next[key] = previous[key];
      else delete next[key];
    }
    // Un fichier vide reste un fichier: l'agent le chargerait pour rien au demarrage.
    if (Object.keys(next).length) await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    else await fs.rm(file, { force: true });
    return { reverted: current.noyauOptimization.applied || [] };
  }
}
