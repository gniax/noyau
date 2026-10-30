// Authentication, permissions, purchases and agent commands must never be replayed later.
export function canQueueOffline(path, method = "POST") {
  if (typeof path !== "string" || !["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false;
  return /^\/api\/(?:todos(?:\/|$)|calendar\/subscriptions(?:\/|$))/.test(path) && !path.includes("?") && !path.includes("..");
}
