const LAST_PER_ROLE = 10;
const MAX_REPLIES = 8;
// A request left unanswered this long belongs to an earlier turn that merged several messages.
const STALE_REQUEST_MS = 30 * 60 * 1000;
const APPROVAL = /^\s*(?:oui|ouais|yes|yep|ok|okay|d'?accord|dac|vas[- ]?y|go|fais|non|no|nope|laisse|valid[eé]|parfait|c'?est bon)\b/i;
const COVERS_ALL = /\b(?:(?:les|aux|des) (?:deux|2)|tout|toutes?|tous|the two|both|all)\b/i;

const isUserMessage = (message) => message.direction === "in" && !message.kind?.includes("agent");
const clipReply = (value) => {
  const text = String(value || "");
  return text.length > 3000 ? `${text.slice(0, 1500)} … ${text.slice(-1500)}` : text;
};

export function extractQuestions(text) {
  const value = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  return value
    .split(/\n/)
    .filter((line) => !/^\s*>/.test(line))
    .flatMap((line) => (line.match(/[^?]{3,}\?/g) || []).map((chunk) => {
      const sentence = chunk.split(/(?<=[.!:;])\s+/).pop();
      return sentence.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim();
    }))
    .filter((question) => question.length >= 5 && question.length <= 500)
    .slice(0, 12);
}

export function conversationQuestions(messages) {
  const recent = new Set(messages.filter((m) => m.direction === "out").slice(-LAST_PER_ROLE).map((m) => m.stableId));
  return messages.flatMap((message, index) => {
    if (message.direction !== "out" || !recent.has(message.stableId)) return [];
    const replies = messages.slice(index + 1).filter(isUserMessage).slice(0, MAX_REPLIES).map((m) => clipReply(m.text));
    return extractQuestions(message.text).map((question, n) => ({ id: `${message.stableId}#${n}`, messageId: message.stableId, question, replies }));
  });
}

// Works without the LLM: a direct approval settles a lone question, or all of them if it says so.
export function obviouslyAnsweredIds(messages) {
  const questions = conversationQuestions(messages);
  const answered = [];
  for (const [index, message] of messages.entries()) {
    if (message.direction !== "out") continue;
    const own = questions.filter((q) => q.messageId === message.stableId);
    if (!own.length) continue;
    const next = messages.slice(index + 1).find((m) => m.direction === "out" || isUserMessage(m));
    if (!next || next.direction === "out") continue;
    const reply = String(next.text || "");
    if (!APPROVAL.test(reply) && !(COVERS_ALL.test(reply) && reply.length < 200)) continue;
    if (own.length === 1 || COVERS_ALL.test(reply)) answered.push(...own.map((q) => q.id));
  }
  return answered;
}

// Only a finished turn answers a request, and one reply answers one request while the agent still works.
function workingRequestIds(messages, { working, now }) {
  const backlog = [];
  for (const message of messages) {
    if (isUserMessage(message)) backlog.push(message);
    else if (message.direction === "out" && message.final !== false) backlog.shift();
  }
  const last = messages.at(-1);
  if (!working) return new Set(backlog.filter((m) => m.pending || (m === last && now - (Date.parse(m.at) || 0) < 60_000)).map((m) => m.stableId));
  const lastReplyAt = Math.max(0, ...messages.filter((m) => m.direction === "out" && m.final !== false).map((m) => Date.parse(m.at) || 0));
  return new Set(backlog.filter((m) => m.pending || (Date.parse(m.at) || now) > lastReplyAt - STALE_REQUEST_MS).map((m) => m.stableId));
}

export function buildConversationTimeline(messages, { answeredIds = [], working = false, now = Date.now() } = {}) {
  const answered = new Set([...answeredIds, ...obviouslyAnsweredIds(messages)]);
  const open = conversationQuestions(messages).filter((q) => !answered.has(q.id));
  const inFlight = workingRequestIds(messages, { working, now });
  // Progress notes fill the conversation, not the summary: only those since the last final answer stay.
  const lastFinal = messages.findLastIndex((m) => m.direction === "out" && m.final !== false);
  const visible = messages.filter((m, index) => (m.direction === "out" && (m.final !== false || index > lastFinal || extractQuestions(m.text).length)) || isUserMessage(m));
  const lastIds = (direction) => visible.filter((m) => m.direction === direction).slice(-LAST_PER_ROLE).map((m) => m.stableId);
  const shown = new Set([...lastIds("in"), ...lastIds("out")]);
  return visible.filter((m) => shown.has(m.stableId)).map((message) => {
    const questions = open.filter((q) => q.messageId === message.stableId).map((q) => q.question);
    const status = message.direction === "in"
      ? (inFlight.has(message.stableId) ? "working" : "done")
      : (questions.length ? "question" : message.final === false ? "progress" : "done");
    return { ...message, role: message.direction === "in" ? "user" : "assistant", status, questions };
  });
}
