const CAPACITY_ERROR = /selected model (?:is|isn't|is not)[^.\n]*capacity[^\n]*(?:try|please)[^\n]*different model/i;

export function codexQuotaAvailable(quota) {
  const windows = Array.isArray(quota?.windows) ? quota.windows : [];
  return windows.some((window) => Number(window.remainingPercent) > 0);
}

export class CodexCapacityRetry {
  constructor({ tmux, providerState, interval = 20_000, cooldown = 90_000, now = () => Date.now() }) {
    this.tmux = tmux;
    this.providerState = providerState;
    this.interval = interval;
    this.cooldown = cooldown;
    this.now = now;
    this.timer = null;
    this.seen = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check().catch(() => {}), this.interval);
    this.timer.unref();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    if (!codexQuotaAvailable(this.providerState.get("codex"))) return 0;
    const sessions = (await this.tmux.list()).filter((session) => session.managed && session.assistant === "codex");
    let retried = 0;
    for (const session of sessions) {
      const recent = String(await this.tmux.capture(session.id, 45)).slice(-3000);
      if (!CAPACITY_ERROR.test(recent)) {
        this.seen.delete(session.id);
        continue;
      }
      const previous = this.seen.get(session.id) || 0;
      if (this.now() - previous < this.cooldown) continue;
      this.seen.set(session.id, this.now());
      await this.tmux.submit(session.id, "continue");
      retried += 1;
    }
    return retried;
  }
}

export { CAPACITY_ERROR };
