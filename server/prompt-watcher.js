import { agentAlertBody } from "../shared/agent-alerts.js";
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

const CODEX_APPROVALS = [
  /would you like to run the following command\?/i,
  /would you like to make the following edits\?/i,
  /would you like to grant these permissions\?/i,
  /do you want to approve network access to/i,
  /answer the questions to continue/i,
  /respond to (?:the )?.{0,80} request to continue/i,
];

const CHOICE_YES = /(?:^|\s)(?:[›❯>]\s*)?(?:1[.)]\s*)?(?:yes|oui|allow|autoriser|approve|approuver)\b/i;
const CHOICE_NO = /\b(?:no|non|deny|refuser|reject|annuler)\b/i;
// Footer shown only while no approval is open: quoted prompt text above it is not a prompt.
const COMPOSER = /ask codex to do anything|\d+% context left|tab to queue|esc to interrupt|worked for \d/i;

export function detectCodexApproval(screen) {
  const lines = String(screen || "").replace(ANSI, "").replace(/\r/g, "").split("\n").slice(-18);
  let promptLine = -1;
  lines.forEach((line, index) => { if (CODEX_APPROVALS.some((pattern) => pattern.test(line))) promptLine = index; });
  if (promptLine < 0) return false;
  const after = lines.slice(promptLine);
  if (after.some((line) => COMPOSER.test(line))) return false;
  const choices = after.join(" ").replace(/\s+/g, " ");
  return CHOICE_YES.test(choices) && CHOICE_NO.test(choices);
}

export function agentNotificationTitle(label, text) {
  const source = String(label || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  return `${source ? `[${source}] ` : ""}${text}`;
}

export class PromptWatcher {
  constructor({ tmux, push, interval = 2500, sessionLabel = (session) => session.name, sessionIcon = async () => null, shouldNotify = () => true, sessionDevice = () => null }) {
    this.shouldNotify = shouldNotify;
    this.sessionDevice = sessionDevice;
    this.tmux = tmux;
    this.push = push;
    this.interval = interval;
    this.sessionLabel = sessionLabel;
    this.sessionIcon = sessionIcon;
    this.waiting = new Set();
    this.ignored = new Set();
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

  dismiss(id) { this.waiting.delete(id); this.ignored.add(id); }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = (await this.tmux.list()).filter((session) => session.managed && session.assistant === "codex");
      const active = new Set(sessions.map((session) => session.id));
      for (const id of this.waiting) if (!active.has(id)) this.waiting.delete(id);
      for (const id of this.ignored) if (!active.has(id)) this.ignored.delete(id);
      await Promise.all(sessions.map(async (session) => {
        const pending = detectCodexApproval(await this.tmux.captureVisible(session.id));
        if (!pending) {
          this.waiting.delete(session.id);
          this.ignored.delete(session.id);
          return;
        }
        if (this.ignored.has(session.id) || this.waiting.has(session.id)) return;
        this.waiting.add(session.id);
        // Ecran deja ouvert sur cet agent: la demande de validation est visible sans notification.
        if (!this.shouldNotify(session.id, session.profileId)) return;
        try {
          await this.push.send({
            title: this.sessionLabel(session) || "Agent Noyau",
            body: agentAlertBody("approval", session.name),
            tag: `approval-${session.id}`,
            url: `/?session=${encodeURIComponent(session.id)}${session.profileId ? `&profile=${encodeURIComponent(session.profileId)}` : ""}`,
            replyUrl: `/?session=${encodeURIComponent(session.id)}&reply=1${session.profileId ? `&profile=${encodeURIComponent(session.profileId)}` : ""}`,
            icon: await this.sessionIcon(session.id),
            actions: [{ action: "reply", title: "Ouvrir" }],
          }, session.profileId || null, this.sessionDevice(session));
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
