import { applyGroceryOperation, initialGroceries } from "../shared/groceries.js";

const key = (profileId) => `noyau:groceries:${profileId || "local"}`;
export function readGroceriesLocal(profileId, storage = localStorage) {
  try { const saved = JSON.parse(storage.getItem(key(profileId)) || "null"); if (saved?.server && Array.isArray(saved.pending)) return saved; } catch { /* first use */ }
  return { server: initialGroceries(), pending: [], lastSyncAt: null };
}
export function optimisticGroceries(local) { return local.pending.reduce((state, operation) => applyGroceryOperation(state, operation), structuredClone(local.server)); }
export function queueGroceryOperation(local, operation) { applyGroceryOperation(optimisticGroceries(local), operation); return { ...local, pending: [...local.pending, operation] }; }
export function persistGroceries(profileId, local, storage = localStorage) { storage.setItem(key(profileId), JSON.stringify(local)); }

export class GroceryClient {
  constructor({ profileId, storageId = profileId, request, storage = localStorage, onChange = () => {} }) { this.profileId = profileId; this.storageId = storageId; this.request = request; this.storage = storage; this.onChange = onChange; this.local = readGroceriesLocal(storageId, storage); this.conflict = null; this.syncing = null; }
  state() { return optimisticGroceries(this.local); }
  publish() { persistGroceries(this.storageId, this.local, this.storage); this.onChange(this.state(), { pending: this.local.pending.length, lastSyncAt: this.local.lastSyncAt, conflict: this.conflict, syncing: Boolean(this.syncing) }); }
  dispatch(type, payload) { this.local = queueGroceryOperation(this.local, { id: crypto.randomUUID(), type, payload }); this.publish(); return this.state(); }
  async sync({ rebase = false } = {}) {
    if (this.syncing) return this.syncing;
    if (this.conflict && !rebase) return;
    if (rebase && this.conflict) { const rebased = { ...this.local, server: this.conflict }; optimisticGroceries(rebased); this.local = rebased; this.conflict = null; }
    const execute = async () => {
      const batch = this.local.pending.slice(0, 200); const base = this.local.server.revision;
      const result = await this.request(batch.length ? "/api/groceries/sync" : `/api/groceries?revision=${base}`, batch.length ? { method: "POST", body: JSON.stringify({ baseRevision: base, operations: batch }) } : {});
      if (result.unchanged) { this.local.lastSyncAt = new Date().toISOString(); this.publish(); return; }
      if (result.conflict) { this.conflict = result.state; this.publish(); return; }
      const accepted = new Set(result.accepted || []);
      const candidate = { server: result.state, pending: this.local.pending.filter((operation) => !accepted.has(operation.id)), lastSyncAt: new Date().toISOString() };
      try { optimisticGroceries(candidate); } catch { this.conflict = result.state; this.publish(); return; }
      this.local = candidate;
      this.publish();
    };
    this.syncing = execute();
    try { await this.syncing; } finally { this.syncing = null; this.publish(); }
    // Edits made during an in-flight request are retained and sent separately.
    if (this.local.pending.length && !this.conflict) return this.sync();
  }
  useServer() { if (this.conflict) { this.local = { server: this.conflict, pending: [], lastSyncAt: new Date().toISOString() }; this.conflict = null; this.publish(); } }
}
