const clean = (value) => String(value || "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
export function agentAlertIdentity(projectName, agentName) {
  const project = clean(projectName); const agent = clean(agentName);
  if (!agent) return project || "Agent Noyau";
  if (!project || project.toLocaleLowerCase("fr") === agent.toLocaleLowerCase("fr")) return agent;
  return `${project} · ${agent}`;
}
export function agentAlertTitle(projectName, agentName) { return clean(projectName) || clean(agentName) || "Agent Noyau"; }
export function agentAlertBody(type, agentName) { const agent = clean(agentName) || "L’agent"; return `${agent} ${type === "waiting" ? "attend votre réponse." : type === "approval" ? "attend votre validation." : "a terminé sa réponse."}`; }
