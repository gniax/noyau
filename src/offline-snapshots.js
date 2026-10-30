// Subscription URLs may contain private feed credentials; they are not needed
// to display saved calendar events and must not be persisted in the WebView.
export function calendarSnapshot(value) {
  if (!Array.isArray(value?.events) || !Array.isArray(value?.subscriptions)) return null;
  return { events: value.events, subscriptions: value.subscriptions.map(({ id, name, color, enabled }) => ({ id, name, color, enabled })) };
}
export function sameSnapshotScope(expected, actual) { return Boolean(expected?.profile && expected.profile === actual?.profile && expected.server === actual?.server); }
