import crypto from "node:crypto";
import fs from "node:fs/promises";

export function validAccessToken(token) {
  return typeof token === "string" && token.trim().length > 0;
}

export async function loadAccessToken(file, environmentToken = "") {
  if (environmentToken) {
    if (!validAccessToken(environmentToken)) throw new Error("NOYAU_TOKEN ne peut pas être vide.");
    return { token: environmentToken.trim(), rotated: false };
  }
  let current = "";
  try {
    current = (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.chmod(file, 0o600).catch(() => {});
  if (validAccessToken(current)) return { token: current, rotated: false };
  const token = crypto.randomBytes(32).toString("base64url");
  await fs.writeFile(file, `${token}\n`, { mode: 0o600 });
  return { token, rotated: false };
}

export function sameWebSocketOrigin({ origin, host, secure }) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).origin === `${secure ? "https" : "http"}://${host}`;
  } catch {
    return false;
  }
}

export function createLoginThrottle({ limit = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map();
  return {
    retryAfter(key, now = Date.now()) {
      const state = failures.get(key);
      if (!state || now - state.startedAt >= windowMs) {
        failures.delete(key);
        return 0;
      }
      return state.count >= limit ? Math.ceil((state.startedAt + windowMs - now) / 1000) : 0;
    },
    fail(key, now = Date.now()) {
      const state = failures.get(key);
      failures.set(key, !state || now - state.startedAt >= windowMs ? { count: 1, startedAt: now } : { ...state, count: state.count + 1 });
    },
    clear(key) {
      failures.delete(key);
    },
  };
}

export const SESSION_MAX_AGE_SECONDS = 2 * 60 * 60; // 2 heures max
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

export const COMMON_WEAK_PASSWORDS = new Set([
  "12345678",
  "123456789",
  "1234567890",
  "password",
  "passwords",
  "qwertyuiop",
  "azertyuiop",
  "admin123",
  "adminadmin",
  "noyau123",
  "noyau2026",
  "motdepasse",
]);

export function checkPasswordStrength(password) {
  if (typeof password !== "string" || !password.trim()) {
    return { valid: false, score: 0, level: "empty", error: "Mot de passe requis." };
  }
  const clean = password.trim();
  if (clean.length < 8) {
    return { valid: false, score: 1, level: "weak", error: "Mot de passe trop court (8 caractères minimum)." };
  }
  if (/^(.)\1+$/.test(clean)) {
    return { valid: false, score: 1, level: "weak", error: "Le mot de passe ne peut pas répéter un seul caractère." };
  }
  if (COMMON_WEAK_PASSWORDS.has(clean.toLowerCase())) {
    return { valid: false, score: 1, level: "weak", error: "Mot de passe trop simple ou trop facile à deviner." };
  }
  const hasLetters = /[a-zA-Z]/.test(clean);
  const hasDigits = /\d/.test(clean);
  const hasSymbols = /[^a-zA-Z0-9]/.test(clean);
  const hasLower = /[a-z]/.test(clean);
  const hasUpper = /[A-Z]/.test(clean);

  if (clean.length < 12 && (!hasLetters || (!hasDigits && !hasSymbols))) {
    return { valid: false, score: 1, level: "weak", error: "Le mot de passe doit combiner lettres et chiffres ou symboles (ou 12 caractères minimum)." };
  }

  let score = 2;
  if (clean.length >= 12) score += 1;
  if (hasLower && hasUpper) score += 1;
  if (hasDigits && hasSymbols) score += 1;

  const level = score >= 4 ? "strong" : "medium";
  return { valid: true, score, level, error: null };
}

export function validatePasswordStrength(password) {
  const check = checkPasswordStrength(password);
  if (!check.valid) {
    throw new Error(check.error);
  }
  return true;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  if (typeof password !== "string" || !password) throw new Error("Mot de passe invalide.");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  try {
    const candidateHash = crypto.scryptSync(String(password), salt, 32).toString("hex");
    const a = Buffer.from(candidateHash, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function createSessionToken({ profileId, issuedAt = Date.now() }, secret) {
  if (!secret) throw new Error("Secret requis pour token de session.");
  const payload = Buffer.from(JSON.stringify({ p: String(profileId || ""), i: issuedAt })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token, secret, maxAgeMs = SESSION_MAX_AGE_MS, now = Date.now()) {
  if (typeof token !== "string" || !token.includes(".") || !secret) return null;
  const [payloadStr, signature] = token.split(".");
  if (!payloadStr || !signature) return null;
  const expectedSignature = crypto.createHmac("sha256", secret).update(payloadStr).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8"));
    const issuedAt = Number(data.i);
    const profileId = String(data.p || "");
    if (!issuedAt || !profileId) return null;
    const age = now - issuedAt;
    if (age < 0 || age > maxAgeMs) return null;
    return { profileId, issuedAt };
  } catch {
    return null;
  }
}
