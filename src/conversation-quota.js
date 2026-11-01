const QUOTA_PATTERN = /usage limit|limite d'utilisation|rate limit|individual quota reached|resource_exhausted|quota (atteint|reached|exceeded|depasse|dépassé)|try again (at|in)|upgrade (to pro|your subscription)|plan limit|out of credits/i;

// A historical provider error is not evidence of the current account quota.
export function conversationQuotaExhausted({ session, messages, activity, quota, pending = false, now = Date.now() }) {
  const windows = Array.isArray(quota?.windows) ? quota.windows : [quota?.fiveHour, quota?.sevenDay].filter(Boolean);
  const known = windows.filter((w) => Number.isFinite(w.remainingPercent));
  const last = messages.at(-1);
  const lastError = last?.direction === 'out' && QUOTA_PATTERN.test(last.text || '');
  const errorAt = Date.parse(last?.at || '');
  const updatedAt = Date.parse(quota?.updatedAt || '');
  const freshAvailable = known.length && known.every((w) => w.remainingPercent > 0) && Number.isFinite(updatedAt) && Number.isFinite(errorAt) && updatedAt > errorAt;
  const exhausted = known.filter((w) => w.remainingPercent <= 0);
  const resetPassed = exhausted.length && exhausted.every((w) => Number.isFinite(Date.parse(w.resetsAt || '')) && Date.parse(w.resetsAt) <= now);
  if (freshAvailable || resetPassed || pending || session.agentStatus?.state === 'working' || last?.direction === 'in') return false;
  return Boolean(session.quotaExhausted || session.agentStatus?.state === 'exhausted' || (activity && QUOTA_PATTERN.test(activity)) || lastError);
}
