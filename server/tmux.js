import { levelLaunch } from "./autonomy.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveTrustPrompt } from "./trust-prompt.js";
import { agentIdentity } from "./agent-identity.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function wait(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}
const SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;
const FORMATS = ["#{session_name}", "#{session_activity}", "#{session_windows}", "#{pane_current_command}", "#{pane_current_path}", "#{pane_pid}"].join("\t");
const CLAUDE_DESIGN_PROMPT = "Tu es agent Claude Design dédié. Traite demandes design/UI/UX transmises par autres agents du même projet. Produis résultat concret directement dans le code du dépôt (pages, CSS, composants restent dans le dépôt, JAMAIS dans les fichiers partagés Noyau). Les fichiers partagés Noyau (node scripts/noyau-file.mjs put) sont réservés uniquement aux images/assets générés pour éviter de donner un chemin /tmp/ inaccessible. Ne change pas logique métier hors nécessité design.";

export function validSessionId(id) {
  return SESSION_PATTERN.test(id);
}

export function createSessionId() {
  const suffix = crypto.randomBytes(2).toString("hex");
  return `noyau-agent-${Date.now().toString(36)}-${suffix}`;
}

export function classifyAssistant(command, storedAssistant) {
  if (storedAssistant) return storedAssistant;
  if (command.includes("claude")) return "claude";
  if (command.includes("codex")) return "codex";
  if (command.includes("antigravity") || /\bagy\b/.test(command)) return "antigravity";
  return "shell";
}

// Saisie tapee en texte litteral. tmux prend un ";" final pour un separateur de commandes
// et l'avale: on envoie ces points-virgules en hexa.
export function literalKeyCommands(target, data) {
  const text = String(data ?? ""); const chunks = []; let chunk = "", bytes = 0;
  for (const character of text) { const size = Buffer.byteLength(character); if (bytes + size > 3000 && chunk) { chunks.push(chunk); chunk = ""; bytes = 0; } chunk += character; bytes += size; }
  if (chunk) chunks.push(chunk);
  const commands = [];
  for (const part of chunks) { const tail = part.match(/;+$/)?.[0] || ""; const head = part.slice(0, part.length - tail.length); if (head) commands.push(["send-keys", "-t", target, "-l", "--", head]); if (tail) for (let i = 0; i < tail.length; i += 1000) commands.push(["send-keys", "-t", target, "-H", ...Array.from(tail.slice(i, i + 1000), () => "3b")]); }
  return commands;
}

// Bound each tmux command message, not just each individual argument.
export function batchTmuxCommands(commands, maxBytes = 6000) {
  const batches = []; let batch = [], bytes = 0;
  for (const command of commands) { const size = command.reduce((sum, value) => sum + Buffer.byteLength(String(value)) + 1, 0) + 1; if (batch.length && bytes + size > maxBytes) { batches.push(chainCommands(batch)); batch = []; bytes = 0; } batch.push(command); bytes += size; }
  if (batch.length) batches.push(chainCommands(batch)); return batches;
}

// Plusieurs commandes tmux en un seul appel, executees dans l'ordre.
export function chainCommands(commands) {
  return commands.flatMap((command, index) => (index ? [";", ...command] : command));
}

// tmux rejette au-dela de ~16 Ko ("command too long"): marge pour cwd, env et UTF-8.
const MAX_INLINE_COMMAND_BYTES = 8000;
const TMUX_VALUE_FLAGS = new Set(["-s", "-t", "-c", "-e", "-n"]);

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export class TmuxController {
  constructor({ binary = "tmux", store, workspaceRoot, codexBinary = "codex", claudeBinary = "claude", antigravityBinary = "antigravity", antigravityArgs = [], codexSessionsRoot = path.join(os.homedir(), ".codex", "sessions"), agentSettingsRoot = null, memory = null, launchRoot = null, codexConfigFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml") }) {
    this.binary = binary;
    this.codexSessionsRoot = codexSessionsRoot;
    this.agentSettingsRoot = agentSettingsRoot;
    this.memory = memory;
    this.codexConfigFile = codexConfigFile;
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.commands = { codex: codexBinary, claude: claudeBinary, "claude-design": claudeBinary, antigravity: antigravityBinary };
    // Antigravity n'expose pas encore d'options connues: on laisse la ligne de commande configurable.
    this.antigravityArgs = antigravityArgs;
    this.launchRoot = launchRoot || agentSettingsRoot || path.join(os.tmpdir(), "noyau");
  }

  async memoryLaunch(id, metadata) {
    if (!this.memory || metadata.assistant === "shell") return { args: [], initial: "" };
    const context = await this.memory.prepare(id, metadata);
    if (["claude", "claude-design"].includes(metadata.assistant)) return { args: ["--append-system-prompt", context.instructions], initial: "" };
    if (metadata.assistant === "codex") {
      const config = await fs.readFile(this.codexConfigFile, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
      // Never override a user's developer instructions, including profile-specific settings.
      if (!/^[^#=\n]*\bdeveloper_instructions["']?\s*=/m.test(config)) return { args: ["-c", `developer_instructions=${JSON.stringify(context.instructions)}`], initial: "" };
      return { args: [], initial: context.instructions + "\nRelis cette mémoire puis attends la prochaine demande, sans exécuter les anciennes tâches." };
    }
    return { args: ["--add-dir", context.directory], initial: context.instructions + "\nRelis cette mémoire puis attends la prochaine demande, sans exécuter les anciennes tâches." };
  }

  // Allegement de contexte propre a un agent: fichier absent = reglages du projet, inchanges.
  async agentSettingsArgs(id) {
    if (!this.agentSettingsRoot || !validSessionId(id)) return [];
    const file = path.join(this.agentSettingsRoot, `${id}.json`);
    return fs.access(file).then(() => ["--settings", file], () => []);
  }

  async run(args) {
    // -u: sans locale UTF-8 (service systemd, install neuve) tmux remplace les tabulations de -F par "_".
    return execFileAsync(this.binary, ["-u", ...args], { maxBuffer: 1024 * 1024 });
  }

  // Lance un agent; une commande trop longue (memoire, passation) passe par un script ephemere.
  async spawn(args) {
    let index = 1;
    while (index < args.length && String(args[index]).startsWith("-")) index += TMUX_VALUE_FLAGS.has(args[index]) ? 2 : 1;
    const command = args.slice(index);
    if (!command.length || Buffer.byteLength(command.join(" ")) <= MAX_INLINE_COMMAND_BYTES) return this.run(args);
    const directory = path.join(this.launchRoot, "launch");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const script = path.join(directory, `${crypto.randomBytes(8).toString("hex")}.sh`);
    await fs.writeFile(script, `#!/bin/sh\nrm -f "$0"\nexec ${command.map(shellQuote).join(" ")}\n`, { mode: 0o700 });
    try {
      return await this.run([...args.slice(0, index), "/bin/sh", script]);
    } catch (error) {
      await fs.rm(script, { force: true });
      throw error;
    }
  }

  // Codex sort en erreur si le fil demande n'a pas de trace sur disque, et la fenetre tmux meurt avec lui.
  async codexThreadResumable(threadId) {
    if (!threadId) return false;
    try {
      const files = await fs.readdir(this.codexSessionsRoot, { recursive: true });
      return files.some((file) => file.endsWith(`${threadId}.jsonl`));
    } catch {
      return false;
    }
  }

  // La molette ne doit jamais devenir des fleches, et l'historique doit valoir la peine d'etre deroule.
  async applyScrollDefaults() {
    // alternate-scroll est une option de fenetre: sans -w, tmux continue d'envoyer des fleches.
    await this.run(["set-option", "-wg", "alternate-scroll", "off"]).catch(() => {});
    await this.run(["set-option", "-g", "history-limit", "20000"]).catch(() => {});
  }

  async list() {
    let stdout = "";
    try {
      ({ stdout } = await this.run(["list-sessions", "-F", FORMATS]));
    } catch (error) {
      if (/no server running|failed to connect|error connecting/i.test(error.stderr || error.message)) return [];
      throw error;
    }

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, activity, windows, command = "", cwd = "", panePid = ""] = line.split("\t");
        const stored = this.store.get(id);
        return {
          id,
          ...agentIdentity(id, stored || {}, this.store),
          name: stored?.name || id,
          assistant: classifyAssistant(command, stored?.assistant),
          command,
          cwd,
          windows: Number(windows),
          panePid: Number(panePid) || null,
          activityAt: new Date(Number(activity) * 1000).toISOString(),
          createdAt: stored?.createdAt || null,
          migrationState: stored?.migrationState || null,
          migrationError: stored?.migrationError || null,
          migrationTarget: stored?.migrationTarget || null,
          migratedTo: stored?.migratedTo || null,
          migratedFrom: stored?.migratedFrom || null,
          yolo: Boolean(stored?.yolo),
          runningYolo: Boolean(stored?.runningYolo),
          permissionRestartPending: Boolean(stored?.permissionRestartPending),
          projectLogo: stored?.projectLogo !== undefined ? Boolean(stored.projectLogo) : Boolean(stored?.projectId),
          projectId: stored?.projectId || null,
          profileId: stored?.profileId || null,
          shared: Boolean(stored?.shared),
          core: Boolean(stored?.core),
          favorite: Boolean(stored?.favorite),
          description: stored?.description || null,
          switchedFrom: stored?.switchedFrom || null,
          switchedAt: stored?.switchedAt || null,
          managed: id.startsWith("noyau-"),
        };
      })
      .sort((a, b) => b.activityAt.localeCompare(a.activityAt));
  }

  async exists(id) {
    if (!validSessionId(id)) return false;
    try {
      await this.run(["has-session", "-t", `=${id}`]);
      return true;
    } catch {
      return false;
    }
  }

  async initializeRestorePlan() {
    const live = new Set((await this.list()).map(({ id }) => id));
    const legacy = Object.entries(this.store.all())
      .filter(([id, entry]) => validSessionId(id) && id.startsWith("noyau-") && typeof entry.autoRestore !== "boolean")
      .map(([id, entry]) => [id, { ...entry, autoRestore: live.has(id) }]);
    if (legacy.length) await this.store.setMany(legacy);
    return { live: live.size, migrated: legacy.length };
  }

  async restorePersisted() {
    const live = new Set((await this.list()).map(({ id }) => id));
    const restored = [];
    const failed = [];
    for (const [id, entry] of Object.entries(this.store.all())) {
      if (!entry.autoRestore || live.has(id) || !validSessionId(id) || !id.startsWith("noyau-")) continue;
      try {
        await this.restoreOne(id, entry);
        live.add(id);
        restored.push(id);
      } catch (error) {
        failed.push({ id, error: error.message });
      }
    }
    return { restored, failed };
  }

  // Relance un agent absent de tmux en reprenant sa conversation, niveau d'autonomie compris.
  async restoreOne(id, entry = this.store.get(id)) {
    try {
      if (!entry) throw new Error("Session introuvable.");
      if (!["codex", "claude", "claude-design", "shell", "antigravity"].includes(entry.assistant)) throw new Error("Assistant invalide.");
      const cwd = path.resolve(entry.cwd || this.workspaceRoot);
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) throw new Error("Dossier de travail invalide.");
      const memory = await this.memoryLaunch(id, { ...entry, cwd });
      const level = levelLaunch(entry.assistant, entry.autonomy);
      const model = level.model || entry.model;
      const args = ["new-session", "-d", "-s", id, "-c", cwd, "-e", `NOYAU_SESSION_ID=${id}`];
      if (entry.assistant === "codex") {
        args.push(this.commands.codex, "--no-alt-screen");
        if (entry.yolo) args.push("--yolo");
        if (model) args.push("-m", String(model));
        args.push("-c", "check_for_update_on_startup=false", ...level.args, ...memory.args);
        // Same flag as create/restart: a keep-alive restart nobody watches must not stop on a hook trust prompt.
        if (entry.yolo) args.push("--dangerously-bypass-hook-trust");
        if (!this.memory || (entry.threadId && await this.codexThreadResumable(entry.threadId))) args.push("resume", entry.threadId ? String(entry.threadId) : "--last");
        if (memory.initial) args.push(memory.initial);
      } else if (["claude", "claude-design"].includes(entry.assistant)) {
        args.push(this.commands.claude, ...(model ? ["--model", String(model)] : []), ...(await this.agentSettingsArgs(id)));
        args.push(...memory.args);
        if (entry.yolo) args.push("--dangerously-skip-permissions");
        if (entry.agentSessionId) args.push("--resume", String(entry.agentSessionId));
        else if (entry.assistant === "claude-design") args.push(CLAUDE_DESIGN_PROMPT);
        else if (!this.memory) args.push("--continue");
      } else if (entry.assistant === "antigravity") {
        args.push(this.commands.antigravity, ...this.antigravityArgs);
        args.push(...memory.args);
        if (entry.model) args.push("--model", String(entry.model));
        if (entry.yolo) args.push("--dangerously-skip-permissions");
        if (entry.conversationId || entry.agentSessionId) args.push("--conversation", String(entry.conversationId || entry.agentSessionId));
        else if (!this.memory) args.push("--continue");
        if (memory.initial) args.push("--prompt-interactive", memory.initial);
      }
      await this.spawn(args);
      const latest = this.store.get?.(id) || entry;
      await this.store.set(id, { ...latest, ...(latest.autonomy ? { autonomy: { ...latest.autonomy, appliedLevel: entry.autonomy?.level ?? latest.autonomy.appliedLevel } } : {}), runningYolo: Boolean(entry.yolo), agentState: "available", agentStateUpdatedAt: new Date().toISOString(), restoredAt: new Date().toISOString(), restoreError: null });
      return true;
    } catch (error) {
      if (entry) await this.store.set(id, { ...(this.store.get?.(id) || entry), restoreError: error.message, restoreFailedAt: new Date().toISOString() });
      throw error;
    }
  }

  async create({ name, description = null, assistant, model = null, cwd, prompt, migratedFrom, yolo = false, projectLogo = null, projectId = null, profileId = null, shared = false, favorite = false, threadId = null, agentSessionId = null, transcriptPath = null, replaceId = null, agentId = null, agentAliases = [], autonomy = null }) {
    if (!["codex", "claude", "claude-design", "shell", "antigravity"].includes(assistant)) throw new Error("Assistant invalide.");
    const resolvedCwd = path.resolve(cwd || this.workspaceRoot);
    let stat;
    try {
      stat = await fs.stat(resolvedCwd);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("Dossier de travail introuvable.");
      throw error;
    }
    if (!stat.isDirectory()) throw new Error("Dossier de travail invalide.");

    if (replaceId && (!validSessionId(replaceId) || !replaceId.startsWith("noyau-") || !this.store.get(replaceId))) throw new Error("Session à remplacer introuvable.");
    const id = replaceId || createSessionId();
    const previous = replaceId ? this.store.get(replaceId) : null;
    const memory = await this.memoryLaunch(id, { ...(previous || {}), agentId: agentId || previous?.agentId || id, assistant, cwd: resolvedCwd, profileId, projectId });
    const unrestricted = assistant !== "shell" && Boolean(yolo);
    const autonomyState = autonomy || previous?.autonomy || null;
    const level = levelLaunch(assistant, autonomyState);
    const launchModel = level.model || model;
    const args = replaceId
      ? ["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", resolvedCwd, "-e", `NOYAU_SESSION_ID=${id}`]
      : ["new-session", "-d", "-s", id, "-c", resolvedCwd, "-e", `NOYAU_SESSION_ID=${id}`];
    if (assistant !== "shell") {
      args.push(this.commands[assistant]);
      if (assistant === "antigravity") {
        args.push(...this.antigravityArgs);
        if (model) args.push("--model", String(model));
      }
      if (assistant === "codex") {
        args.push("--no-alt-screen");
        if (unrestricted) args.push("--yolo");
        if (launchModel) args.push("-m", String(launchModel));
        args.push("-c", "check_for_update_on_startup=false", ...level.args);
        args.push(...memory.args);
        // Les hooks Noyau (suivi to-do) sont locaux: sans ce drapeau, chaque session redemande leur validation.
        if (unrestricted) args.push("--dangerously-bypass-hook-trust");
        if (threadId && await this.codexThreadResumable(threadId)) args.push("resume", String(threadId));
      }
      if (["claude", "claude-design"].includes(assistant)) {
        if (assistant === "claude" && launchModel) args.push("--model", String(launchModel));
        args.push(...(await this.agentSettingsArgs(id)));
        args.push(...memory.args);
        if (unrestricted) args.push("--dangerously-skip-permissions");
        if (agentSessionId) args.push("--resume", String(agentSessionId));
      }
      if (assistant === "antigravity") {
        args.push(...memory.args);
        if (unrestricted) args.push("--dangerously-skip-permissions");
        if (agentSessionId) args.push("--conversation", String(agentSessionId));
      }
      // Antigravity attend son prompt derriere une option, pas en argument libre.
      const initialPrompt = [memory.initial, prompt || (assistant === "claude-design" && !agentSessionId ? CLAUDE_DESIGN_PROMPT : "")].filter(Boolean).join("\n\n");
      if (initialPrompt && assistant === "antigravity") args.push("--prompt-interactive", initialPrompt.slice(0, 50_000));
      else if (initialPrompt && ((!threadId && !agentSessionId) || memory.initial)) args.push(initialPrompt.slice(0, 50_000));
    }
    await this.spawn(args);
    await this.applyScrollDefaults();
    if (assistant !== "shell") void this.acceptTrustPrompt(id).catch(() => {});

    const entry = {
      ...previous,
      ...agentIdentity(id, { ...(previous || {}), ...(agentId ? { agentId } : {}), agentAliases: [...(previous?.agentAliases || []), ...agentAliases], migratedFrom: migratedFrom || previous?.migratedFrom || null, profileId }, this.store),
      name: String(name || assistant).trim().slice(0, 60) || assistant,
      description: String(description || "").trim().slice(0, 1000) || null,
      assistant,
      ...(model ? { model: String(model) } : previous ? { model: null } : {}),
      cwd: resolvedCwd,
      createdAt: previous?.createdAt || new Date().toISOString(),
      migratedFrom: migratedFrom || previous?.migratedFrom || null,
      ...(previous ? { migrationState: "complete", migrationError: null, migrationTarget: assistant, migratedTo: null, switchedFrom: previous.assistant, switchedAt: new Date().toISOString(), threadId: null, agentSessionId: null, conversationId: null, transcriptPath: null } : {}),
      yolo: unrestricted,
      runningYolo: unrestricted,
      permissionRestartPending: false,
      projectLogo: projectLogo !== null && projectLogo !== undefined ? Boolean(projectLogo) : Boolean(projectId),
      projectId: projectId || null,
      profileId: profileId || null,
      shared: Boolean(shared),
      favorite: Boolean(favorite),
      autoRestore: true,
      ...(autonomyState ? { autonomy: { ...autonomyState, appliedLevel: autonomyState.level } } : {}),
      agentState: prompt || (assistant === "claude-design" && !agentSessionId) ? "working" : "available",
      agentStateUpdatedAt: new Date().toISOString(),
      ...(threadId ? { threadId: String(threadId) } : {}),
      ...(agentSessionId ? { agentSessionId: String(agentSessionId) } : {}),
      ...(transcriptPath ? { transcriptPath: String(transcriptPath) } : {}),
    };
    await this.store.set(id, entry);
    return { id, ...entry, managed: true };
  }

  async capture(id, lines = 120) {
    if (!validSessionId(id)) return "";
    try {
      return (await this.run(["capture-pane", "-p", "-t", id, "-S", `-${Math.max(20, Math.min(500, lines))}`])).stdout;
    } catch {
      return "";
    }
  }

  async captureVisible(id) {
    if (!validSessionId(id)) return "";
    try {
      return (await this.run(["capture-pane", "-p", "-t", `=${id}:0.0`])).stdout;
    } catch {
      return "";
    }
  }

  // Les interfaces d'agent avalent une entree envoyee dans la foulee du texte: elles la prennent
  // pour la fin d'un collage. On laisse la saisie se poser avant de valider.
  // Autorisation de dossier au demarrage: on lit le menu et on repond oui, sinon l'agent
  // reste bloque et le prompt de passation n'est jamais traite.
  async acceptTrustPrompt(id, { attempts = 60, delay = 700 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await wait(delay);
      const answer = resolveTrustPrompt(await this.captureVisible(id));
      if (!answer) continue;
      for (const key of answer.keys) {
        await this.run(key.literal ? ["send-keys", "-t", id, "-l", key.literal] : ["send-keys", "-t", id, key.key]);
        await wait(120);
      }
      return answer.label || true;
    }
    return null;
  }

  // Les envois automatiques d'un meme agent passent l'un apres l'autre et attendent la fin
  // du brouillon de l'utilisateur (inputGate), sauf action explicite de sa part (force).
  async submit(id, text, { force = false } = {}) {
    if (!await this.exists(id)) throw new Error("Session introuvable.");
    const data = String(text || "").trim().slice(0, 50_000);
    if (!data) throw new Error("Message vide.");
    this.submitQueues ||= new Map();
    const previous = this.submitQueues.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      if (!force) await this.inputGate?.waitFree(id);
      for (const args of batchTmuxCommands(literalKeyCommands(id, data))) await this.run(args);
      await wait(data.length > 200 ? 600 : 350);
      await this.run(["send-keys", "-t", id, "C-m"]);
    });
    const tail = run.catch(() => {});
    this.submitQueues.set(id, tail);
    tail.then(() => { if (this.submitQueues.get(id) === tail) this.submitQueues.delete(id); });
    return run;
  }

  async restartAgent({ id, assistant, model = null, cwd, threadId, yolo = false, resume = true }) {
    if (!validSessionId(id) || !["codex", "claude", "claude-design", "shell", "antigravity"].includes(assistant)) throw new Error("Agent invalide pour redémarrage.");
    const workingDirectory = path.resolve(cwd || this.workspaceRoot);
    // Un terminal n'a pas de conversation a reprendre: on relance simplement le shell.
    if (assistant === "shell") return this.run(["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory]);
    const metadata = { ...this.store.get?.(id), assistant, cwd: workingDirectory };
    if (this.memory) await this.memory.capture(id, metadata);
    const memory = await this.memoryLaunch(id, metadata);
    const level = levelLaunch(assistant, metadata.autonomy);
    const launchModel = level.model || model;
    if (assistant === "antigravity") {
      const args = ["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory, this.commands.antigravity, ...this.antigravityArgs];
      args.push(...memory.args);
      if (model) args.push("--model", String(model));
      if (yolo) args.push("--dangerously-skip-permissions");
      if (resume) {
        if (threadId || metadata.conversationId) args.push("--conversation", String(threadId || metadata.conversationId));
        else if (!this.memory) args.push("--continue");
      }
      if (memory.initial) args.push("--prompt-interactive", memory.initial);
      await this.spawn(args);
      void this.acceptTrustPrompt(id).catch(() => {});
      return undefined;
    }
    const args = ["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory, this.commands[assistant]];
    if (assistant === "codex") {
      args.push("--no-alt-screen");
      if (yolo) args.push("--yolo");
      if (launchModel) args.push("-m", String(launchModel));
      args.push("-c", "check_for_update_on_startup=false", ...level.args);
      args.push(...memory.args);
      if (yolo) args.push("--dangerously-bypass-hook-trust");
      if (resume && (!this.memory || (threadId && await this.codexThreadResumable(threadId)))) {
        args.push("resume");
        args.push(threadId && await this.codexThreadResumable(threadId) ? String(threadId) : "--last");
      }
      if (memory.initial) args.push(memory.initial);
    } else {
      if (launchModel && assistant === "claude") args.push("--model", String(launchModel));
      args.push(...(await this.agentSettingsArgs(id)));
      args.push(...memory.args);
      if (yolo) args.push("--dangerously-skip-permissions");
      if (resume) {
        if (threadId) args.push("--resume", String(threadId));
        else if (assistant === "claude-design") args.push(CLAUDE_DESIGN_PROMPT);
        else if (!this.memory) args.push("--continue");
      } else if (assistant === "claude-design") {
        args.push(CLAUDE_DESIGN_PROMPT);
      }
    }
    await this.spawn(args);
    void this.acceptTrustPrompt(id).catch(() => {});
    const latest = this.store.get?.(id);
    if (latest?.autonomy && latest.autonomy.appliedLevel !== metadata.autonomy?.level) await this.store.set(id, { ...latest, autonomy: { ...latest.autonomy, appliedLevel: metadata.autonomy?.level ?? latest.autonomy.appliedLevel } });
  }

  async clearHistory(id) {
    if (!validSessionId(id)) return;
    try {
      await this.run(["clear-history", "-H", "-t", `=${id}:0.0`]);
    } catch {
      try {
        await this.run(["clear-history", "-t", `=${id}:0.0`]);
      } catch {}
    }
  }

  async kill(id) {
    if (!validSessionId(id) || !id.startsWith("noyau-")) throw new Error("Seules sessions Noyau peuvent être arrêtées.");
    const current = this.store.get(id);
    if (current) await this.store.set(id, { ...current, autoRestore: false, stopRequestedAt: new Date().toISOString() });
    try {
      await this.run(["kill-session", "-t", `=${id}`]);
    } catch (error) {
      if (!/can't find session|no server running|failed to connect|error connecting/i.test(error.stderr || error.message)) throw error;
    }
    await this.store.remove(id);
  }
}
