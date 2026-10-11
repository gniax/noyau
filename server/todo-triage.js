// Tri des demandes utilisateur: le modele local decide si un prompt merite une tache,
// s'il double une tache existante, et sous quel titre. Aucun quota IA n'est consomme.

const SYSTEM = [
  "Tu classes des demandes adressées à un agent de développement.",
  "Réponds uniquement par un JSON compact, sans texte autour, sans bloc de code.",
  'Format: {"type":"bug"|"evolution"|"autre","titre":"…","doublon":"REF"|null,"priorite":"high"|"medium"|"low","dossier":"NOM_OU_ID"|null}',
  "bug: quelque chose qui ne marche pas et doit être corrigé sur le code ou le produit.",
  "evolution: une demande de changement, d'ajout, de déplacement ou une préférence sur le produit, même formulée mollement.",
  "autre: une question, une discussion, une commande ponctuelle (lancer les tests, lire un fichier, git), OU une action de pilotage de Noyau/agent (passation, passer la main, changer d'agent, relancer un agent, dicter).",
  "RÈGLE STRICTE: Ne JAMAIS créer de tâche pour piloter Noyau ou les agents (ex: « préparer la passation vers codex », « passer la main », « relancer l'agent », « ouvrir codex »). Ce sont TOUJOURS des actions de type \"autre\" sans tâche.",
  "titre: une phrase courte à l'infinitif, moins de 90 caractères, en français.",
  "doublon: la référence d'une tâche existante si la demande porte sur le même sujet, sinon null.",
  "priorite: high pour un bug bloquant, une panne ou un besoin urgent/critique ; low pour cosmétique, confort ou tâche secondaire ; medium pour évolution normale ou bug standard.",
  "dossier: si des sous-dossiers sont listés, choisis le plus adapté selon le sujet (ex: pour du code, dev, tests, api, backend -> dossier code/développement ; pour du design, maquette, visuel, ui, css, graphisme, logo -> dossier design ; marketing, ventes -> dossier marketing ; personnel -> personnel). Sinon null.",
  'Exemple: « je préférerais que le bouton soit à droite » -> {"type":"evolution","titre":"Déplacer le bouton à droite","doublon":null,"priorite":"low","dossier":null}',
  'Exemple: « l\'app plante au démarrage » -> {"type":"bug","titre":"Corriger le crash au démarrage","doublon":null,"priorite":"high","dossier":"Développement"}',
  'Exemple: « c\'est quoi ce fichier ? » -> {"type":"autre","titre":"","doublon":null,"priorite":"medium","dossier":null}',
  'Exemple: « prépare la passation vers codex » -> {"type":"autre","titre":"","doublon":null,"priorite":"medium","dossier":null}',
  'Exemple: « fais une maquette figma et ajuste les polices » -> {"type":"evolution","titre":"Créer la maquette et ajuster les polices","doublon":null,"priorite":"medium","dossier":"Design"}',
].join("\n");

// Une passation, une interruption ou une consigne de systeme ne sont pas des demandes de l'utilisateur.
const NOT_A_REQUEST = /^(?:tu es (?:claude|codex|antigravity)|this session is being continued|\[request interrupted|caveat:|<|tu reprends le? travail|récapitulatif de passation|passation vers|passer? la main|reprendre le travail|ouvre (?:l'agent|codex|claude|antigravity)|relance (?:l'agent|codex|claude|antigravity)|ferme (?:l'agent|codex|claude|antigravity)|lance les tests|npm (?:test|run build)|git (?:commit|push|checkout|status))/i;

export function isRequest(text) {
  const value = String(text || "").trim();
  if (!value || value.startsWith("/") || NOT_A_REQUEST.test(value)) return false;
  if (/^(?:(?:ok|merci|oui|non|salut|bonjour|super|parfait|merci beaucoup)[.! ]*)+$/i.test(value)) return false;
  if (/(?:passation vers|passer? la main à|reprendre le travail|changer d'agent|relancer? l'agent|ouvrir l'agent|switch to)\b/i.test(value)) return false;
  return true;
}

export function parseTriage(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let payload = null;
  try {
    payload = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  // Le petit modele se contredit parfois: une demande typee avec un titre vaut suivi, quoi qu'il dise.
  const declared = payload.suivi === true || payload.suivi === "true";
  const typed = payload.type === "bug" ? "bug" : payload.type === "evolution" ? "evolution" : null;
  if (!typed && !declared) return { follow: false };
  const type = typed || "evolution";
  const title = String(payload.titre || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const duplicate = typeof payload.doublon === "string" && /^\*?[0-9a-fA-F]{4}$/.test(payload.doublon.trim())
    ? payload.doublon.trim().replace(/^\*/, "").toUpperCase()
    : null;
  if (!title && !duplicate) return { follow: false };
  const prioRaw = String(payload.priorite || payload.priority || "").trim().toLowerCase();
  const priority = ["high", "medium", "low"].includes(prioRaw)
    ? prioRaw
    : (/crash|plante|bloquant|panne|urgence|sécurité/i.test(title) ? "high" : "medium");
  const folderTarget = typeof payload.dossier === "string" && payload.dossier.trim()
    ? payload.dossier.trim()
    : null;
  return { follow: true, type, title, duplicate, priority, folderTarget };
}

export function reference(id) {
  return String(id || "").split("-").pop().slice(-4).toUpperCase();
}

export class TodoTriage {
  constructor({ localLlm, maxCandidates = 12 }) {
    this.localLlm = localLlm;
    this.maxCandidates = maxCandidates;
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  enqueue(operation) {
    if (this.pending >= 20) return Promise.reject(new Error("File de tri pleine."));
    this.pending += 1;
    const next = this.queue.then(operation).finally(() => { this.pending -= 1; });
    this.queue = next.catch(() => {});
    return next;
  }

  // Les taches recentes servent de repere pour reconnaitre un doublon.
  candidates(todos) {
    return todos
      .filter((todo) => todo.status !== "done" && !todo.completed)
      .sort((left, right) => String(right.activityAt || "").localeCompare(String(left.activityAt || "")))
      .slice(0, this.maxCandidates);
  }

  async triage(prompt, todos = [], availableFolders = []) {
    const text = String(prompt || "").trim();
    if (!isRequest(text)) return { follow: false };
    const open = this.candidates(todos);
    const listing = open.length
      ? open.map((todo) => `${reference(todo.id)}: ${todo.text.slice(0, 110)}`).join("\n")
      : "(aucune)";
    const foldersListing = availableFolders.length
      ? `\nSous-dossiers / dossiers disponibles :\n${availableFolders.map((f) => `- ${f.name}`).join("\n")}`
      : "";

    const reply = await this.localLlm.chat([
      { role: "system", content: SYSTEM },
      { role: "user", content: `Tâches existantes :\n${listing}${foldersListing}\n\nDemande :\n${text.slice(0, 1200)}` },
    ], { maxTokens: 180 });

    const parsed = parseTriage(reply);
    if (!parsed || !parsed.follow) return { follow: false };
    const duplicate = parsed.duplicate ? open.find((todo) => reference(todo.id) === parsed.duplicate) : null;
    if (!duplicate && !parsed.title) return { follow: false };
    return { ...parsed, duplicate: duplicate ? { id: duplicate.id, text: duplicate.text } : null };
  }
}

export async function suggestEmojiForFolder(name, localLlm = null) {
  const raw = String(name || "").trim();
  if (!raw) return "📁";
  const lower = raw.toLowerCase();

  const rules = [
    [/dév|dev\b|code|prog|soft|backend|api|server|algo|web|front|react/i, "💻"],
    [/design|ui|ux|maquette|graph|css|visuel|logo|art|asset/i, "🎨"],
    [/market|pub|com|social|x\b|twitter|reseau|ventes|ads/i, "📣"],
    [/idée|brainstorm|concept|vision|piste/i, "💡"],
    [/bug|fix|correct|crash|panne|erreur|incident/i, "🐛"],
    [/mobile|app|ios|android|phone/i, "📱"],
    [/test|qa|valid|check|audit/i, "🧪"],
    [/finance|compta|argent|bourse|crypto|paiement|banque/i, "💰"],
    [/doc|guide|note|redac|wiki|readme/i, "📝"],
    [/secu|auth|login|mdp|pass|token/i, "🔒"],
    [/stat|data|analyt|mesure|metriq/i, "📊"],
    [/tool|outil|infra|config|admin|docker|script/i, "🔧"],
    [/release|prod|deploi|lancement|livraison/i, "🚀"],
    [/son|audio|musique|music|midi/i, "🎵"],
    [/video|clip|anim|media/i, "🎬"],
  ];
  for (const [re, em] of rules) {
    if (re.test(lower)) return em;
  }

  if (localLlm && typeof localLlm.chat === "function") {
    try {
      const reply = await localLlm.chat([
        {
          role: "system",
          content: "Tu associes un seul emoji pertinent à un nom de dossier. Réponds UNIQUEMENT par le caractère emoji choisi, sans texte ni ponctuation."
        },
        { role: "user", content: raw }
      ], { maxTokens: 10, temperature: 0.1 });
      const match = reply.match(/\p{Extended_Pictographic}/u);
      if (match) return match[0];
    } catch {}
  }
  return "📁";
}

