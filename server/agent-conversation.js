import { conversationEvents } from "./agent-map.js";

// Resolve only a provider identifier belonging to this agent, never a latest-by-folder guess.
export async function readAgentConversation(metadata, { handover, agentMap, working = false }) {
  const args = { ...metadata, strict: true };
  const file = metadata.assistant === "codex" ? await handover.codexFile(args)
    : ["claude", "claude-design"].includes(metadata.assistant) ? await handover.claudeFile(args)
    : metadata.assistant === "antigravity" ? await handover.antigravityFile(args) : null;
  if (!file) return { available: false, messages: [] };
  const entries = await agentMap.transcriptEntries(file, metadata.assistant);
  const messages = conversationEvents(entries, { working }).slice(-200).map(({ direction, kind, from, text, at }) => ({ direction, kind, from, text: text.slice(0, 16384), truncated: text.length > 16384, at }));
  return { available: true, messages };
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
