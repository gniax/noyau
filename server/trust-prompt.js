// Au premier lancement dans un dossier, les CLI demandent une autorisation avant tout travail.
// L'ordre des reponses varie d'un agent a l'autre: on lit le menu au lieu de le supposer.
const TRUST_QUESTIONS = [
  // Formulations connues: Claude "files in this folder", Antigravity "contents of this project",
  // Codex "trust this folder". On accepte toute question de confiance courte.
  /do you trust\b[^?\n]{0,80}\?/i,
  /trust (the (files|contents)[^?\n]{0,40}|this (folder|directory|workspace|project|repo))/i,
  /allow [\w .]+ to (work|run|operate) in this (folder|directory|workspace|project)/i,
  /faites-vous confiance/i,
  /autoriser l'acc[eè]s (a|à) ce (dossier|projet)/i,
];
const YES_OPTION = /\b(yes|oui|trust|proceed|continue|allow|autoriser|approuver|accepter)\b/i;
const NO_OPTION = /\b(no|non|exit|quit|cancel|annuler|refuser|don'?t|ne pas)\b/i;
const NUMBERED_OPTION = /^\s*[>❯▸*]?\s*(\d)[.)]\s+(.+?)\s*$/;
const MARKED_OPTION = /^\s*[>❯▸]\s+(.+?)\s*$/;

function optionLines(pane) {
  return String(pane).split(/\r?\n/).map((line) => line.replace(/\[[0-9;]*m/g, ""));
}

export function detectsTrustQuestion(pane) {
  const text = String(pane);
  return TRUST_QUESTIONS.some((pattern) => pattern.test(text));
}

// Retourne les touches a envoyer pour accepter, ou null si l'ecran ne pose pas la question.
export function resolveTrustPrompt(pane) {
  if (!detectsTrustQuestion(pane)) return null;
  // On ecarte la question elle-meme, jamais les reponses: "Yes, I trust this folder" en est une.
  const lines = optionLines(pane).filter((line) => !/\?\s*$/.test(line) && !/do you trust/i.test(line));

  const numbered = lines
    .map((line) => line.match(NUMBERED_OPTION))
    .filter(Boolean)
    .map((match) => ({ digit: match[1], label: match[2] }));
  if (numbered.length) {
    const choice = numbered.find(({ label }) => YES_OPTION.test(label) && !NO_OPTION.test(label));
    return choice ? { keys: [{ literal: choice.digit }], label: choice.label } : null;
  }

  // Menu sans numeros: on deplace le curseur jusqu'a la reponse positive, puis on valide.
  const choices = lines
    .map((line) => ({ line, marked: MARKED_OPTION.test(line) }))
    .filter(({ line, marked }) => (marked || /^\s{1,8}\S/.test(line)) && line.trim().length < 60 && (YES_OPTION.test(line) || NO_OPTION.test(line)));
  const yes = choices.findIndex(({ line }) => YES_OPTION.test(line) && !NO_OPTION.test(line));
  if (yes < 0) return null;
  const marked = choices.findIndex(({ marked: cursor }) => cursor);
  const steps = marked < 0 ? 0 : yes - marked;
  const moves = Array.from({ length: Math.abs(steps) }, () => ({ key: steps > 0 ? "Down" : "Up" }));
  return { keys: [...moves, { key: "C-m" }], label: choices[yes].line.trim() };
}
