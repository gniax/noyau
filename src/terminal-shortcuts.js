export function shouldCopyTerminal({ event, targetInField, browserSelectionCollapsed, terminalSelection, assistant = null }) {
  const copyKey = String(event?.key || "").toLowerCase() === "c";
  const modifier = Boolean(event?.metaKey || event?.ctrlKey);
  if (!copyKey || !modifier || event?.altKey || targetInField) return false;
  if (assistant && assistant !== "shell") return true;
  return browserSelectionCollapsed && Boolean(terminalSelection);
}

