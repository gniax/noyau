const STATES = {
  working: { state: "working", label: "Travail" },
  available: { state: "available", label: "Disponible" },
  waiting: { state: "waiting", label: "Attend réponse" },
};

// Marqueurs de travail: compteur de duree du TUI, sortie d'outil en cours, rappel d'interruption.
const WORKING_HINT = /((esc|échap|ctrl-c)[^\n]{0,24}(to )?(interrupt|interrompre|cancel|annuler)|⎿\s*(running|exécution)|\(\s*\d+\s*(h|m|s)[^)\n]{0,24}·|^[✻✽✢✳✶*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s+\S+|running command|thought for \d|thinking…)/im;
// Marqueurs de repos: composer vide, fin de tour, pied de page inactif.
const IDLE_HINT = /(ask codex to do anything|worked for \d|\b(gpt|claude|o\d)[\w.-]*\s+(minimal|low|medium|high|xhigh)\s*·|\? for shortcuts)/i;

// Le pane dit la verite: l'etat memorise reste faux si le hook de fin n'a jamais tire.
export function paneAgentState(screen) {
  const clean = String(screen || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const tail = clean.split("\n").slice(-18).join("\n");
  if (!tail.trim()) return null;
  if (WORKING_HINT.test(tail)) return "working";
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
  // L'etat memorise ne vaut que frais: un hook de fin manque et l'agent reste "Travail" pour toujours.
  if (storedState && Number.isFinite(stateAt) && now - stateAt < 90_000) {
    if (storedState === "working" && Number.isFinite(activityAt) && now - activityAt > 30_000) return STATES.available;
    return STATES[storedState];
  }
  return Number.isFinite(activityAt) && now - activityAt < 15_000 ? STATES.working : STATES.available;
}
