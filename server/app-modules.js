// Modules optionnels de l'interface: actifs par defaut, coupables par config (.data/features.json, NOYAU_DISABLED_MODULES ou Reglages).
export const APP_MODULES = ["projects", "todos", "calendar", "groceries", "budget"];

export function defaultModules(disabledEnv = process.env.NOYAU_DISABLED_MODULES || "") {
  const disabled = new Set(String(disabledEnv).split(",").map((item) => item.trim()).filter(Boolean));
  return Object.fromEntries(APP_MODULES.map((id) => [id, !disabled.has(id)]));
}

export function resolveModules(stored, defaults = defaultModules()) {
  return Object.fromEntries(APP_MODULES.map((id) => [id, typeof stored?.[id] === "boolean" ? stored[id] : defaults[id]]));
}

export function sanitizeModules(input, current) {
  const next = { ...current };
  for (const id of APP_MODULES) if (typeof input?.[id] === "boolean") next[id] = input[id];
  return next;
}
