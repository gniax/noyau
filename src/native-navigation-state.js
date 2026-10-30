const key = profile => `noyau:navigation:${profile}`;
export function readNativeNavigation(storage, profile) {
  if (!profile) return null;
  try { const value = JSON.parse(storage.getItem(key(profile))); return value && typeof value === 'object' && (value.session === null || typeof value.session === 'string') && typeof value.view === 'string' ? value : null; } catch { return null; }
}
export function saveNativeNavigation(storage, profile, session, view) {
  if (!profile) return;
  try { storage.setItem(key(profile), JSON.stringify({ session: session || null, view })); } catch { /* optional */ }
}
export function clearNativeNavigation(storage, profile) { if (profile) try { storage.removeItem(key(profile)); } catch { /* optional */ } }
