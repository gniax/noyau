import en from "./locales/en.json";

// Le texte francais sert de cle (style gettext): une cle absente retombe sur le francais.
const STORAGE_KEY = "noyau:lang";
export const LANGUAGES = [{ id: "en", label: "English" }, { id: "fr", label: "Français" }];

export function currentLanguage() {
  if (typeof window === "undefined") return "fr";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "fr" || stored === "en") return stored;
  } catch {}
  return String(navigator.language || "").toLowerCase().startsWith("fr") ? "fr" : "en";
}

const language = currentLanguage();
const table = language === "en" ? en : null;
export const LOCALE = language === "en" ? "en-US" : "fr-FR";
if (typeof document !== "undefined") document.documentElement.lang = language;

export function tr(key, ...values) {
  const text = table && Object.hasOwn(table, key) ? table[key] : key;
  return values.length ? text.replace(/\{(\d+)\}/g, (match, index) => (values[index] ?? "")) : text;
}

// Les textes sont evalues au chargement des modules: changer de langue recharge l'application.
export function setLanguage(next) {
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  window.location.reload();
}
