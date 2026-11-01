export const moduleNeedsAttention = (module) => module.state === "failed" || module.setup?.status === "required";

// One list, one order: what needs the founder first, then what runs in production, then the tools.
export function groupProjectModules(modules = [], proposals = []) {
  const attention = modules.filter(moduleNeedsAttention);
  const healthy = modules.filter((module) => !moduleNeedsAttention(module));
  return {
    attention,
    production: healthy.filter((module) => module.environment === "production"),
    tools: healthy.filter((module) => module.environment !== "production").sort((a, b) => (b.deviceBuild ? 1 : 0) - (a.deviceBuild ? 1 : 0)),
    proposals,
  };
}

export function projectStats({ agents = [], todos = [], modules = [] }) {
  return {
    agents: agents.length,
    working: agents.filter((agent) => agent.agentStatus?.state === "working").length,
    waiting: agents.filter((agent) => agent.agentStatus?.state === "waiting").length,
    openTodos: todos.filter((todo) => todo.status !== "done" && !todo.completed).length,
    modules: modules.length,
    activeModules: modules.filter((module) => module.enabled).length,
    alerts: modules.filter(moduleNeedsAttention).length,
  };
}
