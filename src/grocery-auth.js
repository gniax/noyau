// The grocery client must use the same authenticated session as the rest of Noyau.
export function grocerySessionHeaders(profileId, storage = globalThis.localStorage) {
  let token = null;
  try { token = storage?.getItem('noyau:token') || storage?.getItem('token') || null; } catch { /* cookies or paired-device authentication may still work */ }
  return { 'Content-Type': 'application/json', ...(profileId ? { 'X-Noyau-Profile': profileId } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
