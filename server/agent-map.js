import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describeCalendar, describeCron, nextCronRun } from "./schedule-text.js";
import { diffInventories, keyLines, scanDirs, sheetPrompt } from "./map-scanner.js";
import { parseDelegate } from "../shared/delegate.js";

// Carte projet: agents, services, timers, cron, modules et APIs, en lecture seule. Noms et statuts seulement.
const WINDOWS = { "24h": 86_400_000, "7d": 7 * 86_400_000 };
const SNAPSHOT_TTL_MS = 30_000;
const PROD_STATUS_TTL_MS = 5 * 60_000;
const CRON_LIST_TTL_MS = 10 * 60_000;
const ARCHIVE_RECENT_MS = 7 * 86_400_000;
const LIVE_LINK_MS = 3_600_000;
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const CHAT_TEXT_CHARS = 1200;
const CHAT_LIMIT = 80;
const EXCHANGE_TTL_MS = 4_000;
const EXCHANGE_TEXT_CHARS = 8000;
const EXCHANGE_LIMIT = 300;
const MAX_SHEETS_PER_SCAN = 80;
const SHEET_BATCH = 8;
const UNIT_PROPS = "Id,Description,ActiveState,SubState,Result,Type,WorkingDirectory,ExecStart,Triggers,NextElapseUSecRealtime,LastTriggerUSec,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainStatus,TimersCalendar,EnvironmentFiles";
const INTER_AGENT = /\[Message inter-agent de « ([^»]+?) »\]:?\s*/;
const INCIDENT = /^\[(?:Incident|Contrôle)\]\s*/;
const SKIPPED_USER = /^(<(command-|local-command|task-notification|bash-|user-prompt-submit-hook)|\[Request interrupted|Caveat: |This session is being continued)/;
const SCRIPT_FILE = /\.(m?js|cjs|ts|py|sh|php|rb)$/i;
const ASSISTANT_COST = { claude: "Claude (Anthropic)", "claude-design": "Claude (Anthropic)", codex: "Codex (OpenAI)", antigravity: "Antigravity (Google)" };
const ZONES = ["agents", "diffusion", "prod", "infra", "external"];
const DIFFUSION_UNIT = /(canva|shorts|social|telegram|tiktok|arena|publish|youtube|twitter|outreach|newsletter)/i;
const API_LABELS = {
  telegram: "Telegram", x: "X", youtube: "YouTube", gmail: "Gmail", cloudflare: "Cloudflare", tiktok: "TikTok", canva: "Canva",
  brevo: "Brevo", github: "GitHub", openai: "OpenAI", anthropic: "Anthropic", llm: "Fournisseurs LLM", google: "Google", ses: "Amazon SES",
  coingecko: "CoinGecko", dexscreener: "DexScreener", geckoterminal: "GeckoTerminal", coinbrain: "CoinBrain", defillama: "DefiLlama", goplus: "GoPlus (rug check)",
  fxtwitter: "FxTwitter (X)", proxies: "Proxys payants", opensea: "OpenSea", coindar: "Coindar", listmonk: "listmonk + SES", nowpayments: "NOWPayments",
  coinzilla: "Coinzilla", openverse: "Openverse", rss: "Flux RSS médias", "solana-rpc": "RPC Solana (Helius)", pumpfun: "pump.fun", androidpublisher: "Google Play",
  "google-avatars": "Google (photos de profil)", coinmarketcap: "CoinMarketCap", qonto: "Qonto", indexnow: "IndexNow", onesignal: "OneSignal", notion: "Notion", drive: "Google Drive",
};

// Valeurs sensibles masquées avant tout affichage (chat, erreurs journal).
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "•••"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "•••"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "•••"],
  [/\b(ghp|gho|ghs|github_pat|xox[abpr]|glpat)[-_A-Za-z0-9]{12,}/g, "•••"],
  [/\b(AKIA|ASIA)[A-Z0-9]{12,}/g, "•••"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "•••"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, "•••"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "•••"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 •••"],
  [/\b([\w.-]*(token|secret|password|passwd|pwd|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth|cookie|session[_-]?id|credential)s?)(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, "$1$3•••"],
  [/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1•••@"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "•••"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}(?=\s|$|["'),.;])/g, "•••"],
];

// systemctl show: blocs séparés par une ligne vide; TimersCalendar peut se répéter (plusieurs OnCalendar).
export function parseUnitShow(output) {
  const units = [];
  let current = {};
  const flush = () => {
    if (current.Id) units.push(current);
    current = {};
  };
  for (const line of String(output).split("\n")) {
    if (!line) {
      flush();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "TimersCalendar") (current.calendars ||= []).push(value.match(/OnCalendar=([^;]+)/)?.[1]?.trim());
    if (key === "EnvironmentFiles") (current.envFiles ||= []).push(value.replace(/\s*\(ignore_errors=\w+\)\s*$/, "").trim());
    current[key] = value;
  }
  flush();
  return units.map((unit) => ({ ...unit, calendars: (unit.calendars || []).filter(Boolean), envFiles: (unit.envFiles || []).filter(Boolean) }));
}

export function redact(value) {
  let text = String(value || "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function clip(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function cleanText(value) {
  return String(value || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slug(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

const GENERIC_SCRIPTS = new Set(["main", "index", "server", "run", "app", "cli", "cron", "start", "worker", "bot"]);
// Fin de chemin d'un script (« scripts/CoinsUpdaterCron.py ») pour relier un cron aux fichiers du scan.
function scriptTail(script) {
  const parts = String(script || "").split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return GENERIC_SCRIPTS.has(parts[0].replace(/\.\w+$/, "").toLowerCase()) || !/\.\w+$/.test(parts[0]) ? null : `/${parts[0]}`;
  return `/${parts.slice(-2).join("/")}`;
}

function hash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
}

export function senderName(raw) {
  return String(raw || "").replace(/\s*\(Projet [^)]*\)\s*$/, "").trim();
}

// Description posée par agent-tools.create: « Créé par X : prompt ».
export function creatorOf(description) {
  const match = String(description || "").match(/^Créé par (.+?) : ([\s\S]*)$/);
  return match ? { name: senderName(match[1]), prompt: match[2].trim() } : null;
}

// Demande humaine ou inter-agent; null pour le bruit (commandes, hooks, résultats d'outils).
export function classifyUserText(raw, creator = null) {
  const text = cleanText(raw);
  if (!text) return null;
  const inter = text.match(INTER_AGENT);
  if (inter) return { from: senderName(inter[1]), kind: "agent", text: text.slice(inter.index + inter[0].length).trim() || text };
  // Envoyé par la surveillance de Noyau, jamais par le fondateur.
  if (INCIDENT.test(text)) return { from: "Noyau", kind: "incident", text: text.replace(INCIDENT, "").trim() || text };
  const delegate = parseDelegate(text);
  if (delegate.delegated) return { from: null, kind: "founder", delegated: true, text: delegate.text };
  if (SKIPPED_USER.test(text)) return null;
  if (creator?.prompt && creator.prompt.length >= 12 && text.startsWith(creator.prompt.slice(0, 40))) return { from: creator.name, kind: "agent", text };
  return { from: null, kind: "founder", text };
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && (block.type === "text" || block.type === "input_text" || block.type === "output_text")).map((block) => block.text || "").join("\n");
}

// Une ligne de transcript → événement neutre { role, text, at, final }.
export function parseTranscriptLine(line, assistant) {
  if (!line || (!line.includes('"user"') && !line.includes('"assistant"') && !line.includes('"queued_command"') && !line.includes('"USER_INPUT"') && !line.includes('"PLANNER_RESPONSE"'))) return null;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const at = Date.parse(entry.timestamp || entry.payload?.timestamp || "") || null;
  if (assistant === "codex") {
    const payload = entry.payload || entry;
    if (payload.type !== "message" || !["user", "assistant"].includes(payload.role)) return null;
    const text = blockText(payload.content);
    return text.trim() ? { role: payload.role, text, at, final: payload.role === "assistant" && payload.phase === "final_answer" ? true : null } : null;
  }
  if (assistant === "antigravity") {
    if (entry.type === "USER_INPUT") {
      const text = String(entry.content || "").match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)?.[1] || entry.content;
      return text ? { role: "user", text: String(text), at, final: null } : null;
    }
    if (entry.type === "PLANNER_RESPONSE" && entry.source === "MODEL" && entry.content) return { role: "assistant", text: String(entry.content), at, final: null };
    return null;
  }
  // Un message envoyé pendant que l'agent travaille n'est écrit que sous cette forme.
  if (entry.type === "attachment") {
    const queued = entry.attachment;
    if (queued?.type !== "queued_command" || (queued.commandMode && queued.commandMode !== "prompt") || (queued.origin?.kind && queued.origin.kind !== "human")) return null;
    const text = blockText(queued.prompt);
    return text.trim() ? { role: "user", text, at, final: null } : null;
  }
  if (!["user", "assistant"].includes(entry.type) || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return null;
  const text = blockText(entry.message?.content);
  if (!text.trim()) return null;
  const stop = entry.message?.stop_reason;
  return { role: entry.type, text, at, final: entry.type === "assistant" ? (stop ? stop === "end_turn" || stop === "stop_sequence" : null) : null };
}

// Garde les demandes (fondateur, agents) et la réponse finale de chaque tour, pas le travail intermédiaire.
// notes: the founder also reads what the agent writes between two actions, as progress messages.
export function conversationEvents(entries, { creator = null, since = 0, working = false, notes = false } = {}) {
  const events = [];
  let pending = null;
  const flush = () => {
    if (pending) events.push({ at: pending.at, direction: "out", kind: "reply", from: null, text: pending.text, final: pending.final === true });
    pending = null;
  };
  for (const entry of entries) {
    if (entry.role === "assistant") {
      if (entry.text.startsWith("You've hit your session limit")) continue;
      if (entry.final === true) {
        if (notes) flush();
        pending = entry;
        flush();
      } else if (notes) {
        flush();
        pending = { ...entry, final: false };
      } else if (entry.final === null) pending = entry;
      continue;
    }
    const classified = classifyUserText(entry.text, creator);
    if (!classified) continue;
    flush();
    events.push({ at: entry.at, direction: "in", kind: classified.kind, from: classified.from, text: classified.text, ...(classified.delegated ? { delegated: true } : {}) });
  }
  if (!working || notes) flush();
  return events.filter((event) => !since || (event.at && event.at >= since));
}

async function readHead(file, bytes) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readTail(file, bytes = TRANSCRIPT_TAIL_BYTES) {
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

export function execArgv(execStart) {
  const match = String(execStart || "").match(/argv\[\]=([^;]*)/);
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
}

// Seul le nom du script est exposé, jamais la ligne de commande (arguments sensibles possibles).
export function scriptName(argv) {
  const file = argv.slice(0, 8).find((token) => SCRIPT_FILE.test(token) && !token.includes("="));
  return file ? path.basename(file) : argv[0] ? path.basename(argv[0]) : null;
}

export function topDir(file, workspaceRoot) {
  if (!file || !path.isAbsolute(file)) return null;
  const relative = path.relative(workspaceRoot, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0];
}

export function unitStatus(unit, triggered = null) {
  const active = unit.ActiveState;
  if (active === "failed") return "err";
  if (unit.Id?.endsWith(".timer")) {
    if (active !== "active") return "stop";
    if (triggered?.ActiveState === "failed") return "err";
    if (triggered?.ActiveState === "activating" || triggered?.SubState === "running") return "run";
    return "ok";
  }
  if (active === "activating" || active === "reloading" || active === "deactivating") return "run";
  if (active === "active") return "ok";
  if (unit.Result && unit.Result !== "success") return "err";
  return unit.triggeredBy ? "ok" : "stop";
}

export function systemdTime(value) {
  if (!value || value === "n/a" || value === "0") return null;
  const unix = String(value).match(/^@(\d+)$/);
  if (unix) return Number(unix[1]) ? new Date(Number(unix[1]) * 1000).toISOString() : null;
  const parsed = Date.parse(String(value).replace(/^\w{3} /, "").replace(/ ([A-Z]{3,4})$/, ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseCrontab(text) {
  return String(text || "").split("\n").flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^[A-Z_][A-Z0-9_]*=/.test(line)) return [];
    const special = line.match(/^(@\w+)\s+(.+)$/);
    const fields = special ? [special[1], special[2]] : (() => {
      const parts = line.split(/\s+/);
      return parts.length > 5 ? [parts.slice(0, 5).join(" "), parts.slice(5).join(" ")] : null;
    })();
    if (!fields) return [];
    const [schedule, command] = fields;
    const tokens = command.split(/[\s;&|()]+/).filter(Boolean);
    const paths = tokens.filter((token) => token.startsWith("/") || token.startsWith("~/"));
    const script = tokens.find((token) => SCRIPT_FILE.test(token) && !token.includes("="));
    return [{ id: hash(line), schedule, script: script ? path.basename(script) : null, paths }];
  });
}

// Sortie de l'action « status » d'un module prod: VPN, services, crons/health. Rien d'autre n'est gardé.
export function parseProdStatus(output) {
  const text = String(output || "");
  const reachable = !/VPN:\s*DÉCONNECT/i.test(text) && /VPN:\s*CONNECT/i.test(text);
  const keys = {};
  const services = text.match(/^Services:\s*(.+)$/m);
  if (services) {
    for (const part of services[1].split("·")) {
      const [name, state] = part.trim().split(/\s+/);
      if (name) keys[`service:${name}`] = state === "ok" ? "ok" : state === "activating" ? "run" : "err";
    }
  }
  const crons = text.match(/^Crons\/health[^:]*:\s*(.+)$/m);
  if (crons) keys.crons = /^OK\b/i.test(crons[1].trim()) ? "ok" : /absent/i.test(crons[1]) ? "unknown" : "err";
  const maintenance = text.match(/^Maintenance:\s*(ON|OFF)/m)?.[1] || null;
  return { reachable, keys, maintenance };
}

function mapRef(ref) {
  const value = String(ref || "").trim();
  if (/^unit:[\w@.-]+\.(service|timer)$/.test(value)) return value;
  if (/^api:[a-z0-9-]{1,40}$/.test(value)) return value;
  if (/^module:[a-z0-9-]{1,60}$/.test(value)) return value;
  if (/^agent:.{1,80}$/.test(value)) return value;
  if (/^[a-z0-9-]{1,60}$/.test(value)) return `local:${value}`;
  return null;
}

function infoFields(config) {
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).slice(0, 8).map((item) => clip(item, 120)).filter(Boolean);
  return {
    desc: config?.desc || config?.description ? clip(config.desc || config.description, 420) : null,
    produces: list(config?.produces),
    dependsOn: list(config?.dependsOn),
    owner: config?.owner ? clip(config.owner, 80) : null,
    verify: config?.verify === true,
    usedIn: list(config?.usedIn),
    keys: (Array.isArray(config?.keys) ? config.keys : []).slice(0, 16).map((key) => clip(String(key).replace(/=.*$/, ""), 120)).filter(Boolean),
    cost: COSTS[config?.cost] ? config.cost : null,
    costNote: config?.costNote ? clip(config.costNote, 160) : null,
    quota: config?.quota ? clip(config.quota, 200) : null,
    lifecycle: LIFECYCLES.includes(config?.lifecycle) ? config.lifecycle : null,
    manage: config?.manage ? clip(config.manage, 120) : null,
  };
}

// Coût déclaré: payant = abonnement, usage ou commission (badge $ sur la carte).
export const COSTS = { free: "Gratuit", subscription: "Payant · abonnement", usage: "Payant · à l'usage", commission: "Commission par transaction", unknown: "À confirmer" };
const PAID = new Set(["subscription", "usage", "commission"]);
const LIFECYCLES = ["actif", "en pause", "sandbox", "obsolète ?", "non utilisé", "secours"];

// Clé « map » optionnelle d'un manifest .noyau/modules/*.json: déclarations de noms et descriptions seulement.
export function normalizeMapConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const zone = ZONES.includes(raw.zone) ? raw.zone : null;
  const units = {};
  for (const [name, config] of Object.entries(raw.units || {}).slice(0, 60)) {
    if (!/^[\w@.-]+\.(service|timer)$/.test(name)) continue;
    units[name] = { role: config?.role === "bot" ? "bot" : null, zone: ZONES.includes(config?.zone) ? config.zone : null, label: config?.label ? clip(config.label, 40) : null, ...infoFields(config) };
  }
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, 40).flatMap((node) => {
    if (!/^[a-z0-9-]{1,60}$/.test(node?.id || "")) return [];
    const type = ["cron", "service", "bot", "script", "api"].includes(node.type) ? node.type : "script";
    return [{
      id: node.id, type, label: clip(node.label || node.id, 40), zone: ZONES.includes(node.zone) ? node.zone : null,
      schedule: node.schedule ? clip(node.schedule, 40) : null, host: node.host ? clip(node.host, 40) : null,
      statusKey: /^[\w:.-]{1,40}$/.test(node.statusKey || "") ? node.statusKey : null,
      ...infoFields(node),
    }];
  });
  const links = (Array.isArray(raw.links) ? raw.links : []).slice(0, 120).flatMap((link) => {
    const [from, to, label] = Array.isArray(link) ? link : [link?.from, link?.to, link?.label];
    const source = mapRef(from);
    const target = mapRef(to);
    return source && target ? [{ source, target, label: label ? clip(label, 40) : null }] : [];
  });
  const statusAction = /^[a-z0-9-]{1,60}$/.test(raw.status?.action || "") ? raw.status.action : null;
  const crons = raw.crons && /^[a-z0-9-]{1,60}$/.test(raw.crons.action || "") ? {
    action: raw.crons.action,
    host: raw.crons.host ? clip(raw.crons.host, 40) : null,
    timezone: raw.crons.timezone === "local" ? "local" : "UTC",
    statusKey: /^[\w:.-]{1,40}$/.test(raw.crons.statusKey || "") ? raw.crons.statusKey : null,
    zone: ZONES.includes(raw.crons.zone) ? raw.crons.zone : null,
    defaultKeys: (Array.isArray(raw.crons.defaultKeys) ? raw.crons.defaultKeys : []).slice(0, 6).map((key) => clip(String(key).replace(/=.*$/, ""), 120)),
    entries: Object.fromEntries(Object.entries(raw.crons.entries || {}).slice(0, 80).filter(([id]) => /^[a-z0-9-]{1,60}$/.test(id)).map(([id, config]) => [id, { label: config?.label ? clip(config.label, 40) : null, ...infoFields(config) }])),
  } : null;
  const apis = Object.fromEntries(Object.entries(raw.apis || {}).slice(0, 80).filter(([id]) => /^[a-z0-9-]{1,40}$/.test(id)).map(([id, config]) => [id, { label: config?.label ? clip(config.label, 48) : null, ...infoFields(config) }]));
  return { zone, units, nodes, links, statusAction, crons, apis };
}

export function cronEntryId(script, args) {
  const file = path.basename(String(script || "tache"));
  const base = /^main\.\w+$/.test(file) ? path.basename(path.dirname(String(script))) || "main" : file.replace(/\.\w+$/, "");
  const arg = (args || []).find((token) => token && !token.startsWith(">") && !/^\d?>/.test(token) && !token.includes("/"));
  return slug(arg ? `${base}-${arg.replace(/^-+/, "")}` : base) || "tache";
}

export function cronLabel(entry) {
  const file = String(entry.script || "");
  const base = !file ? entry.id : /^main\.\w+$/.test(file) ? entry.id.split("-")[0] : file.replace(/\.\w+$/, "");
  const mode = entry.id.startsWith(slug(base)) ? entry.id.slice(slug(base).length).replace(/^-/, "").replace(/-/g, " ") : "";
  return clip(mode ? `${base} · ${mode}` : base, 40);
}

// Sortie « crontab -l » commentée (une section « ## user X » par compte): ligne → commentaire qui la précède.
export function parseCronListing(text) {
  const entries = [];
  const seen = new Map();
  let user = null;
  let comment = [];
  let previous = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const section = line.match(/^##\s*user\s+(\S+)/i);
    if (section) {
      user = section[1];
      comment = [];
      previous = null;
      continue;
    }
    if (line.startsWith("#")) {
      const body = line.replace(/^#+\s?/, "").trim();
      if (/^-{2,}.*-{2,}$/.test(body) || /^m h\s+dom/.test(body)) {
        comment = [];
      } else if (body) comment.push(body);
      previous = null;
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/.test(line)) continue;
    const parsed = parseCrontab(line)[0];
    if (!parsed) continue;
    const command = line.slice(line.indexOf(parsed.schedule) + parsed.schedule.length).trim();
    const tokens = command.split(/\s+/);
    const scriptIndex = tokens.findIndex((token) => SCRIPT_FILE.test(token) && !token.includes("="));
    const script = scriptIndex >= 0 ? tokens[scriptIndex] : null;
    const rest = scriptIndex >= 0 ? tokens.slice(scriptIndex + 1) : [];
    const stop = rest.findIndex((token) => /^(\d?>>?|\||&&|;|2>&1)/.test(token));
    const args = (stop >= 0 ? rest.slice(0, stop) : rest).slice(0, 2);
    // Un commentaire couvre la ligne suivante, et les suivantes du même script (ex. modes d'un même cron).
    const inherited = !comment.length && previous && previous.script && script && previous.script === path.basename(script) ? previous.comment : null;
    let id = cronEntryId(script || tokens[0], args);
    const count = (seen.get(id) || 0) + 1;
    seen.set(id, count);
    if (count > 1) id = `${id}-${count}`;
    const entry = { id, user, schedule: parsed.schedule, command: clip(redact(command), 600), script: script ? path.basename(script) : null, comment: comment.length ? comment.join(" ") : inherited };
    entries.push(entry);
    previous = entry;
    comment = [];
  }
  return entries;
}

export class AgentMapService {
  constructor({ store, projects, tmux, archives, handover, moduleService, workspaceRoot, noyauRoot = null, run, agentState = async () => null, subagents = null, now = () => Date.now(), scanStore = null, llm = null }) {
    this.scanStore = scanStore;
    this.llm = llm;
    this.scanJobs = new Map();
    this.store = store;
    this.projects = projects;
    this.tmux = tmux;
    this.archives = archives;
    this.handover = handover;
    this.moduleService = moduleService;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.noyauDir = noyauRoot ? topDir(noyauRoot, this.workspaceRoot) : null;
    this.run = run;
    this.agentState = agentState;
    this.subagents = subagents;
    this.now = now;
    this.snapshots = new Map();
    this.transcripts = new Map();
    this.prodStatus = new Map();
  }

  async transcriptFile(agent) {
    try {
      if (agent.assistant === "codex") return await this.handover.codexFile({ threadId: agent.threadId, cwd: agent.cwd });
      if (agent.assistant === "antigravity") return await this.handover.antigravityFile({ cwd: agent.cwd });
      if (["claude", "claude-design"].includes(agent.assistant)) {
        if (agent.transcriptPath && await fs.stat(agent.transcriptPath).then(() => true, () => false)) return agent.transcriptPath;
        return agent.agentSessionId ? await this.handover.claudeFile({ agentSessionId: agent.agentSessionId, cwd: agent.cwd }) : null;
      }
    } catch { /* transcript absent */ }
    return null;
  }

  async transcriptEntries(file, assistant) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return [];
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = this.transcripts.get(file);
    if (cached?.key === key) return cached.entries;
    const text = await readTail(file).catch(() => "");
    const entries = text.split("\n").map((line) => parseTranscriptLine(line, assistant)).filter(Boolean);
    this.transcripts.set(file, { key, entries });
    if (this.transcripts.size > 200) this.transcripts.delete(this.transcripts.keys().next().value);
    return entries;
  }

  async systemdUnits() {
    const show = async (scope, names) => {
      if (!names.length) return [];
      const args = [...(scope === "user" ? ["--user"] : []), "show", ...names, "--no-pager", "--timestamp=unix", `--property=${UNIT_PROPS}`];
      const { stdout } = await this.run("/usr/bin/systemctl", args, { timeout: 15_000 });
      return parseUnitShow(stdout).map((unit) => ({ ...unit, scope }));
    };
    const units = [];
    try {
      const { stdout } = await this.run("/usr/bin/systemctl", ["--user", "list-units", "--all", "--type=service,timer", "--plain", "--no-legend", "--no-pager"], { timeout: 15_000 });
      const names = stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^[\w@.\\-]+\.(service|timer)$/.test(name || ""));
      units.push(...await show("user", names));
    } catch { /* systemd user indisponible */ }
    try {
      const files = await fs.readdir("/etc/systemd/system", { withFileTypes: true });
      const userIds = new Set(units.map((unit) => unit.Id));
      // Une unité user prime sur son homonyme système (ex. ancien canva-bot système désactivé).
      const names = files.filter((entry) => entry.isFile() && /\.(service|timer)$/.test(entry.name) && !entry.name.includes("@") && !userIds.has(entry.name)).map((entry) => entry.name);
      units.push(...await show("system", names));
    } catch { /* unités système illisibles */ }
    return units;
  }

  async crontab() {
    try {
      const { stdout } = await this.run("/usr/bin/crontab", ["-l"], { timeout: 5000 });
      return parseCrontab(stdout);
    } catch {
      return [];
    }
  }

  async manifestMaps(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return [];
    const modules = Object.values(this.moduleService.store.all()).filter((module) => module.projectId === projectId);
    const maps = [];
    for (const module of modules) {
      let raw = null;
      if (module.manifestPath) {
        try {
          const stat = await fs.stat(module.manifestPath);
          if (stat.size <= 64 * 1024) raw = JSON.parse(await fs.readFile(module.manifestPath, "utf8"))?.map || null;
        } catch { /* manifest déplacé */ }
      }
      maps.push({ module, map: normalizeMapConfig(raw) });
    }
    return maps;
  }

  // Exécute l'action status déclarée (lecture seule par contrat du manifest), au plus toutes les 5 min.
  // Sortie d'une action déclarée (lecture seule par contrat du manifest), en cache; jamais deux exécutions à la fois.
  async actionOutput(module, actionId, ttl) {
    const key = `${module.id}:${actionId}`;
    const cached = this.prodStatus.get(key);
    const fresh = cached && this.now() - cached.at < ttl;
    if (fresh || cached?.pending) return cached?.value ?? null;
    const action = (module.actions || []).find((item) => item.id === actionId);
    if (!action?.command?.file) return null;
    const pending = this.run(action.command.file, action.command.args, { cwd: module.workingDirectory, timeout: Math.min(action.command.timeout || 30_000, 30_000) })
      .then(({ stdout }) => stdout, (error) => error.stdout || "")
      .then((value) => {
        this.prodStatus.set(key, { at: this.now(), value });
        return value;
      });
    this.prodStatus.set(key, { ...(cached || {}), pending: true });
    if (cached?.value != null) return cached.value;
    return Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(null), 8000))]);
  }

  async moduleStatus(module, actionId) {
    const output = await this.actionOutput(module, actionId, PROD_STATUS_TTL_MS);
    return output == null ? null : parseProdStatus(output);
  }

  relPath(file) {
    const relative = path.relative(this.workspaceRoot, file);
    if (!relative.startsWith("..")) return relative;
    const home = path.dirname(this.workspaceRoot);
    return file.startsWith(`${home}/`) ? `~/${path.relative(home, file)}` : file;
  }

  scanSummary(projectId) {
    const state = this.scanStore.project(projectId);
    const job = this.scanJobs.get(projectId);
    const diff = state.pending?.diff;
    return {
      running: Boolean(job && !job.done), phase: job && !job.done ? job.phase : null, progress: job && !job.done ? job.progress : null,
      lastRunAt: state.lastRunAt, appliedAt: state.applied?.scannedAt || null, error: state.lastError || null,
      pending: diff ? diff.added.length + diff.changed.length + diff.gone.length : 0,
    };
  }

  scanStatus(projectId) {
    const state = this.scanStore.project(projectId);
    const pending = state.pending;
    const find = (id) => pending?.inventory[id] || state.applied?.inventory?.[id] || { label: id };
    const items = (ids) => ids.map((id) => ({ id, label: find(id).label, type: find(id).type || null })).sort((a, b) => String(a.type).localeCompare(String(b.type)) || a.label.localeCompare(b.label, "fr"));
    return {
      ...this.scanSummary(projectId),
      result: pending ? {
        scannedAt: pending.scannedAt, dirs: pending.dirs, stats: pending.stats, total: Object.keys(pending.inventory).length,
        added: items(pending.diff.added), changed: items(pending.diff.changed), gone: items(pending.diff.gone),
      } : null,
      total: Object.keys((pending || state.applied)?.inventory || {}).length,
    };
  }

  // Lance un scan (un seul à la fois par projet). Le diff est prêt dès la fin de la phase « scan »; les fiches suivent.
  startScan(projectId, context) {
    if (!this.scanStore) throw new Error("Scanner indisponible.");
    const current = this.scanJobs.get(projectId);
    if (current && !current.done) return current;
    const state = this.scanStore.project(projectId);
    const job = { phase: "scan", progress: "lecture des dossiers", done: false };
    job.promise = this.runScan(projectId, context, job)
      .then(() => { state.lastError = null; })
      .catch((error) => { state.lastError = error.message; })
      .finally(() => { job.done = true; this.invalidate(); return this.scanStore.save(); });
    this.scanJobs.set(projectId, job);
    return job;
  }

  async runScan(projectId, context, job) {
    const state = this.scanStore.project(projectId);
    const dirs = this.dirOwners().dirs(projectId).map((dir) => path.join(this.workspaceRoot, dir));
    const live = await this.build({ ...context, projectId, span: WINDOWS["24h"], window: "24h", withScan: false });
    const unitIds = new Set(live.nodes.flatMap((node) => [node.meta.unit, node.meta.service]).filter(Boolean));
    const envFiles = (await this.systemdUnits()).filter((unit) => unitIds.has(unit.Id)).flatMap((unit) => unit.envFiles || []);
    job.progress = `${dirs.length} dossier(s), ${envFiles.length} fichier(s) d'environnement`;
    const { providers, stats } = await scanDirs(dirs, { extraEnvFiles: [...new Set(envFiles)], providers: await this.scanStore.providers() });

    const inventory = {};
    const byId = new Map(live.nodes.map((node) => [node.id, node]));
    for (const node of live.nodes) {
      if (node.type === "agent" || node.type === "founder") continue;
      const meta = node.meta;
      inventory[node.id] = { label: node.label, type: node.type, zone: node.zone, hash: hash(JSON.stringify([node.label, meta.schedule, meta.calendar, meta.script, meta.command, meta.what, meta.keys, meta.cost, meta.lifecycle])) };
    }
    // Crons distants illisibles (tunnel prod coupé): on garde ceux du dernier scan plutôt que de les déclarer disparus.
    const previous = state.applied?.inventory || {};
    for (const [id, item] of Object.entries(previous)) {
      const module = /^ext:([^:]+):/.exec(id)?.[1];
      if (item.type === "cron" && module && !item.gone && !inventory[id] && !live.nodes.some((node) => node.type === "cron" && node.id.startsWith(`ext:${module}:`))) inventory[id] = { ...item };
    }
    for (const provider of Object.values(providers)) {
      const id = `api:${provider.slug}`;
      inventory[id] = inventory[id] ? { ...inventory[id], hash: hash(inventory[id].hash + provider.hash) } : { label: provider.label, type: "api", zone: "external", hash: provider.hash };
    }

    // Fiches à rédiger: tout ce qui n'a pas de description écrite à la main, clé = preuves (cache par hash).
    const queue = [];
    const rel = (file) => this.relPath(file);
    const want = (id, label, type, evidence) => {
      const key = hash(JSON.stringify([id, evidence]));
      inventory[id].sheet = key;
      if (!this.scanStore.state.sheets[key]) queue.push({ key, id, label, type, evidence });
      return key;
    };
    for (const provider of Object.values(providers)) {
      const id = `api:${provider.slug}`;
      if (byId.get(id)?.meta.whatSource === "carte") continue;
      provider.sheet = want(id, provider.label, "service externe / API", [
        provider.hosts.length ? `hôtes appelés: ${provider.hosts.slice(0, 6).join(", ")}` : null,
        provider.keys.length ? `noms de clés: ${provider.keys.slice(0, 10).map((key) => key.name).join(", ")}` : null,
        provider.sdks.length ? `paquets: ${provider.sdks.map((sdk) => sdk.name).join(", ")}` : null,
        `fichiers: ${provider.files.slice(0, 8).map(rel).join(", ")}${provider.fileCount > 8 ? ` (+${provider.fileCount - 8})` : ""}`,
      ].filter(Boolean));
    }
    for (const node of live.nodes) {
      if (!["service", "timer", "cron"].includes(node.type) || node.meta.whatSource === "carte") continue;
      const header = node.meta.scriptPath ? await this.scriptHeader(node.meta.scriptPath).catch(() => null) : null;
      want(node.id, node.label, node.type === "cron" ? "tâche cron" : node.type === "timer" ? "tâche planifiée systemd" : "service systemd", [
        node.meta.description ? `description systemd: ${node.meta.description}` : null,
        node.meta.what && node.meta.whatSource !== "description systemd" ? `commentaire: ${node.meta.what}` : null,
        node.meta.scheduleText ? `horaire: ${node.meta.scheduleText}` : null,
        node.meta.command ? `commande: ${clip(redact(node.meta.command), 240)}` : null,
        header ? `en-tête du script: ${clip(redact(header), 600)}` : null,
      ].filter(Boolean));
    }

    const diff = diffInventories(state.applied?.inventory || {}, inventory);
    const pending = { scannedAt: new Date(this.now()).toISOString(), dirs: dirs.map(rel), stats, providers, inventory, diff };
    state.lastRunAt = pending.scannedAt;
    // Rien de neuf: le scan remplace directement l'état appliqué (hashes à jour), pas de pastille.
    if (state.applied && !diff.added.length && !diff.changed.length && !diff.gone.length) {
      state.applied = this.mergeApplied(state.applied, pending);
      state.pending = null;
    } else state.pending = pending;
    await this.scanStore.save();
    this.invalidate();

    if (!this.llm || !queue.length) return;
    job.phase = "fiches";
    const batch = queue.slice(0, MAX_SHEETS_PER_SCAN);
    let done = 0;
    for (let index = 0; index < batch.length; index += SHEET_BATCH) {
      job.progress = `${done}/${batch.length} fiches rédigées`;
      const chunk = batch.slice(index, index + SHEET_BATCH);
      try {
        const answer = await this.llm(sheetPrompt(chunk));
        for (const item of Array.isArray(answer?.items) ? answer.items : []) {
          const target = chunk.find((entry) => entry.id === item?.id);
          const what = clip(cleanText(item?.what), 600);
          if (!target || !what) continue;
          this.scanStore.state.sheets[target.key] = { what, usedIn: (Array.isArray(item.usedIn) ? item.usedIn : []).map((value) => clip(cleanText(value), 120)).filter(Boolean).slice(0, 5), at: new Date(this.now()).toISOString() };
          done += 1;
        }
      } catch (error) {
        job.progress = `fiches: ${clip(error.message, 120)}`;
      }
      await this.scanStore.save();
      this.invalidate();
    }
  }

  mergeApplied(previous, pending) {
    const inventory = { ...pending.inventory };
    const providers = { ...pending.providers };
    for (const [id, item] of Object.entries(previous?.inventory || {})) if (!inventory[id]) inventory[id] = { ...item, gone: true };
    for (const [slug, provider] of Object.entries(previous?.providers || {})) if (!providers[slug]) providers[slug] = { ...provider, gone: true };
    return { scannedAt: pending.scannedAt, dirs: pending.dirs, stats: pending.stats, providers, inventory };
  }

  async applyScan(projectId) {
    const state = this.scanStore.project(projectId);
    if (!state.pending) throw Object.assign(new Error("Aucun scan à appliquer."), { statusCode: 409 });
    state.applied = this.mergeApplied(state.applied, state.pending);
    state.pending = null;
    await this.scanStore.save();
    this.invalidate();
    return this.scanStatus(projectId);
  }

  async setOverride(projectId, nodeId, fields) {
    const fix = {};
    if (typeof fields.what === "string") fix.what = clip(cleanText(fields.what), 800);
    if (fields.cost !== undefined) fix.cost = COSTS[fields.cost] ? fields.cost : null;
    if (typeof fields.costNote === "string") fix.costNote = clip(cleanText(fields.costNote), 200);
    if (fields.lifecycle !== undefined) fix.lifecycle = [...LIFECYCLES, "plus détecté"].includes(fields.lifecycle) ? fields.lifecycle : null;
    const all = (this.scanStore.overrides[projectId] ||= {});
    const next = { ...(all[nodeId] || {}), ...fix, updatedAt: new Date(this.now()).toISOString() };
    for (const key of Object.keys(next)) if (next[key] === null || next[key] === "") delete next[key];
    if (Object.keys(next).length <= 1) delete all[nodeId];
    else all[nodeId] = next;
    await this.scanStore.save();
    this.invalidate();
    return all[nodeId] || null;
  }

  // Dossier du workspace → projet propriétaire (votes: agents par cwd, modules par racine).
  dirOwners() {
    const dirVotes = new Map();
    const vote = (dir, id, weight) => {
      if (!dir) return;
      const votes = dirVotes.get(dir) || new Map();
      votes.set(id, (votes.get(id) || 0) + weight);
      dirVotes.set(dir, votes);
    };
    for (const metadata of Object.values(this.store.all())) if (metadata.projectId) vote(topDir(metadata.cwd, this.workspaceRoot), metadata.projectId, 1);
    // Noyau héberge des manifests d'autres projets: son dossier ne vote pas pour eux.
    for (const module of Object.values(this.moduleService.store.all())) {
      const dir = topDir(module.projectRoot, this.workspaceRoot);
      if (dir && dir !== this.noyauDir) vote(dir, module.projectId, 10);
    }
    const owner = (dir) => {
      const votes = dirVotes.get(dir);
      return votes ? [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
    };
    owner.dirs = (projectId) => [...dirVotes.keys()].filter((dir) => owner(dir) === projectId);
    return owner;
  }

  invalidate() {
    this.snapshots.clear();
    this.exchangeCache?.clear();
  }

  async snapshot({ projectId, window = "24h", visibleProjects, sessionVisible }) {
    const span = WINDOWS[window] || WINDOWS["24h"];
    const key = `${projectId}:${window}:${Object.keys(visibleProjects).sort().join(",")}`;
    const cached = this.snapshots.get(key);
    if (cached && this.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value;
    const value = await this.build({ projectId, span, window, visibleProjects, sessionVisible });
    this.snapshots.set(key, { at: this.now(), value });
    return value;
  }

  // Léger, sans services ni journaux: la vue live le relit toutes les quelques secondes.
  // projectId null = tous les projets visibles, agents sans projet compris.
  async exchanges({ projectId = null, window = "24h", visibleProjects, sessionVisible, agentId = null }) {
    const since = this.now() - (WINDOWS[window] || WINDOWS["24h"]);
    const key = `${projectId}:${window}:${Object.keys(visibleProjects).sort().join(",")}`;
    const cached = this.exchangeCache?.get(key);
    let list = cached && this.now() - cached.at < EXCHANGE_TTL_MS ? cached.value : null;
    if (!list) {
      const inScope = (id) => (projectId ? id === projectId : !id || Boolean(visibleProjects[id]));
      const agents = Object.entries(this.store.all())
        .filter(([id, metadata]) => inScope(metadata.projectId) && sessionVisible(id) && metadata.assistant !== "shell")
        .map(([id, metadata]) => ({ id, ...metadata }));
      for (const entry of await this.archives.list().catch(() => [])) {
        if (!inScope(entry.projectId) || (!entry.projectId && !projectId) || agents.some((agent) => agent.id === entry.id)) continue;
        if (this.now() - Date.parse(entry.archivedAt || 0) <= ARCHIVE_RECENT_MS) agents.push({ ...entry, archived: true });
      }
      const idByName = new Map();
      for (const [id, metadata] of Object.entries(this.store.all())) if (metadata.name && sessionVisible(id)) idByName.set(metadata.name, id);
      list = [];
      for (const agent of agents) {
        const file = await this.transcriptFile(agent);
        if (!file) continue;
        const events = conversationEvents(await this.transcriptEntries(file, agent.assistant), { creator: creatorOf(agent.description), since });
        events.forEach((event, index) => {
          if (event.direction !== "in" || event.kind !== "agent" || !event.at) return;
          const next = events[index + 1];
          list.push({
            id: `${event.at}:${agent.id}`, at: new Date(event.at).toISOString(),
            from: event.from, fromId: idByName.get(event.from) || null,
            to: agent.name || agent.id, toId: agent.id, toArchived: Boolean(agent.archived), projectId: agent.projectId || null,
            text: clip(redact(event.text), EXCHANGE_TEXT_CHARS),
            reply: next?.direction === "out" ? clip(redact(next.text), EXCHANGE_TEXT_CHARS) : null,
          });
        });
      }
      for (const agent of agents) {
        for (const item of agent.transcriptPath && this.subagents ? await this.subagents(agent) : []) {
          const at = item.startedAt || item.updatedAt;
          if (Date.parse(item.updatedAt) < since) continue;
          list.push({
            id: `sub:${item.id}`, at, kind: "subagent", running: item.running,
            from: agent.name || agent.id, fromId: agent.id,
            to: item.description || item.type || item.id, toId: null, toArchived: true, projectId: agent.projectId || null,
            text: clip(redact(item.prompt), EXCHANGE_TEXT_CHARS),
            reply: item.running ? null : clip(redact(item.lastText), EXCHANGE_TEXT_CHARS) || null,
          });
        }
      }
      list.sort((a, b) => a.at.localeCompare(b.at));
      list = list.slice(-EXCHANGE_LIMIT);
      (this.exchangeCache ||= new Map()).set(key, { at: this.now(), value: list });
    }
    return agentId ? list.filter((item) => item.fromId === agentId || item.toId === agentId) : list;
  }

  async build({ projectId, span, window, visibleProjects, sessionVisible, withScan = true }) {
    const now = this.now();
    const since = now - span;
    const project = visibleProjects[projectId];
    if (!project) throw new Error("Projet introuvable.");
    const nodes = new Map();
    const links = new Map();
    const chats = new Map();
    const addNode = (node) => {
      const existing = nodes.get(node.id);
      if (existing) return existing;
      const created = { activity: 0, zone: "infra", status: "ok", meta: {}, ...node };
      nodes.set(node.id, created);
      return created;
    };
    // Service lancé par un seul timer: un seul nœud (le timer) porte horaire, script et dernier résultat.
    const unitAlias = new Map();
    const addLink = (rawSource, rawTarget, kind, { at = null, count = 1, label = null } = {}) => {
      const source = unitAlias.get(rawSource) || rawSource;
      const target = unitAlias.get(rawTarget) || rawTarget;
      if (!source || !target || source === target) return;
      const id = `${source}>${target}>${kind}`;
      const link = links.get(id) || { id, source, target, kind, count: 0, lastAt: null, label };
      link.count += count;
      if (at && (!link.lastAt || at > Date.parse(link.lastAt))) link.lastAt = new Date(at).toISOString();
      links.set(id, link);
    };

    addNode({ id: "founder", type: "founder", label: "Fondateur", zone: "agents", status: "ok" });

    // Agents: registre (actifs + en pause) puis archivés récents.
    const live = new Map((await this.tmux.list().catch(() => [])).map((session) => [session.id, session]));
    const agents = [];
    for (const [id, metadata] of Object.entries(this.store.all())) {
      if (metadata.projectId !== projectId || !sessionVisible(id) || metadata.assistant === "shell") continue;
      agents.push({ id, ...metadata, running: live.has(id), session: live.get(id) || null, archived: false });
    }
    for (const entry of await this.archives.list().catch(() => [])) {
      if (entry.projectId !== projectId || !visibleProjects[entry.projectId] || agents.some((agent) => agent.id === entry.id)) continue;
      if (now - Date.parse(entry.archivedAt || 0) > ARCHIVE_RECENT_MS) continue;
      agents.push({ ...entry, running: false, archived: true });
    }
    const byName = new Map();
    for (const agent of agents) {
      const state = agent.running ? await this.agentState(agent.session, agent) : null;
      const status = agent.archived ? "stop" : !agent.running ? "stop" : state === "working" ? "run" : "ok";
      addNode({
        id: `agent:${agent.id}`, type: "agent", label: agent.name || agent.id, zone: "agents", status,
        archived: agent.archived, paused: !agent.running && !agent.archived, sessionId: agent.id,
        meta: { what: clip(String(agent.description || "").replace(/^Créé par [^:]+ : /, ""), 240) || null, cost: "subscription", costNote: `abonnement ${ASSISTANT_COST[agent.assistant] || agent.assistant || "assistant"}`, lifecycle: agent.archived ? "archivé" : agent.running ? "actif" : "en pause", manage: "Noyau · barre latérale du projet",
          assistant: agent.assistant || null, createdAt: agent.createdAt || null, archivedAt: agent.archivedAt || null, state: state || (agent.running ? "available" : agent.archived ? "archived" : "paused"), canMessage: agent.running && !agent.archived, cwdProject: topDir(agent.cwd, this.workspaceRoot) },
      });
      if (!byName.has(agent.name) || !agent.archived) byName.set(agent.name, `agent:${agent.id}`);
    }
    const resolveAgent = (name) => {
      if (!name) return null;
      if (byName.has(name)) return byName.get(name);
      for (const [id, metadata] of Object.entries(this.store.all())) {
        if (metadata.name === name && visibleProjects[metadata.projectId]) {
          const foreign = metadata.projectId !== projectId ? visibleProjects[metadata.projectId]?.name : null;
          addNode({ id: `agent:${id}`, type: "agent", label: name, zone: "agents", status: "ok", foreign, sessionId: id, meta: { assistant: metadata.assistant || null, foreign, canMessage: false } });
          byName.set(name, `agent:${id}`);
          return `agent:${id}`;
        }
      }
      const ghost = `agent:~${slug(name)}`;
      addNode({ id: ghost, type: "agent", label: name, zone: "agents", status: "stop", archived: true, meta: { state: "archived", canMessage: false } });
      byName.set(name, ghost);
      return ghost;
    };

    // Messages: transcripts des agents du projet, fenêtre de temps.
    for (const agent of agents) {
      const nodeId = `agent:${agent.id}`;
      const creator = creatorOf(agent.description);
      if (creator) addLink(resolveAgent(creator.name), nodeId, "created", { at: Date.parse(agent.createdAt || "") || null });
      const file = await this.transcriptFile(agent);
      if (!file) continue;
      const working = nodes.get(nodeId)?.status === "run";
      const events = conversationEvents(await this.transcriptEntries(file, agent.assistant), { creator, since, working });
      const list = chats.get(nodeId) || [];
      for (const event of events) {
        if (event.direction === "in" && event.kind === "incident") {
          nodes.get(nodeId).activity += 1;
        } else if (event.direction === "in") {
          const source = event.kind === "founder" ? "founder" : resolveAgent(event.from);
          addLink(source, nodeId, event.kind === "founder" ? "founder" : "message", { at: event.at });
          nodes.get(nodeId).activity += 1;
          if (nodes.has(source)) nodes.get(source).activity += 1;
          if (source !== "founder" && source !== nodeId) {
            const sent = chats.get(source) || [];
            sent.push({ ...event, direction: "out", kind: "sent", to: nodes.get(nodeId).label });
            chats.set(source, sent);
          }
        } else nodes.get(nodeId).activity += 0.5;
        list.push(event);
      }
      chats.set(nodeId, list);
    }

    // Modules + déclarations « map ».
    const maps = await this.manifestMaps(projectId);
    const declaredUnits = new Map();
    const localIds = new Map();
    for (const { module, map } of maps) {
      if (module.removed) continue;
      const moduleNode = addNode({
        id: `module:${module.moduleId}`, type: "module", label: module.name, zone: map?.zone || (DIFFUSION_UNIT.test(module.moduleId) ? "diffusion" : /prod/i.test(module.executionHost || "") ? "prod" : "infra"),
        status: "ok", glyph: module.glyph, accent: module.accent,
        meta: { what: module.description, whatSource: "manifest du module", environment: module.environmentOverride || module.environment || "development", host: module.executionHost || null, units: module.controlUnits || [], owner: "Module Noyau" },
      });
      for (const unit of module.controlUnits || []) declaredUnits.set(unit, { ...(declaredUnits.get(unit) || {}), module: moduleNode.id });
      for (const schedule of module.planning || []) if (schedule.unit) declaredUnits.set(schedule.unit, { ...(declaredUnits.get(schedule.unit) || {}), module: declaredUnits.get(schedule.unit)?.module || moduleNode.id });
      if (!map) continue;
      // Les infos « map.units » décrivent une unité sans en faire une unité pilotée par ce module.
      for (const [unit, config] of Object.entries(map.units)) declaredUnits.set(unit, { ...(declaredUnits.get(unit) || {}), ...config, module: declaredUnits.get(unit)?.module || null });
      let status = null;
      if (map.statusAction) status = await this.moduleStatus(module, map.statusAction).catch(() => null);
      if (status) {
        moduleNode.meta.reachable = status.reachable;
        if (status.maintenance) moduleNode.meta.maintenance = status.maintenance;
        if (!status.reachable) moduleNode.status = "unknown";
      } else if (map.statusAction) moduleNode.status = "unknown";
      for (const node of map.nodes) {
        const id = node.type === "api" ? `api:${node.id}` : `ext:${module.moduleId}:${node.id}`;
        localIds.set(`${module.moduleId}:${node.id}`, id);
        const keyed = node.statusKey && status?.reachable ? status.keys[node.statusKey] : null;
        addNode({
          id, type: node.type === "bot" ? "service" : node.type, role: node.type === "bot" ? "bot" : null, label: node.label,
          zone: node.zone || map.zone || (node.type === "api" ? "external" : "prod"),
          status: node.statusKey ? (keyed || "unknown") : "ok",
          meta: { schedule: node.schedule, host: node.host, what: node.desc, whatSource: node.desc ? "carte" : null, verify: node.verify, produces: node.produces, dependsOn: node.dependsOn, owner: node.owner || module.name, declared: true, statusSource: node.statusKey ? module.name : null, usedIn: node.usedIn, keys: node.keys, cost: node.cost, costNote: node.costNote, quota: node.quota, lifecycle: node.lifecycle || "actif", manage: node.manage },
        });
        if (node.type !== "api") addLink(moduleNode.id, id, "declares");
      }
      // Crons distants lus par une action « crons » (crontab commentée, valeurs sensibles masquées côté serveur).
      if (map.crons) {
        const listing = await this.actionOutput(module, map.crons.action, CRON_LIST_TTL_MS).catch(() => null);
        const cronState = map.crons.statusKey && status?.reachable ? status.keys[map.crons.statusKey] || "unknown" : "unknown";
        for (const entry of parseCronListing(listing || "")) {
          const extra = map.crons.entries[entry.id] || {};
          const id = `ext:${module.moduleId}:${entry.id}`;
          localIds.set(`${module.moduleId}:${entry.id}`, id);
          const utc = map.crons.timezone === "UTC";
          addNode({
            id, type: "cron", label: extra.label || cronLabel(entry),
            zone: map.crons.zone || map.zone || "prod", status: cronState,
            meta: {
              host: map.crons.host, user: entry.user, schedule: entry.schedule, scheduleText: describeCron(entry.schedule, { timezone: utc ? "UTC" : "" }),
              nextRun: nextCronRun(entry.schedule, { from: new Date(now), utc }), command: entry.command, script: entry.script,
              what: extra.desc || entry.comment || null, whatSource: extra.desc ? "carte" : entry.comment ? "commentaire crontab" : null, note: extra.desc && entry.comment ? entry.comment : null,
              verify: extra.verify || false, produces: extra.produces || [], dependsOn: extra.dependsOn || [], owner: extra.owner || module.name,
              usedIn: extra.usedIn || [], keys: extra.keys?.length ? extra.keys : map.crons.defaultKeys, cost: extra.cost || null, costNote: extra.costNote || null, quota: extra.quota || null, lifecycle: extra.lifecycle || "actif", manage: extra.manage || `crontab ${entry.user || ""} (infra/crontab, deploy-prod)`.trim(),
              statusSource: map.crons.statusKey ? `${module.name} (santé des crons)` : null,
            },
          });
          addLink(moduleNode.id, id, "declares");
        }
      }
    }

    // Unités systemd rattachées au projet (dossier) ou déclarées par un manifest/une carte.
    const dirOwner = this.dirOwners();
    const referencedUnits = new Set(maps.flatMap(({ map }) => (map?.links || []).flatMap((link) => [link.source, link.target])).filter((ref) => ref.startsWith("unit:")).map((ref) => ref.slice(5)));
    const units = await this.systemdUnits();
    const unitsById = new Map(units.map((unit) => [unit.Id, unit]));
    for (const unit of units) for (const triggered of String(unit.Triggers || "").split(/\s+/).filter(Boolean)) if (unitsById.has(triggered)) unitsById.get(triggered).triggeredBy = unit.Id;
    const unitDir = (unit) => {
      const argv = execArgv(unit.ExecStart);
      return topDir(unit.WorkingDirectory, this.workspaceRoot) || argv.map((token) => topDir(token, this.workspaceRoot)).find(Boolean) || null;
    };
    const included = new Set();
    for (const unit of units) {
      const own = dirOwner(unitDir(unit));
      if (own === projectId || declaredUnits.has(unit.Id) || referencedUnits.has(unit.Id)) included.add(unit.Id);
    }
    for (const id of [...included]) {
      const unit = unitsById.get(id);
      for (const triggered of String(unit?.Triggers || "").split(/\s+/).filter(Boolean)) if (unitsById.has(triggered)) included.add(triggered);
      if (unit?.triggeredBy) included.add(unit.triggeredBy);
    }
    for (const id of included) {
      const targets = id.endsWith(".timer") ? String(unitsById.get(id)?.Triggers || "").split(/\s+/).filter(Boolean) : [];
      if (targets.length === 1 && included.has(targets[0]) && unitsById.get(targets[0])?.triggeredBy === id) unitAlias.set(`unit:${targets[0]}`, `unit:${id}`);
    }
    for (const id of included) {
      const unit = unitsById.get(id);
      if (!unit || unitAlias.has(`unit:${id}`)) continue;
      const isTimer = id.endsWith(".timer");
      const triggered = isTimer ? unitsById.get(String(unit.Triggers || "").split(/\s+/)[0]) : null;
      const declared = { ...(triggered ? declaredUnits.get(triggered.Id) : {}), ...(declaredUnits.get(id) || {}) };
      const shared = dirOwner(unitDir(unit)) !== projectId && !declared.module;
      const name = id.replace(/\.(service|timer)$/, "");
      const source = triggered || unit;
      const startedAt = systemdTime(source.ExecMainStartTimestamp);
      const exitedAt = systemdTime(source.ExecMainExitTimestamp);
      const argv = execArgv(source.ExecStart);
      const scriptToken = argv.slice(0, 8).find((token) => SCRIPT_FILE.test(token) && !token.includes("="));
      const scriptPath = scriptToken ? path.resolve(source.WorkingDirectory && !path.isAbsolute(scriptToken) ? source.WorkingDirectory : "/", scriptToken) : null;
      const ownerModule = declared.module ? nodes.get(declared.module)?.label : null;
      addNode({
        id: `unit:${id}`, type: isTimer ? "timer" : "service", role: declared.role || null, label: declared.label || name,
        zone: declared.zone || (shared ? "infra" : DIFFUSION_UNIT.test(name) ? "diffusion" : "infra"),
        status: unitStatus(unit, triggered), shared,
        meta: {
          unit: id, service: triggered?.Id || null, scope: unit.scope, description: clip(unit.Description, 160), active: unit.ActiveState, sub: unit.SubState,
          what: declared.desc || clip(source.Description || unit.Description, 200) || null, whatSource: declared.desc ? "carte" : "description systemd", verify: declared.verify || false,
          produces: declared.produces || [], dependsOn: declared.dependsOn || [], owner: declared.owner || ownerModule || null,
          usedIn: declared.usedIn || [], keys: declared.keys || [], cost: declared.cost || null, costNote: declared.costNote || null, quota: declared.quota || null, lifecycle: declared.lifecycle || (unit.ActiveState === "active" || unit.triggeredBy ? "actif" : "arrêté"), manage: declared.manage || (ownerModule ? `Noyau · module ${ownerModule}` : "systemctl --user"),
          result: source.Result || null, exitStatus: source.ExecMainStatus ?? null,
          lastRun: startedAt || systemdTime(unit.LastTriggerUSec), lastExit: exitedAt,
          durationMs: startedAt && exitedAt && Date.parse(exitedAt) >= Date.parse(startedAt) ? Date.parse(exitedAt) - Date.parse(startedAt) : null,
          nextRun: isTimer ? systemdTime(unit.NextElapseUSecRealtime) : null,
          calendar: isTimer ? clip(unit.calendars.join(" · "), 120) || null : null,
          scheduleText: isTimer ? describeCalendar(unit.calendars, { now: new Date(now) }) : unit.triggeredBy ? null : unit.ActiveState === "active" ? "service permanent" : null,
          script: scriptName(argv), scriptPath: scriptPath && topDir(scriptPath, this.workspaceRoot) ? scriptPath : null,
          command: clip(redact(argv.join(" ")), 400) || null, workingDirectory: source.WorkingDirectory || null,
        },
      });
      if (isTimer) for (const target of String(unit.Triggers || "").split(/\s+/).filter(Boolean)) if (included.has(target)) addLink(`unit:${id}`, `unit:${target}`, "triggers");
      if (declared.module && !isTimer && !unit.triggeredBy) addLink(declared.module, `unit:${id}`, "controls");
      if (declared.module && isTimer) addLink(declared.module, `unit:${id}`, "controls");
    }

    // Crontab locale: horaire + nom de script seulement.
    for (const job of await this.crontab()) {
      const own = job.paths.map((token) => topDir(token.replace(/^~/, path.dirname(this.workspaceRoot)), this.workspaceRoot)).find(Boolean);
      if (dirOwner(own) !== projectId) continue;
      addNode({ id: `cron:${job.id}`, type: "cron", label: job.script || "tâche cron", zone: "infra", status: "unknown", meta: { schedule: job.schedule, scheduleText: describeCron(job.schedule, { timezone: "" }), nextRun: nextCronRun(job.schedule, { from: new Date(now), utc: false }), host: "Ce PC", script: job.script, what: null } });
    }

    // APIs et services externes déclarés (clé « apis »): présents même sans lien, avec leur fiche.
    const apiLabel = (name) => API_LABELS[name] || name.replace(/(^|-)\w/g, (part) => part.toUpperCase()).replace(/-/g, " ");
    for (const { module, map } of maps) {
      if (!map || module.removed) continue;
      for (const [name, info] of Object.entries(map.apis || {})) {
        const lifecycle = info.lifecycle || "actif";
        addNode({
          id: `api:${name}`, type: "api", label: info.label || apiLabel(name), zone: "external",
          status: lifecycle === "obsolète ?" ? "unknown" : lifecycle === "en pause" || lifecycle === "non utilisé" ? "stop" : "ok", declared: true,
          meta: { what: info.desc, whatSource: info.desc ? "carte" : null, usedIn: info.usedIn, keys: info.keys, cost: info.cost || "unknown", costNote: info.costNote, quota: info.quota, lifecycle, manage: info.manage, verify: info.verify, produces: info.produces, dependsOn: info.dependsOn },
        });
      }
    }

    // Liens déclarés (cron → script → service/API).
    for (const { module, map } of maps) {
      if (!map || module.removed) continue;
      const resolve = (ref) => {
        if (ref.startsWith("local:")) return localIds.get(`${module.moduleId}:${ref.slice(6)}`) || null;
        if (ref.startsWith("unit:")) return nodes.has(unitAlias.get(ref) || ref) ? unitAlias.get(ref) || ref : null;
        if (ref.startsWith("api:")) {
          const name = ref.slice(4);
          return addNode({ id: ref, type: "api", label: apiLabel(name), zone: "external", status: "ok", meta: { cost: "unknown", lifecycle: "actif" } }).id;
        }
        if (ref.startsWith("module:")) return nodes.has(ref) ? ref : null;
        if (ref.startsWith("agent:")) return resolveAgent(ref.slice(6));
        return null;
      };
      for (const link of map.links) addLink(resolve(link.source), resolve(link.target), "calls", { label: link.label });
    }

    // Scan appliqué (bouton Explorer): fournisseurs détectés, fiches rédigées, nœuds plus détectés grisés.
    const scanState = withScan && this.scanStore ? this.scanStore.project(projectId) : null;
    const applied = scanState?.applied || null;
    if (applied) {
      const sheets = this.scanStore.state.sheets;
      const rel = (file) => this.relPath(file);
      const roots = new Set([this.workspaceRoot, ...dirOwner.dirs(projectId).map((dir) => path.join(this.workspaceRoot, dir))]);
      const scopes = [...nodes.values()].filter((node) => ["service", "timer", "cron"].includes(node.type)).map((node) => {
        const scope = node.meta.scriptPath ? path.dirname(node.meta.scriptPath) : node.meta.workingDirectory;
        return { id: node.id, scope: scope && !roots.has(scope) ? scope : null, tail: scriptTail(node.meta.script) };
      });
      // Code à la racine du projet (ex. appli web): rattaché au service permanent lancé depuis cette racine.
      const rootServices = [...nodes.values()].filter((node) => node.type === "service" && !node.meta.service && node.meta.scheduleText === "service permanent" && roots.has(node.meta.workingDirectory)).map((node) => ({ id: node.id, root: node.meta.workingDirectory }));
      for (const provider of Object.values(applied.providers || {})) {
        const id = `api:${provider.slug}`;
        const sheet = sheets[provider.sheet] || null;
        const detected = { hosts: provider.hosts.slice(0, 8), sdks: provider.sdks.map((sdk) => sdk.name), files: provider.fileCount, scannedAt: applied.scannedAt, gone: Boolean(provider.gone) };
        const existing = nodes.get(id);
        if (existing) {
          existing.meta.detected = detected;
          if (!existing.meta.keys?.length && provider.keys.length) existing.meta.keys = keyLines(provider.keys, rel);
          if (!existing.meta.usedIn?.length) existing.meta.usedIn = sheet?.usedIn?.length ? sheet.usedIn : provider.files.slice(0, 6).map(rel);
          if (!existing.meta.what && sheet?.what) Object.assign(existing.meta, { what: sheet.what, whatSource: "rédigé automatiquement depuis le scan (à relire)" });
        } else {
          addNode({
            id, type: "api", label: provider.label, zone: "external", status: provider.gone ? "stop" : "ok", declared: true, scanned: true, gone: Boolean(provider.gone),
            meta: {
              what: sheet?.what || `Détecté dans le code${provider.hosts.length ? ` (${provider.hosts.slice(0, 3).join(", ")})` : provider.sdks.length ? ` (paquet ${provider.sdks[0].name})` : ""}.`,
              whatSource: sheet?.what ? "rédigé automatiquement depuis le scan (à relire)" : "scan",
              usedIn: sheet?.usedIn?.length ? sheet.usedIn : provider.files.slice(0, 6).map(rel), keys: keyLines(provider.keys, rel),
              cost: provider.cost || "unknown", lifecycle: provider.gone ? "plus détecté" : provider.guessed ? "à confirmer" : "actif", detected,
            },
          });
        }
        if (provider.gone) continue;
        let linked = false;
        for (const file of provider.files) {
          for (const scope of scopes) {
            if ((scope.scope && file.startsWith(`${scope.scope}/`)) || (scope.tail && file.endsWith(scope.tail))) {
              addLink(scope.id, id, "calls", { label: "détecté" });
              linked = true;
            }
          }
        }
        if (!linked) for (const service of rootServices) if (provider.files.some((file) => file.startsWith(`${service.root}/`))) addLink(service.id, id, "calls", { label: "détecté" });
      }
      for (const [rawId, item] of Object.entries(applied.inventory || {})) {
        const node = nodes.get(unitAlias.get(rawId) || rawId);
        const sheet = item.sheet ? sheets[item.sheet] : null;
        if (node && sheet?.what && node.type !== "api" && node.meta.whatSource !== "carte") {
          if (node.meta.what && node.meta.what !== sheet.what) node.meta.note ||= node.meta.what;
          Object.assign(node.meta, { what: sheet.what, whatSource: "rédigé automatiquement depuis le scan (à relire)" });
        }
        if (!node && item.gone && item.type !== "api") {
          addNode({ id: rawId, type: item.type, label: item.label, zone: item.zone || "infra", status: "stop", gone: true, meta: { what: "Plus détecté au dernier scan : gardé grisé, rien n'a été supprimé.", whatSource: "scan", lifecycle: "plus détecté" } });
        }
      }
    }

    // Activité visible: lien, statut et poids pour la taille des nœuds non-agents.
    for (const link of links.values()) {
      for (const end of [link.source, link.target]) {
        const node = nodes.get(end);
        if (node && node.type !== "agent" && node.type !== "founder") node.activity += Math.min(link.count, 4) * 0.5;
      }
      link.live = Boolean(link.lastAt && now - Date.parse(link.lastAt) < LIVE_LINK_MS);
    }
    const connected = new Set([...links.values()].flatMap((link) => [link.source, link.target]));
    for (const node of nodes.values()) if (node.type === "api" && !node.declared && !connected.has(node.id)) nodes.delete(node.id);
    // Corrections du fondateur: priment sur la carte, le scan et les fiches rédigées.
    for (const [nodeId, fix] of Object.entries(this.scanStore?.overrides[projectId] || {})) {
      const node = nodes.get(nodeId);
      if (!node) continue;
      if (fix.what) Object.assign(node.meta, { what: fix.what, whatSource: "corrigé par le fondateur" });
      if (fix.cost) node.meta.cost = fix.cost;
      if (fix.costNote !== undefined) node.meta.costNote = fix.costNote || null;
      if (fix.lifecycle) {
        node.meta.lifecycle = fix.lifecycle;
        if (node.type === "api") node.status = fix.lifecycle === "obsolète ?" ? "unknown" : ["en pause", "non utilisé", "plus détecté"].includes(fix.lifecycle) ? "stop" : "ok";
      }
      node.meta.corrected = fix.updatedAt || true;
    }
    // Payant: déclaré sur l'API, ou hérité des APIs payantes qu'un cron/service appelle.
    for (const node of nodes.values()) if (node.type === "api") node.paid = PAID.has(node.meta.cost);
    for (const link of links.values()) {
      const target = nodes.get(link.target);
      const source = nodes.get(link.source);
      if (link.kind !== "calls" || !target?.paid || !source || source.type === "api") continue;
      source.meta.paidVia = [...new Set([...(source.meta.paidVia || []), target.label])];
    }
    for (const node of nodes.values()) {
      if (node.type !== "api" && node.type !== "agent" && PAID.has(node.meta.cost)) node.paid = true;
      if (node.meta.paidVia?.length) node.paidVia = true;
      if (node.meta.cost) node.meta.costLabel = COSTS[node.meta.cost];
    }
    const validLinks = [...links.values()].filter((link) => nodes.has(link.source) && nodes.has(link.target));

    const chatEvents = new Map();
    for (const [nodeId, list] of chats) {
      chatEvents.set(nodeId, list
        .filter((event) => event.at)
        .sort((a, b) => a.at - b.at)
        .slice(-CHAT_LIMIT)
        .map((event) => ({ at: new Date(event.at).toISOString(), direction: event.direction, kind: event.kind, from: event.from, to: event.to || null, text: clip(redact(event.text), CHAT_TEXT_CHARS), ...(event.delegated ? { delegated: true } : {}) })));
    }
    for (const [nodeId, list] of chatEvents) {
      const node = nodes.get(nodeId);
      if (!node) continue;
      node.meta.inbound = list.filter((event) => event.direction === "in").length;
      node.meta.outbound = list.filter((event) => event.direction === "out").length;
      node.meta.lastReplyAt = [...list].reverse().find((event) => event.kind === "reply")?.at || null;
      node.meta.lastMessageAt = list.at(-1)?.at || null;
    }

    const allNodes = [...nodes.values()];
    const runningAgents = allNodes.filter((node) => node.type === "agent" && !node.archived && !node.paused && !node.foreign && node.sessionId && live.has(node.sessionId));
    const services = allNodes.filter((node) => node.type === "service" || node.type === "timer");
    const nextRuns = allNodes.map((node) => node.meta.nextRun ? { at: node.meta.nextRun, label: node.label } : null).filter((item) => item && Date.parse(item.at) > now).sort((a, b) => a.at.localeCompare(b.at));
    return {
      generatedAt: new Date(now).toISOString(),
      scan: scanState ? this.scanSummary(projectId) : null,
      project: { id: projectId, name: project.name },
      window,
      zones: ZONES,
      nodes: allNodes,
      links: validLinks,
      kpis: {
        agents: runningAgents.length,
        working: runningAgents.filter((node) => node.status === "run").length,
        services: services.length,
        errors: services.filter((node) => node.status === "err").length + allNodes.filter((node) => (node.type === "cron" || node.type === "module") && node.status === "err").length,
        nextRun: nextRuns[0] || null,
        messages: validLinks.filter((link) => link.kind === "message" || link.kind === "founder").reduce((sum, link) => sum + link.count, 0),
      },
      chats: chatEvents,
    };
  }

  // Détail à la demande: journal (dernières lignes + erreurs), commentaires d'unité et d'en-tête de script, masqués.
  async journal(unitId, scope, span, { errorsOnly = false, lines = 6 } = {}) {
    if (!/^[\w@.-]+\.(service|timer)$/.test(unitId || "")) return [];
    const target = unitId.endsWith(".timer") ? unitId.replace(/\.timer$/, ".service") : unitId;
    const args = [...(scope === "user" ? ["--user"] : []), "-u", target, ...(errorsOnly ? ["-p", "warning"] : []), "-n", String(lines + 4), "--since", span === "7d" ? "-7d" : "-24h", "-o", "short-iso", "--no-pager", "-q"];
    try {
      const { stdout } = await this.run("/usr/bin/journalctl", args, { timeout: 8000 });
      return stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\S+)\s+\S+\s+[^:]+:\s*(.*)$/);
          return { at: match ? match[1] : null, text: clip(redact(match ? match[2] : line), 240) };
        })
        .filter((entry) => entry.text && !/^(Started|Starting|Finished|Stopped|Stopping|Consumed) /.test(entry.text) && !/: Consumed .* CPU time/.test(entry.text) && !/: Deactivated successfully\.$/.test(entry.text))
        .slice(-lines);
    } catch {
      return [];
    }
  }

  async unitErrors(unitId, scope, span = "24h") {
    return this.journal(unitId, scope, span, { errorsOnly: true, lines: 5 });
  }

  async unitComments(units, scope) {
    const comments = [];
    for (const unit of units.filter((item) => /^[\w@.-]+\.(service|timer)$/.test(item || ""))) {
      try {
        const { stdout } = await this.run("/usr/bin/systemctl", [...(scope === "user" ? ["--user"] : []), "cat", unit, "--no-pager"], { timeout: 5000 });
        for (const line of stdout.split("\n")) {
          const body = line.match(/^\s*[#;]\s?(.*)$/)?.[1]?.trim();
          if (!body || body.startsWith("/") || /(daemon-reload|enable --now|cp to ~|^User unit)/i.test(body)) continue;
          comments.push(clip(redact(body), 220));
        }
      } catch { /* unité absente */ }
    }
    return [...new Set(comments)].slice(0, 8);
  }

  async scriptHeader(file) {
    if (!file || !topDir(file, this.workspaceRoot) || !SCRIPT_FILE.test(file) || /(^|\/)\.env|config/i.test(path.basename(file))) return [];
    try {
      const head = (await readHead(file, 6000)).split("\n").slice(0, 60);
      const lines = [];
      let started = false;
      for (const line of head) {
        const trimmed = line.trim();
        if (!started && (!trimmed || trimmed.startsWith("#!") || trimmed === "<?php" || /^['"]use strict/.test(trimmed))) continue;
        const body = trimmed.match(/^(?:\/\/+|#+|\/\*+|\*+\/?|""")\s?(.*)$/)?.[1];
        if (body === undefined) break;
        started = true;
        const text = body.replace(/\*\/$/, "").replace(/"""$/, "").trim();
        if (text && !/^(@|eslint|-\*-)/.test(text)) lines.push(clip(redact(text), 220));
        if (lines.length >= 8) break;
      }
      return lines;
    } catch {
      return [];
    }
  }

  async nodeDetails(node, span) {
    const meta = node.meta || {};
    if (!meta.unit) return { logs: [], errors: [], comments: [], header: [] };
    const units = [meta.unit, meta.service].filter(Boolean);
    const [logs, errors, comments, header] = await Promise.all([
      this.journal(meta.unit, meta.scope, span, { lines: 5 }),
      this.unitErrors(meta.unit, meta.scope, span),
      this.unitComments(units, meta.scope),
      this.scriptHeader(meta.scriptPath),
    ]);
    return { logs, errors, comments, header };
  }
}
