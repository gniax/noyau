import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Petit modele local servi par llama-server: aucune consommation de quota IA.
// Le serveur demarre a la demande, traite une requete a la fois, puis s'arrete quand il ne sert plus.
export class LocalLlm {
  constructor({
    dataDir,
    port = 8110,
    host = "127.0.0.1",
    threads = 3,
    idleMs = 5 * 60_000,
    // Le 3B met plus d'une minute a se charger sur processeur: on lui laisse le temps.
    startTimeoutMs = 240_000,
    requestTimeoutMs = 60_000,
    spawnFn = spawn,
    fetchFn = fetch,
    now = () => Date.now(),
  }) {
    this.dir = path.join(path.resolve(dataDir), "llm");
    this.port = port;
    this.host = host;
    this.threads = threads;
    this.idleMs = idleMs;
    this.startTimeoutMs = startTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnFn = spawnFn;
    this.fetchFn = fetchFn;
    this.now = now;
    this.largeModelFreeMb = 2200;
    this.model = null;
    this.server = null;
    this.starting = null;
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.lastError = null;
  }

  get binary() {
    return path.join(this.dir, "build", "bin", "llama-server");
  }

  // Deux tailles: le 3B raisonne (classement, doublons), le 1.5B se contente de relire.
  // La machine n'a pas toujours de quoi charger le grand: on choisit au demarrage.
  get models() {
    return { large: path.join(this.dir, "qwen3b.gguf"), small: path.join(this.dir, "qwen.gguf") };
  }

  async pickModel() {
    const { large, small } = this.models;
    const [hasLarge, hasSmall] = await Promise.all([large, small].map((file) => fs.stat(file).then(() => true).catch(() => false)));
    const freeMb = os.freemem() / (1024 * 1024);
    if (hasLarge && freeMb >= this.largeModelFreeMb) return large;
    if (hasSmall) return small;
    return hasLarge ? large : null;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}/v1/chat/completions`;
  }

  async installed() {
    const binary = await fs.stat(this.binary).then(() => true).catch(() => false);
    return binary && Boolean(await this.pickModel());
  }

  async healthy() {
    try {
      const response = await this.fetchFn(`http://${this.host}:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensure() {
    if (await this.healthy()) return true;
    if (this.starting) return this.starting;
    if (!(await this.installed())) {
      this.lastError = "Modèle local absent: lancer scripts/local-llm-install.sh.";
      return false;
    }

    this.starting = (async () => {
      this.model = await this.pickModel();
      if (!this.model) {
        this.lastError = "Aucun modèle local disponible.";
        return false;
      }
      this.server = this.spawnFn(this.binary, [
        "-m", this.model,
        "-t", String(this.threads),
        "-c", "2048",
        "--port", String(this.port),
        "--host", this.host,
      ], { stdio: ["ignore", "ignore", "ignore"], detached: false });
      const child = this.server;
      let failed = false;
      child.on("error", (error) => {
        failed = true;
        this.lastError = `Modèle local: ${error.message}`;
        if (this.server === child) this.server = null;
      });
      child.on("exit", (code, signal) => {
        failed = true;
        if (this.server === child) this.server = null;
        if (code || signal) this.lastError = `Modèle local arrêté: ${signal || code}`;
      });

      const deadline = this.now() + this.startTimeoutMs;
      while (!failed && this.now() < deadline) {
        if (await this.healthy()) {
          this.lastError = null;
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!failed) this.lastError = "Le modèle local n'a pas démarré à temps.";
      this.stop();
      return false;
    })().finally(() => { this.starting = null; });

    return this.starting;
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try { this.server?.kill("SIGTERM"); } catch { /* deja parti */ }
    this.server = null;
  }

  // Le modele tient 1,7 Go en memoire: on le libere quand plus rien n'arrive.
  scheduleIdleStop() {
    clearTimeout(this.idleTimer);
    if (!this.idleMs) return;
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  // Une requete a la fois: le modele tourne sur le processeur, le paralleliser le ralentirait.
  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async chat(messages, { maxTokens = 200, temperature = 0.1 } = {}) {
    return this.enqueue(async () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      if (!(await this.ensure())) throw new Error(this.lastError || "Modèle local indisponible.");
      try {
        const response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "local", messages, temperature, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (!response.ok) throw new Error(`Modèle local: erreur ${response.status}`);
        const payload = await response.json();
        return String(payload?.choices?.[0]?.message?.content || "").trim();
      } finally {
        this.scheduleIdleStop();
      }
    });
  }
}
