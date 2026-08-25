import fs from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";

export class PushService {
  constructor({ dataDir, subject = "mailto:admin@example.com" }) {
    this.keysFile = path.join(dataDir, "vapid.json");
    this.subscriptionsFile = path.join(dataDir, "push-subscriptions.json");
    this.subject = subject;
    this.keys = null;
    this.subscriptions = [];
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      this.keys = JSON.parse(await fs.readFile(this.keysFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.keys = webpush.generateVAPIDKeys();
      await this.write(this.keysFile, this.keys);
    }

    try {
      this.subscriptions = JSON.parse(await fs.readFile(this.subscriptionsFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    webpush.setVapidDetails(this.subject, this.keys.publicKey, this.keys.privateKey);
  }

  publicKey() {
    return this.keys.publicKey;
  }

  async subscribe(subscription) {
    if (!this.valid(subscription)) throw new Error("Abonnement push invalide.");
    const existing = this.subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
    if (existing >= 0) this.subscriptions[existing] = subscription;
    else this.subscriptions.push(subscription);
    await this.persist();
  }

  async unsubscribe(endpoint) {
    this.subscriptions = this.subscriptions.filter((item) => item.endpoint !== endpoint);
    await this.persist();
  }

  async send(payload) {
    const expired = new Set();
    const results = await Promise.allSettled(
      this.subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
          return true;
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            expired.add(subscription.endpoint);
            return false;
          }
          else throw error;
        }
      }),
    );
    if (expired.size) {
      this.subscriptions = this.subscriptions.filter((item) => !expired.has(item.endpoint));
      await this.persist();
    }
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length && failures.length === results.length) {
      const error = failures[0].reason;
      throw new Error(`Push refusé${error?.statusCode ? ` (${error.statusCode})` : ""}: ${String(error?.body || error?.message || "erreur inconnue").slice(0, 240)}`);
    }
    return results.filter((result) => result.status === "fulfilled" && result.value).length;
  }

  valid(subscription) {
    return Boolean(
      subscription &&
      typeof subscription.endpoint === "string" &&
      subscription.endpoint.startsWith("https://") &&
      subscription.endpoint.length < 4096 &&
      typeof subscription.keys?.p256dh === "string" &&
      typeof subscription.keys?.auth === "string",
    );
  }

  async persist() {
    this.queue = this.queue.then(() => this.write(this.subscriptionsFile, this.subscriptions));
    return this.queue;
  }

  async write(file, value) {
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
}
