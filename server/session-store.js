import fs from "node:fs/promises";
import path from "node:path";

export class SessionStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  get(id) {
    return this.data[id] || null;
  }

  all() {
    return this.data;
  }

  async set(id, value) {
    this.data[id] = value;
    await this.persist();
  }

  async remove(id) {
    delete this.data[id];
    await this.persist();
  }

  async persist() {
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    return this.queue;
  }
}
