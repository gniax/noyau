const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

const CODEX_APPROVALS = [
  /would you like to run the following command\?/i,
  /would you like to make the following edits\?/i,
  /would you like to grant these permissions\?/i,
  /do you want to approve network access to/i,
  /answer the questions to continue/i,
  /respond to (?:the )?.{0,80} request to continue/i,
];

export function detectCodexApproval(screen) {
  const visibleTail = String(screen || "")
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n")
    .slice(-18)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return CODEX_APPROVALS.some((pattern) => pattern.test(visibleTail));
}

export function agentNotificationTitle(label, text) {
  const source = String(label || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  return `${source ? `[${source}] ` : ""}${text}`;
}

export class PromptWatcher {
  constructor({ tmux, push, interval = 2500, sessionLabel = (session) => session.name, sessionIcon = async () => null }) {
    this.tmux = tmux;
    this.push = push;
    this.interval = interval;
    this.sessionLabel = sessionLabel;
    this.sessionIcon = sessionIcon;
    this.waiting = new Set();
    this.running = false;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => console.error(`Surveillance validations: ${error.message}`)), this.interval);
    this.timer.unref();
    this.tick().catch((error) => console.error(`Surveillance validations: ${error.message}`));
  }

  isWaiting(id) {
    return this.waiting.has(id);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = (await this.tmux.list()).filter((session) => session.managed && session.assistant === "codex");
      const active = new Set(sessions.map((session) => session.id));
      for (const id of this.waiting) if (!active.has(id)) this.waiting.delete(id);
      await Promise.all(sessions.map(async (session) => {
        const pending = detectCodexApproval(await this.tmux.captureVisible(session.id));
        if (!pending) {
          this.waiting.delete(session.id);
          return;
        }
        if (this.waiting.has(session.id)) return;
        this.waiting.add(session.id);
        try {
          await this.push.send({
            title: agentNotificationTitle(this.sessionLabel(session), "Codex attend validation"),
            body: "Commande ou permission à accepter ou refuser.",
            tag: `approval-${session.id}`,
            url: `/?session=${encodeURIComponent(session.id)}${session.profileId ? `&profile=${encodeURIComponent(session.profileId)}` : ""}`,
            replyUrl: `/?session=${encodeURIComponent(session.id)}&reply=1${session.profileId ? `&profile=${encodeURIComponent(session.profileId)}` : ""}`,
            icon: await this.sessionIcon(session.id),
            actions: [{ action: "reply", title: "Ouvrir" }],
          });
        } catch (error) {
          this.waiting.delete(session.id);
          console.error(`Notification validation ${session.id}: ${error.message}`);
        }
      }));
    } finally {
      this.running = false;
    }
  }
}
