import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Pages de suivi tenues par les agents: un JSON par tableau dans <dir>/<projet>/<tableau>.json,
// rapports locaux a cote dans <tableau>.files/ (lecture seule cote interface).
export const COLUMNS = ["planned", "inProgress", "waiting", "done"];
export const COLUMN_LABELS = { planned: "Prévu", inProgress: "En cours", waiting: "Décision fondateur", done: "Fait" };
const COLUMN_ALIASES = {
  planned: "planned", prevu: "planned", todo: "planned", plan: "planned",
  inprogress: "inProgress", progress: "inProgress", encours: "inProgress", doing: "inProgress", wip: "inProgress",
  waiting: "waiting", waitingfounder: "waiting", decision: "waiting", attente: "waiting", founder: "waiting",
  done: "done", fait: "done", termine: "done",
};
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const REPORT_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.(html?|pdf|png|jpe?g|webp|gif)$/;
export const REPORT_TYPES = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const MAX_ITEMS = 300;
const MAX_REPORTS = 100;
const MAX_KPIS = 12;
export const MAX_REPORT_BYTES = 10 * 1024 * 1024;

const text = (value, limit) => (typeof value === "string" || typeof value === "number" ? String(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) : "");
const longText = (value, limit) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit) : "");
const newId = () => crypto.randomBytes(3).toString("hex");

export function httpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

export function slugify(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export function columnId(value) {
  const key = String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
  return COLUMN_ALIASES[key] || null;
}

function cleanDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function cleanItem(value, previous = {}) {
  const item = {
    id: previous.id || newId(),
    column: columnId(value.column ?? previous.column) || previous.column || "planned",
    title: value.title !== undefined ? text(value.title, 160) : previous.title,
    date: value.date !== undefined ? cleanDate(value.date) : previous.date || null,
    detail: value.detail !== undefined ? longText(value.detail, 2000) : previous.detail || "",
    link: value.link !== undefined ? httpsUrl(value.link) : previous.link || null,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (previous.decision) item.decision = previous.decision;
  if (!item.title) throw new Error("Titre requis.");
  return item;
}

function cleanKpis(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_KPIS)
    .map((kpi) => ({ label: text(kpi?.label, 60), value: text(kpi?.value, 40), note: text(kpi?.note, 160) }))
    .filter((kpi) => kpi.label);
}

export function normalizeBoard(value, slug) {
  const board = value && typeof value === "object" ? value : {};
  return {
    id: slug,
    title: text(board.title, 100) || slug,
    objective: longText(board.objective, 1000),
    agentId: text(board.agentId, 80) || null,
    agentName: text(board.agentName, 80) || null,
    createdAt: cleanDate(board.createdAt) || new Date().toISOString(),
    updatedAt: cleanDate(board.updatedAt) || null,
    kpis: cleanKpis(board.kpis),
    items: (Array.isArray(board.items) ? board.items : []).filter((item) => item?.id && item?.title && COLUMNS.includes(item.column)).slice(0, MAX_ITEMS),
    reports: (Array.isArray(board.reports) ? board.reports : []).filter((report) => report?.id && report?.title && (report.url || report.file)).slice(0, MAX_REPORTS),
  };
}

export function boardSummary(board) {
  const counts = Object.fromEntries(COLUMNS.map((column) => [column, 0]));
  for (const item of board.items) counts[item.column] += 1;
  return { id: board.id, title: board.title, objective: board.objective, agentId: board.agentId, agentName: board.agentName, updatedAt: board.updatedAt, counts, reports: board.reports.length, kpis: board.kpis.slice(0, 4) };
}

export class TrackingService {
  constructor({ dir }) {
    this.dir = path.resolve(dir);
    this.locks = new Map();
  }

  #projectDir(projectId) {
    if (!PROJECT_ID.test(String(projectId || ""))) throw new Error("Projet invalide.");
    return path.join(this.dir, projectId);
  }

  #file(projectId, slug) {
    if (!SLUG.test(String(slug || ""))) throw new Error("Identifiant de tableau invalide (minuscules, chiffres, tirets).");
    return path.join(this.#projectDir(projectId), `${slug}.json`);
  }

  filesDir(projectId, slug) {
    return this.#file(projectId, slug).replace(/\.json$/, ".files");
  }

  async #read(projectId, slug) {
    const raw = await fs.readFile(this.#file(projectId, slug), "utf8").catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    return raw == null ? null : normalizeBoard(JSON.parse(raw), slug);
  }

  async #write(projectId, board) {
    const file = this.#file(projectId, board.id);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
    return board;
  }

  // Ecritures serialisees par tableau: deux agents ou CLI en parallele ne s'ecrasent pas.
  async #mutate(projectId, slug, change, { create = false } = {}) {
    const key = `${projectId}/${slug}`;
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.locks.set(key, previous.then(() => current));
    await previous;
    try {
      let board = await this.#read(projectId, slug);
      if (!board) {
        if (!create) throw new Error(`Tableau « ${slug} » introuvable.`);
        board = normalizeBoard({}, slug);
      }
      const result = await change(board);
      board.updatedAt = new Date().toISOString();
      await this.#write(projectId, board);
      return result === undefined ? board : result;
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async list(projectId) {
    const dir = this.#projectDir(projectId);
    const names = await fs.readdir(dir).catch(() => []);
    const boards = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const slug = name.slice(0, -5);
      if (!SLUG.test(slug)) continue;
      const board = await this.#read(projectId, slug).catch(() => null);
      if (board) boards.push(board);
    }
    boards.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const waiting = boards.flatMap((board) => board.items.filter((item) => item.column === "waiting").map((item) => ({ ...item, boardId: board.id, boardTitle: board.title, agentId: board.agentId, agentName: board.agentName })));
    waiting.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
    return { boards: boards.map(boardSummary), waiting };
  }

  async get(projectId, slug) {
    const board = await this.#read(projectId, slug);
    if (!board) throw new Error(`Tableau « ${slug} » introuvable.`);
    return board;
  }

  async set(projectId, slug, { title, objective, kpis, agentId, agentName } = {}) {
    return this.#mutate(projectId, slug, (board) => {
      if (title !== undefined) board.title = text(title, 100) || slug;
      if (objective !== undefined) board.objective = longText(objective, 1000);
      if (kpis !== undefined) board.kpis = cleanKpis(kpis);
      if (agentId) board.agentId = text(agentId, 80);
      if (agentName) board.agentName = text(agentName, 80);
    }, { create: true });
  }

  async setKpi(projectId, slug, { label, value, note, remove = false }) {
    const name = text(label, 60);
    if (!name) throw new Error("Libellé KPI requis.");
    return this.#mutate(projectId, slug, (board) => {
      const rest = board.kpis.filter((kpi) => kpi.label.toLowerCase() !== name.toLowerCase());
      const existing = board.kpis.find((kpi) => kpi.label.toLowerCase() === name.toLowerCase());
      if (remove) { board.kpis = rest; return; }
      const kpi = { label: existing?.label || name, value: text(value, 40), note: note !== undefined ? text(note, 160) : existing?.note || "" };
      board.kpis = existing ? board.kpis.map((entry) => (entry === existing ? kpi : entry)) : cleanKpis([...rest, kpi]);
    });
  }

  async addItem(projectId, slug, value, meta = {}) {
    return this.#mutate(projectId, slug, (board) => {
      if (board.items.length >= MAX_ITEMS) throw new Error(`Maximum ${MAX_ITEMS} éléments par tableau.`);
      if (!board.agentId && meta.agentId) { board.agentId = meta.agentId; board.agentName = meta.agentName || null; }
      const item = cleanItem(value);
      board.items.push(item);
      return item;
    }, { create: true });
  }

  #find(board, ref) {
    const key = String(ref || "").replace(/^#/, "").toLowerCase();
    const byId = board.items.find((item) => item.id === key);
    if (byId) return byId;
    const matches = board.items.filter((item) => item.title.toLowerCase().includes(key));
    if (matches.length === 1) return matches[0];
    throw new Error(matches.length ? `Plusieurs éléments correspondent à « ${ref} » : ${matches.map((item) => item.id).join(", ")}.` : `Élément « ${ref} » introuvable.`);
  }

  async updateItem(projectId, slug, ref, value) {
    return this.#mutate(projectId, slug, (board) => {
      const item = this.#find(board, ref);
      const next = cleanItem(value, item);
      if (next.column !== "waiting" && item.column === "waiting" && !value.keepDecision) delete next.decision;
      board.items = board.items.map((entry) => (entry === item ? next : entry));
      return next;
    });
  }

  async removeItem(projectId, slug, ref) {
    return this.#mutate(projectId, slug, (board) => {
      const item = this.#find(board, ref);
      board.items = board.items.filter((entry) => entry !== item);
      return item;
    });
  }

  // Go / Non du fondateur: la decision reste visible sur l'element, qui passe en "En cours" (go) ou "Fait" (non).
  async decide(projectId, slug, ref, { decision, note, by }) {
    if (!["go", "no"].includes(decision)) throw new Error("Décision attendue : go ou no.");
    return this.#mutate(projectId, slug, (board) => {
      const item = this.#find(board, ref);
      if (item.column !== "waiting") throw new Error("Cet élément n'attend pas de décision.");
      item.decision = { value: decision, note: longText(note, 500), by: text(by, 60) || null, at: new Date().toISOString() };
      item.column = decision === "go" ? "inProgress" : "done";
      item.updatedAt = item.decision.at;
      return { item, board: { id: board.id, title: board.title, agentId: board.agentId, agentName: board.agentName } };
    });
  }

  async addReport(projectId, slug, { title, url, date, fileName, content }) {
    const name = text(title, 160);
    if (!name) throw new Error("Titre du rapport requis.");
    const link = url ? httpsUrl(url) : null;
    if (url && !link) throw new Error("Lien de rapport : https uniquement.");
    if (!link && !content) throw new Error("Rapport : lien https ou fichier requis.");
    let stored = null;
    if (content) {
      const base = path.basename(String(fileName || "")).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "");
      if (!REPORT_FILE.test(base)) throw new Error("Fichier de rapport : html, pdf, png, jpg, webp ou gif.");
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "base64");
      if (!buffer.length || buffer.length > MAX_REPORT_BYTES) throw new Error("Fichier de rapport vide ou trop gros (10 Mo max).");
      stored = `${newId()}-${base}`;
      const dir = this.filesDir(projectId, slug);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, stored), buffer, { mode: 0o600 });
    }
    return this.#mutate(projectId, slug, (board) => {
      if (board.reports.length >= MAX_REPORTS) board.reports = board.reports.slice(-(MAX_REPORTS - 1));
      const report = { id: newId(), title: name, url: link, file: stored, date: cleanDate(date) || new Date().toISOString() };
      board.reports.push(report);
      return report;
    }, { create: true });
  }

  async removeReport(projectId, slug, reportId) {
    const removed = await this.#mutate(projectId, slug, (board) => {
      const report = board.reports.find((entry) => entry.id === reportId);
      if (!report) throw new Error("Rapport introuvable.");
      board.reports = board.reports.filter((entry) => entry !== report);
      return report;
    });
    if (removed.file) await fs.rm(path.join(this.filesDir(projectId, slug), removed.file), { force: true });
    return removed;
  }

  async remove(projectId, slug) {
    await this.get(projectId, slug);
    await fs.rm(this.#file(projectId, slug), { force: true });
    await fs.rm(this.filesDir(projectId, slug), { recursive: true, force: true });
  }

  async reportFile(projectId, slug, name) {
    if (!REPORT_FILE.test(String(name || ""))) throw new Error("Fichier introuvable.");
    const file = path.join(this.filesDir(projectId, slug), name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error("Fichier introuvable.");
    return { file, type: REPORT_TYPES[name.split(".").pop().toLowerCase()] };
  }
}
