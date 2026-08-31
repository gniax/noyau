import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MESSAGE_LIMIT = 30;
const MESSAGE_CHARS = 700;
const TOTAL_CHARS = 14_000;
const ANTIGRAVITY_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const HANDOVER_REQUEST = /^Prépare passation vers\b/i;

async function readTail(file, bytes = 2 * 1024 * 1024) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    const text = buffer.toString("utf8");
    return length < stat.size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

function jsonLines(text) {
  return String(text).split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function cleanText(value) {
  return String(value || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickTail(messages) {
  const kept = [];
  let total = 0;
  for (const message of messages.slice(-MESSAGE_LIMIT).reverse()) {
    const text = message.text.slice(0, MESSAGE_CHARS);
    if (!text) continue;
    total += text.length;
    if (total > TOTAL_CHARS) break;
    kept.unshift({ ...message, text });
  }
  return kept;
}

export function extractCodexMessages(text) {
  const messages = jsonLines(text).flatMap((entry) => {
    const payload = entry.payload || entry;
    if (payload.type !== "message" || !["user", "assistant"].includes(payload.role)) return [];
    const content = Array.isArray(payload.content) ? payload.content.map((block) => block?.text || "").join(" ") : payload.content;
    const clean = cleanText(content);
    return clean ? [{ role: payload.role, text: clean }] : [];
  });
  return pickTail(messages);
}

export function extractClaudeMessages(text) {
  const messages = jsonLines(text).flatMap((entry) => {
    if (!["user", "assistant"].includes(entry.type) || entry.isMeta) return [];
    const raw = entry.message?.content;
    const content = Array.isArray(raw) ? raw.filter((block) => block?.type === "text").map((block) => block.text).join(" ") : raw;
    const clean = cleanText(content);
    return clean ? [{ role: entry.type, text: clean }] : [];
  });
  return pickTail(messages);
}

function antigravityUserText(content) {
  const request = String(content || "").match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)?.[1] || content;
  const clean = cleanText(request);
  return HANDOVER_REQUEST.test(clean) ? "" : clean;
}

export function extractAntigravityMessages(text) {
  const messages = jsonLines(text).flatMap((entry) => {
    if (entry.type === "USER_INPUT") {
      const clean = antigravityUserText(entry.content);
      return clean ? [{ role: "user", text: clean }] : [];
    }
    if (entry.type !== "PLANNER_RESPONSE" || entry.source !== "MODEL") return [];
    const clean = cleanText(entry.content);
    return clean ? [{ role: "assistant", text: clean }] : [];
  });
  return pickTail(messages);
}

export function formatHandover({ source, target, cwd, messages }) {
  const labels = { codex: "Codex", claude: "Claude", antigravity: "Antigravity" };
  const sourceLabel = labels[source] || source;
  const targetLabel = labels[target] || target;
  const history = messages.map((message) => `[${message.role === "user" ? "utilisateur" : sourceLabel}] ${message.text}`).join("\n");
  return [
    `Tu es ${targetLabel} et tu reprends le travail d'un agent ${sourceLabel} dans ${cwd}.`,
    `Aucune passation rédigée n'était possible (quota ${sourceLabel} épuisé ou agent indisponible): voici l'historique brut de la dernière conversation.`,
    "Sers-t'en comme contexte, vérifie l'état réel du dépôt et du git avant toute modification, puis attends la prochaine demande de l'utilisateur.",
    "",
    `HISTORIQUE (${messages.length} derniers messages, du plus ancien au plus récent):`,
    history,
  ].join("\n");
}

export class HandoverService {
  constructor({
    codexRoot = path.join(os.homedir(), ".codex", "sessions"),
    claudeRoot = path.join(os.homedir(), ".claude", "projects"),
    antigravityRoot = path.join(os.homedir(), ".gemini", "antigravity-cli"),
  } = {}) {
    this.codexRoot = codexRoot;
    this.claudeRoot = claudeRoot;
    this.antigravityRoot = antigravityRoot;
  }

  async newestFile(directory, filter = () => true) {
    let entries = [];
    try {
      entries = await fs.readdir(directory, { recursive: true });
    } catch {
      return null;
    }
    const stats = await Promise.all(entries.filter((entry) => entry.endsWith(".jsonl") && filter(entry)).map(async (entry) => {
      const file = path.join(directory, entry);
      try {
        return { file, time: (await fs.stat(file)).mtimeMs };
      } catch {
        return null;
      }
    }));
    return stats.filter(Boolean).sort((left, right) => right.time - left.time)[0]?.file || null;
  }

  async codexFile({ threadId, cwd }) {
    if (threadId) {
      const match = await this.newestFile(this.codexRoot, (entry) => entry.endsWith(`${threadId}.jsonl`));
      if (match) return match;
    }
    if (!cwd) return null;
    // Sans threadId on retient la conversation la plus recente ouverte sur ce dossier.
    const files = await fs.readdir(this.codexRoot, { recursive: true }).catch(() => []);
    const scored = await Promise.all(files.filter((entry) => entry.endsWith(".jsonl")).map(async (entry) => {
      const file = path.join(this.codexRoot, entry);
      try {
        const stat = await fs.stat(file);
        const handle = await fs.open(file, "r");
        const buffer = Buffer.alloc(Math.min(4096, stat.size));
        await handle.read(buffer, 0, buffer.length, 0);
        await handle.close();
        return buffer.toString("utf8").includes(`"cwd":"${cwd}"`) ? { file, time: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    }));
    return scored.filter(Boolean).sort((left, right) => right.time - left.time)[0]?.file || null;
  }

  async claudeFile({ agentSessionId, cwd }) {
    const directory = cwd ? path.join(this.claudeRoot, cwd.replace(/[^a-zA-Z0-9]/g, "-")) : null;
    if (agentSessionId && directory) {
      const file = path.join(directory, `${agentSessionId}.jsonl`);
      if (await fs.stat(file).then(() => true, () => false)) return file;
    }
    return directory ? this.newestFile(directory) : null;
  }

  async antigravityFile({ cwd }) {
    if (!cwd) return null;
    const history = jsonLines(await readTail(path.join(this.antigravityRoot, "history.jsonl")));
    const conversations = history
      .filter((entry) => entry.workspace && path.resolve(entry.workspace) === path.resolve(cwd) && ANTIGRAVITY_CONVERSATION_ID.test(entry.conversationId || ""))
      .sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0));
    for (const entry of conversations) {
      const file = path.join(this.antigravityRoot, "brain", entry.conversationId, ".system_generated", "logs", "transcript_full.jsonl");
      if (await fs.stat(file).then(() => true, () => false)) return file;
    }
    return null;
  }

  async messages({ assistant, threadId, agentSessionId, cwd }) {
    try {
      if (assistant === "codex") {
        const file = await this.codexFile({ threadId, cwd });
        return file ? extractCodexMessages(await readTail(file)) : [];
      }
      if (["claude", "claude-design"].includes(assistant)) {
        const file = await this.claudeFile({ agentSessionId, cwd });
        return file ? extractClaudeMessages(await readTail(file)) : [];
      }
      if (assistant === "antigravity") {
        const file = await this.antigravityFile({ cwd });
        return file ? extractAntigravityMessages(await readTail(file)) : [];
      }
    } catch { /* transcript illisible */ }
    return [];
  }

  async prompt({ assistant, target, threadId, agentSessionId, cwd }) {
    const messages = await this.messages({ assistant, threadId, agentSessionId, cwd });
    if (!messages.length) return null;
    return formatHandover({ source: assistant, target, cwd, messages });
  }
}
