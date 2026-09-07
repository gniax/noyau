import fs from "node:fs/promises";
import path from "node:path";

export class AgentArchiveService {
  constructor({ file = null, maxEntries = 100 } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.maxEntries = maxEntries;
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
      this.cache = [];
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  async write(archives) {
    this.cache = archives;
    if (!this.file) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp-${Date.now()}`;
      await fs.writeFile(temporary, JSON.stringify(archives, null, 2), "utf8");
      await fs.rename(temporary, this.file);
    } catch (error) {
      console.error(`AgentArchiveService write error: ${error.message}`);
    }
  }

  async list({ profileId = null } = {}) {
    return this.enqueue(async () => {
      const archives = await this.read();
      return archives
        .filter((entry) => !profileId || !entry.profileId || entry.profileId === profileId || entry.shared)
        .sort((a, b) => (b.archivedAt || "").localeCompare(a.archivedAt || ""));
    });
  }

  async get(id) {
    return this.enqueue(async () => {
      const archives = await this.read();
      return archives.find((entry) => entry.id === id) || null;
    });
  }

  async archive(id, entry = {}, { reason = "closed" } = {}) {
    if (!id || typeof entry !== "object") return null;
    return this.enqueue(async () => {
      const archives = await this.read();
      const filtered = archives.filter((item) => item.id !== id);
      const archivedItem = {
        id,
        name: entry.name || entry.assistant || id,
        assistant: entry.assistant || "shell",
        cwd: entry.cwd || null,
        projectId: entry.projectId || null,
        profileId: entry.profileId || null,
        shared: Boolean(entry.shared),
        favorite: Boolean(entry.favorite),
        projectLogo: Boolean(entry.projectLogo),
        yolo: Boolean(entry.yolo),
        threadId: entry.threadId || null,
        agentSessionId: entry.agentSessionId || null,
        transcriptPath: entry.transcriptPath || null,
        createdAt: entry.createdAt || null,
        archivedAt: new Date().toISOString(),
        reason,
      };
      const next = [archivedItem, ...filtered].slice(0, this.maxEntries);
      await this.write(next);
      return archivedItem;
    });
  }

  async remove(id) {
    return this.enqueue(async () => {
      const archives = await this.read();
      const next = archives.filter((item) => item.id !== id);
      if (next.length !== archives.length) {
        await this.write(next);
        return true;
      }
      return false;
    });
  }

  async restore(id, { tmux, profileId = null } = {}) {
    if (!tmux) throw new Error("TmuxController requis pour la restauration.");
    return this.enqueue(async () => {
      const archives = await this.read();
      const index = archives.findIndex((item) => item.id === id);
      if (index === -1) throw new Error("Agent archivé introuvable.");
      const archived = archives[index];
      if (profileId && archived.profileId && archived.profileId !== profileId && !archived.shared) {
        throw new Error("Accès non autorisé à cet agent archivé.");
      }

      const session = await tmux.create({
        name: archived.name,
        assistant: archived.assistant,
        cwd: archived.cwd,
        yolo: archived.yolo,
        projectLogo: archived.projectLogo,
        projectId: archived.projectId,
        profileId: profileId || archived.profileId,
        shared: archived.shared,
        favorite: archived.favorite,
        threadId: archived.threadId,
        agentSessionId: archived.agentSessionId,
        transcriptPath: archived.transcriptPath,
      });

      const next = archives.filter((item) => item.id !== id);
      await this.write(next);
      return session;
    });
  }
}
