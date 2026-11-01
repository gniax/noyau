export class DevicePresence {
  constructor({ now = () => Date.now(), ttl = 45000 } = {}) { this.now = now; this.ttl = ttl; this.devices = new Map(); }
  update(profileId, deviceId, sessionId, visible) {
    if (!deviceId || !profileId) return;
    const key = `${profileId}\0${deviceId}`;
    if (!visible) { this.devices.delete(key); return; }
    this.devices.set(key, { at: this.now(), sessionId, profileId, deviceId });
  }
  list(profileId) {
    const now = this.now();
    for (const [id, item] of this.devices) if (now - item.at > this.ttl) this.devices.delete(id);
    return [...this.devices.values()].filter((item) => item.profileId === profileId).sort((a,b) => b.at-a.at);
  }
  watching(profileId, sessionId) { return Boolean(sessionId && this.list(profileId).some((item) => item.sessionId === sessionId)); }
  active(profileId) { return this.list(profileId)[0]?.deviceId || null; }
}
