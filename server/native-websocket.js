import crypto from "node:crypto";

export const NATIVE_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost"]);
export class NativeWebSocketTickets {
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.entries = new Map(); }
  issue(profileId, path) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key);
    if (this.entries.size >= 500) throw new Error("Trop de connexions mobiles en attente.");
    const token = crypto.randomBytes(32).toString("base64url");
    this.entries.set(crypto.createHash("sha256").update(token).digest("hex"), { profileId, path, expiresAt: this.now() + 30000 });
    return { ticket: token, expiresIn: 30 };
  }
  take(token, path) {
    if (typeof token !== "string" || token.length > 100) return null;
    const hash = crypto.createHash("sha256").update(token).digest("hex"); const entry = this.entries.get(hash); this.entries.delete(hash);
    return entry && entry.expiresAt > this.now() && entry.path === path ? entry : null;
  }
}
