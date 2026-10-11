#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
const args = process.argv.slice(2);
const command = (args[0] || "list").toLowerCase();

function reference(id) {
  return `*${String(id || "").split("-").pop().slice(-4).toUpperCase()}`;
}

async function getClient() {
  const [token, sessions, profiles] = await Promise.all([
    fs.readFile(path.join(dataDir, "access-token"), "utf8").then((v) => v.trim()).catch(() => ""),
    fs.readFile(path.join(dataDir, "sessions.json"), "utf8").then(JSON.parse).catch(() => ({})),
    fs.readFile(path.join(dataDir, "profiles.json"), "utf8").then(JSON.parse).catch(() => ({})),
  ]);
  const cwd = path.resolve(process.cwd());
  const exact = process.env.NOYAU_SESSION_ID && sessions[process.env.NOYAU_SESSION_ID] ? [process.env.NOYAU_SESSION_ID, sessions[process.env.NOYAU_SESSION_ID]] : null;
  const owner = exact || Object.entries(sessions)
    .filter(([, session]) => session?.cwd && (cwd === path.resolve(session.cwd) || cwd.startsWith(`${path.resolve(session.cwd)}${path.sep}`)))
    .sort((a, b) => {
      const exactA = cwd === path.resolve(a[1].cwd) ? 1 : 0;
      const exactB = cwd === path.resolve(b[1].cwd) ? 1 : 0;
      if (exactA !== exactB) return exactB - exactA;
      const lenDiff = path.resolve(b[1].cwd).length - path.resolve(a[1].cwd).length;
      if (lenDiff !== 0) return lenDiff;
      return Date.parse(b[1].agentStateUpdatedAt || 0) - Date.parse(a[1].agentStateUpdatedAt || 0);
    })[0];
  const profileId = owner?.[1]?.profileId || "";
  const projectId = owner?.[1]?.projectId || null;
  const agentName = owner?.[1]?.name || "Agent";
  const userName = profiles[profileId]?.name || "Moi";

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

  return { api, projectId, agentName, userName, cwd };
}

// Le commit courant sert de preuve dans le suivi: on l'ajoute au commentaire quand le dossier est un depot.
async function headCommit() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/git", ["log", "-1", "--pretty=%h %s"], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function stamp() {
  return new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function print(data) {
  process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
}

function match(todos, needle) {
  const query = String(needle || "").trim().toLowerCase().replace(/^[*#]/, "");
  if (!query) return null;
  return todos.find((todo) => todo.id.toLowerCase() === query)
    || todos.find((todo) => reference(todo.id).toLowerCase() === `*${query}`)
    || todos.find((todo) => todo.text.toLowerCase().includes(query))
    || null;
}

try {
  const { api, projectId, agentName } = await getClient();
  const view = await api("/api/todos");
  const folder = projectId ? (view.folders || []).find((item) => item.projectId === projectId) : null;
  const scoped = folder ? (view.todos || []).filter((todo) => todo.folderId === folder.id) : (view.todos || []);

  if (["list", "ls"].includes(command)) {
    print(scoped.map((todo) => ({
      ref: reference(todo.id),
      id: todo.id,
      text: todo.text,
      status: todo.status,
      priority: todo.priority || null,
      dueDate: todo.dueDate,
      comments: todo.comments?.length || 0,
    })));
  } else if (["add", "new"].includes(command)) {
    const text = args.slice(1).join(" ").trim();
    if (!text) throw new Error("Usage: node scripts/noyau-todo.mjs add \"Texte de la tâche\"");
    const result = await api("/api/todos", { method: "POST", body: JSON.stringify({ text: text.slice(0, 200), folderId: folder?.id || null, projectId, author: agentName, authorKind: "agent" }) });
    print({ created: reference(result.todo.id), id: result.todo.id, text: result.todo.text });
  } else if (["comment", "note", "prompt", "user-comment"].includes(command)) {
    const todo = match(scoped, args[1]);
    if (!todo) throw new Error("Tâche introuvable (référence, id ou extrait de texte attendu).");
    let remaining = args.slice(2);
    let asUser = ["prompt", "user-comment"].includes(command);
    if (remaining[0] === "--user" || remaining[0] === "-u") {
      asUser = true;
      remaining = remaining.slice(1);
    }
    const rawText = remaining.join(" ").trim();
    if (!rawText) throw new Error("Usage: node scripts/noyau-todo.mjs comment <ref> \"Suivi\" [--user] | prompt <ref> \"Demande\"");
    let text = rawText;
    if (!asUser && /^(?:demande(?:\s+de\s+l'utilisateur|\s+utilisateur)?|prompt(?:\s+utilisateur)?)\s*:\s*/i.test(text)) {
      text = text.replace(/^(?:demande(?:\s+de\s+l'utilisateur|\s+utilisateur)?|prompt(?:\s+utilisateur)?)\s*:\s*/i, "").trim();
      asUser = true;
    }
    const author = asUser ? userName : agentName;
    const authorKind = asUser ? "user" : "agent";
    await api(`/api/todos/${encodeURIComponent(todo.id)}/comments`, { method: "POST", body: JSON.stringify({ text: text.slice(0, 220), author, authorKind }) });
    print({ commented: reference(todo.id), author: asUser ? userName : `IA · ${agentName}`, text: todo.text });
  } else if (["status", "move"].includes(command)) {
    const todo = match(scoped, args[1]);
    if (!todo) throw new Error("Tâche introuvable (référence, id ou extrait de texte attendu).");
    let status = String(args[2] || "").trim();
    if (!status) throw new Error("Usage: node scripts/noyau-todo.mjs status <ref> <todo|review|done|zone>");
    const reviewCol = (view.columns || []).find((c) => c.id === "review" || c.kind === "review");
    const isReviewEnabled = reviewCol ? reviewCol.enabled !== false : true;
    if (status === "done" && isReviewEnabled) throw new Error("Interdit: seul l'utilisateur valide une tâche. Utiliser « review ».");
    if (status === "review" && !isReviewEnabled) {
      status = "done";
    }
    await api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
    print({ moved: reference(todo.id), status, text: todo.text });
  } else if (["report", "done-review", "trace"].includes(command)) {
    const todo = match(scoped, args[1]);
    if (!todo) throw new Error("Tâche introuvable (référence, id ou extrait de texte attendu).");
    const summary = args.slice(2).join(" ").trim();
    if (!summary) throw new Error("Usage: node scripts/noyau-todo.mjs report <ref> \"Modifications effectuées\"");
    const commit = await headCommit();
    // Suivi concis: une ligne, commit court en preuve.
    const text = `${stamp()}${commit ? ` · ${commit.split(" ")[0]}` : ""} · ${summary}`.slice(0, 220);
    await api(`/api/todos/${encodeURIComponent(todo.id)}/comments`, { method: "POST", body: JSON.stringify({ text, author: agentName, authorKind: "agent" }) });
    const reviewCol = (view.columns || []).find((c) => c.id === "review" || c.kind === "review");
    const isReviewEnabled = reviewCol ? reviewCol.enabled !== false : true;
    const targetStatus = isReviewEnabled ? "review" : "done";
    await api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: "PATCH", body: JSON.stringify({ status: targetStatus }) });
    print({ reported: reference(todo.id), status: targetStatus, commit, text: todo.text });
  } else if (["find", "search"].includes(command)) {
    const todo = match(scoped, args.slice(1).join(" "));
    print(todo ? { ref: reference(todo.id), id: todo.id, text: todo.text, status: todo.status, comments: todo.comments || [] } : null);
  } else {
    print(`Usage: node scripts/noyau-todo.mjs [list | add <texte> | comment <ref> <texte> | status <ref> <zone> | find <recherche>]
- list                       : Tâches du projet du dossier courant, avec leur référence courte (*XXXX).
- add "Texte"                : Crée une tâche dans le dossier du projet courant.
- comment <ref> "Suivi"      : Commentaire horodaté, une phrase courte (220 caractères max).
- status <ref> review        : Déplace la tâche (« done » réservé à la validation utilisateur).
- report <ref> "Modifs"      : Une ligne (date, commit, résumé bref) puis passe la tâche en « À tester ».
- find "mots clés"           : Retrouve une tâche et ses commentaires.`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
