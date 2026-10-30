import crypto from "node:crypto";
import express from "express";
import { SessionStore } from "./session-store.js";
import { createSessionToken, SESSION_MAX_AGE_MS, SESSION_MAX_AGE_SECONDS } from "./security.js";

const digest = (value) => crypto.createHash("sha256").update(value).digest();
export class BiometricAuthService {
  constructor({ file, profiles, secret, now = () => Date.now() }) { this.store = new SessionStore(file); Object.assign(this, { profiles, secret, now }); this.queue = Promise.resolve(); }
  async load() { await this.store.load(); }
  stamp(profileId) {
    const profile = this.profiles.get(profileId); if (!profile) return null;
    return crypto.createHmac("sha256", this.secret).update(JSON.stringify([profileId, profile.passwordHash, profile.passwordSalt, profile.passwordUpdatedAt])).digest("hex");
  }
  active(id, profileId) { const device = this.store.get(id); return Boolean(device && device.profileId === profileId && device.expiresAt > this.now() && device.stamp === this.stamp(profileId)); }
  list(profileId) { return Object.entries(this.store.all()).filter(([id, device]) => device.profileId === profileId && this.active(id, profileId)).map(([id, { name, platform, createdAt, expiresAt }]) => ({ id, name, platform, createdAt, expiresAt })); }
  async enroll(profileId, { name, platform, password } = {}) {
    if (!["android", "ios"].includes(platform) || typeof password !== "string" || !this.profiles.authenticate(password, profileId, this.secret)) throw Object.assign(new Error("Confirmez le mot de passe de ce profil pour activer la biométrie."), { statusCode: 401 });
    const approvedStamp = this.stamp(profileId);
    const write = this.queue.catch(() => {}).then(async () => {
      if (approvedStamp !== this.stamp(profileId)) throw Object.assign(new Error("Mot de passe modifié pendant l’association. Reconnectez-vous."), { statusCode: 401 });
      const id = crypto.randomUUID(); const token = crypto.randomBytes(32).toString("base64url"); const createdAt = this.now(); const expiresAt = createdAt + 30 * 86400000;
      if (this.list(profileId).length >= 10) throw new Error("Dix appareils maximum ; révoquez un ancien appareil.");
      await this.store.set(id, { profileId, name: String(name || "Application Noyau").slice(0, 80), platform, createdAt, expiresAt, stamp: approvedStamp, hash: digest(token).toString("hex") });
      return { id, token, profileId, expiresAt };
    }); this.queue = write; return write;
  }
  authenticate({ id, token } = {}) {
    if (typeof id !== "string" || id.length > 100 || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const device = this.store.get(id); if (!device || !this.active(id, device.profileId)) return null;
    const expected = Buffer.from(device.hash, "hex"); if (expected.length !== 32 || !crypto.timingSafeEqual(expected, digest(token))) return null;
    return { deviceId: id, profileId: device.profileId };
  }
  async revoke(profileId, id) { const write = this.queue.catch(() => {}).then(async () => { if (this.store.get(id)?.profileId === profileId) await this.store.remove(id); }); this.queue = write; return write; }
}

export function biometricSessionRoutes({ service, profiles, secret, throttle }) {
  const router = express.Router();
  router.post("/session", (request, response) => {
    response.set("Cache-Control", "no-store");
    const remote = `biometric:${request.socket.remoteAddress || "unknown"}`; const retry = throttle.retryAfter(remote);
    if (retry) return response.status(429).set("Retry-After", String(retry)).json({ error: "Trop de tentatives. Réessayez plus tard." });
    const identity = service.authenticate(request.body || {});
    if (!identity) { throttle.fail(remote); return response.status(401).json({ error: "Connexion biométrique expirée ou révoquée. Reconnectez-vous avec votre mot de passe." }); }
    throttle.clear(remote);
    const token = createSessionToken({ profileId: identity.profileId, biometricDeviceId: identity.deviceId }, secret);
    response.set("Set-Cookie", `noyau_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; Secure`);
    response.json({ ok: true, profile: profiles.resolve(identity.profileId), token, expiresAt: Date.now() + SESSION_MAX_AGE_MS });
  });
  return router;
}
