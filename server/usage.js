import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function readTail(file, bytes = 512 * 1024) {
  if (!file) return "";
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function jsonLines(text) {
  return text.split("\n").reverse().flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function codexWindowLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return "Fenêtre";
  if (value >= 8640) return "Semaine";
  if (value >= 1380) return `${Math.round(value / 1440)}j`;
  return `${Math.round(value / 60)}h`;
}

export function codexRateWindows(rateLimits) {
  return [rateLimits?.primary, rateLimits?.secondary]
    .filter((item) => item && Number.isFinite(Number(item.used_percent)))
    .map((item) => ({
      label: codexWindowLabel(item.window_minutes),
      remainingPercent: Math.max(0, Math.round(100 - Number(item.used_percent))),
      resetsAt: item.resets_at ? new Date(Number(item.resets_at) * 1000).toISOString() : null,
      windowMinutes: Number(item.window_minutes) || null,
    }));
}

export function parseCodexUsage(text) {
  const events = jsonLines(text).filter((item) => item.type === "event_msg" && item.payload?.type === "token_count" && item.payload.info);
  const event = events[0];
  if (!event) return null;
  // Codex emet aussi des token_count sans quotas (limit_id premium): on garde le dernier porteur de limites.
  const limits = events.find((item) => item.payload.rate_limits?.primary)?.payload.rate_limits || event.payload.rate_limits;
  const info = event.payload.info;
  const latest = info.last_token_usage || info.total_token_usage || {};
  const usedTokens = Number(latest.input_tokens || 0) + Number(latest.output_tokens || 0);
  const contextWindow = Number(info.model_context_window || 0);
  const remainingTokens = contextWindow ? Math.max(0, contextWindow - usedTokens) : null;
  const primary = limits?.primary;
  const rateWindows = codexRateWindows(limits);
  return {
    rateWindows,
    usedTokens,
    remainingTokens,
    contextWindow: contextWindow || null,
    contextPercent: contextWindow ? Math.max(0, Math.round((remainingTokens / contextWindow) * 100)) : null,
    rateRemainingPercent: primary ? Math.max(0, Math.round(100 - Number(primary.used_percent || 0))) : null,
    rateResetsAt: primary?.resets_at ? new Date(primary.resets_at * 1000).toISOString() : null,
    rateWindowMinutes: Number(primary?.window_minutes) || null,
    estimated: false,
  };
}

export function parseClaudeRateLimits(rateLimits) {
  const parse = (item) => {
    // utilization arrive en ratio (0-1) via le hook statusline, en pourcentage via l'API OAuth.
    const utilization = Number(item?.utilization);
    const used = item?.used_percentage ?? (Number.isFinite(utilization) ? (utilization > 1 ? utilization : utilization * 100) : null);
    if (used === null || used === undefined || !Number.isFinite(Number(used))) return null;
    const rawReset = item.resets_at;
    const resetsAt = Number(rawReset) ? new Date(Number(rawReset) * 1000).toISOString() : (rawReset && !Number.isNaN(new Date(rawReset).getTime()) ? new Date(rawReset).toISOString() : null);
    return { remainingPercent: Math.max(0, Math.round(100 - Number(used))), resetsAt };
  };
  const fiveHour = parse(rateLimits?.five_hour);
  const sevenDay = parse(rateLimits?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, updatedAt: new Date().toISOString() };
}

// Passe la fenetre a 100% quand son reset est derriere nous: sans nouvel echange,
// aucun agent ne rapporte le renouvellement et l'ecran resterait bloque a 0%.
export function refreshExpiredWindow(window, now = Date.now()) {
  if (!window) return window;
  const resetsAt = Date.parse(window.resetsAt || "");
  if (!Number.isFinite(resetsAt) || resetsAt > now) return window;
  return { ...window, remainingPercent: 100, resetsAt: null, renewed: true };
}

export function refreshExpiredQuota(quota, now = Date.now()) {
  if (!quota) return quota;
  const next = { ...quota };
  if (Array.isArray(quota.windows)) next.windows = quota.windows.map((window) => refreshExpiredWindow(window, now));
  if (quota.fiveHour) next.fiveHour = refreshExpiredWindow(quota.fiveHour, now);
  if (quota.sevenDay) next.sevenDay = refreshExpiredWindow(quota.sevenDay, now);
  if (Number.isFinite(quota.remainingPercent) && next.windows?.length) {
    next.remainingPercent = next.windows[0].remainingPercent;
    next.resetsAt = next.windows[0].resetsAt;
  }
  return next;
}

export function parseClaudeUsage(text, contextWindow = 200_000) {
  const item = jsonLines(text).find((entry) => entry.type === "assistant" && entry.message?.model && entry.message.model !== "<synthetic>" && entry.message.usage);
  if (!item) return null;
  const usage = item.message.usage;
  const usedTokens = Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0) + Number(usage.output_tokens || 0);
  const remainingTokens = Math.max(0, contextWindow - usedTokens);
  return {
    usedTokens,
    remainingTokens,
    contextWindow,
    contextPercent: Math.max(0, Math.round((remainingTokens / contextWindow) * 100)),
    rateRemainingPercent: null,
    rateResetsAt: null,
    estimated: true,
  };
}

export function parsePaneUsage(text) {
  const match = String(text).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").match(/(\d{1,3})%\s+context left/i);
  return match ? { contextPercent: Number(match[1]), remainingTokens: null, usedTokens: null, contextWindow: null, rateRemainingPercent: null, rateResetsAt: null, estimated: true } : null;
}

export async function lastClaudeMessage(file) {
  try {
    const item = jsonLines(await readTail(file)).find((entry) => entry.type === "assistant" && Array.isArray(entry.message?.content));
    return item?.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim() || "";
  } catch {
    return "";
  }
}

export class UsageService {
  constructor({ codexRoot = path.join(os.homedir(), ".codex", "sessions") } = {}) {
    this.codexRoot = codexRoot;
    this.codexFiles = new Map();
  }

  async processTree(pid, seen = new Set()) {
    if (!pid || seen.has(pid)) return [];
    seen.add(pid);
    let children = [];
    try {
      children = (await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
    } catch { /* process exited */ }
    const descendants = await Promise.all(children.map((child) => this.processTree(child, seen)));
    return [pid, ...descendants.flat()];
  }

  async discoverCodexThread(panePid) {
    for (const pid of await this.processTree(panePid)) {
      try {
        const environment = (await fs.readFile(`/proc/${pid}/environ`)).toString("utf8").split("\0");
        const value = environment.find((entry) => entry.startsWith("CODEX_THREAD_ID="))?.slice("CODEX_THREAD_ID=".length);
        if (value) return value;
      } catch { /* process exited */ }
      try {
        for (const descriptor of await fs.readdir(`/proc/${pid}/fd`)) {
          const target = await fs.readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => "");
          const match = target.match(/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
          if (match) return match[1];
        }
      } catch { /* process exited */ }
    }
    return null;
  }

  async codexFile(threadId) {
    if (!threadId) return null;
    if (this.codexFiles.has(threadId)) return this.codexFiles.get(threadId);
    try {
      const files = await fs.readdir(this.codexRoot, { recursive: true });
      const match = files.find((file) => file.endsWith(`${threadId}.jsonl`));
      const resolved = match ? path.join(this.codexRoot, match) : null;
      this.codexFiles.set(threadId, resolved);
      return resolved;
    } catch {
      return null;
    }
  }

  // Les quotas sont ceux du compte: la conversation Codex la plus recente suffit a les rafraichir.
  async recentCodexFiles(limit = 6) {
    let entries = [];
    try {
      entries = await fs.readdir(this.codexRoot, { recursive: true });
    } catch {
      return [];
    }
    const stats = await Promise.all(entries.filter((entry) => entry.endsWith(".jsonl")).map(async (entry) => {
      const file = path.join(this.codexRoot, entry);
      try {
        return { file, time: (await fs.stat(file)).mtimeMs };
      } catch {
        return null;
      }
    }));
    return stats.filter(Boolean).sort((left, right) => right.time - left.time).slice(0, limit).map(({ file }) => file);
  }

  async latestCodexRateWindows(limit = 6) {
    for (const file of await this.recentCodexFiles(limit)) {
      try {
        const parsed = parseCodexUsage(await readTail(file));
        if (parsed?.rateWindows?.length) return parsed.rateWindows;
      } catch { /* fichier en cours d'ecriture */ }
    }
    return [];
  }

  async get(session, pane = "") {
    try {
      if (session.assistant === "codex" && session.threadId) return parseCodexUsage(await readTail(await this.codexFile(session.threadId))) || parsePaneUsage(pane);
      if (session.assistant === "claude" && session.transcriptPath) return parseClaudeUsage(await readTail(session.transcriptPath)) || parsePaneUsage(pane);
    } catch { /* unavailable while agent writes */ }
    return parsePaneUsage(pane);
  }
}
