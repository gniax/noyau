export function quotaTone(remainingPercent) {
  if (remainingPercent == null || remainingPercent === "") return "normal";
  const percent = Number(remainingPercent);
  if (!Number.isFinite(percent)) return "normal";
  if (percent <= 10) return "critical";
  if (percent <= 25) return "warning";
  return "normal";
}
