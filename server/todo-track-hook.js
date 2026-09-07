#!/usr/bin/env node
// Hook UserPromptSubmit: rappelle a l'agent de tracer chaque demande dans les to-do Noyau,
// et lui fournit les taches deja ouvertes du projet pour qu'il commente au lieu de dupliquer.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
const BASE = process.env.NOYAU_URL || "https://127.0.0.1:4242";

function reference(id) {
  return `*${String(id || "").split("-").pop().slice(-4).toUpperCase()}`;
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

function trackable(prompt) {
  const text = String(prompt || "").trim();
  // Les commandes et les messages tres courts ne decrivent ni evolution ni bug.
  return text.length >= 25 && !text.startsWith("/");
}

async function main() {
  const input = await readInput();
  if (!trackable(input.prompt)) return;

  const cwd = path.resolve(input.cwd || process.cwd());
  const [token, sessions, projects] = await Promise.all([
    fs.readFile(path.join(dataDir, "access-token"), "utf8").then((value) => value.trim()).catch(() => ""),
    fs.readFile(path.join(dataDir, "sessions.json"), "utf8").then(JSON.parse).catch(() => ({})),
    fs.readFile(path.join(dataDir, "projects.json"), "utf8").then(JSON.parse).catch(() => ({})),
  ]);
  if (!token) return;

  const owner = Object.entries(sessions)
    .filter(([, session]) => session?.cwd && (cwd === path.resolve(session.cwd) || cwd.startsWith(`${path.resolve(session.cwd)}${path.sep}`)))
    .sort((a, b) => Date.parse(b[1].agentStateUpdatedAt || 0) - Date.parse(a[1].agentStateUpdatedAt || 0))[0];
  const profileId = owner?.[1]?.profileId || "";
  const projectId = owner?.[1]?.projectId || null;
  // Reporting desactivable par agent et par projet: un seul « non » suffit a couper le suivi.
  if (owner?.[1]?.todoTracking === false) return;
  if (projectId && projects[projectId]?.todoTracking === false) return;

  const response = await fetch(`${BASE}/api/todos`, {
    headers: { authorization: `Bearer ${token}`, ...(profileId ? { "x-noyau-profile": profileId } : {}) },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) return;
  const view = await response.json();
  const folder = projectId ? (view.folders || []).find((item) => item.projectId === projectId) : null;
  const open = (folder ? (view.todos || []).filter((todo) => todo.folderId === folder.id) : view.todos || [])
    .filter((todo) => todo.status !== "done" && !todo.completed)
    .slice(0, 40)
    .map((todo) => `${reference(todo.id)} [${todo.status}] ${todo.text}`);

  const context = [
    "Suivi to-do Noyau (obligatoire pour ce message s'il décrit une évolution ou un bug) :",
    "- Tâche déjà listée ci-dessous : `node /home/user/projects/noyau/scripts/noyau-todo.mjs comment <ref> \"suivi\"`.",
    "- Commentaires très concis : une seule phrase, 200 caractères maximum, pas de liste ni de rappel du contexte.",
    "- Sinon : `node /home/user/projects/noyau/scripts/noyau-todo.mjs add \"…\"`.",
    "- Une fois traité : `… report <ref> \"ce qui a été modifié\"` — commente avec date, heure et commit courant puis passe en « À tester ». Jamais `done` : seul l'utilisateur valide.",
    open.length ? `Tâches ouvertes${folder ? ` · ${folder.name}` : ""} :\n${open.join("\n")}` : "Aucune tâche ouverte pour ce projet.",
  ].join("\n");

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
  }));
}

main().catch(() => {});
