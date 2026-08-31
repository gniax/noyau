import { agentStatus } from "./agent-status.js";

function sleep(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

export class ClaudeDesignTool {
  constructor({ tmux, store, readResponse, timeout = 10 * 60_000, pollInterval = 1_000, wait = sleep, now = () => Date.now() }) {
    this.tmux = tmux;
    this.store = store;
    this.readResponse = readResponse;
    this.timeout = timeout;
    this.pollInterval = pollInterval;
    this.wait = wait;
    this.now = now;
    this.reserved = new Set();
  }

  async candidates(projectId, excludeSessionId) {
    const sessions = (await this.tmux.list()).filter((session) => {
      const metadata = this.store.get(session.id);
      return session.managed
        && session.assistant === "claude-design"
        && metadata?.projectId === projectId
        && session.id !== excludeSessionId
        && !this.reserved.has(session.id);
    });
    const ready = [];
    for (const session of sessions) {
      const metadata = this.store.get(session.id) || {};
      const pane = await this.tmux.capture(session.id, 30);
      if (agentStatus(session, metadata, false, this.now(), pane).state === "available") ready.push(session);
    }
    return { sessions, ready };
  }

  async run({ callerSessionId, prompt }) {
    const task = String(prompt || "").trim().slice(0, 30_000);
    if (!task) throw new Error("Demande Claude Design requise.");
    const caller = this.store.get(callerSessionId);
    if (!caller?.projectId) throw new Error("Agent appelant sans projet Noyau.");
    const { sessions, ready } = await this.candidates(caller.projectId, callerSessionId);
    if (!sessions.length) throw new Error("Aucun agent Claude Design actif dans ce projet.");
    if (!ready.length) throw new Error("Agent Claude Design occupé. Réessaie après sa tâche actuelle.");

    const target = ready[0];
    const baseline = await this.readResponse(this.store.get(target.id) || {});
    const startedAt = this.now();
    this.reserved.add(target.id);
    try {
      const metadata = this.store.get(target.id) || {};
      await this.store.set(target.id, { ...metadata, agentState: "working", agentStateUpdatedAt: new Date(startedAt).toISOString() });
      await this.tmux.submit(target.id, task);
      while (this.now() - startedAt < this.timeout) {
        await this.wait(this.pollInterval);
        const current = this.store.get(target.id) || {};
        const completedAt = Date.parse(current.agentStateUpdatedAt || "");
        if (current.agentState !== "available" || !Number.isFinite(completedAt) || completedAt <= startedAt) continue;
        const response = await this.readResponse(current);
        if (response && response !== baseline) {
          return { sessionId: target.id, name: current.name || target.name, projectId: caller.projectId, response };
        }
      }
      throw new Error("Claude Design n'a pas terminé avant délai de 10 minutes.");
    } finally {
      this.reserved.delete(target.id);
    }
  }
}
