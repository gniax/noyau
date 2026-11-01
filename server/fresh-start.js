const clip = (text, max) => {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

// Hidden from the conversation by the handover filter: it must start with this exact wording.
const HEADER = "Tu reprends le travail d'un autre agent : toi-même, reparti sur un contexte propre à la demande du fondateur.";

export function freshStartPrompt({ messages = [], name = "cet agent", maxRequests = 20, transcriptPath = null, previousHistory = false, todos = [], gitStatus = "", gitLog = "", wasWorking = false, subagents = [] }) {
  const requests = messages.filter((message) => message.direction === "in" && message.kind !== "agent" && message.kind !== "incident" && !message.pending);
  const fromAgents = messages.filter((message) => message.direction === "in" && message.kind === "agent").slice(-5);
  const lastFinalIndex = messages.findLastIndex((message) => message.direction === "out" && message.final !== false);
  const since = messages.slice(lastFinalIndex + 1);
  const unanswered = since.filter((message) => message.direction === "in");
  const notes = since.filter((message) => message.direction === "out");
  const interrupted = subagents.filter((item) => item.running);
  const inProgress = wasWorking || unanswered.length > 0 || notes.length > 0 || interrupted.length > 0;
  const lines = [HEADER, `Tu restes ${name}, ta mémoire d'agent reste disponible et rien de ton travail ne doit se perdre.`];
  lines.push(inProgress
    ? "Un travail était en cours quand ton contexte a été vidé : vérifie d'abord l'état réel (dépôt, tâches, fichiers), ne refais pas ce qui est fait, puis REPRENDS-LE immédiatement et va au bout, sans attendre de nouvelle consigne."
    : "Aucun travail ne semblait en cours : vérifie l'état réel, termine ce qui reste dans les demandes ci-dessous si besoin, sinon dis en une phrase où tu en es et attends la suite.");
  if (unanswered.length) lines.push("", "À FAIRE EN PRIORITÉ, demandes encore sans réponse :", ...unanswered.map((message) => `- ${message.kind === "incident" ? "Incident signalé par Noyau : " : message.kind === "agent" ? `${message.from || "Agent"} : ` : ""}${clip(message.text, 2000)}`));
  // Background subagents live inside the replaced process: they die with it and nothing else remembers their brief.
  if (interrupted.length) lines.push("", "Sous-agents arrêtés par cette relance, leur travail n'est pas terminé. Regarde ce qu'ils ont laissé, puis relance-les ou finis toi-même :", ...interrupted.map((item) => [
    `- ${item.description || item.id}${item.worktreePath ? ` (worktree : ${item.worktreePath})` : ""}`,
    `  Consigne complète : ${clip(item.prompt, 8000)}`,
    ...(item.lastText ? [`  Dernier point : ${clip(item.lastText, 800)}`] : []),
  ].join("\n")));
  if (notes.length) lines.push("", "Où tu en étais (tes derniers points d'avancement) :", ...notes.slice(-8).map((message) => `- ${clip(message.text, 600)}`));
  if (todos.length) lines.push("", "Tâches ouvertes du projet :", ...todos.slice(0, 25).map((todo) => `- ${todo.ref ? `${todo.ref} ` : ""}${clip(todo.text, 200)}`));
  if (String(gitStatus).trim()) lines.push("", "Fichiers modifiés non commités au moment de la relance :", clip(gitStatus, 2500));
  if (String(gitLog).trim()) lines.push("", "Derniers commits :", clip(gitLog, 600));
  if (requests.length) lines.push("", "Historique des demandes du fondateur, de la plus ancienne à la plus récente :", ...requests.slice(-maxRequests).map((message, index) => `${index + 1}. ${clip(message.text, 1200)}`));
  if (fromAgents.length) lines.push("", "Derniers messages reçus d'autres agents :", ...fromAgents.map((message) => `- ${message.from || "Agent"} : ${clip(message.text, 500)}`));
  const answers = messages.filter((message) => message.direction === "out" && message.final !== false);
  if (answers.length) lines.push("", "Ta dernière réponse finale :", clip(answers.at(-1).text, 3000));
  if (transcriptPath) lines.push("", `Transcript complet de ton ancien contexte, à consulter par morceaux si un détail manque (fichier JSONL, très long, ne le lis jamais en entier) : ${transcriptPath}`);
  return lines.join("\n");
}
