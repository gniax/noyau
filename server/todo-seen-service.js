import fs from "node:fs/promises";
import path from "node:path";

// Marqueurs de lecture par profil: ce que l'utilisateur a deja vu sur chaque tache.
export class TodoSeenService {
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

  async write(state) {
    this.cache = state;
    if (!this.file) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp-${Date.now()}`;
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(temporary, this.file);
    } catch (error) {
      console.error(`TodoSeenService write error: ${error.message}`);
    }
  }

  async seen(profileId) {
    return this.enqueue(async () => (await this.read())[profileId] || {});
  }

  async mark(profileId, todoIds, at = new Date().toISOString()) {
    return this.enqueue(async () => {
      const state = await this.read();
      const profile = { ...(state[profileId] || {}) };
      for (const id of Array.isArray(todoIds) ? todoIds : [todoIds]) if (id) profile[id] = at;
      const next = { ...state, [profileId]: profile };
      await this.write(next);
      return profile;
    });
  }

  // Premier passage d'un profil: tout l'existant compte comme deja vu, sinon tout clignoterait d'un coup.
  async bootstrap(profileId, todos) {
    const state = await this.read();
    if (state[profileId]) return state[profileId];
    return this.mark(profileId, todos.map((todo) => todo.id));
  }

  count(todo, seenAt) {
    // Tache jamais ouverte: elle est nouvelle, donc entierement non lue.
    if (!seenAt) return 1 + (todo.comments || []).length;
    const comments = (todo.comments || []).filter((comment) => comment.createdAt && comment.createdAt > seenAt).length;
    const changed = todo.activityAt && todo.activityAt > seenAt;
    const latestComment = (todo.comments || []).reduce((latest, comment) => (comment.createdAt > latest ? comment.createdAt : latest), "");
    const otherChange = changed && (!latestComment || todo.activityAt > latestComment) ? 1 : 0;
    return comments + otherChange;
  }

  decorate(todos, seen) {
    return todos.map((todo) => ({ ...todo, unread: this.count(todo, seen[todo.id]), seenAt: seen[todo.id] || null }));
  }
}
