import fs from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg", ".ico"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "vendor", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", ".cache", "target", "tmp", "logs"]);

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
}
