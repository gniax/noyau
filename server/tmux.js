import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveTrustPrompt } from "./trust-prompt.js";
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

export function createSessionId(assistant) {
  const suffix = crypto.randomBytes(2).toString("hex");
  return `noyau-${assistant}-${Date.now().toString(36)}-${suffix}`;
}

export function classifyAssistant(command, storedAssistant) {
  if (storedAssistant) return storedAssistant;
  if (command.includes("claude")) return "claude";
  if (command.includes("codex")) return "codex";
  if (command.includes("antigravity") || /\bagy\b/.test(command)) return "antigravity";
  return "shell";
}

export class TmuxController {
  constructor({ binary = "tmux", store, workspaceRoot, codexBinary = "codex", claudeBinary = "claude", antigravityBinary = "antigravity", antigravityArgs = [], codexSessionsRoot = path.join(os.homedir(), ".codex", "sessions"), agentSettingsRoot = null }) {
    this.binary = binary;
    this.codexSessionsRoot = codexSessionsRoot;
    this.agentSettingsRoot = agentSettingsRoot;
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.commands = { codex: codexBinary, claude: claudeBinary, "claude-design": claudeBinary, antigravity: antigravityBinary };
    // Antigravity n'expose pas encore d'options connues: on laisse la ligne de commande configurable.
    this.antigravityArgs = antigravityArgs;
  }

  // Allegement de contexte propre a un agent: fichier absent = reglages du projet, inchanges.
  async agentSettingsArgs(id) {
    if (!this.agentSettingsRoot || !validSessionId(id)) return [];
    const file = path.join(this.agentSettingsRoot, `${id}.json`);
    return fs.access(file).then(() => ["--settings", file], () => []);
  }

  async run(args) {
    return execFileAsync(this.binary, args, { maxBuffer: 1024 * 1024 });
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
        if (!["codex", "claude", "claude-design", "shell", "antigravity"].includes(entry.assistant)) throw new Error("Assistant invalide.");
        const cwd = path.resolve(entry.cwd || this.workspaceRoot);
        const stat = await fs.stat(cwd);
        if (!stat.isDirectory()) throw new Error("Dossier de travail invalide.");
        const args = ["new-session", "-d", "-s", id, "-c", cwd, "-e", `NOYAU_SESSION_ID=${id}`];
        if (entry.assistant === "codex") {
          args.push(this.commands.codex, "--no-alt-screen");
          if (entry.yolo) args.push("--yolo");
          if (entry.model) args.push("-m", String(entry.model));
          args.push("-c", "check_for_update_on_startup=false", "resume", entry.threadId ? String(entry.threadId) : "--last");
        } else if (["claude", "claude-design"].includes(entry.assistant)) {
          args.push(this.commands.claude, ...(entry.model ? ["--model", String(entry.model)] : []), ...(await this.agentSettingsArgs(id)));
          if (entry.yolo) args.push("--dangerously-skip-permissions");
          if (entry.agentSessionId) args.push("--resume", String(entry.agentSessionId));
          else if (entry.assistant === "claude-design") args.push(CLAUDE_DESIGN_PROMPT);
          else args.push("--continue");
        } else if (entry.assistant === "antigravity") {
          args.push(this.commands.antigravity, ...this.antigravityArgs);
          if (entry.model) args.push("--model", String(entry.model));
          if (entry.yolo) args.push("--dangerously-skip-permissions");
          if (entry.agentSessionId) args.push("--conversation", String(entry.agentSessionId));
          else args.push("--continue");
        }
        await this.run(args);
        live.add(id);
        await this.store.set(id, { ...entry, runningYolo: Boolean(entry.yolo), agentState: "available", agentStateUpdatedAt: new Date().toISOString(), restoredAt: new Date().toISOString(), restoreError: null });
        restored.push(id);
      } catch (error) {
        await this.store.set(id, { ...entry, restoreError: error.message, restoreFailedAt: new Date().toISOString() });
        failed.push({ id, error: error.message });
      }
    }
    return { restored, failed };
  }

  async create({ name, description = null, assistant, model = null, cwd, prompt, migratedFrom, yolo = false, projectLogo = null, projectId = null, profileId = null, shared = false, favorite = false, threadId = null, agentSessionId = null, transcriptPath = null }) {
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

    const id = createSessionId(assistant);
    const unrestricted = assistant !== "shell" && Boolean(yolo);
    const args = ["new-session", "-d", "-s", id, "-c", resolvedCwd, "-e", `NOYAU_SESSION_ID=${id}`];
    if (assistant !== "shell") {
      args.push(this.commands[assistant]);
      if (assistant === "antigravity") {
        args.push(...this.antigravityArgs);
        if (model) args.push("--model", String(model));
      }
      if (assistant === "codex") {
        args.push("--no-alt-screen");
        if (unrestricted) args.push("--yolo");
        if (model) args.push("-m", String(model));
        args.push("-c", "check_for_update_on_startup=false");
        // Les hooks Noyau (suivi to-do) sont locaux: sans ce drapeau, chaque session redemande leur validation.
        if (unrestricted) args.push("--dangerously-bypass-hook-trust");
        if (threadId && await this.codexThreadResumable(threadId)) args.push("resume", String(threadId));
      }
      if (["claude", "claude-design"].includes(assistant)) {
        if (assistant === "claude" && model) args.push("--model", String(model));
        args.push(...(await this.agentSettingsArgs(id)));
        if (unrestricted) args.push("--dangerously-skip-permissions");
        if (agentSessionId) args.push("--resume", String(agentSessionId));
      }
      if (assistant === "antigravity") {
        if (unrestricted) args.push("--dangerously-skip-permissions");
        if (agentSessionId) args.push("--conversation", String(agentSessionId));
      }
      // Antigravity attend son prompt derriere une option, pas en argument libre.
      const initialPrompt = prompt || (assistant === "claude-design" && !agentSessionId ? CLAUDE_DESIGN_PROMPT : null);
      if (initialPrompt && assistant === "antigravity" && !agentSessionId) args.push("--prompt-interactive", String(initialPrompt).slice(0, 50_000));
      else if (initialPrompt && !threadId && !agentSessionId) args.push(String(initialPrompt).slice(0, 50_000));
    }
    await this.run(args);
    await this.applyScrollDefaults();
    if (assistant !== "shell") void this.acceptTrustPrompt(id).catch(() => {});

    const entry = {
      name: String(name || assistant).trim().slice(0, 60) || assistant,
      description: String(description || "").trim().slice(0, 1000) || null,
      assistant,
      ...(model ? { model: String(model) } : {}),
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
      migratedFrom: migratedFrom || null,
      yolo: unrestricted,
      runningYolo: unrestricted,
      permissionRestartPending: false,
      projectLogo: projectLogo !== null && projectLogo !== undefined ? Boolean(projectLogo) : Boolean(projectId),
      projectId: projectId || null,
      profileId: profileId || null,
      shared: Boolean(shared),
      favorite: Boolean(favorite),
      autoRestore: true,
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

  async submit(id, text) {
    if (!await this.exists(id)) throw new Error("Session introuvable.");
    const data = String(text || "").trim().slice(0, 50_000);
    if (!data) throw new Error("Message vide.");
    await this.run(["send-keys", "-t", id, "-l", data]);
    await wait(data.length > 200 ? 600 : 350);
    await this.run(["send-keys", "-t", id, "C-m"]);
  }

  async restartAgent({ id, assistant, model = null, cwd, threadId, yolo = false, resume = true }) {
    if (!validSessionId(id) || !["codex", "claude", "claude-design", "shell", "antigravity"].includes(assistant)) throw new Error("Agent invalide pour redémarrage.");
    const workingDirectory = path.resolve(cwd || this.workspaceRoot);
    // Un terminal n'a pas de conversation a reprendre: on relance simplement le shell.
    if (assistant === "shell") return this.run(["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory]);
    if (assistant === "antigravity") {
      const args = ["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory, this.commands.antigravity, ...this.antigravityArgs];
      if (model) args.push("--model", String(model));
      if (yolo) args.push("--dangerously-skip-permissions");
      if (resume) {
        if (threadId) args.push("--conversation", String(threadId));
        else args.push("--continue");
      }
      await this.run(args);
      void this.acceptTrustPrompt(id).catch(() => {});
      return undefined;
    }
    const args = ["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory, this.commands[assistant]];
    if (assistant === "codex") {
      args.push("--no-alt-screen");
      if (yolo) args.push("--yolo");
      if (model) args.push("-m", String(model));
      args.push("-c", "check_for_update_on_startup=false");
      if (yolo) args.push("--dangerously-bypass-hook-trust");
      if (resume) {
        args.push("resume");
        args.push(threadId && await this.codexThreadResumable(threadId) ? String(threadId) : "--last");
      }
    } else {
      if (model && assistant === "claude") args.push("--model", String(model));
      args.push(...(await this.agentSettingsArgs(id)));
      if (yolo) args.push("--dangerously-skip-permissions");
      if (resume) {
        if (threadId) args.push("--resume", String(threadId));
        else if (assistant === "claude-design") args.push(CLAUDE_DESIGN_PROMPT);
        else args.push("--continue");
      } else if (assistant === "claude-design") {
        args.push(CLAUDE_DESIGN_PROMPT);
      }
    }
    await this.run(args);
    void this.acceptTrustPrompt(id).catch(() => {});
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
