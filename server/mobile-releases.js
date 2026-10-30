import fs from "node:fs/promises";
import path from "node:path";

// Authenticated application releases are served independently of project-file
// visibility. Never accept a path or filename from the requesting client.
export async function resolveMobileRelease(dataDir, platform) {
  if (!["android", "ios"].includes(platform)) return null;
  let manifest; try { manifest = JSON.parse(await fs.readFile(path.join(dataDir, "mobile-releases.json"), "utf8")); } catch { return null; }
  const release = manifest?.[platform]; const filename = release?.filename;
  const suffix = platform === "android" ? ".apk" : ".ipa";
  if (typeof filename !== "string" || !/^noyau-[a-zA-Z0-9._-]+\.(apk|ipa)$/.test(filename) || !filename.endsWith(suffix)) return null;
  const projectPath = typeof release.url === "string" && /^\/api\/projects\/(project-[a-z0-9]+-[a-f0-9]{6})\/files\/([^/]+)$/.exec(release.url);
  const folders = [path.join(dataDir, "mobile-builds")];
  if (projectPath && projectPath[2] === filename) folders.push(path.join(dataDir, "project-files", projectPath[1]));
  for (const folder of folders) {
    const candidate = path.join(folder, filename);
    try { const info = await fs.lstat(candidate); if (info.isFile() && !info.isSymbolicLink() && info.size > 0) return { filename, file: candidate, size: info.size }; } catch { /* try shared copy */ }
  }
  return null;
}

export async function sendMobileRelease(dataDir, platform, response, next) {
  try {
    const release = await resolveMobileRelease(dataDir, platform);
    if (!release) return response.status(404).json({ error: "Application non disponible : actualisez les versions." });
    response.set("Cache-Control", "no-store");
    return response.download(release.file, release.filename, { dotfiles: "allow" }, (error) => { if (error) next(error); });
  } catch (error) { return next(error); }
}
