#!/usr/bin/env node
// Hook UserPromptSubmit: transmet la demande a Noyau, qui la trie avec son modele local.
// L'agent ne porte plus le suivi, et son prompt n'est pas alourdi.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
const BASE = process.env.NOYAU_URL || "https://127.0.0.1:4242";

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
  return Boolean(text) && !text.startsWith("/") && !/^(?:(?:ok|merci|oui|non|salut|bonjour)[.! ]*)+$/i.test(text);
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

  const exact = sessions[process.env.NOYAU_SESSION_ID];
  const owner = exact ? [process.env.NOYAU_SESSION_ID, exact] : Object.entries(sessions)
    .filter(([, session]) => session?.cwd && (cwd === path.resolve(session.cwd) || cwd.startsWith(`${path.resolve(session.cwd)}${path.sep}`)))
    .sort((a, b) => path.resolve(b[1].cwd).length - path.resolve(a[1].cwd).length || Date.parse(b[1].agentStateUpdatedAt || 0) - Date.parse(a[1].agentStateUpdatedAt || 0))[0];
  if (!owner) return;
  const profileId = owner[1].profileId || "";
  const projectId = owner?.[1]?.projectId || null;
  // Reporting desactivable par agent et par projet: un seul « non » suffit a couper le suivi.
  if (owner?.[1]?.todoTracking === false) return;
  if (projectId && projects[projectId]?.todoTracking === false) return;

  // Noyau trie la demande avec son modele local et repond aussitot:
  // rien n'est injecte dans le prompt, le suivi ne coute donc aucun token.
  await fetch(`${BASE}/api/todos/triage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(profileId ? { "x-noyau-profile": profileId } : {}),
    },
    body: JSON.stringify({ text: input.prompt, projectId }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

main().catch(() => {});
