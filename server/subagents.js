import fs from "node:fs/promises";
import path from "node:path";

const STALE_MS = 15 * 60_000;
const KEEP_MS = 7 * 86_400_000;
const EDGE_BYTES = 64 * 1024;
const TEXT_CHARS = 8000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n");
}

function parseLines(text) {
  return text.split("\n").flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

async function readEdges(file, size) {
  const handle = await fs.open(file, "r");
  try {
    const read = async (position, length) => {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      return buffer.toString("utf8");
    };
    return { head: await read(0, Math.min(size, EDGE_BYTES)), tail: await read(Math.max(0, size - EDGE_BYTES), Math.min(size, EDGE_BYTES)) };
  } finally {
    await handle.close();
  }
}

// Claude writes each background subagent next to its parent transcript; the parent's screen says nothing about them.
export function summarizeSubagent({ head, tail, meta = {}, id, mtimeMs, now }) {
  const first = parseLines(head).find((entry) => entry.type === "user");
  const entries = parseLines(tail).filter((entry) => entry.type === "assistant" || entry.type === "user");
  const last = entries.at(-1);
  const assistants = entries.filter((entry) => entry.type === "assistant");
  const lastAssistant = assistants.at(-1);
  const stop = lastAssistant?.message?.stop_reason;
  const interrupted = last?.type === "user" && /^\[Request interrupted/.test(textOf(last.message?.content));
  const finished = interrupted || (last?.type === "assistant" && (stop === "end_turn" || stop === "stop_sequence"));
  const lastTool = (lastAssistant?.message?.content || []).filter?.((block) => block?.type === "tool_use").at(-1)?.name || null;
  const lastText = [...assistants].reverse().map((entry) => textOf(entry.message?.content).trim()).find(Boolean) || "";
  return {
    id,
    description: meta.description || null,
    type: meta.agentType || null,
    worktreePath: meta.worktreePath || null,
    running: !finished && now - mtimeMs < STALE_MS,
    interrupted,
    startedAt: first?.timestamp || null,
    updatedAt: new Date(mtimeMs).toISOString(),
    prompt: textOf(first?.message?.content).slice(0, TEXT_CHARS),
    lastTool,
    lastText: lastText.slice(0, TEXT_CHARS),
  };
}

export class SubagentReader {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.cache = new Map();
  }

  async list(transcriptPath) {
    if (!transcriptPath) return [];
    const directory = path.join(transcriptPath.replace(/\.jsonl$/, ""), "subagents");
    const names = await fs.readdir(directory).catch(() => []);
    const now = this.now();
    const results = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(directory, name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat || now - stat.mtimeMs > KEEP_MS) continue;
      const key = `${stat.size}:${stat.mtimeMs}`;
      let summary = this.cache.get(file)?.key === key ? this.cache.get(file).summary : null;
      if (!summary) {
        const edges = await readEdges(file, stat.size).catch(() => null);
        if (!edges) continue;
        const meta = await fs.readFile(file.replace(/\.jsonl$/, ".meta.json"), "utf8").then(JSON.parse).catch(() => ({}));
        summary = summarizeSubagent({ ...edges, meta, id: name.replace(/^agent-|\.jsonl$/g, ""), mtimeMs: stat.mtimeMs, now });
        this.cache.set(file, { key, summary });
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
      }
      // A silent subagent goes stale without its file changing.
      results.push({ ...summary, running: summary.running && now - stat.mtimeMs < STALE_MS });
    }
    return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
