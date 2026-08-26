import path from "node:path";

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const THEMES = new Set(["noyau", "aurora"]);

function cleanName(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
}

function slug(value) {
  return cleanName(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "profil";
}

function todoFile(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (raw.length > 1000 || !path.isAbsolute(raw)) throw new Error("Chemin Todo Obsidian absolu requis.");
  return path.resolve(raw);
}

function mountUri(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length > 1000 || !/^smb:\/\//i.test(raw)) throw new Error("URI montage Todo invalide.");
  return raw;
}

export class ProfileService {
  constructor({ store, dataDir, primaryTodoFile, primaryTodoMountUri = null, primaryName = "Noyau" }) {
    this.store = store;
    this.dataDir = path.resolve(dataDir);
    this.primaryTodoFile = path.resolve(primaryTodoFile);
    this.primaryTodoMountUri = primaryTodoMountUri || null;
    this.primaryName = cleanName(primaryName) || "Gniax";
  }

  profileTodoFile(id) {
    return path.join(this.dataDir, "profiles", id, "TO DO.md");
  }

  async initialize() {
    const entries = Object.entries(this.store.all());
    if (!entries.length) {
      const now = new Date().toISOString();
      await this.store.setMany([
        ["principal", { name: this.primaryName, theme: "noyau", primary: true, todoFile: this.primaryTodoFile, todoMountUri: this.primaryTodoMountUri, createdAt: now, updatedAt: now }],
        ["guest", { name: "Invité", theme: "aurora", primary: false, todoFile: this.profileTodoFile("guest"), todoMountUri: null, createdAt: now, updatedAt: now }],
      ]);
      return { created: 2, migrated: 0 };
    }
    const primaryId = entries.find(([, profile]) => profile.primary)?.[0] || entries[0][0];
    const updates = entries.map(([id, profile]) => [id, {
      ...profile,
      name: cleanName(profile.name) || id,
      theme: THEMES.has(profile.theme) ? profile.theme : id === primaryId ? "noyau" : "aurora",
      primary: id === primaryId,
      todoFile: todoFile(profile.todoFile, id === primaryId ? this.primaryTodoFile : this.profileTodoFile(id)),
      todoMountUri: mountUri(profile.todoMountUri),
      updatedAt: profile.updatedAt || new Date().toISOString(),
    }]);
    await this.store.setMany(updates);
    return { created: 0, migrated: updates.length };
  }

  primaryId() {
    return Object.entries(this.store.all()).find(([, profile]) => profile.primary)?.[0] || Object.keys(this.store.all())[0] || "principal";
  }

  get(id) {
    return PROFILE_ID.test(String(id || "")) ? this.store.get(id) : null;
  }

  resolve(id) {
    const profileId = this.get(id) ? id : this.primaryId();
    return { id: profileId, ...this.store.get(profileId) };
  }

  list() {
    return Object.entries(this.store.all()).map(([id, profile]) => ({ id, ...profile })).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "fr"));
  }

  async create(input = {}) {
    const name = cleanName(input.name);
    if (!name) throw new Error("Nom profil requis.");
    const base = slug(name);
    let id = base;
    for (let suffix = 2; this.store.get(id); suffix += 1) id = `${base.slice(0, 27)}-${suffix}`;
    const now = new Date().toISOString();
    const profile = {
      name,
      theme: THEMES.has(input.theme) ? input.theme : "aurora",
      primary: false,
      todoFile: todoFile(input.todoFile, this.profileTodoFile(id)),
      todoMountUri: mountUri(input.todoMountUri),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(id, profile);
    return { id, ...profile };
  }

  async update(id, input = {}) {
    const current = this.get(id);
    if (!current) throw new Error("Profil introuvable.");
    const name = input.name === undefined ? current.name : cleanName(input.name);
    if (!name) throw new Error("Nom profil requis.");
    const theme = input.theme === undefined ? current.theme : String(input.theme);
    if (!THEMES.has(theme)) throw new Error("Thème profil invalide.");
    const next = {
      ...current,
      name,
      theme,
      todoFile: input.todoFile === undefined ? current.todoFile : todoFile(input.todoFile, this.profileTodoFile(id)),
      todoMountUri: input.todoMountUri === undefined ? current.todoMountUri : mountUri(input.todoMountUri),
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(id, next);
    return { id, ...next };
  }
}

export { PROFILE_ID, THEMES, cleanName, slug };
