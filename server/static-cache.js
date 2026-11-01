import path from "node:path";

// L'app iOS n'a pas de service worker: sans ces en-tetes, chaque ouverture revalide tout sur le reseau.
export function staticCachePolicy(filePath) {
  const normalized = String(filePath).split(path.sep).join("/");
  if (/\/sw\.js$|\.html$/.test(normalized)) return null;
  if (normalized.includes("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=86400, stale-while-revalidate=604800";
}

export function staticCacheHeaders(response, filePath) {
  const policy = staticCachePolicy(filePath);
  if (policy && !response.getHeader("Cache-Control")) response.setHeader("Cache-Control", policy);
}
