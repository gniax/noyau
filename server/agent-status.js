const STATES = {
  working: { state: "working", label: "Travail" },
  available: { state: "available", label: "Disponible" },
  waiting: { state: "waiting", label: "Attend réponse" },
};

const INTERRUPT_HINT = /(esc|échap|ctrl-c)[^\n]{0,30}(interrupt|interrompre|stop)/i;
const IDLE_HINT = /(ask codex to do anything|\? for shortcuts|bypass permissions on|shift\+tab to cycle|worked for \d|\b(gpt|claude|o\d)[\w.-]*\s+(minimal|low|medium|high|xhigh)\s*·)/i;

// Le pane dit la verite: les TUI affichent "Esc to interrupt" tant qu'une reponse tourne.
export function paneAgentState(screen) {
  const clean = String(screen || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const tail = clean.split("\n").slice(-14).join("\n");
  if (!tail.trim()) return null;
  if (INTERRUPT_HINT.test(tail)) return "working";
  if (IDLE_HINT.test(tail)) return "available";
  return null;
}

export function agentStatus(session, metadata = {}, promptWaiting = false, now = Date.now(), pane = "") {
  if (promptWaiting) return STATES.waiting;
  if (session.assistant === "shell") return STATES.available;
  const observed = paneAgentState(pane);
  if (observed) return STATES[observed];
  const storedState = STATES[metadata.agentState] ? metadata.agentState : null;
  const activityAt = Date.parse(session.activityAt || "");
  const stateAt = Date.parse(metadata.agentStateUpdatedAt || "");
  if (storedState && Number.isFinite(activityAt) && Number.isFinite(stateAt) && activityAt > stateAt + 1000) return STATES.working;
  if (storedState) return STATES[storedState];
  return Number.isFinite(activityAt) && now - activityAt < 15_000 ? STATES.working : STATES.available;
}
