const STATES = {
  working: { state: "working", label: "Travail" },
  available: { state: "available", label: "Disponible" },
  waiting: { state: "waiting", label: "Attend réponse" },
};

export function agentStatus(session, metadata = {}, promptWaiting = false, now = Date.now()) {
  if (promptWaiting) return STATES.waiting;
  if (session.assistant === "shell") return STATES.available;
  const storedState = STATES[metadata.agentState] ? metadata.agentState : null;
  const activityAt = Date.parse(session.activityAt || "");
  const stateAt = Date.parse(metadata.agentStateUpdatedAt || "");
  if (storedState && Number.isFinite(activityAt) && Number.isFinite(stateAt) && activityAt > stateAt + 1000) return STATES.working;
  if (storedState) return STATES[storedState];
  return Number.isFinite(activityAt) && now - activityAt < 15_000 ? STATES.working : STATES.available;
}
