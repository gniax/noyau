import crypto from "node:crypto";
import fs from "node:fs/promises";
import http2 from "node:http2";
import { SessionStore } from "./session-store.js";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
export class NativePushService {
  constructor({ file, fcmFile = process.env.NOYAU_FCM_SERVICE_ACCOUNT, apnsFile = process.env.NOYAU_APNS_KEY_FILE, apnsKeyId = process.env.NOYAU_APNS_KEY_ID, apnsTeamId = process.env.NOYAU_APNS_TEAM_ID, apnsTopic = "com.noyau.app", apnsSandbox = process.env.NOYAU_APNS_SANDBOX === "1", fetchImpl = fetch }) {
    Object.assign(this, { fcmFile, apnsFile, apnsKeyId, apnsTeamId, apnsTopic, apnsSandbox, fetchImpl }); this.store = new SessionStore(file); this.queue = Promise.resolve();
  }
  async load() { await this.store.load(); if (this.fcmFile) this.fcm = JSON.parse(await fs.readFile(this.fcmFile, "utf8")); if (this.apnsFile) this.apnsKey = await fs.readFile(this.apnsFile, "utf8"); }
  status() { return { android: Boolean(this.fcm?.private_key && this.fcm?.client_email && this.fcm?.project_id), ios: Boolean(this.apnsKey && this.apnsKeyId && this.apnsTeamId) }; }
  async subscribe(profileId, { platform, token, deviceId }) {
    if (!["android", "ios"].includes(platform) || !this.status()[platform]) throw new Error("Push natif non configuré : Firebase/FCM ou Apple APNs requis.");
    if (typeof token !== "string" || token.length < 20 || token.length > 4096 || !/^[a-zA-Z0-9_:.\-]+$/.test(token) || platform === "ios" && !/^[a-fA-F0-9]{64,200}$/.test(token) || typeof deviceId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(deviceId)) throw new Error("Appareil push invalide.");
    const write = this.queue.catch(() => {}).then(async () => {
      const entries = Object.entries(this.store.all()).map(([id, devices]) => [id, devices.filter((device) => device.token !== token && !(id === profileId && device.deviceId === deviceId))]);
      const current = entries.find(([id]) => id === profileId)?.[1] || []; current.push({ platform, token, deviceId, updatedAt: new Date().toISOString() });
      await this.store.setMany([...entries.filter(([id]) => id !== profileId), [profileId, current.slice(-20)]]);
    }); this.queue = write; await write;
  }
  devices(profileId, deviceId) { return (this.store.get(profileId) || []).filter((device) => !deviceId || device.deviceId === deviceId); }
  async unsubscribe(profileId, deviceId) { if (typeof deviceId !== "string") throw new Error("Appareil push invalide."); const write = this.queue.catch(() => {}).then(() => this.store.set(profileId, this.devices(profileId).filter((device) => device.deviceId !== deviceId))); this.queue = write; await write; }
  async fcmToken() {
    if (this.access?.expiresAt > Date.now() + 60000) return this.access.token;
    const now = Math.floor(Date.now() / 1000); const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.fcm.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
    const jwt = `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), this.fcm.private_key).toString("base64url")}`;
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Authentification FCM refusée (${response.status}).`);
    const result = await response.json(); if (!result.access_token) throw new Error("Jeton FCM absent."); this.access = { token: result.access_token, expiresAt: Date.now() + Math.min(result.expires_in || 3600, 3600) * 1000 }; return this.access.token;
  }
  apnsToken() { const now = Math.floor(Date.now() / 1000); if (this.apnsJwt?.at > now - 3000) return this.apnsJwt.token; const unsigned = `${encode({ alg: "ES256", kid: this.apnsKeyId })}.${encode({ iss: this.apnsTeamId, iat: now })}`; const token = `${unsigned}.${crypto.sign("sha256", Buffer.from(unsigned), { key: this.apnsKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`; this.apnsJwt = { at: now, token }; return token; }
  async sendOne(device, payload) {
    const data = { url: String(payload.url || "/"), sessionId: String(payload.sessionId || ""), view: String(payload.view || "") };
    if (device.platform === "android") {
      const response = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.fcm.project_id)}/messages:send`, { method: "POST", headers: { authorization: `Bearer ${await this.fcmToken()}`, "content-type": "application/json" }, body: JSON.stringify({ message: { token: device.token, notification: { title: String(payload.title || "Noyau").slice(0, 150), body: String(payload.body || "Nouvelle activité").slice(0, 1000) }, data, android: { priority: "high" } } }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) { const result = await response.json().catch(() => ({})); if (result.error?.details?.some((item) => item.errorCode === "UNREGISTERED")) return false; throw new Error(`Envoi FCM refusé (${response.status}).`); } return true;
    }
    const authorization = this.apnsToken();
    return new Promise((resolve, reject) => {
      const client = http2.connect(this.apnsSandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com"); let settled = false; let status;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); client.destroy(); if (error) reject(error); else resolve(value); };
      const timer = setTimeout(() => finish(new Error("APNs : délai dépassé.")), 10000);
      client.on("error", (error) => finish(error)); const request = client.request({ ":method": "POST", ":path": `/3/device/${device.token}`, authorization: `bearer ${authorization}`, "apns-topic": this.apnsTopic, "apns-push-type": "alert", "apns-priority": "10" });
      request.on("response", (headers) => { status = headers[":status"]; }); request.on("data", () => {}); request.on("error", (error) => finish(error)); request.on("end", () => { if (status === 410) finish(null, false); else if (status === 200) finish(null, true); else finish(new Error(`Envoi APNs refusé (${status || "inconnu"}).`)); }); request.end(JSON.stringify({ aps: { alert: { title: String(payload.title || "Noyau").slice(0, 150), body: String(payload.body || "Nouvelle activité").slice(0, 1000) }, sound: "default" }, ...data }));
    });
  }
  async send(payload, profileId, deviceId) {
    if (!profileId) return 0; const devices = this.devices(profileId, deviceId); const results = await Promise.allSettled(devices.map((device) => this.sendOne(device, payload))); const dead = new Set(devices.filter((_device, index) => results[index].status === "fulfilled" && results[index].value === false).map((device) => device.token));
    if (dead.size) { const write = this.queue.catch(() => {}).then(() => this.store.set(profileId, this.devices(profileId).filter((device) => !dead.has(device.token)))); this.queue = write; await write; }
    const count = results.filter((result) => result.status === "fulfilled" && result.value).length; if (!count && results.some((result) => result.status === "rejected")) throw results.find((result) => result.status === "rejected").reason; return count;
  }
}

export class NotificationGateway {
  constructor(web, native, background = null) { this.web = web; this.native = native; this.background = background; }
  publicKey() { return this.web.publicKey(); }
  subscribe(...args) { return this.web.subscribe(...args); }
  unsubscribe(...args) { return this.web.unsubscribe(...args); }
  // L'ecran aux commandes peut ne rien savoir recevoir (onglet PC, kiosque): l'alerte ne doit pas se perdre avec lui.
  reachable(profileId, deviceId) { return Boolean(this.web.devices(profileId, deviceId).length || this.native.devices(profileId, deviceId).length || this.background?.devices(profileId, deviceId).length); }
  async send(payload, profileId = null, activeDeviceId = null) { const target = activeDeviceId && this.reachable(profileId, activeDeviceId) ? activeDeviceId : null; const args = [payload, profileId, target]; const results = await Promise.allSettled([this.web.send(...args), this.native.send(...args), ...(this.background ? [this.background.send(...args)] : [])]); const count = results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value : 0), 0); if (!count && results.some((result) => result.status === "rejected")) throw results.find((result) => result.status === "rejected").reason; return count; }
}
