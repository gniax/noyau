export function normalizeProjectOrder(visibleIds, requestedIds) {
  const visible = new Set(visibleIds);
  const ordered = [];
  for (const id of Array.isArray(requestedIds) ? requestedIds : []) {
    if (visible.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const id of visibleIds) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

export function sortProjects(entries, order) {
  const positions = new Map((order || []).map((id, index) => [id, index]));
  return [...entries].sort(([leftId, left], [rightId, right]) => {
    const leftOrder = positions.get(leftId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = positions.get(rightId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.name.localeCompare(right.name, "fr");
  });
}
