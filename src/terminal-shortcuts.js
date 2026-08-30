export function shouldCopyTerminal({ event, targetInField, browserSelectionCollapsed, terminalSelection }) {
  const copyKey = String(event?.key || "").toLowerCase() === "c";
  const modifier = Boolean(event?.metaKey || event?.ctrlKey);
  return copyKey && modifier && !event?.altKey && !targetInField && browserSelectionCollapsed && Boolean(terminalSelection);
}
