import { editDistance } from "./voice-commands.js";

export function cleanCorrectedText(raw, fallback = "") {
  if (!raw || typeof raw !== "string") return fallback;
  let text = raw.trim();
  const fenced = text.match(/^```(?:text|markdown)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(?:voici le texte corrigé\s*:\s*|texte corrigé\s*:\s*|correction\s*:\s*)/i, "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("«") && text.endsWith("»")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text || fallback;
}

// Ecart de securite: un petit modele peut repondre a cote (explication, reformulation).
// On mesure la distance d'edition: une correction reste proche, une reecriture s'en eloigne.
export function tooDifferent(original, corrected) {
  const a = String(original || "").trim();
  const b = String(corrected || "").trim();
  if (!b) return true;
  if (b.length > a.length * 1.5 + 20 || b.length < a.length * 0.6) return true;
  return editDistance(a, b) / Math.max(a.length, b.length) > 0.35;
}

export class TextCorrector {
  constructor({ localLlm = null } = {}) {
    this.localLlm = localLlm;
    this.lastProvider = null;
  }

  async run(text) {
    if (!this.localLlm) throw new Error("Modèle local de correction indisponible.");
    const reply = await this.localLlm.chat([
      { role: "system", content: "Corrige orthographe, grammaire et ponctuation du texte français. Réponds uniquement avec le texte corrigé. Préserve sens, noms, termes techniques, URL et identifiants." },
      { role: "user", content: "rajouter un bouton pour suprimer une liste avec confirmation" },
      { role: "assistant", content: "Rajouter un bouton pour supprimer une liste avec confirmation" },
      { role: "user", content: text },
    ], { maxTokens: 220 });
    this.lastProvider = "local";
    return reply;
  }

  async correct(text) {
    const raw = String(text || "").trim();
    if (!raw) return text;
    try {
      const reply = await this.run(raw);
      const corrected = cleanCorrectedText(reply, raw);
      // Un modele leger peut reformuler au lieu de corriger: dans le doute on garde l'original.
      return tooDifferent(raw, corrected) ? raw : corrected;
    } catch {
      return text;
    }
  }
}
