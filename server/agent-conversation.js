import { conversationEvents } from "./agent-map.js";
import { readConversationTail } from "./conversation-tail.js";
import fs from "node:fs/promises";
const conversationCache = new Map();

// Resolve only a provider identifier belonging to this agent, never a latest-by-folder guess.
export async function readAgentConversation(metadata, { handover, agentMap, working = false }) {
  const args = { ...metadata, strict: true };
  const file = metadata.assistant === "codex" ? await handover.codexFile(args)
    : ["claude", "claude-design"].includes(metadata.assistant) ? await handover.claudeFile(args)
    : metadata.assistant === "antigravity" ? await handover.antigravityFile(args) : null;
  const previous = Array.isArray(metadata.conversationHistory) ? metadata.conversationHistory : [];
  if (!file) return { available: previous.length > 0, messages: previous.slice(-200) };
  const stat = await fs.stat(file).catch(() => null);
  const key = stat && `${stat.size}:${stat.mtimeMs}`;
  let entries = conversationCache.get(file)?.key === key ? conversationCache.get(file).entries : null;
  if (!entries) {
    entries = await readConversationTail(file, metadata.assistant).catch(() => agentMap.transcriptEntries(file, metadata.assistant));
    if (key) { conversationCache.set(file, { key, entries }); if (conversationCache.size > 100) conversationCache.delete(conversationCache.keys().next().value); }
  }
  const messages = conversationEvents(entries, { working, notes: true }).slice(-200).map(({ direction, kind, from, text, at, final, delegated }) => ({ ...(delegated ? { delegated: true } : {}), direction, kind, from, text: text.slice(0, 16384), truncated: text.length > 16384, at, final }));
  const current = previous.length ? messages.filter((message) => !(message.direction === "in" && /^(?:Tu es (?:Codex|Claude) et tu reprends le travail d.un agent|Tu reprends (?:le )?travail d.un autre agent|Tu reprends le travail d.un agent .+ dans .+ Aucun historique lisible)/i.test(message.text))) : messages;
  return { available: true, messages: [...previous, ...current].slice(-200) };
}

// Visible terminal tail, never interpreted as a completed assistant message.
export function liveActivity(screen) {
  const clean = String(screen || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const meaningful = clean.filter((line) => {
    if (/^[-─_=·*~—│┃┌┐└┘├┤┬┴┼]+$/.test(line)) return false;
    if (/press (up|down|esc|ctrl|\?|enter)|type your message|for shortcuts|to interrupt|ctrl\+[a-z]|cmd\+[a-z]/i.test(line)) return false;
    if (/^[>❯»$#]\s*$/.test(line)) return false;
    if (/^(bypass hook|dangerously|--no-alt-screen|check_for_update)/i.test(line)) return false;
    return true;
  });

  const lines = meaningful.length > 0 ? meaningful : clean;
  return lines.slice(-6).join("\n").slice(-600);
}
