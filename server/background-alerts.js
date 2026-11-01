import crypto from "node:crypto";
import fs from "node:fs/promises";

const hash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const DAY = 86_400_000;

// iPhone sans cle APNs: le serveur garde les alertes, l'app les releve elle-meme en arriere-plan.
export class BackgroundAlertService {
  constructor({ file = null, now = () => Date.now(), retentionMs = 7 * DAY, deviceTtlMs = 30 * DAY, maxItems = 200, randomToken = () => crypto.randomBytes(32).toString("base64url") } = {}) {
    Object.assign(this, { file, now, retentionMs, deviceTtlMs, maxItems, randomToken });
    this.state = { seq: 0, devices: {}, items: [] };
    this.queue = Promise.resolve();
  }

  async load() {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.state = { seq: Number(parsed.seq) || 0, devices: parsed.devices || {}, items: Array.isArray(parsed.items) ? parsed.items : [] };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  persist() {
    if (!this.file) return Promise.resolve();
    const write = this.queue.catch(() => {}).then(async () => {
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    this.queue = write;
    return write;
  }

  prune() {
    const now = this.now();
    this.state.items = this.state.items.filter((item) => now - item.at < this.retentionMs).slice(-this.maxItems);
    for (const [key, device] of Object.entries(this.state.devices)) if (now - device.lastSeenAt > this.deviceTtlMs) delete this.state.devices[key];
  }

  entries(profileId) { return Object.values(this.state.devices).filter((device) => device.profileId === profileId); }

  devices(profileId, deviceId = null) { return this.entries(profileId).filter((device) => !deviceId || device.deviceId === deviceId); }

  async register(profileId, { deviceId, platform } = {}) {
    if (!profileId || typeof deviceId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(deviceId)) throw new Error("Appareil invalide.");
    if (!["ios", "android"].includes(platform)) throw new Error("Plateforme invalide.");
    for (const [key, device] of Object.entries(this.state.devices)) if (device.deviceId === deviceId) delete this.state.devices[key];
    const token = this.randomToken();
    this.state.devices[hash(token)] = { profileId, deviceId, platform, createdAt: this.now(), lastSeenAt: this.now() };
    await this.persist();
    return { token, cursor: this.state.seq };
  }

  async unregister(profileId, deviceId) {
    for (const [key, device] of Object.entries(this.state.devices)) if (device.profileId === profileId && device.deviceId === deviceId) delete this.state.devices[key];
    await this.persist();
  }

  async send(payload, profileId, deviceId = null) {
    if (!profileId) return 0;
    const targets = this.devices(profileId, deviceId);
    if (!targets.length) return 0;
    this.prune();
    this.state.items.push({
      id: ++this.state.seq,
      at: this.now(),
      profileId,
      deviceId: deviceId || null,
      title: String(payload.title || "Noyau").slice(0, 150),
      body: String(payload.body || "Nouvelle activité.").slice(0, 1000),
      tag: String(payload.tag || "").slice(0, 200),
      url: String(payload.url || "/").slice(0, 500),
    });
    await this.persist();
    return targets.length;
  }

  // Le jeton d'appareil ne donne acces qu'a ses propres alertes: jamais a la session Noyau.
  poll(token, after) {
    const device = token ? this.state.devices[hash(token)] : null;
    if (!device) return null;
    device.lastSeenAt = this.now();
    const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
    const items = this.state.items
      .filter((item) => item.id > cursor && item.profileId === device.profileId && (!item.deviceId || item.deviceId === device.deviceId))
      .map(({ id, title, body, tag, url }) => ({ id, title, body, tag, url }));
    return { items, cursor: this.state.seq };
  }
}
