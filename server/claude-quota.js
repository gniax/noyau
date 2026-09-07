import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClaudeRateLimits } from "./usage.js";

export class ClaudeQuotaService {
  constructor({ store, credentialsFile = path.join(os.homedir(), ".claude", ".credentials.json"), fetchImpl = fetch, interval = 5 * 60 * 1000 }) {
    this.store = store;
    this.credentialsFile = credentialsFile;
    this.fetch = fetchImpl;
    this.interval = interval;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.interval);
    this.timer.unref();
  }

  async refresh() {
    let credentials;
    try {
      credentials = JSON.parse(await fs.readFile(this.credentialsFile, "utf8"));
    } catch {
      await this.store.set("claude", { status: "loggedOut", updatedAt: new Date().toISOString() });
      return;
    }
    const oauth = credentials.claudeAiOauth;
    const token = oauth?.accessToken;
    if (!token && !oauth?.refreshToken) {
      await this.store.set("claude", { status: "loggedOut", updatedAt: new Date().toISOString() });
      return;
    }
    if (!token) return this.store.get("claude");

    const response = await this.fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const quota = parseClaudeRateLimits(await response.json());
      if (quota) await this.store.set("claude", quota);
      return quota;
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const previous = this.store.get("claude") || {};
      const quota = {
        ...previous,
        fiveHour: {
          remainingPercent: 0,
          resetsAt: Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1000).toISOString() : previous.fiveHour?.resetsAt || null,
        },
        updatedAt: new Date().toISOString(),
      };
      await this.store.set("claude", quota);
      return quota;
    }
    if (response.status === 401 || response.status === 403) {
      const previous = this.store.get("claude");
      if (oauth?.refreshToken || previous?.fiveHour || previous?.sevenDay) {
        return previous;
      }
      await this.store.set("claude", { status: "loggedOut", updatedAt: new Date().toISOString() });
      return;
    }
    throw new Error(`Relevé quota Claude: HTTP ${response.status}`);
  }
}
