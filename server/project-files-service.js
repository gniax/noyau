import fs from "node:fs/promises";
import path from "node:path";

function sanitizeFilename(name) {
  const base = path.basename(String(name || "")).replace(/[/\\?%*:|"<>]/g, "_").trim();
  return base.slice(0, 150) || "fichier";
}

export class ProjectFilesService {
  constructor({ dataDir } = {}) {
    this.dataDir = path.resolve(dataDir || path.join(process.cwd(), ".data"));
    this.rootFilesDir = path.join(this.dataDir, "project-files");
  }

  async ensureProjectDir(projectId) {
    if (!projectId || !/^[a-z0-9_-]+$/i.test(projectId)) {
      throw new Error("Identifiant de projet invalide.");
    }
    const dir = path.join(this.rootFilesDir, projectId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async list(projectId) {
    const dir = await this.ensureProjectDir(projectId);
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        files.push({
          name: entry.name,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          extension: path.extname(entry.name).toLowerCase(),
        });
      } catch {
        // Ignorer fichier supprimé entre-temps
      }
    }
    return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveFile(projectId, { originalname, buffer }) {
    if (!buffer || !Buffer.isBuffer(buffer)) {
      throw new Error("Contenu de fichier manquant.");
    }
    const dir = await this.ensureProjectDir(projectId);
    let safeName = sanitizeFilename(originalname);
    let target = path.join(dir, safeName);

    // Si le fichier existe déjà, générer un nom unique en suffixant
    let counter = 1;
    const ext = path.extname(safeName);
    const stem = path.basename(safeName, ext);
    while (true) {
      try {
        await fs.access(target);
        // Existe déjà
        safeName = `${stem}_${counter}${ext}`;
        target = path.join(dir, safeName);
        counter++;
      } catch {
        // Libre
        break;
      }
    }

    await fs.writeFile(target, buffer, { mode: 0o600 });
    const stat = await fs.stat(target);
    return {
      name: safeName,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      extension: path.extname(safeName).toLowerCase(),
      path: target,
    };
  }

  async getFilePath(projectId, filename) {
    const dir = await this.ensureProjectDir(projectId);
    const safeName = sanitizeFilename(filename);
    const target = path.join(dir, safeName);
    const rel = path.relative(dir, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Accès refusé.");
    }
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      throw new Error("Fichier introuvable.");
    }
    if (!stat.isFile()) throw new Error("Fichier introuvable.");
    return target;
  }

  async deleteFile(projectId, filename) {
    const target = await this.getFilePath(projectId, filename);
    await fs.unlink(target);
    return true;
  }
}
