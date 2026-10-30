const LEGACY_ID = /^noyau-(?:claude-design|antigravity|claude|codex|shell)-([a-z0-9]+-[a-f0-9]{4})$/i;
const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;

// Runtime session names are transport details; public agent identities never encode a provider.
export function agentIdentity(sessionId, metadata = {}, store = null) {
  const id = metadata.agentId || sessionId.replace(LEGACY_ID, "noyau-agent-$1");
  const aliases = new Set([sessionId, ...(metadata.agentAliases || [])]);
  const visited = new Set([sessionId]);
  let previous = metadata.migratedFrom;
  while (previous && VALID_ID.test(previous) && !visited.has(previous)) {
    visited.add(previous);
    const entry = store?.get(previous);
    if (entry && (entry.profileId || null) !== (metadata.profileId || null)) break;
    aliases.add(previous);
    if (!entry) break;
    if (entry.agentId) aliases.add(entry.agentId);
    for (const alias of entry.agentAliases || []) aliases.add(alias);
    previous = entry.migratedFrom;
  }
  aliases.delete(id);
  return { agentId: id, agentAliases: [...aliases].filter((alias) => VALID_ID.test(alias)).sort() };
}

export async function initializeAgentIdentities(store) {
  const updates = [];
  for (const [sessionId, metadata] of Object.entries(store.all())) {
    if (!sessionId.startsWith("noyau-") || metadata.migratedTo) continue;
    const identity = agentIdentity(sessionId, metadata, store);
    if (metadata.agentId !== identity.agentId || JSON.stringify(metadata.agentAliases) !== JSON.stringify(identity.agentAliases)) {
      updates.push([sessionId, { ...metadata, ...identity }]);
    }
  }
  if (updates.length) await store.setMany(updates);
  return updates.length;
}
