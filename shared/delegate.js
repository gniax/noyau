const HEADER = "[Délégation]";
const REQUEST_MARK = "Demande du fondateur :\n";

export function delegateMessage(request) {
  return [
    `${HEADER} Le fondateur veut que cette demande soit traitée par un nouvel agent Noyau dédié, pas par toi.`,
    "Crée cet agent maintenant avec l'outil inter-agents Noyau (skill noyau-agent-create ou scripts/noyau-agent.mjs create), dans le même projet ; pas de sous-agent interne, le fondateur doit le voir dans Noyau.",
    "Donne-lui un nom court et un brief autonome : la demande telle quelle, le contexte utile de ta conversation et ce que tu as déjà écarté. S'il modifie du code dans un dépôt où d'autres travaillent, demande-lui d'utiliser un git worktree. Demande-lui de te rendre compte par message inter-agents à la fin.",
    "Ne fais pas le travail toi-même. Réponds en une phrase avec le nom de l'agent créé, puis relis son compte rendu quand il arrive.",
    "",
    `${REQUEST_MARK}${request}`,
  ].join("\n");
}

// Only the founder's words are shown; the instructions around them are for the receiving agent.
export function parseDelegate(text) {
  const value = String(text ?? "");
  const mark = value.startsWith(HEADER) ? value.indexOf(REQUEST_MARK) : -1;
  return mark < 0 ? { delegated: false, text: value } : { delegated: true, text: value.slice(mark + REQUEST_MARK.length) };
}
