// Versioned, profile-scoped image cache; API data and session tokens are never cached.
const THUMB_SIZE = 96;
const thumbKey = (src) => {
  const url = new URL(src, 'https://localhost');
  url.searchParams.delete('v');
  return `noyau-thumb:${url.pathname}${url.search}`;
};
// Sans le numero de version: apres une retouche du projet, l'ancien logo reste affiche le temps de charger le nouveau.
export function readProjectThumb(src, store = globalThis.localStorage) {
  try { return store?.getItem(thumbKey(src)) || null; } catch { return null; }
}
export async function saveProjectThumb(src, blob, { store = globalThis.localStorage, makeBitmap = globalThis.createImageBitmap, doc = globalThis.document } = {}) {
  if (!store || !makeBitmap || !doc) return;
  try {
    const bitmap = await makeBitmap(blob);
    const ratio = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    store.setItem(thumbKey(src), canvas.toDataURL('image/png'));
  } catch { /* vignette optionnelle */ }
}
export async function cachedProjectImage(src, scope, { storage = globalThis.caches, fetchImpl = globalThis.fetch, thumb = saveProjectThumb } = {}) {
  const url = new URL(src, globalThis.location?.origin || 'https://localhost');
  const cacheable = url.pathname.startsWith('/api/') && url.searchParams.has('v');
  let cache = null;
  if (cacheable && storage) {
    try { cache = await storage.open(`project-images:${scope}`); const saved = await cache.match(url.href); if (saved) { const blob = await saved.blob(); if (!readProjectThumb(src)) void thumb(src, blob); return blob; } } catch { /* storage unavailable */ }
  }
  const response = await fetchImpl(src, { credentials: 'include' });
  if (!response.ok) throw new Error('Image indisponible');
  const blob = await response.blob();
  void thumb(src, blob);
  if (cache && blob.type.startsWith('image/') && blob.size <= 2 * 1024 * 1024) {
    try { await cache.put(url.href, new Response(blob, { headers: { 'Content-Type': blob.type } })); if (cache.keys && cache.delete) { const keys = await cache.keys(); for (const key of keys.slice(0, Math.max(0, keys.length - 80))) await cache.delete(key); } } catch { /* storage full */ }
  }
  return blob;
}
