// Interpretation des commandes vocales: pure, sans effet de bord, donc testable seule.
// Le modele vocal ne connait pas les noms propres ("Octanix" ressort en "obtenez"):
// on rapproche donc la cible entendue des noms reels par distance d'edition.

const WAKE_WORDS = ["noyau", "noyaux", "noyo"];

const VIEW_WORDS = [
  { view: "dashboard", words: ["accueil", "tableau de bord", "dashboard", "vue générale"] },
  { view: "projects", words: ["projets", "projet", "mes projets"] },
  { view: "todos", words: ["todo", "todos", "tâches", "taches", "liste de tâches", "kanban", "trello"] },
  { view: "finances", words: ["budget", "finances", "dépenses", "depenses", "argent"] },
  { view: "settings", words: ["réglages", "reglages", "paramètres", "parametres", "options"] },
];

const OPEN_VERBS = ["ouvre", "ouvrir", "affiche", "afficher", "montre", "montrer", "va sur", "va dans", "va a", "passe sur", "passe à", "passe a", "bascule sur", "retourne sur", "reviens sur", "lance"];
const AGENT_WORDS = ["l'agent", "agent", "la session", "session"];
const PROJECT_WORDS = ["le projet", "projet"];
// « affiche la vue de l'agent X »: la vue n'est pas la cible, juste la maniere de le dire.
const SCREEN_WORDS = ["vue de", "vue du", "vue", "ecran de", "ecran", "page de", "page", "fenetre de", "fenetre", "onglet"];
// Ce qui separe le nom de l'agent du message a lui transmettre.
const MESSAGE_JOINTS = [" que ", " qu ", " de ", " d ", " pour ", " qu il ", " ceci ", " ca "];

export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function editDistance(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return Math.max(a.length, b.length);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = current;
    }
  }
  return previous[b.length];
}

// Un nom entendu vaut pour une cible si la difference reste courte au regard de sa longueur.
// Les noms propres sortent souvent deformes du modele ("Octanix" -> "obtenez"): on accepte donc
// aussi un score moyen quand il domine nettement les autres candidats.
export function scoreCandidates(heard, candidates) {
  const spoken = normalize(heard);
  if (!spoken) return [];
  return candidates
    .map((candidate) => {
      let best = 0;
      let matched = candidate.name;
      for (const label of [candidate.name, ...(candidate.aliases || [])]) {
        const target = normalize(label);
        if (!target) continue;
        const distance = editDistance(spoken, target);
        const ratio = 1 - distance / Math.max(spoken.length, target.length);
        const contained = spoken.includes(target) || target.includes(spoken);
        const value = contained ? Math.max(ratio, 0.82) : ratio;
        if (value > best) { best = value; matched = label; }
      }
      return { ...candidate, score: best, matched };
    })
    .sort((left, right) => right.score - left.score);
}

export function bestMatch(heard, candidates) {
  const ranked = scoreCandidates(heard, candidates);
  const [first, second] = ranked;
  if (!first) return null;
  if (first.score >= 0.55) return first;
  // Un seul candidat plausible et loin devant: on tranche malgre un score moyen.
  if (first.score >= 0.38 && (!second || first.score >= second.score * 1.35)) return first;
  return null;
}

export function stripWake(text) {
  const spoken = normalize(text);
  for (const wake of WAKE_WORDS) {
    if (spoken === wake) return { awake: true, rest: "" };
    if (spoken.startsWith(`${wake} `)) return { awake: true, rest: spoken.slice(wake.length + 1).trim() };
  }
  return { awake: false, rest: spoken };
}

export function hasWakeWord(text) {
  const spoken = normalize(text);
  return WAKE_WORDS.some((wake) => spoken === wake || spoken.startsWith(`${wake} `) || spoken.includes(` ${wake} `));
}

function stripLeading(rest, words) {
  for (const word of words) {
    const normalized = normalize(word);
    if (rest === normalized) return "";
    if (rest.startsWith(`${normalized} `)) return rest.slice(normalized.length + 1).trim();
  }
  return rest;
}

const ARTICLES = ["les", "le", "la", "l", "des", "du", "de la", "de", "mes", "mon", "ma", "a l", "au", "a"];

// « dis a atlas de corriger la route »: le nom d'abord, le message apres le mot de liaison.
function splitMessage(rest) {
  let earliest = null;
  for (const joint of MESSAGE_JOINTS) {
    const index = rest.indexOf(joint);
    if (index > 0 && (earliest === null || index < earliest.index)) earliest = { index, joint };
  }
  if (!earliest) return { target: rest, message: "" };
  return { target: rest.slice(0, earliest.index).trim(), message: rest.slice(earliest.index + earliest.joint.length).trim() };
}

// Renvoie l'action a executer, ou null si la phrase ne dit rien d'exploitable.
// Sans mot d'appel, seule une phrase qui commence par un verbe connu et vise une cible connue
// est retenue: une conversation qui ne concerne pas Noyau ne declenche rien.
export function parseCommand(text, { agents = [], projects = [] } = {}) {
  const { awake, rest } = stripWake(text);
  if (!rest) return awake ? { action: "wake" } : null;
  const answer = (command, explicit = true) => (awake || explicit ? command : null);
  // Sans mot d'appel, on n'agit que sur un nom clairement reconnu: un mot attrape au vol ne suffit pas.
  const pick = (heard, list) => {
    const match = bestMatch(heard, list);
    return match && (awake || match.score >= 0.62) ? match : null;
  };

  if (/^(stop|arrete|arreter|silence|chut|tais toi)$/.test(rest) || /^(stop|arrete|arreter|coupe|couper) (d ecouter|le micro|micro|l ecoute)$/.test(rest)) {
    return answer({ action: "stop-listening" });
  }
  if (/^(coupe|couper|mets) (le )?son/.test(rest) || rest === "muet") return answer({ action: "mute" });
  if (/^(remets|remettre|active|rallume) (le )?son/.test(rest)) return answer({ action: "unmute" });
  if (/^(dicte|dictee|ecris|note)\b/.test(rest)) {
    return answer({ action: "dictate", text: stripLeading(rest, ["dicte", "dictee", "ecris", "note"]) });
  }

  // Interruption d'un agent: « arrete l'agent atlas », « annule ce qu'il fait ».
  const interrupt = rest.match(/^(arrete|arretes|arreter|stoppe|stop|annule|annuler|interromps|coupe) (.*)$/);
  if (interrupt) {
    const scope = stripLeading(stripLeading(interrupt[2], ARTICLES), AGENT_WORDS);
    const named = pick(stripLeading(scope, ARTICLES), agents);
    if (named) return answer({ action: "interrupt", id: named.id, name: named.name });
    if (/^(sa tache|la tache|tache|ce qu il fait|tout|ca)$/.test(scope)) return answer({ action: "interrupt", id: null, name: null });
  }

  // Entretien d'un agent a la voix: contexte trop lourd, ou agent a relancer.
  const upkeep = rest.match(/^(compacte|compacter|compresse|reduis|allege|vide|nettoie|clear|redemarre|relance) (.*)$/);
  if (upkeep) {
    const scope = stripLeading(stripLeading(stripLeading(upkeep[2], ["le contexte", "la conversation", "le fil"]), ARTICLES), AGENT_WORDS);
    const agent = pick(stripLeading(scope, ARTICLES), agents);
    if (agent) {
      if (/^(redemarre|relance)$/.test(upkeep[1])) return answer({ action: "restart", id: agent.id, name: agent.name });
      const mode = /^(vide|nettoie|clear)$/.test(upkeep[1]) ? "clear" : "compact";
      return answer({ action: "optimize", mode, id: agent.id, name: agent.name });
    }
  }

  // Orchestration: Noyau transmet la demande a l'agent vise, sans que l'utilisateur ouvre sa vue.
  const relay = rest.match(/^(dis|dit|dis lui|demande|demandes|envoie|envoi|transmets|transmet|previens|parle) (.*)$/);
  if (relay) {
    const scoped = stripLeading(stripLeading(relay[2], ["un message", "le message", "message"]), ARTICLES);
    const { target: heard, message } = splitMessage(stripLeading(stripLeading(scoped, AGENT_WORDS), ARTICLES));
    const agent = heard ? pick(heard, agents) : null;
    if (agent && message) return answer({ action: "send-agent", id: agent.id, name: agent.name, text: message, score: agent.score });
  }

  let target = stripLeading(rest, OPEN_VERBS);
  const opened = target !== rest;
  target = stripLeading(target, ARTICLES);
  target = stripLeading(target, SCREEN_WORDS);
  target = stripLeading(target, ARTICLES);
  // « ouvre l'agent X » ne doit pas tomber sur un projet homonyme, et inversement.
  const beforeScope = target;
  target = stripLeading(target, AGENT_WORDS);
  const wantsAgent = target !== beforeScope;
  const beforeProject = target;
  target = stripLeading(target, PROJECT_WORDS);
  const wantsProject = target !== beforeProject;
  target = stripLeading(target, ARTICLES);

  for (const entry of VIEW_WORDS) {
    if (entry.words.some((word) => normalize(word) === target)) return answer({ action: "view", view: entry.view }, opened);
  }

  if (target) {
    const agent = wantsProject ? null : pick(target, agents);
    if (agent) return answer({ action: "open-agent", id: agent.id, name: agent.name, score: agent.score }, opened);
    const project = wantsAgent ? null : pick(target, projects);
    if (project) return answer({ action: "open-project", id: project.id, name: project.name, score: project.score }, opened);
  }

  // Rien de reconnu: on ne repond que si l'utilisateur s'adressait bien a Noyau.
  return awake ? { action: "unknown", target: target || rest } : null;
}

export { WAKE_WORDS };
