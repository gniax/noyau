import crypto from "node:crypto";
import fs from "node:fs/promises";
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
  constructor({ binary = "tmux", store, workspaceRoot, codexBinary = "codex", claudeBinary = "claude", antigravityBinary = "antigravity", antigravityArgs = [] }) {
    this.binary = binary;
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.commands = { codex: codexBinary, claude: claudeBinary, antigravity: antigravityBinary };
    // Antigravity n'expose pas encore d'options connues: on laisse la ligne de commande configurable.
    this.antigravityArgs = antigravityArgs;
  }

  async run(args) {
    return execFileAsync(this.binary, args, { maxBuffer: 1024 * 1024 });
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
          projectLogo: Boolean(stored?.projectLogo),
          projectId: stored?.projectId || null,
          profileId: stored?.profileId || null,
          shared: Boolean(stored?.shared),
          core: Boolean(stored?.core),
          favorite: Boolean(stored?.favorite),
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
        if (!["codex", "claude", "shell", "antigravity"].includes(entry.assistant)) throw new Error("Assistant invalide.");
        const cwd = path.resolve(entry.cwd || this.workspaceRoot);
        const stat = await fs.stat(cwd);
        if (!stat.isDirectory()) throw new Error("Dossier de travail invalide.");
        const args = ["new-session", "-d", "-s", id, "-c", cwd, "-e", `NOYAU_SESSION_ID=${id}`];
        if (entry.assistant === "codex") {
          args.push(this.commands.codex, "--no-alt-screen");
          if (entry.yolo) args.push("--yolo");
          args.push("-c", "check_for_update_on_startup=false", "resume", entry.threadId ? String(entry.threadId) : "--last");
        } else if (entry.assistant === "claude") {
          args.push(this.commands.claude);
          if (entry.yolo) args.push("--dangerously-skip-permissions");
          args.push(entry.agentSessionId ? "--resume" : "--continue");
          if (entry.agentSessionId) args.push(String(entry.agentSessionId));
        } else if (entry.assistant === "antigravity") {
          args.push(this.commands.antigravity, ...this.antigravityArgs);
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

  async create({ name, assistant, cwd, prompt, migratedFrom, yolo = false, projectLogo = false, projectId = null, profileId = null, shared = false, favorite = false }) {
    if (!["codex", "claude", "shell", "antigravity"].includes(assistant)) throw new Error("Assistant invalide.");
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
      if (assistant === "antigravity") args.push(...this.antigravityArgs);
      if (assistant === "codex") {
        args.push("--no-alt-screen");
        if (unrestricted) args.push("--yolo");
        args.push("-c", "check_for_update_on_startup=false");
      }
      if (assistant === "claude" && unrestricted) args.push("--dangerously-skip-permissions");
      if (assistant === "antigravity" && unrestricted) args.push("--dangerously-skip-permissions");
      // Antigravity attend son prompt derriere une option, pas en argument libre.
      if (prompt && assistant === "antigravity") args.push("--prompt-interactive", String(prompt).slice(0, 50_000));
      else if (prompt) args.push(String(prompt).slice(0, 50_000));
    }
    await this.run(args);
    await this.applyScrollDefaults();
    if (assistant !== "shell") void this.acceptTrustPrompt(id).catch(() => {});

    const entry = {
      name: String(name || assistant).trim().slice(0, 60) || assistant,
      assistant,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
      migratedFrom: migratedFrom || null,
      yolo: unrestricted,
      runningYolo: unrestricted,
      permissionRestartPending: false,
      projectLogo: Boolean(projectLogo),
      projectId: projectId || null,
      profileId: profileId || null,
      shared: Boolean(shared),
      favorite: Boolean(favorite),
      autoRestore: true,
      agentState: prompt ? "working" : "available",
      agentStateUpdatedAt: new Date().toISOString(),
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
  async acceptTrustPrompt(id, { attempts = 20, delay = 700 } = {}) {
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

  async restartAgent({ id, assistant, cwd, threadId, yolo = false }) {
    if (!validSessionId(id) || !["codex", "claude", "shell", "antigravity"].includes(assistant)) throw new Error("Agent invalide pour redémarrage.");
    const workingDirectory = path.resolve(cwd || this.workspaceRoot);
    // Un terminal n'a pas de conversation a reprendre: on relance simplement le shell.
    if (assistant === "shell") return this.run(["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory]);
    if (assistant === "antigravity") {
      const args = ["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory, this.commands.antigravity, ...this.antigravityArgs];
      if (yolo) args.push("--dangerously-skip-permissions");
      if (threadId) args.push("--conversation", String(threadId));
      else args.push("--continue");
      await this.run(args);
      void this.acceptTrustPrompt(id).catch(() => {});
      return undefined;
    }
    const args = ["respawn-pane", "-k", "-t", `=${id}:0.0`, "-c", workingDirectory, this.commands[assistant]];
    if (assistant === "codex") {
      args.push("--no-alt-screen");
      if (yolo) args.push("--yolo");
      args.push("-c", "check_for_update_on_startup=false", "resume");
      args.push(threadId ? String(threadId) : "--last");
    } else {
      if (yolo) args.push("--dangerously-skip-permissions");
      args.push(threadId ? "--resume" : "--continue");
      if (threadId) args.push(String(threadId));
    }
    await this.run(args);
    void this.acceptTrustPrompt(id).catch(() => {});
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
