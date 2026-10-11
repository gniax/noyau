#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.NOYAU_DATA_DIR || path.join(root, ".data"));
const rootFilesDir = path.join(dataDir, "project-files");

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || "")).replace(/[/\\?%*:|"<>]/g, "_").trim();
  return base.slice(0, 150) || "fichier";
}

async function loadData() {
  const [projectsRaw, sessionsRaw] = await Promise.all([
    fs.readFile(path.join(dataDir, "projects.json"), "utf8").then(JSON.parse).catch(() => ({})),
    fs.readFile(path.join(dataDir, "sessions.json"), "utf8").then(JSON.parse).catch(() => ({})),
  ]);
  return { projects: projectsRaw, sessions: sessionsRaw };
}

async function resolveProject(targetIdentifier, { projects, sessions, cwd }) {
  const target = String(targetIdentifier || "").trim().toLowerCase();

  // 1. Si identifiant explicite fourni
  if (target) {
    // Par ID exact
    if (projects[target]) {
      return { id: target, ...projects[target] };
    }
    // Par nom exact insensible à la casse
    for (const [id, p] of Object.entries(projects)) {
      if (String(p.name || "").trim().toLowerCase() === target) {
        return { id, ...p };
      }
    }
    // Par sous-chaîne dans nom ou ID
    for (const [id, p] of Object.entries(projects)) {
      if (id.toLowerCase().includes(target) || String(p.name || "").toLowerCase().includes(target)) {
        return { id, ...p };
      }
    }
    throw new Error(`Projet « ${targetIdentifier} » introuvable parmi : ${Object.values(projects).map((p) => p.name).join(", ")}`);
  }

  // 2. Variable d'environnement
  if (process.env.NOYAU_PROJECT_ID && projects[process.env.NOYAU_PROJECT_ID]) {
    return { id: process.env.NOYAU_PROJECT_ID, ...projects[process.env.NOYAU_PROJECT_ID] };
  }

  // 3. Détection par session active ou cwd
  const realCwd = path.resolve(cwd || process.cwd());
  const matchingSessions = Object.entries(sessions)
    .filter(([, s]) => s?.cwd && (realCwd === path.resolve(s.cwd) || realCwd.startsWith(`${path.resolve(s.cwd)}${path.sep}`)))
    .sort((a, b) => Date.parse(b[1].agentStateUpdatedAt || 0) - Date.parse(a[1].agentStateUpdatedAt || 0));

  for (const [, s] of matchingSessions) {
    if (s.projectId && projects[s.projectId]) {
      return { id: s.projectId, ...projects[s.projectId] };
    }
  }

  // 4. Détection par correspondance du nom de dossier cwd avec un nom de projet
  const cwdParts = realCwd.toLowerCase().split(path.sep);
  for (const [id, p] of Object.entries(projects)) {
    const pName = String(p.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (pName && cwdParts.some((part) => part.replace(/[^a-z0-9]/g, "").includes(pName))) {
      return { id, ...p };
    }
  }

  // 5. Si un seul projet existe
  const allProjects = Object.entries(projects);
  if (allProjects.length === 1) {
    return { id: allProjects[0][0], ...allProjects[0][1] };
  }

  throw new Error(
    `Impossible de déterminer le projet depuis ${realCwd}. Spécifie le nom du projet (ex: atlas, octanix). Projets disponibles : ${Object.values(projects).map((p) => p.name).join(", ")}`
  );
}

async function ensureProjectDir(projectId) {
  const dir = path.join(rootFilesDir, projectId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function print(data) {
  process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
}

const args = process.argv.slice(2);
const command = (args[0] || "list").toLowerCase();

try {
  const cwd = path.resolve(process.cwd());
  const { projects, sessions } = await loadData();

  if (["projects", "list-projects", "projets"].includes(command)) {
    const list = Object.entries(projects).map(([id, p]) => ({
      id,
      name: p.name,
      shared: Boolean(p.shared),
      dir: path.join(rootFilesDir, id),
    }));
    print(list);
    process.exit(0);
  }

  if (["path", "dir", "dossier"].includes(command)) {
    const project = await resolveProject(args[1], { projects, sessions, cwd });
    const dir = await ensureProjectDir(project.id);
    print(dir);
    process.exit(0);
  }

  if (["list", "ls"].includes(command)) {
    const project = await resolveProject(args[1], { projects, sessions, cwd });
    const dir = await ensureProjectDir(project.id);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        files.push({
          name: entry.name,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size),
          updatedAt: stat.mtime.toISOString(),
          path: filePath,
          url: `/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(entry.name)}`,
        });
      } catch {}
    }
    files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    print({
      project: project.name,
      projectId: project.id,
      directory: dir,
      count: files.length,
      files,
    });
    process.exit(0);
  }

  if (["put", "add", "upload", "push", "deposer"].includes(command)) {
    const sourceFilePath = args[1];
    if (!sourceFilePath) {
      throw new Error("Usage: node scripts/noyau-file.mjs put <chemin-source> [nom-destination] [projet]");
    }
    const resolvedSource = path.resolve(cwd, sourceFilePath);
    const stat = await fs.stat(resolvedSource).catch(() => {
      throw new Error(`Fichier source introuvable : ${resolvedSource}`);
    });
    if (!stat.isFile()) throw new Error(`Ce n'est pas un fichier régulier : ${resolvedSource}`);

    const ext = path.extname(resolvedSource).toLowerCase();
    const isCode = [".js", ".jsx", ".ts", ".tsx", ".php", ".py", ".rb", ".go", ".rs", ".c", ".cpp", ".java", ".vue", ".svelte"].includes(ext);
    if (isCode && !process.argv.includes("--force")) {
      throw new Error(`Le code source (${ext}) doit être modifié directement dans le dépôt Git du projet, pas dans les Fichiers Partagés Noyau (réservés aux images, médias, documents, PDF, exports et archives).`);
    }

    // Args optionnels: [nom-destination] [projet]
    let destName = null;
    let targetProject = null;
    if (args[2]) {
      // Si args[2] correspond à un projet connu, alors args[2] est le projet
      try {
        const p = await resolveProject(args[2], { projects, sessions, cwd });
        targetProject = p;
      } catch {
        destName = args[2];
        if (args[3]) {
          targetProject = await resolveProject(args[3], { projects, sessions, cwd });
        }
      }
    }
    if (!targetProject) {
      targetProject = await resolveProject(null, { projects, sessions, cwd });
    }

    const dir = await ensureProjectDir(targetProject.id);
    const filename = sanitizeFilename(destName || path.basename(resolvedSource));
    const targetPath = path.join(dir, filename);

    await fs.copyFile(resolvedSource, targetPath);
    await fs.chmod(targetPath, 0o600).catch(() => {});

    print({
      success: true,
      action: "put",
      project: targetProject.name,
      projectId: targetProject.id,
      filename,
      size: stat.size,
      sizeFormatted: formatBytes(stat.size),
      savedTo: targetPath,
      url: `/api/projects/${encodeURIComponent(targetProject.id)}/files/${encodeURIComponent(filename)}`,
    });
    process.exit(0);
  }

  if (["get", "pull", "download", "recuperer"].includes(command)) {
    const filename = args[1];
    if (!filename) {
      throw new Error("Usage: node scripts/noyau-file.mjs get <nom-fichier> [chemin-destination] [projet]");
    }
    let destPath = null;
    let targetProject = null;
    if (args[2]) {
      try {
        const p = await resolveProject(args[2], { projects, sessions, cwd });
        targetProject = p;
      } catch {
        destPath = args[2];
        if (args[3]) {
          targetProject = await resolveProject(args[3], { projects, sessions, cwd });
        }
      }
    }
    if (!targetProject) {
      targetProject = await resolveProject(null, { projects, sessions, cwd });
    }

    const dir = await ensureProjectDir(targetProject.id);
    const safeName = sanitizeFilename(filename);
    const sourcePath = path.join(dir, safeName);
    const stat = await fs.stat(sourcePath).catch(() => {
      throw new Error(`Fichier « ${filename} » introuvable dans le dossier partagé du projet ${targetProject.name}`);
    });

    let finalDest = path.resolve(cwd, destPath || safeName);
    const destStat = await fs.stat(finalDest).catch(() => null);
    if (destStat?.isDirectory()) {
      finalDest = path.join(finalDest, safeName);
    }

    await fs.copyFile(sourcePath, finalDest);
    print({
      success: true,
      action: "get",
      project: targetProject.name,
      filename: safeName,
      sizeFormatted: formatBytes(stat.size),
      downloadedTo: finalDest,
    });
    process.exit(0);
  }

  if (["delete", "rm", "supprimer"].includes(command)) {
    const filename = args[1];
    if (!filename) throw new Error("Usage: node scripts/noyau-file.mjs delete <nom-fichier> [projet]");
    const targetProject = await resolveProject(args[2], { projects, sessions, cwd });
    const dir = await ensureProjectDir(targetProject.id);
    const safeName = sanitizeFilename(filename);
    const target = path.join(dir, safeName);
    await fs.unlink(target).catch(() => {
      throw new Error(`Fichier introuvable : ${safeName}`);
    });
    print({ success: true, action: "delete", project: targetProject.name, filename: safeName });
    process.exit(0);
  }

  throw new Error(`Commande inconnue : « ${command} ». Commandes valides : list, put, get, path, delete, projects.`);
} catch (error) {
  process.stderr.write(`Erreur: ${error.message}\n`);
  process.exit(1);
}
