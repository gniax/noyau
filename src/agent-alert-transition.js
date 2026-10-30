// Pane status can briefly look idle while the assistant is still streaming.
// Require a sustained idle state before a local completion alert.
export function advanceAgentAlert(previous, current, now, settleMs = 20000) {
  if (!previous) return { state: current, pendingSince: null, alert: null };
  if (current === 'waiting') return { state: current, pendingSince: null, alert: previous.state !== 'waiting' ? 'waiting' : null };
  if (current !== 'available') return { state: current, pendingSince: null, alert: null };
  const pendingSince = previous.state === 'working' ? now : previous.pendingSince;
  if (pendingSince != null && now - pendingSince >= settleMs) return { state: current, pendingSince: null, alert: 'done' };
  return { state: current, pendingSince: pendingSince ?? null, alert: null };
}
