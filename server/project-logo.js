import fs from "node:fs/promises";
import path from "node:path";

export const IMAGE_EXTENSIONS = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg", ".ico", ".gif", ".avif"]);
export const IGNORED_DIRECTORIES = new Set(["node_modules", "vendor", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", ".cache", "target", "tmp", "logs", ".data", ".gemini"]);

function candidateScore(file, depth) {
  const extension = path.extname(file).toLowerCase();
  const name = path.basename(file, extension).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let score = 0;
  if (name === "logo") score = 120;
  else if (["app-logo", "brand-logo", "logo-mark"].includes(name)) score = 112;
  else if (["icon", "app-icon", "apple-touch-icon"].includes(name)) score = 100;
  else if (name === "favicon") score = 92;
  else if (name.includes("logo")) score = 80;
  else if (name.includes("icon")) score = 60;
  if (!score) return 0;
  if (extension === ".svg") score += 8;
  if (/(^|\/)public|assets|static|resources(\/|$)/i.test(file)) score += 6;
  return score - depth * 2;
}

export class ProjectLogoService {
  constructor({ maxDepth = 6, maxEntries = 3000, ttl = 60_000 } = {}) {
    this.maxDepth = maxDepth;
    this.maxEntries = maxEntries;
    this.ttl = ttl;
    this.cache = new Map();
    this.listCache = new Map();
  }

  clearCache() {
    this.cache.clear();
    this.listCache.clear();
  }

  async find(root) {
    const resolved = path.resolve(root);
    const cached = this.cache.get(resolved);
    if (cached && cached.expires > Date.now()) return cached.value;
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return null;
    const queue = [{ directory: resolved, depth: 0 }];
    const candidates = [];
    let visited = 0;
    while (queue.length && visited < this.maxEntries) {
      const { directory, depth } = queue.shift();
      let entries = [];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch { /* unreadable directory */ }
      for (const entry of entries) {
        if (++visited > this.maxEntries) break;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory() && depth < this.maxDepth && !IGNORED_DIRECTORIES.has(entry.name) && !entry.isSymbolicLink()) {
          queue.push({ directory: target, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const score = candidateScore(path.relative(resolved, target), depth);
        if (score) candidates.push({ target, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.target.length - b.target.length);
    const value = candidates[0]?.target || null;
    this.cache.set(resolved, { value, expires: Date.now() + this.ttl });
    return value;
  }

  async list(roots, { offset = 0, limit = 30, search = "" } = {}) {
    const listRoots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map((r) => path.resolve(r));
    if (!listRoots.length) return { images: [], total: 0, hasMore: false };
    const cacheKey = listRoots.slice().sort().join("::");
    let cached = this.listCache.get(cacheKey);
    if (!cached || cached.expires <= Date.now()) {
      const candidates = [];
      const seen = new Set();
      let visited = 0;
      const maxEntries = this.maxEntries * 2;
      const maxImages = 1500;

      for (const root of listRoots) {
        let stat;
        try {
          stat = await fs.stat(root);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        const queue = [{ directory: root, depth: 0, originRoot: root }];
        while (queue.length && visited < maxEntries && candidates.length < maxImages) {
          const { directory, depth, originRoot } = queue.shift();
          let dir;
          try {
            dir = await fs.opendir(directory);
            for await (const entry of dir) {
              if (++visited > maxEntries || candidates.length >= maxImages) break;
              const target = path.join(directory, entry.name);
              if (entry.isDirectory()) {
                if (depth < this.maxDepth && !IGNORED_DIRECTORIES.has(entry.name) && !entry.isSymbolicLink()) {
                  queue.push({ directory: target, depth: depth + 1, originRoot });
                }
                continue;
              }
              if (!entry.isFile()) continue;
              const ext = path.extname(entry.name).toLowerCase();
              if (!IMAGE_EXTENSIONS.has(ext)) continue;
              if (seen.has(target)) continue;
              seen.add(target);

              const relativePath = path.relative(originRoot, target);
              const score = candidateScore(relativePath, depth);
              candidates.push({
                path: target,
                name: entry.name,
                relativePath,
                extension: ext,
                score,
              });
            }
          } catch {
            /* unreadable */
          } finally {
            try { await dir?.close(); } catch {}
          }
        }
      }

      candidates.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
      cached = { candidates, expires: Date.now() + this.ttl };
      this.listCache.set(cacheKey, cached);
    }

    let items = cached.candidates;
    if (search) {
      const q = String(search).toLowerCase();
      items = items.filter((c) => c.name.toLowerCase().includes(q) || c.relativePath.toLowerCase().includes(q));
    }

    const start = Math.max(0, Number(offset) || 0);
    const count = Math.max(1, Math.min(100, Number(limit) || 30));
    const page = items.slice(start, start + count);

    return {
      images: page,
      total: items.length,
      hasMore: start + count < items.length,
    };
  }
}
