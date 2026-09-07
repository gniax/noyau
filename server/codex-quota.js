import { spawn } from "node:child_process";
import { codexRateWindows } from "./usage.js";

export function parseCodexRateLimitResponse(message) {
  const result = message?.result;
  const snapshot = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  return codexRateWindows(snapshot);
}

export function readCodexRateLimits(binary, { spawnImpl = spawn, timeout = 10_000 } = {}) {
  if (!binary) return Promise.reject(new Error("Codex indisponible."));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Relevé quota Codex: délai dépassé.")), timeout);
    timer.unref?.();

    function finish(error, windows = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill?.();
      if (error) reject(error);
      else resolve(windows);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => { errors = `${errors}${chunk}`.slice(-1000); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split(/\r?\n/);
      output = lines.pop() || "";
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: null });
        }
        if (message.id === 2) {
          if (message.error) return finish(new Error(`Relevé quota Codex: ${message.error.message || "échec"}`));
          const windows = parseCodexRateLimitResponse(message);
          return windows.length ? finish(null, windows) : finish(new Error("Relevé quota Codex illisible."));
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (!settled) finish(new Error(`Relevé quota Codex interrompu (${code ?? "inconnu"}): ${errors.trim() || "aucun détail"}`));
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "noyau", version: "1" } } });
  });
}

export class CodexQuotaService {
  constructor({ store, binary, read = readCodexRateLimits, fallback = async () => [], interval = 5 * 60 * 1000 }) {
    this.store = store;
    this.binary = binary;
    this.read = read;
    this.fallback = fallback;
    this.interval = interval;
    this.timer = null;
    this.inFlight = null;
  }

  start() {
    if (this.timer || !this.binary) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.interval);
    this.timer.unref();
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refreshNow().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async refreshNow() {
    let windows;
    let source = "live";
    try {
      windows = await this.read(this.binary);
    } catch (error) {
      windows = await this.fallback();
      source = "session";
      if (!windows.length) throw error;
    }
    if (!windows.length) throw new Error("Relevé quota Codex illisible.");
    const quota = { windows, source, updatedAt: new Date().toISOString() };
    await this.store.set("codex", quota);
    return quota;
  }
}
