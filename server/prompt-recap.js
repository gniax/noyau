const recapCache = new Map();
const MAX_CACHE = 500;

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

export async function summarizeRequestPrompt({ text, llmProxyUrl = process.env.NOYAU_LLM_PROXY_URL || "http://127.0.0.1:3001/v1/chat/completions", timeoutMs = 8000 }) {
  if (!text || typeof text !== "string") {
    return { bullets: ["Demande utilisateur"], cached: true };
  }

  const key = text.trim();
  if (recapCache.has(key)) {
    return { bullets: recapCache.get(key), cached: true };
  }

  try {
    const res = await fetch(llmProxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          {
            role: "system",
            content: "Tu es un assistant de synthèse concis. Résume la demande de l'utilisateur sous forme de points d'action clairs, lisibles et sans bavardage. Réponds UNIQUEMENT avec une liste à tirets (- Action avec verbe à l'infinitif). Aucun texte d'introduction ni de conclusion.",
          },
          {
            role: "user",
            content: key,
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || "";
      const lines = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-") || l.startsWith("•") || l.startsWith("*") || /^\d+[.)]/.test(l))
        .map((l) => l.replace(/^[-•*]\s*|\d+[.)]\s*/, "").trim())
        .filter(Boolean);

      if (lines.length > 0) {
        if (recapCache.size >= MAX_CACHE) {
          const oldestKey = recapCache.keys().next().value;
          recapCache.delete(oldestKey);
        }
        recapCache.set(key, lines);
        return { bullets: lines, cached: false, ai: true };
      }
    }
  } catch {
    // Échec ou timeout LLM -> fallback heuristique
  }

  const fallback = fallbackRecap(key);
  if (recapCache.size >= MAX_CACHE) {
    const oldestKey = recapCache.keys().next().value;
    recapCache.delete(oldestKey);
  }
  recapCache.set(key, fallback);
  return { bullets: fallback, cached: false, ai: false };
}
