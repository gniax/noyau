import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const COLUMN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BUILTIN = [
  { id: "todo", name: "À faire", kind: "todo" },
  { id: "review", name: "À tester / valider", kind: "review" },
  { id: "done", name: "Terminé", kind: "done" },
];

function cleanName(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

function normalize(columns) {
  const seen = new Set();
  const list = [];
  for (const column of Array.isArray(columns) ? columns : []) {
    if (!column || !COLUMN_ID.test(String(column.id || "")) || seen.has(column.id)) continue;
    const builtin = BUILTIN.find((item) => item.id === column.id);
    seen.add(column.id);
    list.push({
      id: column.id,
      name: cleanName(column.name) || builtin?.name || "Colonne",
      kind: builtin ? builtin.kind : "custom",
    });
  }
  // Les trois colonnes de base restent presentes: aucun to-do ne peut se retrouver sans zone.
  for (const builtin of BUILTIN) {
    if (seen.has(builtin.id)) continue;
    const doneIndex = list.findIndex((column) => column.id === "done");
    if (builtin.id === "done" || doneIndex === -1) list.push({ ...builtin });
    else list.splice(doneIndex, 0, { ...builtin });
  }
  return list;
}

export class BoardService {
  constructor({ file = null } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.queue = Promise.resolve();
    this.cache = null;
  }

  enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async read() {
    if (this.cache) return this.cache;
    if (!this.file) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async write(boards) {
    this.cache = boards;
    if (!this.file) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp-${Date.now()}`;
      await fs.writeFile(temporary, JSON.stringify(boards, null, 2), "utf8");
      await fs.rename(temporary, this.file);
    } catch (error) {
      console.error(`BoardService write error: ${error.message}`);
    }
  }

  async columns(profileId) {
    return this.enqueue(async () => {
      const boards = await this.read();
      return normalize(boards[profileId]);
    });
  }

  async save(profileId, columns) {
    const list = normalize(columns);
    const boards = await this.read();
    await this.write({ ...boards, [profileId]: list });
    return list;
  }

  async add(profileId, name) {
    return this.enqueue(async () => {
      const label = cleanName(name);
      if (!label) throw new Error("Nom de zone requis.");
      const current = normalize((await this.read())[profileId]);
      if (current.length >= 12) throw new Error("Maximum 12 zones.");
      const column = { id: `col-${crypto.randomBytes(4).toString("hex")}`, name: label, kind: "custom" };
      // La nouvelle zone se pose avant « Terminé » pour garder la colonne finale a droite.
      const doneIndex = current.findIndex((item) => item.id === "done");
      const next = [...current];
      next.splice(doneIndex === -1 ? next.length : doneIndex, 0, column);
      return { columns: await this.save(profileId, next), column };
    });
  }

  async rename(profileId, id, name) {
    return this.enqueue(async () => {
      const label = cleanName(name);
      if (!label) throw new Error("Nom de zone requis.");
      const current = normalize((await this.read())[profileId]);
      if (!current.some((column) => column.id === id)) throw new Error("Zone introuvable.");
      return this.save(profileId, current.map((column) => (column.id === id ? { ...column, name: label } : column)));
    });
  }

  async remove(profileId, id) {
    return this.enqueue(async () => {
      if (BUILTIN.some((column) => column.id === id)) throw new Error("Zone de base non supprimable.");
      const current = normalize((await this.read())[profileId]);
      if (!current.some((column) => column.id === id)) throw new Error("Zone introuvable.");
      return this.save(profileId, current.filter((column) => column.id !== id));
    });
  }

  async reorder(profileId, ids) {
    return this.enqueue(async () => {
      const current = normalize((await this.read())[profileId]);
      const byId = new Map(current.map((column) => [column.id, column]));
      const ordered = (Array.isArray(ids) ? ids : []).map((id) => byId.get(id)).filter(Boolean);
      for (const column of current) if (!ordered.some((item) => item.id === column.id)) ordered.push(column);
      return this.save(profileId, ordered);
    });
  }
}

export const BUILTIN_COLUMNS = BUILTIN;
