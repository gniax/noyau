import assert from "node:assert/strict";
import test from "node:test";
import { ProfileService } from "./profile-service.js";

class MemoryStore {
  constructor(data = {}) { this.data = data; }
  all() { return this.data; }
  get(id) { return this.data[id] || null; }
  async set(id, value) { this.data[id] = value; }
  async setMany(entries) { for (const [id, value] of entries) this.data[id] = value; }
}

test("profile service seeds isolated primary and partner profiles", async () => {
  const store = new MemoryStore();
  const service = new ProfileService({ store, dataDir: "/tmp/noyau", primaryTodoFile: "/vault/principal/TO DO.md", primaryTodoMountUri: "smb://nas/data" });
  await service.initialize();
  assert.equal(service.primaryId(), "principal");
  assert.equal(service.get("principal").theme, "noyau");
  assert.equal(service.get("copine").theme, "aurora");
  assert.equal(service.get("copine").todoFile, "/tmp/noyau/profiles/copine/TO DO.md");
  assert.notEqual(service.get("principal").todoFile, service.get("copine").todoFile);
});

test("profile service creates and updates safe profile settings", async () => {
  const store = new MemoryStore({ gniax: { name: "Noyau", primary: true, theme: "noyau", todoFile: "/vault/main.md" } });
  const service = new ProfileService({ store, dataDir: "/tmp/noyau", primaryTodoFile: "/vault/main.md" });
  await service.initialize();
  const profile = await service.create({ name: "Camille Martin", theme: "aurora" });
  assert.equal(profile.id, "camille-martin");
  assert.equal(profile.todoFile, "/tmp/noyau/profiles/camille-martin/TO DO.md");
  const updated = await service.update(profile.id, { todoFile: "/vault/camille/TO DO.md", todoMountUri: "smb://nas/partage" });
  assert.equal(updated.todoFile, "/vault/camille/TO DO.md");
  await assert.rejects(() => service.update(profile.id, { todoFile: "relative.md" }), /absolu requis/);
});
