const TYPO_REPLACEMENTS = [
  [/\b(lsiible|lsiibles)\b/gi, "lisible"],
  [/\b(grenre)\b/gi, "genre"],
  [/\b(avecd)\b/gi, "avec"],
  [/\b(cets|cesr|c est)\b/gi, "c'est"],
  [/\b(pur|poru|porur)\b/gi, "pour"],
  [/\b(aegnt|aegnts)\b/gi, "agent"],
  [/\b(damndes)\b/gi, "demandes"],
  [/\b(su temps)\b/gi, "du temps"],
  [/\b(shitft)\b/gi, "shift"],
  [/\b(entrer)\b/gi, "entrée"],
  [/\b(lrie)\b/gi, "lire"],
  [/\b(tacghe)\b/gi, "tâche"],
  [/\b(motnre)\b/gi, "montre"],
  [/\b(corrspond)\b/gi, "correspond"],
  [/\b(instlaler|isnaller)\b/gi, "installer"],
];

const STOP_WORDS = new Set([
  "avec", "dans", "pour", "plus", "tout", "tous", "toute", "toutes", "faire", "fait",
  "bien", "cette", "cet", "ces", "aussi", "leur", "leurs", "sans", "comme", "votre",
  "notre", "nos", "vos", "quel", "quelle", "quels", "quelles", "être", "avoir",
  "suis", "sont", "nous", "vous", "ils", "elles", "mais", "donc", "alors", "après",
  "avant", "vers", "chez", "sous", "sur", "entre", "depuis", "pendant", "même",
  "encore", "déjà", "très", "trop", "peux", "peut", "faut", "dire",
  "aller", "vais", "vont", "autre", "autres", "premier", "1er", "première", "voir",
  "mettre", "mets", "met", "passer", "passe", "reste", "restent", "chaque", "chose",
  "merci", "salut", "bonjour", "mode", "projet", "page", "site", "agent", "message",
  "demande", "demandes", "affiche", "afficher", "changer", "change", "enlever", "supprimer",
  "ajouter", "ajoute", "rajoute", "rajouter", "créer", "crée"
]);

function cleanTypoWords(str) {
  let res = str;
  for (const [pattern, replacement] of TYPO_REPLACEMENTS) {
    res = res.replace(pattern, replacement);
  }
  return res;
}

export function extractKeywords(str) {
  if (!str || typeof str !== "string") return [];
  return String(str)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

export function findMatchingTodo(text, allTodos = [], projectId = null) {
  if (!text || !allTodos?.length) return null;

  // 1. Référence explicite *XXXX (insensible à la casse)
  const refMatch = String(text).match(/\*([A-Za-z0-9]{3,8})\b/);
  if (refMatch) {
    const refStr = `*${refMatch[1].toUpperCase()}`;
    const found = allTodos.find((t) => t.ref?.toUpperCase() === refStr);
    if (found) return found;
  }

  // 2. Filtrage par projet : on n'associe pas un todo d'un autre projet
  const candidateTodos = projectId
    ? allTodos.filter((t) => !t.projectId || t.projectId === projectId)
    : allTodos;

  const lowerText = String(text).toLowerCase();

  // 3. Référence textuelle directe du ref
  for (const t of candidateTodos) {
    if (t.ref && lowerText.includes(t.ref.toLowerCase())) return t;
  }

  // 4. Mots-clés significatifs sans faux positifs
  const queryKeywords = new Set(extractKeywords(text));
  if (queryKeywords.size < 2) return null;

  let bestTodo = null;
  let bestScore = 0;

  for (const t of candidateTodos) {
    const todoKeywords = extractKeywords(t.text);
    if (todoKeywords.length < 2) continue;

    let matchCount = 0;
    for (const kw of todoKeywords) {
      if (queryKeywords.has(kw)) matchCount++;
    }

    const ratio = matchCount / todoKeywords.length;
    const isStrongMatch =
      (matchCount >= 3 && ratio >= 0.4) ||
      (matchCount >= 2 && todoKeywords.length <= 3 && ratio >= 0.65);

    if (isStrongMatch && matchCount > bestScore) {
      bestScore = matchCount;
      bestTodo = t;
    }
  }

  return bestTodo;
}

export function fallbackRecap(text, todo = null) {
  if (!text || typeof text !== "string") return ["Demande utilisateur"];

  let cleaned = text
    .replace(/^@\S+\s*/, "")
    .replace(/\r\n/g, "\n")
    .trim();

  cleaned = cleanTypoWords(cleaned);

  let rawSegments = cleaned
    .split(/(?:\n+|;|\.(?:\s+|$)|(?<=\s|^)(?:et aussi|pareil(?:\s+faut)?|de plus|enfin|également|en plus|d'ailleurs)(?=\s|$))/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (rawSegments.length <= 1 && cleaned.length > 70) {
    rawSegments = cleaned
      .split(/(?:\b(?:faudrait que|il faudrait que|faut que|tu peux|je veux|j'aimerais|on pourrait|ajoute|rajoute|mets|fais|refais|corrige|répare|supprime|retire|propose)\b)/i)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
  }

  const fillerRegex = /[\s,;]+(?:stp|svp|stpl|merci|plz|s'il te pla[iî]t|jsp|genre|bref|rbef)\b/gi;
  const bullets = [];
  const seen = new Set();

  if (todo?.text) {
    const todoLine = `Tâche : ${todo.text}`;
    bullets.push(todoLine);
    seen.add(todoLine.toLowerCase());
  }

  for (let seg of rawSegments) {
    seg = seg
      .replace(fillerRegex, "")
      .replace(/^(?:bonjour|salut|hello|dis)[,\s]+/i, "")
      .replace(/^(?:est-ce que tu peux|peux-tu|pourrais-tu|tu peux|faudrait que|il faudrait que|faut que|il faut|faut)\s+/i, "")
      .replace(/^(?:je veux|j'aimerais bien|j'aimerais|je voudrais|on pourrait)\s+/i, "")
      .trim();

    if (seg.length >= 4) {
      const formatted = seg.charAt(0).toUpperCase() + seg.slice(1);
      const lower = formatted.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        bullets.push(formatted);
      }
    }
  }

  return bullets.length > 0 ? bullets.slice(0, 10) : [cleaned.slice(0, 80)];
}

export function reformulateRequest(text, todo = null) {
  if (todo?.text) {
    const todoTitle = String(todo.text).replace(/\s+/g, " ").trim();
    return todoTitle.length <= 50 ? todoTitle : `${todoTitle.slice(0, 48)}…`;
  }
  if (!text) return "Demande";

  let s = cleanTypoWords(String(text))
    .replace(/^@\S+\s*/, "")
    .replace(/^(?:bonjour|salut|hello|dis|stp|s'il te pla[iî]t|merci)[,\s]+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const introPatterns = [
    /^(?:est-ce que tu peux|peux-tu|pourrais-tu|tu peux|faudrait que|il faudrait que|faut que|il faut|faut)\s+/i,
    /^(?:je veux|j'aimerais bien|j'aimerais|je voudrais|on pourrait)\s+/i,
    /^(?:ajoute|rajoute|mets|fais|refais|crée|supprime|retire|enlève|corrige|répare|change|modifie)\s+/i,
  ];

  for (const p of introPatterns) {
    s = s.replace(p, "").trim();
  }

  if (s.includes(";")) {
    const parts = s.split(";").map((p) => p.trim()).filter(Boolean);
    if (parts[0] && parts[0].length >= 10) s = parts[0];
  }

  s = s.replace(/[\s,;]+(?:stp|merci|svp|stpl|plz)\b/gi, "").trim();
  if (!s) return "Demande utilisateur";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 50 ? `${s.slice(0, 48)}…` : s;
}
