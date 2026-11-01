const MAX_CANDIDATES = 30;
const CANDIDATE_AGE_MS = 30 * 24 * 3600 * 1000;

const SYSTEM_PROMPT = `Un agent de code vient de finir son tour. Voici sa réponse finale et les tâches ouvertes de son projet.
Liste uniquement les tâches que cette réponse déclare explicitement livrées (corrigé, déployé, terminé, en prod).
Une tâche seulement évoquée, partiellement faite, bloquée, ou sur laquelle l'agent pose une question reste ouverte. En cas de doute, ne la liste pas.
Réponds uniquement en JSON : {"done":[{"id":"…","evidence":"extrait exact de la réponse"}]}`;

const normalize = (value) => String(value).toLocaleLowerCase("fr").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();

export function autoCloseCandidates(todos, projectId, now = Date.now()) {
  return (todos || [])
    .filter((todo) => todo.projectId === projectId && todo.status === "todo" && now - (Date.parse(todo.createdAt) || 0) < CANDIDATE_AGE_MS)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
    .slice(0, MAX_CANDIDATES);
}

// Returns { id, evidence } only when the quoted evidence really is in the reply.
export async function finishedTodos({ todos, reply, fetchImpl = fetch, url = process.env.NOYAU_LLM_PROXY_URL || "http://127.0.0.1:3001/v1/chat/completions", timeoutMs = 60000 }) {
  const text = String(reply || "").slice(0, 8000);
  if (!text.trim() || !todos?.length) return [];
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "auto",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ reponse: text, taches: todos.map(({ id, text: title }) => ({ id, texte: String(title).slice(0, 300) })) }) },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return [];
  const json = await response.json();
  const raw = String(json?.choices?.[0]?.message?.content || "");
  const answer = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const allowed = new Set(todos.map((todo) => todo.id));
  const haystack = normalize(text);
  return (Array.isArray(answer.done) ? answer.done : [])
    .filter((entry) => allowed.has(entry?.id) && normalize(entry?.evidence || "").length >= 4 && haystack.includes(normalize(entry.evidence)))
    .map((entry) => ({ id: entry.id, evidence: String(entry.evidence).slice(0, 160) }));
}
