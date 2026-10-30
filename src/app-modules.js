import { useSyncExternalStore } from "react";

// Modules optionnels (Reglages > Modules, .data/features.json ou NOYAU_DISABLED_MODULES).
const CACHE_KEY = "noyau:modules";
const ALL_ON = { projects: true, todos: true, calendar: true, groceries: true, budget: true };
const listeners = new Set();
let modules = (() => {
  try { return { ...ALL_ON, ...JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") }; } catch { return { ...ALL_ON }; }
})();

export function setModules(next) {
  modules = { ...ALL_ON, ...(next || {}) };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(modules)); } catch {}
  for (const listener of listeners) listener();
}

export function moduleEnabled(id) {
  return modules[id] !== false;
}

export function useModules() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => modules);
}

export function viewModule(view) {
  if (!view) return null;
  if (view === "finances" || view.startsWith("finance-")) return "budget";
  if (view === "map") return "projects";
  return ["projects", "todos", "calendar", "groceries"].includes(view) ? view : null;
}
