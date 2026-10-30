// A stale Budget destination should not survive an ordinary password login.
// Explicit agent links and bank-provider callbacks keep their destination.
export function loginNavigation(search) {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const explicit = Boolean(params.get("session") || params.has("bank") || params.has("bankError") || view && view !== "finances");
  if (!explicit && view === "finances") params.delete("view");
  return { explicit, search: params.toString() };
}
