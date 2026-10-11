import crypto from "node:crypto";
import path from "node:path";
import { hashPassword, validatePasswordStrength, verifyPassword } from "./security.js";

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const THEMES = new Set(["noyau", "moving-castle"]);

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

const DEFAULT_QUOTA_RESET_NOTIFY = { codex: true, claude: true, antigravity: false };

function cleanQuotaResetNotify(value, fallback = DEFAULT_QUOTA_RESET_NOTIFY) {
  const current = value && typeof value === "object" ? value : fallback;
  return {
    codex: typeof current?.codex === "boolean" ? current.codex : Boolean(fallback?.codex),
    claude: typeof current?.claude === "boolean" ? current.claude : Boolean(fallback?.claude),
    antigravity: typeof current?.antigravity === "boolean" ? current.antigravity : Boolean(fallback?.antigravity),
  };
}

export function sanitizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const { passwordHash, passwordSalt, ...safe } = profile;
  return {
    ...safe,
    hasPassword: Boolean(passwordHash),
  };
}

export class ProfileService {
  constructor({ store, dataDir, primaryTodoFile, primaryTodoMountUri = null, primaryName = "Noyau" }) {
    this.store = store;
    this.dataDir = path.resolve(dataDir);
    this.primaryTodoFile = path.resolve(primaryTodoFile);
    this.primaryTodoMountUri = primaryTodoMountUri || null;
    this.primaryName = cleanName(primaryName) || "Noyau";
  }

  profileTodoFile(id) {
    return path.join(this.dataDir, "profiles", id, "TO DO.md");
  }

  async initialize() {
    const entries = Object.entries(this.store.all());
    if (!entries.length) {
      const now = new Date().toISOString();
      await this.store.setMany([
        ["main", { name: this.primaryName, theme: "noyau", primary: true, todoFile: this.primaryTodoFile, todoMountUri: this.primaryTodoMountUri, quotaResetNotify: cleanQuotaResetNotify(), passwordHash: null, passwordSalt: null, passwordUpdatedAt: null, createdAt: now, updatedAt: now }],
        ["aurora", { name: "Aurora", theme: "moving-castle", primary: false, todoFile: this.profileTodoFile("aurora"), todoMountUri: null, quotaResetNotify: cleanQuotaResetNotify(), passwordHash: null, passwordSalt: null, passwordUpdatedAt: null, createdAt: now, updatedAt: now }],
      ]);
      return { created: 2, migrated: 0 };
    }
    const primaryId = entries.find(([, profile]) => profile.primary)?.[0] || entries[0][0];
    const updates = entries.map(([id, profile]) => [id, {
      ...profile,
      name: cleanName(profile.name) || id,
      theme: THEMES.has(profile.theme) ? profile.theme : id === primaryId ? "noyau" : "moving-castle",
      primary: id === primaryId,
      todoFile: todoFile(profile.todoFile, id === primaryId ? this.primaryTodoFile : this.profileTodoFile(id)),
      todoMountUri: mountUri(profile.todoMountUri),
      quotaResetNotify: cleanQuotaResetNotify(profile.quotaResetNotify),
      passwordHash: profile.passwordHash || null,
      passwordSalt: profile.passwordSalt || null,
      passwordUpdatedAt: profile.passwordUpdatedAt || null,
      updatedAt: profile.updatedAt || new Date().toISOString(),
    }]);
    await this.store.setMany(updates);
    return { created: 0, migrated: updates.length };
  }

  primaryId() {
    return Object.entries(this.store.all()).find(([, profile]) => profile.primary)?.[0] || Object.keys(this.store.all())[0] || "main";
  }

  get(id) {
    return PROFILE_ID.test(String(id || "")) ? this.store.get(id) : null;
  }

  getPublic(id) {
    return sanitizeProfile(this.get(id));
  }

  resolve(id) {
    const profileId = this.get(id) ? id : this.primaryId();
    return sanitizeProfile({ id: profileId, ...this.store.get(profileId) });
  }

  list() {
    return Object.entries(this.store.all())
      .map(([id, profile]) => sanitizeProfile({ id, ...profile }))
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "fr"));
  }

  async setPassword(id, password) {
    const current = this.get(id);
    if (!current) throw new Error("Profil introuvable.");
    const now = new Date().toISOString();
    let passwordHash = null;
    let passwordSalt = null;
    if (password !== null && password !== undefined && String(password).trim() !== "") {
      const clean = String(password).trim();
      validatePasswordStrength(clean);
      const hashed = hashPassword(clean);
      passwordHash = hashed.hash;
      passwordSalt = hashed.salt;
    }
    const next = {
      ...current,
      passwordHash,
      passwordSalt,
      passwordUpdatedAt: now,
      updatedAt: now,
    };
    await this.store.set(id, next);
    return sanitizeProfile({ id, ...next });
  }

  authenticate(credential, profileId = null, masterToken = "") {
    const candidate = String(credential || "").trim();
    if (!candidate) return null;

    let masterMatches = false;
    if (masterToken) {
      try {
        const expected = crypto.createHash("sha256").update(masterToken).digest();
        const actual = crypto.createHash("sha256").update(candidate).digest();
        masterMatches = crypto.timingSafeEqual(expected, actual);
      } catch {
        masterMatches = false;
      }
    }

    if (profileId) {
      const profile = this.get(profileId);
      if (!profile) return null;
      if (profile.passwordHash && profile.passwordSalt) {
        if (verifyPassword(candidate, profile.passwordHash, profile.passwordSalt)) {
          return sanitizeProfile({ id: profileId, ...profile });
        }
      }
      if (masterMatches) {
        return sanitizeProfile({ id: profileId, ...profile });
      }
      return null;
    }

    // Sans profileId : teste les profils ayant un mot de passe
    const all = this.store.all();
    for (const [id, profile] of Object.entries(all)) {
      if (profile.passwordHash && profile.passwordSalt) {
        if (verifyPassword(candidate, profile.passwordHash, profile.passwordSalt)) {
          return sanitizeProfile({ id, ...profile });
        }
      }
    }

    // Fallback clé master -> profil principal
    if (masterMatches) {
      const primaryId = this.primaryId();
      return sanitizeProfile({ id: primaryId, ...all[primaryId] });
    }

    return null;
  }

  async create(input = {}) {
    const name = cleanName(input.name);
    if (!name) throw new Error("Nom profil requis.");
    const base = slug(name);
    let id = base;
    for (let suffix = 2; this.store.get(id); suffix += 1) id = `${base.slice(0, 27)}-${suffix}`;
    const now = new Date().toISOString();
    let passwordHash = null;
    let passwordSalt = null;
    let passwordUpdatedAt = null;
    if (input.password !== null && input.password !== undefined && String(input.password).trim() !== "") {
      const clean = String(input.password).trim();
      validatePasswordStrength(clean);
      const hashed = hashPassword(clean);
      passwordHash = hashed.hash;
      passwordSalt = hashed.salt;
      passwordUpdatedAt = now;
    }
    const profile = {
      name,
      theme: THEMES.has(input.theme) ? input.theme : "moving-castle",
      primary: false,
      todoFile: todoFile(input.todoFile, this.profileTodoFile(id)),
      todoMountUri: mountUri(input.todoMountUri),
      quotaResetNotify: cleanQuotaResetNotify(input.quotaResetNotify),
      passwordHash,
      passwordSalt,
      passwordUpdatedAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(id, profile);
    return sanitizeProfile({ id, ...profile });
  }

  async update(id, input = {}) {
    const current = this.get(id);
    if (!current) throw new Error("Profil introuvable.");
    const name = input.name === undefined ? current.name : cleanName(input.name);
    if (!name) throw new Error("Nom profil requis.");
    const isAurora = id.toLowerCase().includes("aurora") || name.toLowerCase().includes("aurora");
    const rawTheme = input.theme === undefined ? current.theme : String(input.theme);
    if (!THEMES.has(rawTheme)) throw new Error("Thème profil invalide.");
    const theme = isAurora ? "moving-castle" : rawTheme;
    let passwordHash = current.passwordHash || null;
    let passwordSalt = current.passwordSalt || null;
    let passwordUpdatedAt = current.passwordUpdatedAt || null;
    if (input.password !== undefined) {
      if (input.password !== null && String(input.password).trim() !== "") {
        const clean = String(input.password).trim();
        validatePasswordStrength(clean);
        const hashed = hashPassword(clean);
        passwordHash = hashed.hash;
        passwordSalt = hashed.salt;
        passwordUpdatedAt = new Date().toISOString();
      } else {
        passwordHash = null;
        passwordSalt = null;
        passwordUpdatedAt = new Date().toISOString();
      }
    }
    const next = {
      ...current,
      name,
      theme,
      todoFile: input.todoFile === undefined ? current.todoFile : todoFile(input.todoFile, this.profileTodoFile(id)),
      todoMountUri: input.todoMountUri === undefined ? current.todoMountUri : mountUri(input.todoMountUri),
      quotaResetNotify: input.quotaResetNotify === undefined ? cleanQuotaResetNotify(current.quotaResetNotify) : cleanQuotaResetNotify(input.quotaResetNotify, current.quotaResetNotify),
      passwordHash,
      passwordSalt,
      passwordUpdatedAt,
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(id, next);
    return sanitizeProfile({ id, ...next });
  }
}

export { PROFILE_ID, THEMES, cleanName, cleanQuotaResetNotify, slug };
