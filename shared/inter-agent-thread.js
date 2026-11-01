// Separates what the founder discusses with an agent from what other agents asked it.
// A reply follows the request of its turn, unless a founder request is still unanswered.
export function splitInterAgent(messages) {
  const main = [];
  const exchanges = [];
  let current = null;
  let founderOpen = false;
  for (const message of messages) {
    if (message.direction === "in" && message.kind === "agent") {
      current = { id: message.stableId, message, replies: [] };
      exchanges.push(current);
      main.push({ ...message, exchange: current });
    } else if (message.direction === "in" && message.kind === "incident") {
      current = null;
      main.push(message);
    } else if (message.direction === "in") {
      current = null;
      founderOpen = true;
      main.push(message);
    } else if (current && !founderOpen) {
      current.replies.push(message);
    } else {
      if (message.final !== false) founderOpen = false;
      main.push(message);
    }
  }
  return { main, exchanges, founderMessages: main.filter((message) => !message.exchange && message.kind !== "incident") };
}

export function oneLine(text, max = 110) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
