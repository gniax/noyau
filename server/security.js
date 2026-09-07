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
