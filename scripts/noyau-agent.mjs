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

  return { api, callerSessionId, callerName, cwd };
}

function print(data) {
  process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
}

try {
  const { api, callerSessionId, callerName } = await getClient();

  if (["list", "ls", "status", "agents"].includes(command)) {
    const res = await api("/api/agent-tools/agents");
    print(res.agents || []);
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
  } else {
    print(`Usage: node scripts/noyau-agent.mjs [list | read <nom> | send <nom> <message> | find <recherche>]
- list                      : Liste tous les agents actifs de Noyau (nom, projet, assistant, état, dossier).
- read "Nom ou ID"          : Affiche les derniers échanges et le contexte récent de l agent.
- send "Nom ou ID" "Message": Transmet un message / tâche / contexte directement à l agent.
- find "mots clés"          : Recherche un agent par nom, projet ou mot-clé.`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
