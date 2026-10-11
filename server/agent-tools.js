import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cleanString(value, limit = 50000) {
  return String(value || "").trim().slice(0, limit);
}

export function resolveProjectId(raw, projects) {
  if (!raw || !projects) return null;
  const target = String(raw).trim();
  if (!target) return null;

  // 1. Clé exacte dans projects (ex: project-mt8ac94v-aeb626)
  if (projects.get && projects.get(target)) return target;

  const all = projects.all ? Object.entries(projects.all()) : [];
  // 2. Recherche par ID insensible à la casse
  const byId = all.find(([id]) => id.toLowerCase() === target.toLowerCase());
  if (byId) return byId[0];

  // 3. Recherche par nom exact insensible à la casse (ex: "Atlas")
  const byExactName = all.find(([, p]) => p.name && p.name.trim().toLowerCase() === target.toLowerCase());
  if (byExactName) return byExactName[0];

  // 4. Recherche par inclusion insensible à la casse (ex: "atlas" dans "Atlas.cc")
  const byIncludes = all.find(([, p]) => p.name && (
    p.name.toLowerCase().includes(target.toLowerCase()) ||
    target.toLowerCase().includes(p.name.toLowerCase())
  ));
  if (byIncludes) return byIncludes[0];

  return null;
}

export class AgentCommunicationService {
  constructor({ tmux, store, projects = null, handover = null, agentStatus = null, workspaceRoot = process.cwd(), projectFiles = null } = {}) {
    this.tmux = tmux;
    this.store = store;
    this.projects = projects;
    this.handover = handover;
    this.agentStatus = agentStatus;
    this.workspaceRoot = workspaceRoot;
    this.projectFiles = projectFiles;
  }

  async list({ profileId = null } = {}) {
    const rawSessions = await this.tmux.list();
    const visible = rawSessions.filter((session) => {
      if (!session.managed) return false;
      if (!profileId) return true;
      if (session.profileId === profileId) return true;
      if (session.shared) return true;
      const stored = this.store ? this.store.get(session.id) : null;
      if (stored?.shared) return true;
      const projectId = stored?.projectId || session.projectId;
      const project = projectId && this.projects ? this.projects.get(projectId) : null;
      if (project && (project.profileId === profileId || project.shared)) return true;
      return false;
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
        description: stored?.description || session.description || null,
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

    let projectFiles = [];
    if (this.projectFiles && agent.projectId) {
      try {
        projectFiles = await this.projectFiles.list(agent.projectId);
      } catch { /* fichiers optionnels */ }
    }

    return {
      agent,
      messages: messages.slice(-15),
      visibleTail: visibleTail.split("\n").slice(-40).join("\n").trim(),
      git,
      projectFiles,
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

  async create({
    name = null,
    assistant = null,
    model = null,
    projectId = null,
    projectName = null,
    cwd = null,
    prompt = null,
    yolo = null,
    projectLogo = null,
    description = null,
    callerSessionId = null,
    callerName = null,
    profileId = null,
  } = {}) {
    let caller = null;
    if (callerSessionId && this.store) {
      caller = this.store.get(callerSessionId) || null;
    }

    const requestedProject = projectId || projectName || null;
    let targetProjectId = resolveProjectId(requestedProject, this.projects);
    if (requestedProject && !targetProjectId) {
      const allList = this.projects?.all ? Object.values(this.projects.all()).map((p) => `« ${p.name} » (${p.id})`).join(", ") : "";
      throw new Error(`Projet « ${requestedProject} » introuvable. Projets existants : ${allList}`);
    }
    if (!targetProjectId && caller?.projectId) {
      targetProjectId = caller.projectId;
    }

    const project = targetProjectId && this.projects ? this.projects.get(targetProjectId) : null;

    let targetCwd = cwd ? path.resolve(cwd) : null;
    if (!targetCwd) {
      if (caller?.cwd) {
        targetCwd = path.resolve(caller.cwd);
      } else if (project?.rootPath) {
        targetCwd = path.resolve(project.rootPath);
      } else {
        targetCwd = path.resolve(this.workspaceRoot);
      }
    }

    let targetYolo = true;
    if (typeof yolo === "boolean") {
      targetYolo = yolo;
    } else if (caller) {
      targetYolo = caller.yolo ?? caller.runningYolo ?? true;
    }

    let targetAssistant = assistant ? String(assistant).trim().toLowerCase() : null;
    if (!targetAssistant && caller?.assistant) {
      targetAssistant = caller.assistant;
    }
    if (!targetAssistant || !["codex", "claude", "claude-design", "antigravity", "shell"].includes(targetAssistant)) {
      targetAssistant = "codex";
    }
    const targetModel = model == null || model === "" ? null : String(model).trim();
    if (targetModel && !/^[a-zA-Z0-9._:/-]{1,100}$/.test(targetModel)) {
      throw new Error("Modèle invalide : identifiant attendu (ex: claude-3-5-sonnet-20241022, o3-mini, gpt-4o, gemini-2.5-pro).");
    }

    let targetName = name ? String(name).trim().slice(0, 60) : null;
    if (!targetName) {
      const prefix = targetAssistant === "claude" ? "Claude" : targetAssistant === "antigravity" ? "Antigravity" : targetAssistant === "codex" ? "Codex" : "Agent";
      targetName = `${prefix} ${project?.name || "Sub"}`;
    }

    const initialPrompt = prompt ? cleanString(prompt, 50000) : null;
    const finalDescription = description ? cleanString(description, 1000) : (
      initialPrompt ? `Créé par ${caller?.name || callerName || "agent"} : ${initialPrompt.slice(0, 100)}` : `Agent ${project?.name || ""}`
    );

    const targetProjectLogo = typeof projectLogo === "boolean"
      ? projectLogo
      : Boolean(targetProjectId || caller?.projectLogo);

    const session = await this.tmux.create({
      name: targetName,
      assistant: targetAssistant,
      model: targetModel,
      cwd: targetCwd,
      prompt: initialPrompt,
      yolo: targetYolo,
      projectLogo: targetProjectLogo,
      projectId: targetProjectId,
      profileId: profileId || caller?.profileId || null,
      shared: Boolean(project?.shared || caller?.shared),
      description: finalDescription,
    });

    return {
      success: true,
      agent: {
        id: session.id,
        name: session.name,
        assistant: session.assistant,
        model: targetModel || null,
        projectId: session.projectId,
        projectName: project?.name || null,
        cwd: session.cwd,
        yolo: session.yolo,
        prompt: initialPrompt,
        state: session.agentState,
      },
    };
  }

  async assignProject(query, projectTarget, { profileId = null } = {}) {
    const agent = await this.resolve(query, { profileId });
    const targetProjectId = resolveProjectId(projectTarget, this.projects);
    if (!targetProjectId) {
      const allList = this.projects?.all ? Object.values(this.projects.all()).map((p) => `« ${p.name} » (${p.id})`).join(", ") : "";
      throw new Error(`Projet « ${projectTarget} » introuvable. Projets existants : ${allList}`);
    }
    const current = this.store ? this.store.get(agent.id) : null;
    if (!current) throw new Error("Agent introuvable dans le store.");
    const project = this.projects.get(targetProjectId);
    const updated = {
      ...current,
      projectId: targetProjectId,
      projectLogo: current.projectLogo !== false,
      shared: Boolean(project?.shared || current.shared),
    };
    await this.store.set(agent.id, updated);
    return {
      success: true,
      agent: {
        id: agent.id,
        name: current.name,
        projectId: targetProjectId,
        projectName: project?.name || null,
      },
    };
  }

  async stop(query, { profileId = null } = {}) {
    const agent = await this.resolve(query, { profileId });
    if (this.store && this.store.get(agent.id)?.core) {
      throw new Error("Agent de base du Noyau: non supprimable.");
    }
    await this.tmux.kill(agent.id);
    return {
      success: true,
      stopped: agent.id,
      name: agent.name,
    };
  }
}
