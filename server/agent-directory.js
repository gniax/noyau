import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function folderName(value) {
  return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

// Nobody should need an absolute path to start an agent: the folder follows from the project or the name.
export async function resolveAgentDirectory({ cwd, name, project, workspaceRoot }) {
  const root = path.resolve(workspaceRoot);
  const wanted = String(cwd || "").trim().replace(/^~(?=$|\/)/, os.homedir());
  let target;
  if (wanted) target = path.resolve(root, wanted);
  else if (project?.rootPath) return path.resolve(project.rootPath);
  else if (folderName(project?.name)) target = path.join(root, folderName(project.name));
  else target = folderName(name) ? path.join(root, folderName(name)) : root;
  const stat = await fs.stat(target).catch(() => null);
  if (stat) {
    if (!stat.isDirectory()) throw new Error("Dossier de travail invalide.");
    return target;
  }
  // Only ever creates under the projects folder: a typo elsewhere stays an error.
  if (!inside(root, target)) throw new Error("Dossier de travail introuvable.");
  await fs.mkdir(target, { recursive: true });
  return target;
}
