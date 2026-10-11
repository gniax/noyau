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
  const service = new ProfileService({ store, dataDir: "/tmp/noyau", primaryTodoFile: "/vault/main/TO DO.md", primaryTodoMountUri: "smb://nas/data" });
  await service.initialize();
  assert.equal(service.primaryId(), "main");
  assert.equal(service.get("main").theme, "noyau");
  assert.equal(service.get("aurora").theme, "moving-castle");
  assert.equal(service.get("aurora").todoFile, "/tmp/noyau/profiles/aurora/TO DO.md");
  assert.notEqual(service.get("main").todoFile, service.get("aurora").todoFile);
});

test("profile service creates and updates safe profile settings", async () => {
  const store = new MemoryStore({ main: { name: "Noyau", primary: true, theme: "noyau", todoFile: "/vault/main.md" } });
  const service = new ProfileService({ store, dataDir: "/tmp/noyau", primaryTodoFile: "/vault/main.md" });
  await service.initialize();
  const profile = await service.create({ name: "Léa Maison", theme: "moving-castle" });
  assert.equal(profile.id, "lea-maison");
  assert.equal(profile.todoFile, "/tmp/noyau/profiles/lea-maison/TO DO.md");
  const updated = await service.update(profile.id, { todoFile: "/vault/lea/TO DO.md", todoMountUri: "smb://nas/lea" });
  assert.equal(updated.todoFile, "/vault/lea/TO DO.md");
  const notified = await service.update(profile.id, { quotaResetNotify: { codex: false, claude: true, antigravity: true } });
  assert.deepEqual(notified.quotaResetNotify, { codex: false, claude: true, antigravity: true });
  await assert.rejects(() => service.update(profile.id, { todoFile: "relative.md" }), /absolu requis/);
});

test("profile password management and authentication", async () => {
  const store = new MemoryStore();
  const service = new ProfileService({ store, dataDir: "/tmp/noyau", primaryTodoFile: "/vault/main.md" });
  await service.initialize();

  // Initialement pas de mot de passe
  assert.equal(service.list().find((p) => p.id === "main").hasPassword, false);

  // Authentification via master token
  const masterAuth = service.authenticate("master-token-123", "main", "master-token-123");
  assert.equal(masterAuth?.id, "main");

  // Définition d'un mot de passe pour aurora
  const updatedAurora = await service.setPassword("aurora", "mon-chateau-secret");
  assert.equal(updatedAurora.hasPassword, true);
  assert.equal(updatedAurora.passwordHash, undefined); // hash non divulgué

  // Authentification Aurora avec son mot de passe
  const auroraAuth = service.authenticate("mon-chateau-secret", "aurora", "master-token-123");
  assert.equal(auroraAuth?.id, "aurora");

  // Authentification sans profileId (auto-détection)
  const autoAuth = service.authenticate("mon-chateau-secret", null, "master-token-123");
  assert.equal(autoAuth?.id, "aurora");

  // Mauvais mot de passe
  assert.equal(service.authenticate("mauvais-pass", "aurora", "master-token-123"), null);

  // Suppression du mot de passe
  const cleared = await service.setPassword("aurora", "");
  assert.equal(cleared.hasPassword, false);
});

test("profile service enforces password strength on setPassword and create", async () => {
  const store = new MemoryStore();
  const service = new ProfileService({ store, dataDir: "/tmp/noyau", primaryTodoFile: "/vault/main.md" });
  await service.initialize();

  await assert.rejects(() => service.setPassword("main", "1234"), /trop court/);
  await assert.rejects(() => service.setPassword("main", "password"), /trop simple/);
  await assert.rejects(() => service.setPassword("main", "11111111"), /répéter/);
  await assert.rejects(() => service.setPassword("main", "abcdefgh"), /combiner lettres/);

  // Valide
  const updated = await service.setPassword("main", "Noyau-Safe2026!");
  assert.equal(updated.hasPassword, true);
});

