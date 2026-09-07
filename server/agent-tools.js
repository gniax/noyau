import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cleanString(value, limit = 50000) {
  return String(value || "").trim().slice(0, limit);
}

export class AgentCommunicationService {
  constructor({ tmux, store, projects = null, handover = null, agentStatus = null, workspaceRoot = process.cwd() } = {}) {
    this.tmux = tmux;
    this.store = store;
    this.projects = projects;
    this.handover = handover;
    this.agentStatus = agentStatus;
    this.workspaceRoot = workspaceRoot;
  }

  async list({ profileId = null } = {}) {
    const rawSessions = await this.tmux.list();
    const visible = rawSessions.filter((session) => {
      if (!session.managed) return false;
      if (profileId && session.profileId && session.profileId !== profileId && !session.shared) return false;
      return true;
    });

    const enriched = await Promise.all(visible.map(async (session) => {
      const stored = this.store ? this.store.get(session.id) : null;
      const project = stored?.projectId && this.projects ? this.projects.get(stored.projectId) : null;
      let status = { state: "available", label: "Disponible" };
      if (this.agentStatus) {
        try {
          const visibleText = await this.tmux.captureVisible(session.id).catch(() => "");
          status = this.agentStatus.status(session.id, visibleText);
        } catch { /* fallback status */ }
      }

      return {
        id: session.id,
        name: stored?.name || session.name || session.id,
        assistant: session.assistant,
        projectId: stored?.projectId || null,
        projectName: project?.name || null,
        cwd: session.cwd,
        status: status.state || "available",
        statusLabel: status.label || "Disponible",
        activityAt: session.activityAt,
        favorite: Boolean(stored?.favorite),
      };
    }));

    return enriched.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || b.activityAt.localeCompare(a.activityAt));
  }

  async resolve(query, { profileId = null } = {}) {
    const target = cleanString(query, 120);
    if (!target) throw new Error("Nom, ID ou projet de l agent cible requis.");

    const agents = await this.list({ profileId });
    if (!agents.length) throw new Error("Aucun agent actif dans Noyau.");

    const normalized = target.toLowerCase();

    // 1. Exact ID
    const byId = agents.find((a) => a.id === target || a.id.toLowerCase() === normalized);
    if (byId) return byId;

    // 2. Exact Name
    const byName = agents.find((a) => a.name.toLowerCase() === normalized);
    if (byName) return byName;

    // 3. Exact Project Name
    const byProject = agents.find((a) => a.projectName && a.projectName.toLowerCase() === normalized);
    if (byProject) return byProject;

    // 4. Fuzzy Name contains or matches
    const byNameIncludes = agents.find((a) => a.name.toLowerCase().includes(normalized) || normalized.includes(a.name.toLowerCase()));
    if (byNameIncludes) return byNameIncludes;

    // 5. Fuzzy Project Name
    const byProjectIncludes = agents.find((a) => a.projectName && (a.projectName.toLowerCase().includes(normalized) || normalized.includes(a.projectName.toLowerCase())));
    if (byProjectIncludes) return byProjectIncludes;

    // 6. CWD matching
    const byCwd = agents.find((a) => a.cwd && (path.basename(a.cwd).toLowerCase() === normalized || a.cwd.toLowerCase().includes(normalized)));
    if (byCwd) return byCwd;

    const availableNames = agents.map((a) => `« ${a.name} » (${a.assistant}${a.projectName ? `, projet ${a.projectName}` : ""})`).join(", ");
    throw new Error(`Agent introuvable pour « ${target} ». Agents actifs : ${availableNames}`);
  }

  async context(query, { profileId = null } = {}) {
    const agent = await this.resolve(query, { profileId });
    const stored = this.store ? this.store.get(agent.id) : null;

    let messages = [];
    if (this.handover) {
      try {
        messages = await this.handover.messages({
          assistant: agent.assistant,
          threadId: stored?.threadId,
          agentSessionId: stored?.agentSessionId,
          cwd: agent.cwd,
        });
      } catch { /* messages optionnels */ }
    }

    let visibleTail = "";
    try {
      visibleTail = await this.tmux.captureVisible(agent.id).catch(() => "");
    } catch { /* tail optionnel */ }

    let git = null;
    if (agent.cwd) {
      try {
        const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], { cwd: agent.cwd, timeout: 3000 });
        const { stdout: lastCommit } = await execFileAsync("git", ["log", "-1", "--oneline"], { cwd: agent.cwd, timeout: 3000 });
        const { stdout: status } = await execFileAsync("git", ["status", "-s"], { cwd: agent.cwd, timeout: 3000 });
        git = {
          branch: branch.trim(),
          lastCommit: lastCommit.trim(),
          status: status.trim().slice(0, 1500),
        };
      } catch { /* pas de git ou erreur */ }
    }

    return {
      agent,
      messages: messages.slice(-15),
      visibleTail: visibleTail.split("\n").slice(-40).join("\n").trim(),
      git,
    };
  }

  async send(query, { message, callerSessionId = null, callerName = null, profileId = null } = {}) {
    const text = cleanString(message, 50000);
    if (!text) throw new Error("Message à transmettre requis.");

    const target = await this.resolve(query, { profileId });

    let callerTitle = callerName || null;
    if (!callerTitle && callerSessionId && this.store) {
      const caller = this.store.get(callerSessionId);
      if (caller?.name) {
        const project = caller.projectId && this.projects ? this.projects.get(caller.projectId) : null;
        callerTitle = `${caller.name}${project?.name ? ` (Projet ${project.name})` : ""}`;
      }
    }
    if (!callerTitle) callerTitle = "un autre agent Noyau";

    const formatted = `[Message inter-agent de « ${callerTitle} »]:\n${text}`;
    await this.tmux.submit(target.id, formatted);

    return {
      success: true,
      target: {
        id: target.id,
        name: target.name,
        assistant: target.assistant,
        project: target.projectName,
        cwd: target.cwd,
      },
      message: text,
      formatted,
    };
  }
}
