import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { refreshExpiredWindow } from "./usage.js";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const BUCKET_MS = 10 * 60_000;
const CHUNK_BYTES = 256 * 1024;
const FULL_SCAN_MS = 10 * 60_000;
// Choix de prudence, pas des mesures: l'interface les présente comme tels.
export const ESTIMATE_POLICY = {
  margin: 1.5,
  minObservedHours: 6,
  minMessages: 5,
  // Le % fournisseur est un entier: en dessous, le rendement calculé dépend surtout de l'arrondi.
  minUsedPercent: 5,
  minWindowHours: 6,
  maxQuotaAgeHours: 6,
};

// Une réponse Claude occupe plusieurs lignes portant le même id et le même usage: l'appelant déduplique.
export function parseClaudeUsageLine(line) {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const usage = entry?.message?.usage;
  if (entry?.type !== "assistant" || !usage || entry.message.model === "<synthetic>") return null;
  const at = Date.parse(entry.timestamp || "");
  if (!Number.isFinite(at)) return null;
  const input = Number(usage.input_tokens || 0);
  const created = Number(usage.cache_creation_input_tokens || 0);
  const read = Number(usage.cache_read_input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  return { id: entry.message.id || entry.uuid || null, at, fresh: input + created + output, cached: read };
}

// Codex répète ses compteurs cumulés: seul l'écart avec l'événement précédent du fichier est consommé.
export function parseCodexUsageLine(line, previous = null) {
  if (!line.includes('"token_count"')) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const info = entry?.payload?.type === "token_count" ? entry.payload.info : null;
  if (!info) return null;
  const at = Date.parse(entry.timestamp || "");
  if (!Number.isFinite(at)) return null;
  const counters = (usage) => ({
    input: Number(usage?.input_tokens || 0),
    cached: Number(usage?.cached_input_tokens || 0),
    output: Number(usage?.output_tokens || 0),
  });
  const totals = counters(info.total_token_usage);
  const last = counters(info.last_token_usage);
  const size = (value) => value.input + value.output;
  const restarted = !previous || size(totals) < size(previous);
  const delta = restarted ? last : { input: totals.input - previous.input, cached: totals.cached - previous.cached, output: totals.output - previous.output };
  if (size(delta) <= 0) return { totals, at, fresh: 0, cached: 0 };
  const cached = Math.max(0, delta.cached);
  return { totals, at, fresh: Math.max(0, delta.input - cached) + Math.max(0, delta.output), cached };
}

const sumInto = (buckets, at, fresh, cached, messages) => {
  const key = at - (at % BUCKET_MS);
  const bucket = buckets.get(key) || { fresh: 0, cached: 0, messages: 0 };
  bucket.fresh += fresh;
  bucket.cached += cached;
  bucket.messages += messages;
  buckets.set(key, bucket);
};

export function sumBuckets(buckets, since) {
  const total = { fresh: 0, cached: 0, messages: 0 };
  for (const [key, bucket] of buckets) {
    if (key + BUCKET_MS <= since) continue;
    total.fresh += bucket.fresh;
    total.cached += bucket.cached;
    total.messages += bucket.messages;
  }
  return total;
}

// Fenêtre hebdo du compte telle que relevée par les services de quota.
export function weeklyWindow(provider, quota, now = Date.now()) {
  const raw = provider === "claude" ? quota?.sevenDay : quota?.windows?.find((item) => Number(item.windowMinutes) >= 8640);
  const window = refreshExpiredWindow(raw, now);
  const resetsAt = Date.parse(window?.resetsAt || "");
  if (!window || !Number.isFinite(resetsAt) || !Number.isFinite(Number(window.remainingPercent))) return null;
  const minutes = Number(window.windowMinutes) || 10080;
  return { usedPercent: 100 - Number(window.remainingPercent), start: resetsAt - minutes * 60_000, resetsAt, updatedAt: Date.parse(quota?.updatedAt || "") || null };
}

// Rendement = tokens consommés par % de limite. Deux lectures car le poids du cache n'est pas publié.
export function providerYield(window, usage, now = Date.now(), policy = ESTIMATE_POLICY) {
  if (!window) return { reason: "no-quota" };
  if (window.updatedAt && now - window.updatedAt > policy.maxQuotaAgeHours * 3_600_000) return { reason: "stale-quota" };
  if (now - window.start < policy.minWindowHours * 3_600_000) return { reason: "window-young" };
  if (window.usedPercent < policy.minUsedPercent) return { reason: "low-usage" };
  if (!usage?.fresh) return { reason: "no-tokens" };
  // Pourcentage arrondi: on prend sa borne haute, donc le rendement le plus bas possible.
  const percent = window.usedPercent + 0.5;
  return { usedPercent: window.usedPercent, freshPerPercent: usage.fresh / percent, allPerPercent: (usage.fresh + usage.cached) / percent };
}

export function projectAgent({ usage, observedMs, yields, policy = ESTIMATE_POLICY }) {
  const hours = observedMs / 3_600_000;
  const base = { measured: { tokens: usage.fresh + usage.cached, freshTokens: usage.fresh, messages: usage.messages, hours }, margin: policy.margin, policy: { minObservedHours: policy.minObservedHours, minMessages: policy.minMessages } };
  if (hours < policy.minObservedHours) return { ...base, status: "insufficient", reason: "observation" };
  if (usage.messages < policy.minMessages) return { ...base, status: "insufficient", reason: "activity" };
  const scale = (WEEK_MS / observedMs) * policy.margin;
  const projected = { fresh: usage.fresh * scale, all: (usage.fresh + usage.cached) * scale };
  const providers = {};
  for (const [provider, value] of Object.entries(yields)) {
    // Sans poids connu pour le cache, on retient la lecture qui donne le pourcentage le plus élevé.
    providers[provider] = value.reason ? { percent: null, reason: value.reason } : { percent: Math.ceil(Math.max(projected.fresh / value.freshPerPercent, projected.all / value.allPerPercent)), usedPercent: value.usedPercent };
  }
  return { ...base, status: "ok", projectedTokens: Math.round(projected.all), providers };
}

export class AutonomyEstimator {
  constructor({
    claudeRoot = path.join(os.homedir(), ".claude", "projects"),
    codexRoot = path.join(os.homedir(), ".codex", "sessions"),
    quota = () => null,
    now = () => Date.now(),
    policy = ESTIMATE_POLICY,
    fullScanMs = FULL_SCAN_MS,
  } = {}) {
    Object.assign(this, { roots: { claude: claudeRoot, codex: codexRoot }, quota, now, policy, fullScanMs });
    this.files = new Map();
    this.seen = new Map();
    this.starts = { claude: null, codex: null };
    this.lastFullAt = 0;
    this.scanning = null;
    this.lastScan = null;
    this.results = new Map();
  }

  // Lecture par morceaux en await: l'event loop reste libre, seul ce qui a été ajouté au fichier est relu.
  async scanFile(file, provider) {
    let state = this.files.get(file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return;
    if (state && stat.size === state.size && stat.mtimeMs === state.mtimeMs) return;
    if (!state || stat.size < state.offset) {
      state = { provider, size: 0, mtimeMs: 0, offset: 0, previous: null, buckets: new Map() };
      this.files.set(file, state);
    }
    const handle = await fs.open(file, "r").catch(() => null);
    if (!handle) return;
    try {
      let position = state.offset;
      let carry = Buffer.alloc(0);
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
        if (!bytesRead) break;
        position += bytesRead;
        carry = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
        const end = carry.lastIndexOf(10);
        if (end < 0) continue;
        this.consume(carry.subarray(0, end).toString("utf8"), state);
        state.offset += end + 1;
        carry = carry.subarray(end + 1);
      }
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
    } finally {
      await handle.close();
    }
  }

  consume(text, state) {
    for (const line of text.split("\n")) {
      if (state.provider === "claude") {
        const parsed = parseClaudeUsageLine(line);
        if (!parsed) continue;
        const known = parsed.id ? this.seen.get(parsed.id) : undefined;
        if (known === undefined) {
          if (parsed.id) this.seen.set(parsed.id, parsed.fresh);
          sumInto(state.buckets, parsed.at, parsed.fresh, parsed.cached, 1);
        } else if (parsed.fresh > known) {
          // La dernière ligne d'une réponse porte le total de sortie, les précédentes un cumul partiel.
          this.seen.set(parsed.id, parsed.fresh);
          sumInto(state.buckets, parsed.at, parsed.fresh - known, 0, 0);
        }
      } else {
        const parsed = parseCodexUsageLine(line, state.previous);
        if (!parsed) continue;
        state.previous = parsed.totals;
        if (parsed.fresh || parsed.cached) sumInto(state.buckets, parsed.at, parsed.fresh, parsed.cached, 1);
      }
    }
  }

  async jsonlFiles(root, since) {
    let entries = [];
    try { entries = await fs.readdir(root, { recursive: true }); } catch { return []; }
    const files = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry.endsWith(".jsonl")) continue;
      const file = path.join(root, entry);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.mtimeMs >= since) files.push(file);
    }
    return files;
  }

  windows(now = this.now()) {
    return { claude: weeklyWindow("claude", this.quota("claude"), now), codex: weeklyWindow("codex", this.quota("codex"), now) };
  }

  // Tâche de fond, jamais appelée depuis une requête. Une seule passe à la fois.
  refresh({ agents = [], force = false } = {}) {
    if (this.scanning) return this.scanning;
    this.scanning = this.runRefresh(agents, force).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async runRefresh(agents, force) {
    const startedAt = this.now();
    const windows = this.windows(startedAt);
    const full = force || startedAt - this.lastFullAt >= this.fullScanMs;
    if (full) {
      for (const provider of ["claude", "codex"]) {
        const start = windows[provider]?.start ?? null;
        // Nouvelle semaine: on repart à zéro plutôt que de garder des compteurs devenus inutiles.
        if (start !== this.starts[provider]) {
          for (const [file, state] of this.files) if (state.provider === provider) this.files.delete(file);
          if (provider === "claude") this.seen.clear();
          this.starts[provider] = start;
        }
        for (const file of await this.jsonlFiles(this.roots[provider], start ?? startedAt - WEEK_MS)) await this.scanFile(file, provider);
      }
      this.lastFullAt = this.now();
      this.lastScan = { at: new Date(this.lastFullAt).toISOString(), ms: this.lastFullAt - startedAt, files: this.files.size };
    }
    // Fichiers de l'agent à chaque passe: son compteur suit sa conversation sans attendre la passe complète.
    for (const agent of agents) for (const [file, provider] of await this.agentFiles(agent)) await this.scanFile(file, provider);
    this.results.clear();
  }

  async agentFiles(agent) {
    const files = [];
    for (const transcript of agent.sources?.claude || []) {
      files.push([transcript, "claude"]);
      const directory = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
      for (const entry of await fs.readdir(directory).catch(() => [])) if (entry.endsWith(".jsonl")) files.push([path.join(directory, entry), "claude"]);
    }
    for (const thread of agent.sources?.codex || []) {
      for (const [file, state] of this.files) if (state.provider === "codex" && file.endsWith(`${thread}.jsonl`)) files.push([file, "codex"]);
    }
    return files;
  }

  agentUsage(agent, since) {
    const total = { fresh: 0, cached: 0, messages: 0 };
    const add = (state) => {
      const part = sumBuckets(state.buckets, since);
      total.fresh += part.fresh;
      total.cached += part.cached;
      total.messages += part.messages;
    };
    const claude = agent.sources?.claude || [];
    const prefixes = claude.map((transcript) => `${transcript.replace(/\.jsonl$/, "")}${path.sep}`);
    const threads = agent.sources?.codex || [];
    for (const [file, state] of this.files) {
      if (state.provider === "claude" ? claude.includes(file) || prefixes.some((prefix) => file.startsWith(prefix)) : threads.some((thread) => file.endsWith(`${thread}.jsonl`))) add(state);
    }
    return total;
  }

  providerUsage(provider, since) {
    const total = { fresh: 0, cached: 0, messages: 0 };
    for (const state of this.files.values()) {
      if (state.provider !== provider) continue;
      const part = sumBuckets(state.buckets, since);
      total.fresh += part.fresh;
      total.cached += part.cached;
      total.messages += part.messages;
    }
    return total;
  }

  yields(now = this.now()) {
    const windows = this.windows(now);
    return Object.fromEntries(Object.entries(windows).map(([provider, window]) => [provider, window ? providerYield(window, this.providerUsage(provider, window.start), now, this.policy) : { reason: "no-quota" }]));
  }

  // Lecture synchrone du cache, appelée à chaque poll: aucun accès disque.
  estimate(id, autonomy) {
    if (!this.lastScan) return { status: "pending" };
    const cached = this.results.get(id);
    const now = this.now();
    if (cached && now - cached.at < 60_000) return cached.value;
    const started = Date.parse(autonomy?.enabledAt || "") || now;
    const since = Math.max(started, now - WEEK_MS);
    const paused = Number(autonomy?.pausedMs || 0) + (autonomy?.pausedAt ? Math.max(0, now - Date.parse(autonomy.pausedAt)) : 0);
    const observedMs = Math.max(1, now - since - paused);
    const value = {
      ...projectAgent({ usage: this.agentUsage(autonomy, since), observedMs, yields: this.yields(now), policy: this.policy }),
      scannedAt: this.lastScan.at,
    };
    this.results.set(id, { at: now, value });
    return value;
  }
}
