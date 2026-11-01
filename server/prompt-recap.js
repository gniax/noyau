import fs from "node:fs/promises";

const recapCache = new Map();
const MAX_CACHE = 2000;

export function fallbackRecap(text) {
  if (!text || typeof text !== "string") return ["Demande utilisateur"];

  const cleaned = text
    .replace(/^@\S+\s*/, "")
    .replace(/\r\n/g, "\n")
    .trim();

  // Découpage par retours à la ligne ou points-virgules
  let rawSegments = cleaned
    .split(/(?:\n+|;|\b(?:et aussi|pareil(?:\s+faut)?|de plus|enfin|également)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  // Si un seul segment très long, découper sur les verbes d'action ou conjonctions
  if (rawSegments.length <= 1 && cleaned.length > 80) {
    rawSegments = cleaned
      .split(/(?:\b(?:faudrait que|il faudrait que|faut que|tu peux|je veux|j'aimerais|on pourrait|ajoute|rajoute|mets|fais|refais|corrige|répare|supprime|retire)\b)/i)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8);
  }

  const fillerRegex = /[\s,;]+(?:stp|svp|stpl|merci|plz|s'il te pla[iî]t|jsp|genre|bref|rbef)\b/gi;
  const bullets = [];

  for (let seg of rawSegments) {
    seg = seg
      .replace(fillerRegex, "")
      .replace(/^(?:bonjour|salut|hello|dis)[,\s]+/i, "")
      .replace(/^(?:est-ce que tu peux|peux-tu|pourrais-tu|tu peux|faudrait que|il faudrait que|faut que|il faut|faut)\s+/i, "")
      .replace(/^(?:je veux|j'aimerais bien|j'aimerais|je voudrais|on pourrait)\s+/i, "")
      .trim();

    if (seg.length >= 5) {
      const formatted = seg.charAt(0).toUpperCase() + seg.slice(1);
      bullets.push(formatted);
    }
  }

  if (bullets.length === 0) {
    return [cleaned.slice(0, 80)];
  }

  return bullets.slice(0, 10);
}

const PROMPTS = {
  request: `Tu reçois une demande tapée vite par un utilisateur français, souvent pleine de fautes. Corrige les fautes et reformule-la fidèlement, sans recopier le texte brut.
Conserve toutes les fonctionnalités, contraintes et exemples importants ; n'invente aucun détail et ne transforme pas une suggestion en obligation.
Réponds uniquement en JSON : {"title":"titre corrigé à l'infinitif ou nominal, 70 caractères maximum","bullets":["point concis", "…"]}`,
  reply: `Tu reçois la réponse d'un agent de code à son utilisateur. Résume-la fidèlement en français : ce qui est fait, ce qui reste, ce qu'il demande.
Réponds uniquement en JSON : {"title":"résumé en une phrase, 70 caractères maximum","bullets":["point concis", "…"]}`,
};

function parseRecap(content) {
  const raw = String(content || "");
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const bullets = (Array.isArray(parsed.bullets) ? parsed.bullets : []).map((b) => String(b).trim()).filter(Boolean);
    const title = String(parsed.title || bullets[0] || "").trim();
    if (title) return { title, bullets: bullets.length ? bullets : [title] };
  } catch { /* A model may ignore the format: plain lines below stay usable. */ }
  const lines = raw.split("\n").map((line) => line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  return lines.length ? { title: lines[0], bullets: lines } : null;
}

let diskCacheLoaded = false;
let saveTimer = null;

async function loadDiskCache(cacheFile) {
  if (diskCacheLoaded || !cacheFile) return;
  diskCacheLoaded = true;
  try {
    for (const [key, value] of JSON.parse(await fs.readFile(cacheFile, "utf8"))) recapCache.set(key, value);
  } catch { /* First run or unreadable cache: titles get regenerated. */ }
}

function scheduleDiskSave(cacheFile) {
  if (!cacheFile || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const temporary = `${cacheFile}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify([...recapCache]));
      await fs.rename(temporary, cacheFile);
    } catch (error) { console.error(`Cache des récapitulatifs : ${error.message}`); }
  }, 2000);
  saveTimer.unref?.();
}

export async function summarizeRequestPrompt({ text, kind = "request", cacheFile = null, fetchImpl = fetch, llmProxyUrl = process.env.NOYAU_LLM_PROXY_URL || "http://127.0.0.1:3001/v1/chat/completions", timeoutMs = 25000 }) {
  if (!text || typeof text !== "string") return { title: "Demande utilisateur", bullets: ["Demande utilisateur"], cached: true };
  const mode = PROMPTS[kind] ? kind : "request";
  const source = text.trim();
  const key = `${mode}:${source}`;
  await loadDiskCache(cacheFile);
  if (recapCache.has(key)) return { ...recapCache.get(key), cached: true, ai: true };

  try {
    const res = await fetchImpl(llmProxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "system", content: PROMPTS[mode] }, { role: "user", content: source }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = await res.json();
      const recap = parseRecap(data?.choices?.[0]?.message?.content);
      if (recap) {
        if (recapCache.size >= MAX_CACHE) recapCache.delete(recapCache.keys().next().value);
        recapCache.set(key, recap);
        scheduleDiskSave(cacheFile);
        return { ...recap, cached: false, ai: true };
      }
    }
  } catch {
    // LLM down or slow: the heuristic below keeps the panel usable.
  }

  // A fallback is not an AI result and must not poison the successful-result cache.
  const bullets = fallbackRecap(source);
  return { title: bullets[0], bullets, cached: false, ai: false };
}
