import { applyGroceryOperation, initialGroceries } from "../shared/groceries.js";

const key = (profileId) => `noyau:groceries:${profileId || "local"}`;
export function readGroceriesLocal(profileId, storage = localStorage) {
  try { const saved = JSON.parse(storage.getItem(key(profileId)) || "null"); if (saved?.server && Array.isArray(saved.pending)) return saved; } catch { /* first use */ }
  return { server: initialGroceries(), pending: [], lastSyncAt: null };
}
export function optimisticGroceries(local) { return local.pending.reduce((state, operation) => applyGroceryOperation(state, operation), structuredClone(local.server)); }
export function queueGroceryOperation(local, operation) { applyGroceryOperation(optimisticGroceries(local), operation); return { ...local, pending: [...local.pending, operation] }; }
// Imported photos can fill the 5 MB quota: losing them offline beats losing the whole menu.
export function persistGroceries(profileId, local, storage = localStorage) {
  try { storage.setItem(key(profileId), JSON.stringify(local)); }
  catch { const light = structuredClone(local); for (const recipe of light.server.customRecipes || []) recipe.imageData = ""; for (const operation of light.pending) if (operation.payload?.imageData) operation.payload.imageData = ""; try { storage.setItem(key(profileId), JSON.stringify(light)); } catch { /* memory state stays authoritative for this session */ } }
}
const scanKey = (profileId) => `noyau:groceries-scan:${profileId || "local"}`;
export function readCachedScan(profileId, storage = localStorage) { try { return JSON.parse(storage.getItem(scanKey(profileId)) || "null"); } catch { return null; } }
export function cacheScan(profileId, scan, storage = localStorage) { try { storage.setItem(scanKey(profileId), JSON.stringify(scan)); } catch { try { storage.setItem(scanKey(profileId), JSON.stringify({ ...scan, deals: (scan.deals || []).map(({ imageData, ...deal }) => deal) })); } catch { /* cache only */ } } }

export class GroceryClient {
  constructor({ profileId, storageId = profileId, request, storage = localStorage, onChange = () => {} }) { this.profileId = profileId; this.storageId = storageId; this.request = request; this.storage = storage; this.onChange = onChange; this.local = readGroceriesLocal(storageId, storage); this.conflict = null; this.invalid = null; this.syncing = null; }
  state() {
    let state = structuredClone(this.local.server);
    for (const operation of this.local.pending) {
      try { state = applyGroceryOperation(state, operation); }
      catch (error) { if (!this.invalid) this.invalid = { operationId: operation.id, error: error.message }; }
    }
    return state;
  }
  publish() { persistGroceries(this.storageId, this.local, this.storage); this.onChange(this.state(), { pending: this.local.pending.length, lastSyncAt: this.local.lastSyncAt, conflict: this.conflict, invalid: this.invalid, syncing: Boolean(this.syncing) }); }
  dispatch(type, payload) { this.local = queueGroceryOperation(this.local, { id: crypto.randomUUID(), type, payload }); this.publish(); return this.state(); }
  async sync({ rebase = false } = {}) {
    if (this.syncing) return this.syncing;
    if (this.invalid) return;
    if (this.conflict && !rebase) return;
    if (rebase && this.conflict) {
      this.local = { ...this.local, server: this.conflict }; this.conflict = null; this.publish();
      if (this.invalid) return;
    }
    let conflictRetries = 0;
    const execute = async () => {
      const batch = this.local.pending.slice(0, 200); const base = this.local.server.revision;
      const result = await this.request(batch.length ? "/api/groceries/sync" : `/api/groceries?revision=${base}`, batch.length ? { method: "POST", body: JSON.stringify({ baseRevision: base, operations: batch }) } : {});
      if (result.unchanged) { this.local.lastSyncAt = new Date().toISOString(); this.publish(); return; }
      if (result.conflict) {
        // Household members edit concurrently: operations are semantic, so replay them on the newer state.
        if (conflictRetries < 3) { try { optimisticGroceries({ server: result.state, pending: this.local.pending }); this.local = { ...this.local, server: result.state }; conflictRetries++; return await execute(); } catch { /* a real clash stays explicit below */ } }
        this.conflict = result.state; this.publish(); return;
      }
      if (result.invalid) { this.local = { ...this.local, server: result.state }; this.invalid = { operationId: result.operationId, error: result.error }; this.publish(); return; }
      const accepted = new Set(result.accepted || []);
      const candidate = { server: result.state, pending: this.local.pending.filter((operation) => !accepted.has(operation.id)), lastSyncAt: new Date().toISOString() };
      try { optimisticGroceries(candidate); } catch { this.conflict = result.state; this.publish(); return; }
      this.local = candidate;
      this.publish();
    };
    this.syncing = execute();
    try { await this.syncing; } finally { this.syncing = null; this.publish(); }
    // Edits made during an in-flight request are retained and sent separately.
    if (this.local.pending.length && !this.conflict && !this.invalid) return this.sync();
  }
  discardInvalid() {
    if (!this.invalid) return false;
    const candidate = { ...this.local, pending: this.local.pending.filter((operation) => operation.id !== this.invalid.operationId) };
    this.local = candidate; this.invalid = null; this.publish(); return true;
  }
  useServer() { if (this.conflict) { this.local = { server: this.conflict, pending: [], lastSyncAt: new Date().toISOString() }; this.conflict = null; this.publish(); } }
}
