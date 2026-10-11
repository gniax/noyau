// Conseil d'entretien du contexte: un agent qui approche de sa fenetre pleine coute
// cher a chaque tour, car tout l'historique repart en entree du modele.

const LEVELS = {
  ok: { level: "ok", rank: 0 },
  watch: { level: "watch", rank: 1, label: "Contexte charge", message: "Contexte a moitie rempli: compacter garde l'essentiel et allege les prochains tours.", action: "compact" },
  warn: { level: "warn", rank: 2, label: "Compacter conseille", message: "Contexte presque plein: compacte maintenant pour eviter de renvoyer tout l'historique.", action: "compact" },
  critical: { level: "critical", rank: 3, label: "Repartir propre", message: "Contexte sature: compacter ne suffira plus, repars sur un contexte propre.", action: "clear" },
};

const THRESHOLDS = [
  { max: 12, ...LEVELS.critical },
  { max: 25, ...LEVELS.warn },
  { max: 50, ...LEVELS.watch },
];

// Chaque agent nomme differemment la remise a zero; le compactage porte le meme nom partout.
const COMMANDS = {
  codex: { compact: "/compact", clear: "/new" },
  claude: { compact: "/compact", clear: "/clear" },
  "claude-design": { compact: "/compact", clear: "/clear" },
  antigravity: { compact: "/compact", clear: "/clear" },
};

export function optimizeCommand(assistant, mode = "compact") {
  const commands = COMMANDS[assistant];
  if (!commands) throw new Error("Agent sans commande d'optimisation.");
  const command = commands[mode];
  if (!command) throw new Error("Mode d'optimisation inconnu.");
  return command;
}

export function supportsOptimize(assistant) {
  return Boolean(COMMANDS[assistant]);
}

export function contextAdvice(session) {
  if (!session || !supportsOptimize(session.assistant)) return null;
  const percent = Number(session.usage?.contextPercent);
  if (!Number.isFinite(percent)) return null;
  const match = THRESHOLDS.find((item) => percent <= item.max);
  const base = {
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    estimated: Boolean(session.usage?.estimated),
    remainingTokens: Number.isFinite(Number(session.usage?.remainingTokens)) ? Number(session.usage.remainingTokens) : null,
  };
  if (!match) return { ...base, level: "ok", rank: 0, label: "Contexte sain", message: "", action: null };
  return { ...base, level: match.level, rank: match.rank, label: match.label, message: match.message, action: match.action };
}

// Une seule alerte a la fois: l'agent le plus proche de la saturation parle en premier.
export function contextAlerts(sessions = []) {
  return sessions
    .map((session) => ({ session, advice: contextAdvice(session) }))
    .filter(({ advice }) => advice && advice.rank > 0)
    .sort((left, right) => right.advice.rank - left.advice.rank || left.advice.percent - right.advice.percent)
    .map(({ session, advice }) => ({
      id: `${session.id}:${advice.level}`,
      sessionId: session.id,
      name: session.name || session.id,
      assistant: session.assistant,
      ...advice,
    }));
}
