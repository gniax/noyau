const STATES = {
  working: { state: "working", label: "Travail" },
  available: { state: "available", label: "Disponible" },
  waiting: { state: "waiting", label: "Attend réponse" },
};

// Marqueurs de travail: compteur de duree du TUI, sortie d'outil en cours, rappel d'interruption.
const WORKING_HINT = /((esc|échap|ctrl-c)[^\n]{0,24}(to )?(interrupt|interrompre|cancel|annuler)|⎿\s*(running|exécution)|\(\s*\d+\s*(h|m|s)[^)\n]{0,24}·|^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]\s+\S+|^[✻✽✢✳✶*]\s+\S+…|running command\.{0,3}$|thinking…)/im;
// Marqueurs de repos: composer vide, fin de tour, pied de page inactif.
const IDLE_HINT = /(ask codex to do anything|worked for \d|\b(gpt|claude|o\d)[\w.-]*\s+(minimal|low|medium|high|xhigh)\s*·|\? for shortcuts)/i;

// Ligne de spinner seulement: le mot seul peut apparaitre dans une reponse affichee.
const COMPACTING = /^\s*[^\s\w]{0,2}\s*Compacting\b[^\n]*(…|\.\.\.|\()/im;

const PROMPT_CHOICE = /^\s*[❯›>]\s*1[.)]\s|do you want|would you like|enter to select|esc to cancel/im;

// Le pane dit la verite: l'etat memorise reste faux si le hook de fin n'a jamais tire.
export function paneAgentState(screen) {
  const clean = String(screen || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const tail = clean.split("\n").slice(-18).join("\n");
  if (!tail.trim()) return null;
  if (COMPACTING.test(tail) || WORKING_HINT.test(tail)) return "working";
  if (IDLE_HINT.test(tail)) return "available";
  return null;
}

export function agentStatus(session, metadata = {}, promptWaiting = false, now = Date.now(), pane = "") {
  if (promptWaiting) return STATES.waiting;
  if (session.assistant === "shell") return STATES.available;
  if (COMPACTING.test(String(pane || "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("\n").slice(-18).join("\n"))) return { state: "working", label: "Compacte le contexte", compacting: true };
  const observed = paneAgentState(pane);
  if (observed) return STATES[observed];
  const storedState = STATES[metadata.agentState] ? metadata.agentState : null;
  // A hook said "waiting" but the visible screen offers no choice: the prompt is gone.
  if (storedState === "waiting" && String(pane || "").trim() && !PROMPT_CHOICE.test(pane)) return STATES.available;
  const activityAt = Date.parse(session.activityAt || "");
  const stateAt = Date.parse(metadata.agentStateUpdatedAt || "");
  // L'etat memorise ne vaut que frais: un hook de fin manque et l'agent reste "Travail" pour toujours.
  if (storedState && Number.isFinite(stateAt) && now - stateAt < 90_000) {
    if (storedState === "working" && Number.isFinite(activityAt) && now - activityAt > 30_000) return STATES.available;
    return STATES[storedState];
  }
  // Ecran lisible sans marqueur de travail: l'agent attend, meme si une phrase est en cours de frappe.
  if (String(pane || "").trim()) return STATES.available;
  return Number.isFinite(activityAt) && now - activityAt < 15_000 ? STATES.working : STATES.available;
}

// L'agent reste "available": il accepte des messages, mais il n'est pas au repos pour autant.
export function withSubagents(status, subagents = []) {
  const running = subagents.filter((item) => item.running).length;
  if (!running || status.state !== "available") return running ? { ...status, subagents: running } : status;
  return { ...status, label: "Attend ses sous-agents", subagents: running };
}
