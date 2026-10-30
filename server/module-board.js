import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 512 * 1024;
const MEDIA_MAX = 4 * 1024 * 1024;
const MEDIA_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.(gif|png|webp|jpe?g)$/;
const MEDIA_TYPES = { gif: "image/gif", png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };
const TONES = new Set(["live", "ready", "wait", "bad", "neutral"]);
const text = (value, limit) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "");
const httpsUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
};

// Tableau de bord lecture seule ecrit par le module (JSON sous $HOME); images servies depuis le meme dossier.
export function boardConfig(value, homeDir) {
  if (value == null) return null;
  const file = path.resolve(String(value.file || "").replace(/^~(?=\/)/, homeDir));
  if (!file.startsWith(`${path.resolve(homeDir)}${path.sep}`) || !file.endsWith(".json")) throw new Error("Fichier tableau module invalide.");
  return { file, mediaDir: path.dirname(file) };
}

export function normalizeBoard(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.sections)) throw new Error("Tableau module invalide.");
  return {
    title: text(value.title, 80),
    summary: text(value.summary, 300),
    generatedAt: Number.isFinite(Date.parse(value.generatedAt)) ? new Date(value.generatedAt).toISOString() : null,
    sections: value.sections.slice(0, 8).map((section) => ({
      title: text(section?.title, 80),
      note: text(section?.note, 240),
      rows: (Array.isArray(section?.rows) ? section.rows : []).slice(0, 24).map((row) => (Array.isArray(row) ? row : []).slice(0, 3).map((cell) => text(String(cell ?? ""), 120))),
      cards: (Array.isArray(section?.cards) ? section.cards : []).slice(0, 24).map((card) => ({
        title: text(card?.title, 80),
        subtitle: text(card?.subtitle, 120),
        badge: text(card?.badge, 40),
        tone: TONES.has(card?.tone) ? card.tone : "neutral",
        lines: (Array.isArray(card?.lines) ? card.lines : []).slice(0, 8).map((line) => text(line, 240)).filter(Boolean),
        links: (Array.isArray(card?.links) ? card.links : []).slice(0, 4).map((link) => ({ label: text(link?.label, 40), url: httpsUrl(link?.url) })).filter((link) => link.label && link.url),
        images: (Array.isArray(card?.images) ? card.images : []).slice(0, 4).filter((image) => MEDIA_PATTERN.test(String(image?.file || ""))).map((image) => ({
          file: image.file,
          label: text(image.label, 60),
          size: image.size === "small" ? "small" : "wide",
          version: text(String(image.version ?? ""), 40),
        })),
      })),
    })),
  };
}

export async function readModuleBoard(module) {
  if (!module.board) return null;
  const stat = await fs.stat(module.board.file).catch(() => null);
  if (!stat?.isFile()) return { availability: "waiting" };
  if (stat.size > MAX_BYTES) return { availability: "unavailable" };
  try {
    return { availability: "ready", ...normalizeBoard(JSON.parse(await fs.readFile(module.board.file, "utf8"))) };
  } catch {
    return { availability: "unavailable" };
  }
}

export async function boardMedia(module, name) {
  if (!module.board || !MEDIA_PATTERN.test(String(name || ""))) throw new Error("Image introuvable.");
  const file = path.join(module.board.mediaDir, name);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MEDIA_MAX) throw new Error("Image introuvable.");
  return { file, type: MEDIA_TYPES[name.split(".").pop().toLowerCase()] };
}
