#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
const callerSessionId = process.env.NOYAU_SESSION_ID;
const prompt = process.argv.slice(2).join(" ").trim();

try {
  if (!callerSessionId) throw new Error("NOYAU_SESSION_ID absent: outil disponible depuis agent lancé par Noyau.");
  if (!prompt) throw new Error("Usage: node scripts/claude-design-tool.mjs DEMANDE");
  const [token, sessions] = await Promise.all([
    fs.readFile(path.join(dataDir, "access-token"), "utf8").then((value) => value.trim()),
    fs.readFile(path.join(dataDir, "sessions.json"), "utf8").then(JSON.parse),
  ]);
  const profileId = sessions[callerSessionId]?.profileId || "";
  const response = await fetch("http://127.0.0.1:4242/api/agent-tools/claude-design", {
    method: "POST",
    signal: AbortSignal.timeout(11 * 60_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(profileId ? { "x-noyau-profile": profileId } : {}),
    },
    body: JSON.stringify({ callerSessionId, prompt }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Noyau: erreur ${response.status}`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
