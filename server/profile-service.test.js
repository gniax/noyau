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

test("profile service seeds a single primary profile", async () => {
  const store = new MemoryStore();
  const service = new ProfileService({ store, dataDir: "/tmp/noyau", primaryTodoFile: "/vault/principal/TO DO.md", primaryTodoMountUri: "smb://nas/data" });
  const seeded = await service.initialize();
  assert.equal(seeded.created, 1);
  assert.equal(service.primaryId(), "principal");
  assert.equal(service.get("principal").theme, "noyau");
  assert.equal(service.list().length, 1);

  // Les profils suivants restent isoles: leur vault ne touche pas celui du profil principal.
  const guest = await service.create({ name: "Invité", theme: "aurora" });
  assert.equal(guest.todoFile, "/tmp/noyau/profiles/invite/TO DO.md");
  assert.notEqual(service.get("principal").todoFile, guest.todoFile);
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
  const notified = await service.update(profile.id, { quotaResetNotify: { codex: false, claude: true, antigravity: true } });
  assert.deepEqual(notified.quotaResetNotify, { codex: false, claude: true, antigravity: true });
  await assert.rejects(() => service.update(profile.id, { todoFile: "relative.md" }), /absolu requis/);
});
