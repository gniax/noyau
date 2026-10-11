#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
let callerSessionId = process.env.NOYAU_SESSION_ID;
const args = process.argv.slice(2);
const command = (args[0] || "list").toLowerCase();

async function getClient() {
  const [token, sessions] = await Promise.all([
    fs.readFile(path.join(dataDir, "access-token"), "utf8").then((v) => v.trim()).catch(() => ""),
    fs.readFile(path.join(dataDir, "sessions.json"), "utf8").then(JSON.parse).catch(() => ({})),
  ]);

  const cwd = path.resolve(process.cwd());
  if (!callerSessionId) {
    const candidates = Object.entries(sessions).filter(([, s]) => {
      if (!s?.cwd) return false;
      const scwd = path.resolve(s.cwd);
      return cwd === scwd || cwd.startsWith(scwd + path.sep);
    });
    if (candidates.length > 0) {
      candidates.sort((a, b) => Date.parse(b[1].agentStateUpdatedAt || 0) - Date.parse(a[1].agentStateUpdatedAt || 0));
      callerSessionId = candidates[0][0];
    }
  }

  const profileId = callerSessionId ? sessions[callerSessionId]?.profileId || "" : "";
  const callerName = callerSessionId ? sessions[callerSessionId]?.name || null : null;

  async function api(pathname, options = {}) {
    const response = await fetch(`https://127.0.0.1:4242${pathname}`, {
      ...options,
      headers: {
        authorization: token ? `Bearer ${token}` : "",
        "content-type": "application/json",
        ...(profileId ? { "x-noyau-profile": profileId } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Noyau: erreur ${response.status}`);
    return payload;
  }

  return { api, token, sessions, profileId, callerSessionId, callerName, cwd };
}

function print(data) {
  process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
}

try {
  const { api, token, sessions, profileId, callerSessionId, callerName } = await getClient();

  if (["list", "ls", "status", "agents"].includes(command)) {
    const res = await api("/api/agent-tools/agents");
    print(res.agents || []);
  } else if (["create", "new", "spawn", "add"].includes(command)) {
    let name = null;
    let assistant = null;
    let model = null;
    let project = null;
    let cwd = null;
    let prompt = null;
    let yolo = null;
    let projectLogo = null;
    let description = null;

    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--name" || arg === "-n") {
        name = rest[++i];
      } else if (arg === "--assistant" || arg === "-a") {
        assistant = rest[++i];
      } else if (arg === "--model") {
        model = rest[++i];
      } else if (arg === "--project" || arg === "-p") {
        project = rest[++i];
      } else if (arg === "--cwd" || arg === "-d") {
        cwd = rest[++i];
      } else if (arg === "--prompt" || arg === "-m") {
        prompt = rest[++i];
      } else if (arg === "--desc" || arg === "--description") {
        description = rest[++i];
      } else if (arg === "--yolo" || arg === "--dangerous") {
        yolo = true;
      } else if (arg === "--no-yolo" || arg === "--safe") {
        yolo = false;
      } else if (arg === "--logo" || arg === "--project-logo") {
        projectLogo = true;
      } else if (arg === "--no-logo") {
        projectLogo = false;
      } else if (!arg.startsWith("-")) {
        if (!name) {
          name = arg;
        } else if (!prompt) {
          prompt = arg;
        } else {
          prompt += " " + arg;
        }
      }
    }

    const payload = {
      name,
      assistant,
      model,
      projectId: project,
      projectName: project,
      cwd,
      prompt,
      yolo,
      projectLogo,
      description,
      callerSessionId,
      callerName,
    };

    const res = await api("/api/agent-tools/agents/create", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    print(res);
  } else if (["assign", "attach", "set-project"].includes(command)) {
    const target = args[1];
    const project = args[2];
    if (!target || !project) throw new Error("Usage: node scripts/noyau-agent.mjs assign 'Nom ou ID agent' 'Nom ou ID projet'");
    const res = await api(`/api/agent-tools/agents/${encodeURIComponent(target)}/assign-project`, {
      method: "POST",
      body: JSON.stringify({ project }),
    });
    print(res);
  } else if (["stop", "delete", "kill", "rm"].includes(command)) {
    const target = args[1];
    if (!target) throw new Error("Usage: node scripts/noyau-agent.mjs stop 'Nom ou ID agent'");
    const res = await api(`/api/agent-tools/agents/${encodeURIComponent(target)}/stop`, {
      method: "POST",
    });
    print(res);
  } else if (["read", "context", "view", "get"].includes(command)) {
    const target = args[1];
    if (!target) throw new Error("Usage: node scripts/noyau-agent.mjs read 'Nom ou ID de l agent'");
    const res = await api(`/api/agent-tools/agents/${encodeURIComponent(target)}/context`);
    print(res);
  } else if (["send", "msg", "message", "tell"].includes(command)) {
    const target = args[1];
    const message = args.slice(2).join(" ").trim();
    if (!target || !message) throw new Error("Usage: node scripts/noyau-agent.mjs send 'Nom ou ID' 'Message'");
    const res = await api(`/api/agent-tools/agents/${encodeURIComponent(target)}/send`, {
      method: "POST",
      body: JSON.stringify({ message, callerSessionId, callerName }),
    });
    print(res);
  } else if (["find", "search"].includes(command)) {
    const query = args.slice(1).join(" ").trim().toLowerCase();
    const res = await api("/api/agent-tools/agents");
    const agents = res.agents || [];
    const matches = query ? agents.filter((a) =>
      a.name.toLowerCase().includes(query) ||
      (a.projectName && a.projectName.toLowerCase().includes(query)) ||
      a.assistant.toLowerCase().includes(query) ||
      a.id.toLowerCase().includes(query) ||
      (a.cwd && a.cwd.toLowerCase().includes(query))
    ) : agents;
    print(matches);
  } else if (["files", "list-files"].includes(command)) {
    const targetProject = args[1] || (callerSessionId ? sessions[callerSessionId]?.projectId : null);
    if (!targetProject) throw new Error("Usage: node scripts/noyau-agent.mjs files <projectId>");
    const res = await api(`/api/projects/${encodeURIComponent(targetProject)}/files`);
    print(res.files || []);
  } else if (["putfile", "upload"].includes(command)) {
    const filePath = args[1];
    const targetProject = args[2] || (callerSessionId ? sessions[callerSessionId]?.projectId : null);
    if (!filePath || !targetProject) throw new Error("Usage: node scripts/noyau-agent.mjs putfile <chemin-fichier> <projectId>");
    const resolvedPath = path.resolve(filePath);
    const content = await fs.readFile(resolvedPath);
    const filename = path.basename(resolvedPath);
    const formData = new FormData();
    formData.append("file", new Blob([content]), filename);
    const response = await fetch(`https://127.0.0.1:4242/api/projects/${encodeURIComponent(targetProject)}/files`, {
      method: "POST",
      headers: {
        authorization: token ? `Bearer ${token}` : "",
        ...(profileId ? { "x-noyau-profile": profileId } : {}),
      },
      body: formData,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Erreur ${response.status}`);
    print(payload);
  } else {
    print(`Usage: node scripts/noyau-agent.mjs [create | assign | stop | list | read | send | find | files | putfile]
- create [--name <nom>] [--prompt <texte>] [--project <id|nom>] [--assistant codex|claude|antigravity] [--model <id>] [--cwd <dir>] [--yolo|--no-yolo]
  Crée un nouvel agent sur Noyau, rattaché à un projet avec consigne initiale (reprend par défaut la permission yolo/dangerous).
- assign <agent> <projet>   : Rattache un agent existant à un projet (nom ou identifiant).
- stop <agent>              : Arrête et supprime un agent de Noyau.
- list                      : Liste tous les agents actifs de Noyau (nom, projet, assistant, état, dossier).
- read "Nom ou ID"          : Affiche les derniers échanges, le contexte récent et les fichiers du projet.
- send "Nom ou ID" "Message": Transmet un message / tâche / contexte directement à l agent.
- find "mots clés"          : Recherche un agent par nom, projet ou mot-clé.
- files [projectId]         : Liste les fichiers partagés du projet.
- putfile <fichier> <projId>: Dépose un fichier local dans l'espace partagé du projet.`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
