// Platform-independent orchestration; the only secret persistence is the native vault.
export class BiometricClient {
  constructor({ server, profileId, vault, metadata, request }) {
    const url = new URL(server);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profileId)) throw new Error("Serveur ou profil biométrique invalide.");
    Object.assign(this, { server: url.origin, profileId, vault, metadata, request }); this.scope = `${url.origin}|${profileId}`;
  }
  async record() { return this.metadata.get(this.scope); }
  async enroll({ password, platform, label }) {
    const device = await this.request("/api/auth/biometric/devices", { method: "POST", body: JSON.stringify({ password, platform, name: label }) });
    try {
      if (device.profileId !== this.profileId) throw new Error("Profil d'association incorrect.");
      await this.vault.enroll({ scope: this.scope, value: JSON.stringify({ ...device, server: this.server }) });
      const session = await this.request("/api/auth/biometric/session", { method: "POST", body: JSON.stringify({ id: device.id, token: device.token }) });
      if (session.profile?.id !== this.profileId) throw new Error("Profil de connexion inattendu.");
      const record = { id: device.id, profileId: device.profileId, server: this.server, expiresAt: device.expiresAt, label };
      await this.metadata.set(this.scope, record); return record;
    } catch (error) {
      await this.vault.clear({ scope: this.scope }).catch(() => {});
      await this.metadata.remove(this.scope).catch(() => {});
      await this.request(`/api/auth/biometric/devices/${device.id}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  }
  async unlock() {
    const record = await this.record(); if (!record) throw new Error("Connexion biométrique non activée.");
    if (record.expiresAt <= Date.now()) throw new Error("Connexion biométrique expirée : reconnectez-vous avec le mot de passe.");
    const { value } = await this.vault.unlock({ scope: this.scope });
    const credential = JSON.parse(value);
    if (credential.server !== this.server || credential.profileId !== this.profileId || credential.id !== record.id || typeof credential.token !== "string" || credential.expiresAt <= Date.now()) throw new Error("Association biométrique invalide.");
    try {
      const result = await this.request("/api/auth/biometric/session", { method: "POST", body: JSON.stringify({ id: credential.id, token: credential.token }) });
      if (result.profile?.id !== this.profileId) throw Object.assign(new Error("Profil de connexion inattendu."), { status: 403 });
      return { offline: false };
    } catch (error) {
      // Only transport failures permit cached offline access, after OS approval.
      // HTTP denials, rate limits, and server errors never become a bypass.
      if (error.status) throw error;
      return { offline: true };
    }
  }
  async disable() {
    let record; let revoked = true;
    try { record = await this.record(); } catch { revoked = false; }
    if (record?.id) try { await this.request(`/api/auth/biometric/devices/${record.id}`, { method: "DELETE" }); } catch { revoked = false; }
    await this.vault.clear({ scope: this.scope }); await this.metadata.remove(this.scope);
    return { revoked };
  }
}
