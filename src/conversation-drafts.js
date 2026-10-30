// Drafts stay on this device. Scope every key to the server, profile and agent;
// never put draft text into URLs, project files or server storage.
export function createConversationDraftStore({ storage, server, profile }) {
  const memory = new Map();
  const prefix = server && profile ? `noyau:conversation-draft:${encodeURIComponent(server)}:${encodeURIComponent(profile)}:` : null;
  const key = (id) => prefix ? prefix + encodeURIComponent(id) : null;
  return {
    get(id) {
      if (memory.has(id)) return memory.get(id);
      try {
        const k = key(id); if (!k) return undefined;
        const value = JSON.parse(storage.getItem(k) || "null");
        if (!value || typeof value.draft !== "string" || !Array.isArray(value.attachments)) return undefined;
        const clean = {
          draft: value.draft.slice(0, 16384),
          attachments: value.attachments.filter((item) => item && typeof item.name === "string" && typeof item.path === "string").slice(0, 50),
          ...(Array.isArray(value.queue) && value.queue.length ? {
            queue: value.queue.filter((q) => q && typeof q.text === "string" && q.text.trim()).map((q) => ({ id: q.id || crypto.randomUUID(), text: String(q.text).slice(0, 16384), createdAt: q.createdAt || new Date().toISOString() })).slice(0, 30)
          } : {})
        };
        memory.set(id, clean); return clean;
      } catch { return undefined; }
    },
    set(id, value) {
      const queueItems = Array.isArray(value?.queue) ? value.queue.filter((q) => q && typeof q.text === "string" && q.text.trim()).map((q) => ({ id: q.id || crypto.randomUUID(), text: String(q.text).slice(0, 16384), createdAt: q.createdAt || new Date().toISOString() })).slice(0, 30) : [];
      const safe = {
        draft: typeof value?.draft === "string" ? value.draft.slice(0, 16384) : "",
        attachments: Array.isArray(value?.attachments) ? value.attachments.filter((item) => item && typeof item.name === "string" && typeof item.path === "string").slice(0, 50) : [],
        ...(queueItems.length ? { queue: queueItems } : {})
      };
      memory.set(id, safe);
      try { const k = key(id); if (k) { if (!safe.draft && !safe.attachments.length && !queueItems.length) storage.removeItem(k); else storage.setItem(k, JSON.stringify(safe)); } } catch { /* in-memory fallback when storage is blocked or full */ }
      return this;
    },
  };
}
