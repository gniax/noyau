import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Tri des fichiers partagés: un agent met à la corbeille (restaurable 30 j), jamais d'effacement direct.
// Etat par projet dans <dataDir>/project-files-sort/<projet>.json, corbeille dans <dataDir>/project-files-trash/<projet>/.
export const TRASH_DAYS = 30;
export const PROTECTED_HOURS = 48;
const STALE_RUN_MS = 6 * 60 * 60 * 1000;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const TRASH_ID = /^[0-9a-f]{8}$/;
const DAY = 24 * 60 * 60 * 1000;

const text = (value, limit) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "");
const safeName = (name) => {
  const base = path.basename(String(name || ""));
  if (!base || base === "." || base === ".." || base !== String(name)) throw new Error("Nom de fichier invalide.");
  return base;
};

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

const emptyState = () => ({ status: "idle", agentId: null, startedAt: null, finishedAt: null, summary: "", deleted: [], kept: [], founder: {}, trash: [] });

export class FileSortService {
  constructor({ dataDir, now = () => Date.now() } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.filesRoot = path.join(this.dataDir, "project-files");
    this.now = now;
    this.locks = new Map();
  }

  project(projectId) {
    if (!PROJECT_ID.test(String(projectId || ""))) throw new Error("Identifiant de projet invalide.");
    return {
      files: path.join(this.filesRoot, projectId),
      trash: path.join(this.dataDir, "project-files-trash", projectId),
      state: path.join(this.dataDir, "project-files-sort", `${projectId}.json`),
    };
  }

  async read(projectId) {
    const raw = await fs.readFile(this.project(projectId).state, "utf8").then(JSON.parse).catch(() => null);
    return { ...emptyState(), ...(raw && typeof raw === "object" ? raw : {}) };
  }

  // Ecritures serialisees par projet: l'agent enchaine les mises a la corbeille pendant que l'UI interroge.
  mutate(projectId, fn) {
    const previous = this.locks.get(projectId) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const state = await this.read(projectId);
      const result = await fn(state);
      await writeJson(this.project(projectId).state, state);
      return result;
    });
    this.locks.set(projectId, run);
    return run;
  }

  async status(projectId) {
    await this.purge(projectId);
    const state = await this.read(projectId);
    const now = this.now();
    const running = state.status === "running" && now - Date.parse(state.startedAt || 0) < STALE_RUN_MS;
    return {
      status: running ? "running" : state.status === "running" ? "stale" : state.status,
      agentId: state.agentId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      summary: state.summary,
      deleted: state.deleted,
      kept: state.kept,
      freedBytes: state.deleted.reduce((sum, item) => sum + (item.size || 0), 0),
      trash: state.trash.map((item) => ({ ...item, expiresAt: new Date(Date.parse(item.trashedAt) + TRASH_DAYS * DAY).toISOString() })),
    };
  }

  async markFounder(projectId, name) {
    return this.mutate(projectId, (state) => { state.founder[safeName(name)] = new Date(this.now()).toISOString(); });
  }

  async start(projectId, { agentId = null } = {}) {
    return this.mutate(projectId, (state) => {
      if (state.status === "running" && this.now() - Date.parse(state.startedAt || 0) < STALE_RUN_MS) throw new Error("Un tri est déjà en cours.");
      Object.assign(state, { status: "running", agentId, startedAt: new Date(this.now()).toISOString(), finishedAt: null, summary: "", deleted: [], kept: [] });
    });
  }

  async setAgent(projectId, agentId) {
    return this.mutate(projectId, (state) => { state.agentId = agentId; });
  }

  async scan(projectId) {
    const { files: dir } = this.project(projectId);
    const state = await this.read(projectId);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      const ageHours = Math.floor((this.now() - stat.mtimeMs) / 3600000);
      files.push({
        name: entry.name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        ageHours,
        sha256: await sha256(file).catch(() => null),
        founder: Boolean(state.founder[entry.name]),
        protected: ageHours < PROTECTED_HOURS,
      });
    }
    const byHash = new Map();
    for (const file of files) if (file.sha256) byHash.set(file.sha256, [...(byHash.get(file.sha256) || []), file.name]);
    for (const file of files) file.duplicates = (byHash.get(file.sha256) || []).filter((name) => name !== file.name);
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  async trash(projectId, name, { reason, duplicateOf = null } = {}) {
    const fileName = safeName(name);
    const why = text(reason, 300);
    if (!why) throw new Error("Raison requise.");
    const paths = this.project(projectId);
    return this.mutate(projectId, async (state) => {
      const source = path.join(paths.files, fileName);
      const stat = await fs.stat(source).catch(() => null);
      if (!stat?.isFile()) throw new Error(`Fichier introuvable : ${fileName}`);
      if (this.now() - stat.mtimeMs < PROTECTED_HOURS * 3600000) throw new Error(`${fileName} a moins de ${PROTECTED_HOURS} h : à garder.`);
      if (duplicateOf) {
        const twin = path.join(paths.files, safeName(duplicateOf));
        if (twin === source || !(await fs.stat(twin).catch(() => null))?.isFile()) throw new Error(`Doublon de référence introuvable : ${duplicateOf}`);
        if (await sha256(twin) !== await sha256(source)) throw new Error(`${fileName} n'est pas un doublon exact de ${duplicateOf}.`);
      } else if (state.founder[fileName]) {
        throw new Error(`${fileName} a été uploadé par le fondateur : suppression seulement si doublon exact (--duplicate-of).`);
      }
      const id = crypto.randomBytes(4).toString("hex");
      await fs.mkdir(paths.trash, { recursive: true, mode: 0o700 });
      await fs.rename(source, path.join(paths.trash, `${id}-${fileName}`));
      const item = { id, name: fileName, size: stat.size, reason: why, duplicateOf: duplicateOf ? safeName(duplicateOf) : null, founder: Boolean(state.founder[fileName]), trashedAt: new Date(this.now()).toISOString() };
      delete state.founder[fileName];
      state.trash.push(item);
      if (state.status === "running") state.deleted.push(item);
      return item;
    });
  }

  async keep(projectId, name, { reason } = {}) {
    const fileName = safeName(name);
    const why = text(reason, 300);
    if (!why) throw new Error("Raison requise.");
    return this.mutate(projectId, (state) => {
      if (state.status !== "running") throw new Error("Aucun tri en cours.");
      state.kept = state.kept.filter((item) => item.name !== fileName);
      state.kept.push({ name: fileName, reason: why });
    });
  }

  async finish(projectId, { summary = "" } = {}) {
    return this.mutate(projectId, (state) => {
      if (state.status !== "running") throw new Error("Aucun tri en cours.");
      Object.assign(state, { status: "done", finishedAt: new Date(this.now()).toISOString(), summary: text(summary, 1000) });
      return { agentId: state.agentId, deleted: state.deleted.length };
    });
  }

  async restore(projectId, trashId) {
    if (!TRASH_ID.test(String(trashId || ""))) throw new Error("Élément de corbeille invalide.");
    const paths = this.project(projectId);
    return this.mutate(projectId, async (state) => {
      const item = state.trash.find((entry) => entry.id === trashId);
      if (!item) throw new Error("Élément introuvable dans la corbeille.");
      await fs.mkdir(paths.files, { recursive: true, mode: 0o700 });
      const ext = path.extname(item.name);
      const stem = path.basename(item.name, ext);
      let name = item.name;
      for (let n = 1; await fs.stat(path.join(paths.files, name)).catch(() => null); n += 1) name = `${stem}_restaure${n > 1 ? n : ""}${ext}`;
      await fs.rename(path.join(paths.trash, `${item.id}-${item.name}`), path.join(paths.files, name));
      state.trash = state.trash.filter((entry) => entry.id !== trashId);
      if (item.founder) state.founder[name] = new Date(this.now()).toISOString();
      return { ...item, restoredAs: name };
    });
  }

  async deleteForever(projectId, trashId) {
    if (!TRASH_ID.test(String(trashId || ""))) throw new Error("Élément de corbeille invalide.");
    const { trash } = this.project(projectId);
    return this.mutate(projectId, async (state) => {
      const item = state.trash.find((entry) => entry.id === trashId);
      if (!item) throw new Error("Élément introuvable dans la corbeille.");
      await fs.rm(path.join(trash, `${item.id}-${item.name}`), { force: true });
      state.trash = state.trash.filter((entry) => entry.id !== trashId);
      return item;
    });
  }

  async emptyTrash(projectId) {
    const { trash } = this.project(projectId);
    return this.mutate(projectId, async (state) => {
      for (const item of state.trash) await fs.rm(path.join(trash, `${item.id}-${item.name}`), { force: true });
      const removed = { count: state.trash.length, size: state.trash.reduce((sum, item) => sum + (item.size || 0), 0) };
      state.trash = [];
      return removed;
    });
  }

  async purge(projectId) {
    const state = await this.read(projectId);
    const limit = this.now() - TRASH_DAYS * DAY;
    if (!state.trash.some((item) => Date.parse(item.trashedAt) < limit)) return 0;
    const { trash } = this.project(projectId);
    return this.mutate(projectId, async (current) => {
      const expired = current.trash.filter((item) => Date.parse(item.trashedAt) < limit);
      for (const item of expired) await fs.rm(path.join(trash, `${item.id}-${item.name}`), { force: true });
      current.trash = current.trash.filter((item) => !expired.includes(item));
      return expired.length;
    });
  }

  async purgeAll() {
    const dir = path.join(this.dataDir, "project-files-sort");
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names) if (name.endsWith(".json")) await this.purge(name.slice(0, -5)).catch(() => {});
  }
}
