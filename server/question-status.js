import crypto from "node:crypto";

const MAX_CACHE = 500;
const cache = new Map();

const SYSTEM_PROMPT = `Tu suis les questions qu'un agent de code pose à son utilisateur.
Pour chaque entrée, "question" est une phrase de l'agent et "replies" les messages envoyés ensuite par l'utilisateur (éventuellement vide).
- "answered" : l'utilisateur a tranché cette question dans une de ses réponses. Une approbation claire compte (« oui », « vas-y », « fais les deux », « ok go », « non laisse tomber »), même mal orthographiée, si elle suit la question et n'en vise pas manifestement une autre.
- Si plusieurs questions sont ouvertes et que la réponse n'en traite qu'une, seule celle-là est répondue ; « les deux » ou « tout » les couvre toutes.
- "notQuestions" : phrase qui n'attend aucune réponse de l'utilisateur (rhétorique, question citée, question que l'agent résout lui-même).
- Une demande sans rapport n'est pas une réponse. En cas de doute, ne classe pas l'entrée.
Réponds uniquement en JSON : {"answered":[{"id":"…","evidence":"extrait exact de la réponse"}],"notQuestions":["id"]}`;

const normalize = (value) => String(value).toLocaleLowerCase("fr").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();

export async function answeredQuestions(questions, { fetchImpl = fetch, url = process.env.NOYAU_LLM_PROXY_URL || "http://127.0.0.1:3001/v1/chat/completions", timeoutMs = 25000 } = {}) {
  const items = (Array.isArray(questions) ? questions : [])
    .filter((q) => typeof q?.id === "string" && typeof q?.question === "string" && Array.isArray(q?.replies))
    .slice(-30)
    .map((q) => ({ id: q.id.slice(0, 160), question: q.question.slice(0, 500), replies: q.replies.slice(0, 12).map((reply) => String(reply).slice(0, 3000)) }));
  if (!items.length) return [];
  const hash = crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
  if (cache.has(hash)) return cache.get(hash);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: JSON.stringify(items) }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];
    const json = await response.json();
    const raw = String(json?.choices?.[0]?.message?.content || "");
    const answer = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const allowed = new Map(items.map((item) => [item.id, item]));
    const answered = (Array.isArray(answer.answered) ? answer.answered : [])
      .filter((entry) => {
        const evidence = normalize(entry?.evidence || "");
        return evidence.length >= 2 && allowed.get(entry?.id)?.replies.some((reply) => normalize(reply).includes(evidence));
      })
      .map((entry) => entry.id);
    const closed = (Array.isArray(answer.notQuestions) ? answer.notQuestions : []).filter((id) => allowed.has(id));
    const result = [...new Set([...answered, ...closed])];
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(hash, result);
    return result;
  } catch {
    // Unknown stays open: a wrongly closed question is the failure this tracking exists to prevent.
    return [];
  }
}
