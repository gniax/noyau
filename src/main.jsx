import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./theme-castle.css";
import { shouldCopyTerminal } from "./terminal-shortcuts.js";

const assistantMeta = {
  codex: { label: "Codex", glyph: "C", color: "green" },
  claude: { label: "Claude", glyph: "A", color: "orange" },
  "claude-design": { label: "Claude Design", glyph: "D", color: "orange" },
  antigravity: { label: "Antigravity", glyph: "G", color: "violet" },
  shell: { label: "Terminal", glyph: ">_", color: "blue" },
};
const LAUNCHABLE_ASSISTANTS = ["codex", "claude", "antigravity", "shell"];


// Cache leger par vue: on repeint la derniere donnee connue puis on rafraichit en fond.
const viewCache = new Map();
const PROFILE_KEY = "noyau:profile";
const requestedProfileId = new URLSearchParams(location.search).get("profile");
if (requestedProfileId) {
  try { localStorage.setItem(PROFILE_KEY, requestedProfileId); } catch { /* stockage optionnel */ }
}

function activeProfileId() {
  try { return localStorage.getItem(PROFILE_KEY) || ""; } catch { return ""; }
}

function profileCacheKey(key) {
  return `${activeProfileId() || "primary"}:${key}`;
}

const ROOT_FOLDER = "root";
const DEFAULT_COLUMNS = [
  { id: "todo", name: "À faire", kind: "todo" },
  { id: "review", name: "À tester / valider", kind: "review" },
  { id: "done", name: "Terminé", kind: "done" },
];
// Reference courte affichee sur la carte: sert a designer une tache dans un prompt d'agent.
function todoRef(id) {
  return `*${String(id || "").split("-").pop().slice(-4).toUpperCase()}`;
}
const DEVICE_KEY = "noyau:device";
const CONFIRM_KEY = "noyau:confirm";

// Identite locale de l'appareil: elle relie la presence a l'abonnement push de cet ecran.
function deviceId() {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const created = `device-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return "device-volatile";
  }
}
const OSK_KEY = "noyau:osk";

// Confirmations d'app (redemarrage, changement de fournisseur): desactivables par appareil.
// Les actions destructrices gardent toujours leur garde-fou.
function confirmAction(message) {
  try {
    if (localStorage.getItem(CONFIRM_KEY) === "off") return true;
  } catch { /* stockage optionnel */ }
  return window.confirm(message);
}
const PHYSICAL_KEY = "noyau:physical-keyboard";

// Clavier virtuel: "auto" le retient des qu'un vrai clavier a servi sur cet appareil.
function oskMode() {
  try { return localStorage.getItem(OSK_KEY) || "auto"; } catch { return "auto"; }
}

function physicalKeyboardSeen() {
  try { return localStorage.getItem(PHYSICAL_KEY) === "1"; } catch { return false; }
}

function markPhysicalKeyboard() {
  try { localStorage.setItem(PHYSICAL_KEY, "1"); } catch { /* stockage optionnel */ }
}

function wantsOnScreenKeyboard() {
  const mode = oskMode();
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (physicalKeyboardSeen()) return false;
  // Noyau Desk tourne sur le PC, clavier branche; un telephone ou une tablette n'en a pas.
  if (TOUCH_MODE) return false;
  // Un portable tactile expose aussi un pointeur fin: seul un vrai mobile n'en a aucun.
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
}
const THEME_KEY = "noyau:theme";
const THEMES = {
  noyau: { label: "Thème Noyau", terminal: { background: "#080b0a", foreground: "#d9e0dc", cursor: "#b8ff5e", selectionBackground: "#31551f88" } },
  "aurora": { label: "Château ambulant", terminal: { background: "#0f1119", foreground: "#eeeae3", cursor: "#e1b047", selectionBackground: "#e1b04744" } },
};

function applyTheme(theme) {
  const value = THEMES[theme] ? theme : "noyau";
  document.documentElement.dataset.theme = value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", value === "aurora" ? "#0f1119" : "#080b0a");
  try { localStorage.setItem(THEME_KEY, value); } catch { /* stockage optionnel */ }
}

function applyInstallIdentity(profile) {
  if (!profile) return;
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", `/manifest.webmanifest?profile=${encodeURIComponent(profile.id)}`);
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", profile.primary ? "Noyau" : `Noyau · ${profile.name}`);
}

function terminalTheme() {
  return (THEMES[document.documentElement.dataset.theme] || THEMES.noyau).terminal;
}

function cachedView(key) {
  const scopedKey = profileCacheKey(key);
  if (viewCache.has(scopedKey)) return viewCache.get(scopedKey);
  try {
    const raw = localStorage.getItem(`noyau-cache-${scopedKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    viewCache.set(scopedKey, parsed.value);
    return parsed.value;
  } catch {
    return null;
  }
}

function storeView(key, value) {
  const scopedKey = profileCacheKey(key);
  viewCache.set(scopedKey, value);
  try {
    localStorage.setItem(`noyau-cache-${scopedKey}`, JSON.stringify({ value, at: Date.now() }));
  } catch { /* stockage optionnel */ }
}

function applicationServerKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function api(path, options = {}) {
  const multipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const profileId = activeProfileId();
  const response = await fetch(path, {
    ...options,
    headers: { ...(multipart ? {} : { "Content-Type": "application/json" }), ...(profileId ? { "X-Noyau-Profile": profileId } : {}), ...options.headers },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Erreur ${response.status}`);
    error.status = response.status;
    error.retryAfter = Number(body.retryAfter || response.headers.get("retry-after")) || 0;
    throw error;
  }
  return body;
}

function useCountdown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return undefined;
    const timer = setTimeout(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds];
}

const VERSION_KEY = "noyau:version";
const TOUCH_MODE = new URLSearchParams(location.search).get("touch") === "1";

function appPath(parameters = {}) {
  const search = new URLSearchParams();
  if (TOUCH_MODE) search.set("touch", "1");
  if (activeProfileId()) search.set("profile", activeProfileId());
  Object.entries(parameters).forEach(([key, value]) => search.set(key, String(value)));
  const query = search.toString();
  return query ? `/?${query}` : "/";
}

async function purgeClient() {
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch { /* ignore */ }
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((registrations || []).map((registration) => registration.unregister()));
  } catch { /* ignore */ }
}

async function hardReset() {
  await purgeClient();
  try { localStorage.removeItem(VERSION_KEY); } catch { /* ignore */ }
  location.replace(appPath({ reset: Date.now() }));
}

function Mark() {
  return <span className="mark"><i /><b /></span>;
}

function BootRing({ percent }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(Math.max(percent, 0), 100) / 100);
  return (
    <div className="boot-ring">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="boot-ring-track" cx="32" cy="32" r={radius} />
        <circle className="boot-ring-value" cx="32" cy="32" r={radius} strokeDasharray={circumference} strokeDashoffset={offset} />
      </svg>
      <span className="boot-percent">{Math.round(percent)}%</span>
    </div>
  );
}

function Boot({ percent, step, offline, detail, attempts, onRetry, onReset }) {
  return (
    <div className="boot">
      <div className="boot-content">
        <Mark />
        <strong>Noyau</strong>
        <BootRing percent={offline ? 100 : percent} />
        <small className={offline ? "boot-step error" : "boot-step"}>{offline ? "Serveur injoignable" : step}</small>
        {offline && (
          <>
            <p className="muted boot-detail">{detail || "Vérifie le VPN / le Wi-Fi local."} ({attempts} tentative{attempts > 1 ? "s" : ""})</p>
            <div className="boot-actions">
              <button className="primary" onClick={onRetry}>Réessayer</button>
              <button className="ghost danger" onClick={onReset}>Réinitialiser l’app</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Login({ onLogin }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/auth", { method: "POST", body: JSON.stringify({ token }) });
      onLogin();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <Mark />
        <p className="eyebrow">CENTRE DE CONTRÔLE LOCAL</p>
        <h1>Noyau</h1>
        <p className="muted">Tes agents. Ton ordinateur. Depuis partout.</p>
        <form onSubmit={submit}>
          <label htmlFor="token">Clé d’accès</label>
          <input id="token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoFocus autoComplete="current-password" />
          {error && <p className="form-error">{error}</p>}
          <button className="primary wide" disabled={!token || loading}>{loading ? "Connexion…" : "Entrer"}</button>
        </form>
        <p className="login-hint">Clé affichée dans terminal au démarrage.</p>
      </section>
    </main>
  );
}

function AgentIcon({ assistant, small = false, logoUrl = null }) {
  const meta = assistantMeta[assistant] || assistantMeta.shell;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logoUrl]);
  if (logoUrl && !failed) return <span className={`agent-icon project-logo ${small ? "small" : ""}`}><img src={logoUrl} alt="" onError={() => setFailed(true)} /></span>;
  return <span className={`agent-icon ${meta.color} ${small ? "small" : ""}`}>{meta.glyph}</span>;
}

function ProjectIcon({ project, small = false }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [project.logoUrl]);
  if (!failed) return <span className={`agent-icon project-logo ${small ? "small" : ""}`}><img src={project.logoUrl} alt="" onError={() => setFailed(true)} /></span>;
  return <span className={`agent-icon violet ${small ? "small" : ""}`}>P</span>;
}

function RelativeTime({ date }) {
  const formatter = useMemo(() => new Intl.RelativeTimeFormat("fr", { numeric: "auto" }), []);
  if (!date) return "inconnue";
  const seconds = Math.round((new Date(date).getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function providerQuota(quotas, assistant) {
  if (assistant === "codex") {
    const windows = quotas?.codex?.windows || [];
    if (!windows.length) return null;
    const min = windows.reduce((prev, curr) => (Number(curr.remainingPercent) < Number(prev.remainingPercent) ? curr : prev), windows[0]);
    return { percent: min.remainingPercent, resetsAt: min.resetsAt };
  }
  if (["claude", "claude-design"].includes(assistant)) {
    const windows = [quotas?.claude?.fiveHour, quotas?.claude?.sevenDay].filter(Boolean);
    if (!windows.length) return null;
    const min = windows.reduce((prev, curr) => (Number(curr.remainingPercent) < Number(prev.remainingPercent) ? curr : prev), windows[0]);
    return { percent: min.remainingPercent, resetsAt: min.resetsAt };
  }
  if (assistant === "antigravity") {
    const windows = quotas?.antigravity?.windows || [];
    if (!windows.length) return null;
    const min = windows.reduce((prev, curr) => (Number(curr.remainingPercent) < Number(prev.remainingPercent) ? curr : prev), windows[0]);
    return { percent: min.remainingPercent, resetsAt: min.resetsAt };
  }
  return null;
}

function formatReset(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Reset inconnu";
  return `Reset ${new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))}`;
}

// Temps restant avant renouvellement: plus parlant qu'une date pour savoir si on peut lancer un agent.
function resetCountdown(value) {
  const target = new Date(value).getTime();
  if (!value || Number.isNaN(target)) return "reset inconnu";
  const minutes = Math.round((target - Date.now()) / 60_000);
  if (minutes <= 0) return "renouvelé";
  if (minutes < 60) return `dans ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `dans ${hours} h${minutes % 60 ? ` ${minutes % 60}` : ""}`;
  return `dans ${Math.floor(hours / 24)} j ${hours % 24} h`;
}

function weatherLabel(code) {
  if (code === 0) return "Dégagé";
  if ([1, 2].includes(code)) return "Peu nuageux";
  if (code === 3) return "Couvert";
  if ([45, 48].includes(code)) return "Brouillard";
  if (code >= 51 && code <= 57) return "Bruine";
  if (code >= 61 && code <= 67) return "Pluie";
  if (code >= 71 && code <= 77) return "Neige";
  if (code >= 80 && code <= 82) return "Averses";
  if (code >= 85 && code <= 86) return "Neige";
  if (code >= 95) return "Orage";
  return "Variable";
}

function sortAgents(sessions) {
  return [...sessions].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || (a.project?.name || "zzz").localeCompare(b.project?.name || "zzz", "fr") || a.name.localeCompare(b.name, "fr"));
}

function euro(value) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function localIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftIsoDate(days, from = new Date()) {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

function operationDate(item) {
  const actual = item.date.split("-").reverse().join("/");
  return item.bookingDate ? `${actual} · comptabilisé ${item.bookingDate.split("-").reverse().join("/")}` : actual;
}

function merchantKey(value) {
  const cleaned = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(cb|carte|paiement|paiment|par|achat|achats|virement|vir|prlv|prelevement|facture|du|le|la|les|des)\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 3)
    .join(" ")
    .trim();
  return cleaned || String(value || "").toLowerCase().trim();
}

// Ligne d'etat de synchro: derniere reception bancaire et resultat du passage automatique de 6h.
function bankSyncLabel(banking) {
  if (!banking?.status?.connections?.length) return "Aucune banque liée.";
  const last = banking.lastSyncAt ? new Date(banking.lastSyncAt) : null;
  const when = last && !Number.isNaN(last.getTime())
    ? `${last.toLocaleDateString("fr-FR")} à ${last.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
    : "jamais";
  const auto = banking.autoSync?.error ? ` · dernier passage auto en échec: ${banking.autoSync.error}` : "";
  return `Dernière synchro bancaire ${when} · automatique chaque matin à 6h${auto}`;
}

function exclusionLabel(reason) {
  return reason === "placement" ? "Placement exclu" : reason === "doublon-carte" ? "Doublon carte exclu" : reason === "professionnel" ? "Dépense professionnelle exclue" : "Transfert interne exclu";
}

function ProfileSwitcher({ profiles, profileId, onSwitch, onLogout }) {
  const [open, setOpen] = useState(false);
  const active = profiles.find((item) => item.id === profileId);
  const label = active?.name || "Session locale";
  return (
    <div className="profile-switcher">
      {open && (
        <>
          <button className="profile-menu-backdrop" onClick={() => setOpen(false)} aria-label="Fermer profils" />
          <nav className="profile-menu">
            {profiles.map((item) => (
              <button className={item.id === profileId ? "active" : ""} onClick={() => { setOpen(false); onSwitch(item.id); }} key={item.id}>
                <span>{item.name.slice(0, 1).toUpperCase()}</span>
                <strong>{item.name}<small>{THEMES[item.theme]?.label || item.theme}</small></strong>
                {item.id === profileId && <i>✓</i>}
              </button>
            ))}
            <button className="profile-logout" onClick={() => { setOpen(false); onLogout(); }}>Se déconnecter</button>
          </nav>
        </>
      )}
      <button className="profile-chip" onClick={() => setOpen((value) => !value)} aria-label={`Profil ${label}`}>
        <span>{label.slice(0, 1).toUpperCase()}</span>
        <strong>{label}</strong>
        <i aria-hidden="true">▾</i>
      </button>
    </div>
  );
}

function Sidebar({ sessions, activeId, view, onOpen, onView, onNew, onLogout, open, onClose, profiles, profileId, onSwitchProfile, todoUnread = 0 }) {
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><Mark /><span>Noyau</span><button className="icon-button close-menu" onClick={onClose} aria-label="Fermer">×</button></div>
      <ProfileSwitcher profiles={profiles} profileId={profileId} onSwitch={onSwitchProfile} onLogout={onLogout} />
      <nav className="main-nav">
        <button className={!activeId && view === "dashboard" ? "active" : ""} onClick={() => { onOpen(null); onView("dashboard"); onClose(); }}><span>⌂</span>Accueil</button>
        <button className={!activeId && view === "projects" ? "active" : ""} onClick={() => { onOpen(null); onView("projects"); onClose(); }}><span>◫</span>Projets</button>
        <button className={!activeId && view === "todos" ? "active" : ""} onClick={() => { onOpen(null); onView("todos"); onClose(); }}><span>✓</span>Todo{todoUnread > 0 && <b className="nav-badge" title={`${todoUnread} changement${todoUnread > 1 ? "s" : ""} non lu${todoUnread > 1 ? "s" : ""}`}>{todoUnread > 99 ? "99+" : todoUnread}</b>}</button>
        <button className={!activeId && ["finances", "finance-transactions", "finance-agent", "finance-modules"].includes(view) ? "active" : ""} onClick={() => { onOpen(null); onView("finances"); onClose(); }}><span>€</span>Budget</button>
        <button className={!activeId && view === "settings" ? "active" : ""} onClick={() => { onOpen(null); onView("settings"); onClose(); }}><span className="nav-settings-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h10m4 0h2M4 17h2m4 0h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg></span>Réglages</button>
      </nav>
      <div className="sidebar-title"><span>AGENTS</span><button onClick={onNew} aria-label="Nouvelle session">+</button></div>
      <div className="session-list">
        {sessions.map((session) => (
          <button className={activeId === session.id ? "active" : ""} onClick={() => { onOpen(session.id); onClose(); }} key={session.id}>
            <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small />
            <span><strong>{session.favorite && <b className="favorite-star">★</b>}{session.name}{(session.shared || session.canEdit === false) && <b className="shared-star" title={session.canEdit === false ? `Partagé par ${session.owner?.name || "autre profil"}` : "Partagé avec les autres profils"}>⇄</b>}</strong><small>{session.canEdit === false ? `${session.owner?.name || "Autre profil"} · ` : ""}{session.project?.name || assistantMeta[session.assistant]?.label || "Terminal"} · {session.agentStatus?.label || "Disponible"}</small></span>
            <i className={`live-dot ${session.agentStatus?.state || "available"}`} title={session.agentStatus?.label || "Disponible"} />
          </button>
        ))}
        {!sessions.length && <p className="empty-small">Aucune session active.</p>}
      </div>
      <AgentArchives onOpen={(id) => { onOpen(id); onClose(); }} compact />
    </aside>
  );
}

function Header({ title, subtitle, onMenu, actionLabel = "Nouvel agent", onAction }) {
  return (
    <header className="topbar">
      <button className="icon-button menu-button" onClick={onMenu} aria-label="Menu">☰</button>
      <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <div className="top-actions">
        <FullscreenToggle />
        {onAction && <button className="primary" onClick={onAction}><span>+</span> {actionLabel}</button>}
      </div>
    </header>
  );
}

// Plein ecran natif: dispo sur le PC (Firefox, Chrome), absent sur iOS ou l'API n'existe pas.
function FullscreenToggle({ className = "" }) {
  const [full, setFull] = useState(() => Boolean(document.fullscreenElement));
  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  if (!document.fullscreenEnabled) return null;
  const toggle = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch (error) {
      window.alert(`Plein écran refusé: ${error.message}`);
    }
  };
  return (
    <button className={`fullscreen-toggle ${className}`} onClick={toggle} title={full ? "Quitter le plein écran (F11)" : "Passer en plein écran (F11)"} aria-label={full ? "Quitter le plein écran" : "Passer en plein écran"}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {full
          ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
      </svg>
    </button>
  );
}

function TouchSystemBar({ sessions, onHome, onNew }) {
  const [now, setNow] = useState(new Date());
  const [online, setOnline] = useState(navigator.onLine);
  const [sleeping, setSleeping] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    const updateNetwork = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, []);
  const working = sessions.filter(({ agentStatus }) => agentStatus?.state === "working").length;
  const waiting = sessions.filter(({ agentStatus }) => agentStatus?.state === "waiting").length;
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(now);
  const date = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "short" }).format(now);
  async function sleepDisplay() {
    setSleeping(true);
    try {
      await api("/api/system/display/sleep", { method: "POST" });
    } catch (error) {
      window.alert(error.message);
    } finally {
      setSleeping(false);
    }
  }
  return (
    <header className="touch-system-bar">
      <button className="touch-system-home" onClick={onHome}><Mark /><span><strong>NOYAU</strong><small>DESK OS</small></span></button>
      <div className="touch-system-stats">
        <span><i className="available" /><b>{sessions.length}</b> agents</span>
        <span><i className="working" /><b>{working}</b> travail</span>
        <span><i className="waiting" /><b>{waiting}</b> attente</span>
        <span><i className={online ? "available" : "offline"} />{online ? "PC local" : "Hors ligne"}</span>
      </div>
      <button className="touch-system-new" onClick={onNew}>＋ Agent</button>
      <FullscreenToggle className="touch-system-fullscreen" />
      <button className="touch-system-sleep" onClick={sleepDisplay} disabled={sleeping} title="Éteindre écran jusqu’au prochain toucher">◐ Écran</button>
      <time dateTime={now.toISOString()}><strong>{time}</strong><small>{date}</small></time>
    </header>
  );
}

function DashboardAgentCard({ session, onOpen, onEdit, onFavorite, onArchive }) {
  return (
    <article className="agent-card">
      <button className="agent-card-open" onClick={() => onOpen(session.id)}>
        <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} />
        <span className="agent-info"><strong><b className={`assistant-chip ${session.assistant}`} title={`${assistantMeta[session.assistant]?.label || session.assistant}${session.switchedFrom ? ` · basculé depuis ${assistantMeta[session.switchedFrom]?.label || session.switchedFrom}` : ""}`}>{assistantMeta[session.assistant]?.glyph || "?"}</b>{session.switchedFrom && <i className="switched-mark" title={`Basculé depuis ${assistantMeta[session.switchedFrom]?.label || session.switchedFrom}`}>↔</i>}<span className="agent-name">{session.name}</span>{session.canEdit === false && <b className="shared-chip" title={`Agent partagé par ${session.owner?.name || "autre profil"}`}>⇄ {session.owner?.name || "partagé"}</b>}{session.canEdit !== false && session.shared && <b className="shared-chip own" title="Agent partagé avec les autres profils">⇄ partagé</b>}</strong><small>{session.project?.name || "Sans projet"} · {session.cwd || session.id}</small><em><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {session.agentStatus?.label || "Disponible"} · {session.usage?.contextPercent ?? "—"}% contexte · <RelativeTime date={session.activityAt} /></em></span>
        <span className="open-arrow">›</span>
      </button>
      {session.managed && session.canEdit !== false && <div className="agent-card-actions"><button className={`agent-card-favorite ${session.favorite ? "active" : ""}`} onClick={() => onFavorite(session)} aria-label={`${session.favorite ? "Retirer" : "Ajouter"} favori`}>★</button>{!session.core && <button className="agent-card-archive" onClick={() => onArchive(session)} title="Archiver: ferme l'agent en gardant son fil pour le restaurer" aria-label={`Archiver ${session.name}`}>⇩</button>}<button className="agent-card-edit" onClick={() => onEdit(session.id)} aria-label={`Éditer ${session.name}`}>Éditer</button></div>}
    </article>
  );
}

// Selecteur de tache pour la conversation: les plus recemment actives d'abord.
function TodoTagPicker({ onPick, onClose, projectId = null, projectName = null }) {
  const [todos, setTodos] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  const [scope, setScope] = useState(projectId ? "project" : "all");

  useEffect(() => {
    api("/api/todos")
      .then((result) => {
        // Les taches du projet de l'agent passent devant, puis l'activite la plus recente.
        const folderIds = new Set((result.folders || []).filter((folder) => projectId && folder.projectId === projectId).map((folder) => folder.id));
        const ranked = [...(result.todos || [])]
          .map((todo) => ({ ...todo, inProject: folderIds.has(todo.folderId) }))
          .sort((a, b) => (a.inProject === b.inProject ? String(b.activityAt || "").localeCompare(String(a.activityAt || "")) : a.inProject ? -1 : 1));
        setTodos(ranked);
      })
      .catch((reason) => setError(reason.message));
  }, [projectId]);

  const needle = query.trim().toLowerCase().replace(/^\*/, "");
  const matches = todos
    .filter((todo) => scope !== "project" || todo.inProject)
    .filter((todo) => !needle || todo.text.toLowerCase().includes(needle) || todoRef(todo.id).toLowerCase().includes(needle))
    .slice(0, 40);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal todo-picker">
        <div className="modal-head"><div><p className="eyebrow">TÂCHES</p><h2>Taguer une tâche</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
        <input
          autoFocus
          className="todo-picker-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Chercher une tâche ou une référence *A1B2…"
        />
        {projectId && (
          <div className="todo-picker-scope">
            <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>{projectName || "Ce projet"}</button>
            <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>Toutes les tâches</button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="todo-picker-list">
          {matches.map((todo) => (
            <button className="todo-picker-row" key={todo.id} onClick={() => onPick(todo)}>
              <b>{todoRef(todo.id)}</b>
              <span>
                <strong>{todo.text}</strong>
                <small>{todo.status === "done" ? "Terminé" : todo.status === "review" ? "À tester / valider" : "À faire"} · {todo.comments?.length || 0} commentaire{(todo.comments?.length || 0) > 1 ? "s" : ""}{todo.activityAt ? ` · ${formatCommentDate(todo.activityAt)}` : ""}</small>
              </span>
            </button>
          ))}
          {!matches.length && <p className="todo-column-empty">Aucune tâche trouvée.</p>}
        </div>
      </section>
    </div>
  );
}

// Vue d'une tache ouverte depuis la conversation, avec retour vers l'agent.
function TodoDetailOverlay({ todo, onClose, onTag }) {
  const [entry, setEntry] = useState(todo);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function addComment(event) {
    event.preventDefault();
    if (!comment.trim()) return;
    setBusy(true);
    try {
      const result = await api(`/api/todos/${encodeURIComponent(entry.id)}/comments`, { method: "POST", body: JSON.stringify({ text: comment }) });
      setEntry(result.todo || entry);
      setComment("");
      setError("");
      window.dispatchEvent(new Event("noyau:todos"));
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="todo-detail-overlay">
      <header>
        <button className="todo-detail-back" onClick={onClose}>‹ Retour à l’agent</button>
        <b className="todo-ref-pill">{todoRef(entry.id)}</b>
        {onTag && <button className="ghost" onClick={() => { onTag(entry); onClose(); }}>Taguer dans la conversation</button>}
      </header>
      <div className="todo-detail-body">
        <h2>{entry.text}</h2>
        <p className="todo-detail-meta">
          {entry.status === "done" ? "Terminé" : entry.status === "review" ? "À tester / valider" : "À faire"}
          {entry.dueDate ? ` · échéance ${entry.dueDate.split("-").reverse().join("/")}` : ""}
          {entry.activityAt ? ` · dernière activité ${formatCommentDate(entry.activityAt)}` : ""}
        </p>
        <div className="todo-comments-list">
          {(entry.comments || []).map((item) => (
            <div className="todo-comment-item" key={item.id}>
              <div className="todo-comment-meta">
                {item.author && <strong className={`todo-comment-author ${item.kind === "agent" ? "agent" : ""}`}>{item.kind === "agent" ? `IA · ${item.author}` : item.author}</strong>}
                <span className="todo-comment-time">{formatCommentDate(item.createdAt)}</span>
              </div>
              <p className="todo-comment-text">{item.text}</p>
            </div>
          ))}
          {!(entry.comments || []).length && <p className="todo-comments-empty">Aucun commentaire pour le moment.</p>}
        </div>
        {error && <p className="form-error">{error}</p>}
        <form className="todo-comment-form" onSubmit={addComment}>
          <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Ajouter un commentaire…" maxLength="2000" />
          <button className="primary" disabled={busy || !comment.trim()}>{busy ? "…" : "Commenter"}</button>
        </form>
      </div>
    </div>
  );
}

function AgentArchives({ onOpen, compact = false }) {
  const [archives, setArchives] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api("/api/agents/archives");
      setArchives(result.archives || []);
      setError("");
    } catch (reason) {
      setError(reason.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Un archivage ailleurs dans l'ecran rafraichit immediatement la liste.
    window.addEventListener("noyau:archives", load);
    const timer = setInterval(load, open ? 20_000 : 60_000);
    return () => { window.removeEventListener("noyau:archives", load); clearInterval(timer); };
  }, [open, load]);

  async function restore(archive) {
    setBusy(archive.id);
    try {
      const result = await api(`/api/agents/archives/${encodeURIComponent(archive.id)}/restore`, { method: "POST" });
      setArchives(result.archives || []);
      setError("");
      if (result.session?.id) onOpen?.(result.session.id);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy("");
    }
  }

  async function forget(archive) {
    if (!window.confirm(`Oublier définitivement l'archive « ${archive.name} » ?`)) return;
    setBusy(archive.id);
    try {
      const result = await api(`/api/agents/archives/${encodeURIComponent(archive.id)}`, { method: "DELETE" });
      setArchives(result.archives || []);
      setError("");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <details className={`agent-archives ${compact ? "compact" : ""}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="agent-group-chevron">›</span>
        <strong>Agents archivés</strong>
        <small>{archives.length ? `${archives.length} restaurable${archives.length > 1 ? "s" : ""}` : "aucun"}</small>
      </summary>
      {error && <p className="finance-error">{error}</p>}
      <div className="agent-archive-list">
        {archives.map((archive) => (
          <article className="agent-archive-row" key={archive.id}>
            <div>
              <strong>{archive.name}</strong>
              <small>{assistantMeta[archive.assistant]?.label || archive.assistant} · {archive.cwd || "—"}</small>
              <small>{archive.reason === "reaped" ? "Fermé tout seul" : "Fermé manuellement"} · {formatCommentDate(archive.archivedAt)}</small>
            </div>
            <div className="agent-archive-actions">
              <button className="primary" onClick={() => restore(archive)} disabled={busy === archive.id} title="Relancer cet agent avec son fil de discussion">
                {busy === archive.id ? "…" : "Restaurer"}
              </button>
              <button className="ghost" onClick={() => forget(archive)} disabled={busy === archive.id} title="Oublier cette archive">×</button>
            </div>
          </article>
        ))}
        {!archives.length && <p className="todo-column-empty">Aucun agent archivé pour le moment.</p>}
      </div>
    </details>
  );
}

function Dashboard({ sessions, projects, quotas, onOpen, onNew, onEdit, onFavorite, onArchive, onProjects, onFinances, onRefreshQuotas }) {
  const [refreshingQuotas, setRefreshingQuotas] = useState(false);
  const [quotaRefreshState, setQuotaRefreshState] = useState("");
  const [weather, setWeather] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("noyau-weather"));
      return cached && Date.now() - new Date(cached.retrievedAt).getTime() < 30 * 60 * 1000 ? cached : null;
    } catch {
      return null;
    }
  });
  const codexCount = sessions.filter((session) => session.assistant === "codex").length;
  const claudeCount = sessions.filter((session) => ["claude", "claude-design"].includes(session.assistant)).length;
  const shellCount = sessions.filter((session) => session.assistant === "shell").length;
  const antigravityCount = sessions.filter((session) => session.assistant === "antigravity").length;
  const linkedProjects = new Set(sessions.map((session) => session.projectId).filter(Boolean)).size;
  const favoriteCount = sessions.filter((session) => session.favorite).length;

  const antigravityWindows = quotas.antigravity?.windows || [];
  const codexWindows = (quotas.codex?.windows || []).map((item) => ({ ...item, label: item.windowMinutes >= 10_080 ? "7 j" : item.label }));
  const claudeWindows = [
    quotas.claude?.fiveHour && { label: "5 h", ...quotas.claude.fiveHour },
    quotas.claude?.sevenDay && { label: "7 j", ...quotas.claude.sevenDay },
  ].filter(Boolean);
  const projectBuckets = new Map();
  sessions.forEach((session) => {
    if (!session.projectId) return;
    const bucket = projectBuckets.get(session.projectId) || [];
    bucket.push(session);
    projectBuckets.set(session.projectId, bucket);
  });
  const insertedProjects = new Set();
  const agentItems = [];
  sessions.forEach((session) => {
    const bucket = session.projectId && projectBuckets.get(session.projectId);
    if (!bucket || bucket.length < 2) {
      agentItems.push({ session });
      return;
    }
    if (insertedProjects.has(session.projectId)) return;
    insertedProjects.add(session.projectId);
    agentItems.push({ project: projects.find((project) => project.id === session.projectId) || session.project, sessions: bucket });
  });
  useEffect(() => {
    let disposed = false;
    const apply = (next) => {
      if (disposed || !next) return;
      setWeather(next);
      try { localStorage.setItem("noyau-weather", JSON.stringify(next)); } catch { /* cache optional */ }
    };
    // iOS refuse la geolocalisation hors HTTPS de confiance: on demande quand meme la meteo,
    // le serveur repond avec la derniere position connue.
    const lastKnown = () => api("/api/weather").then(apply).catch(() => {});
    if (!navigator.geolocation) {
      lastKnown();
      return () => { disposed = true; };
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => api(`/api/weather?latitude=${encodeURIComponent(coords.latitude)}&longitude=${encodeURIComponent(coords.longitude)}`).then(apply).catch(lastKnown),
      lastKnown,
      { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 5000 },
    );
    return () => { disposed = true; };
  }, []);
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(now).toLocaleUpperCase("fr-FR");
  const greeting = now.getHours() < 12 ? "Bonjour" : now.getHours() < 18 ? "Bon après-midi" : "Bonsoir";
  return (
    <div className="page dashboard">
      <section className="hero-row">
        <div><p className="eyebrow">{weekday} · CENTRE DE CONTRÔLE</p><div className="hero-title"><h1>{greeting}.</h1>{weather && <span className={`weather-inline ${weather.isDay ? "day" : "night"}`} title={`Ressenti ${Math.round(weather.apparentTemperature)}°C`}><i /><b>{Math.round(weather.temperature)}°</b><span>{weatherLabel(weather.code)}</span><small>Open-Meteo</small></span>}</div></div>
        <div className="system-state"><i /><span><strong>Système opérationnel</strong><small>Connexion locale chiffrable via VPN</small></span></div>
      </section>

      <section className="metrics">
        <article className="active-agents-metric"><span className="metric-symbol green">◎</span><div className="active-agents-content"><small>AGENTS ACTIFS</small><div className="active-agents-data"><div className="active-total-block"><strong className="active-total">{sessions.length}</strong><em>en ligne</em></div><div className="agent-breakdown"><span><b>{codexCount}</b><em>Codex</em></span><span><b>{claudeCount}</b><em>Claude</em></span>{antigravityCount > 0 && <span><b>{antigravityCount}</b><em>Antigravity</em></span>}<span><b>{shellCount}</b><em>Terminal</em></span></div></div><p className="active-agents-footer"><span>{linkedProjects} projet{linkedProjects > 1 ? "s" : ""} lié{linkedProjects > 1 ? "s" : ""}</span><span>{favoriteCount} favori{favoriteCount > 1 ? "s" : ""}</span></p></div></article>
        <article className="quota-metric"><span className="metric-symbol blue">↗</span><div><small className="quota-title">QUOTAS IA<button className={refreshingQuotas ? "quota-refresh updating" : "quota-refresh"} onClick={async () => { setRefreshingQuotas(true); setQuotaRefreshState("Actualisation…"); try { const result = await onRefreshQuotas(); const failed = Object.entries(result?.refreshed || {}).filter(([, state]) => !state.ok).map(([provider]) => provider); setQuotaRefreshState(failed.length ? `Échec: ${failed.join(", ")}` : `Actualisé ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`); } catch (error) { setQuotaRefreshState(error.message || "Actualisation impossible"); } finally { setRefreshingQuotas(false); } }} disabled={refreshingQuotas} aria-label="Rafraîchir quotas" title="Rafraîchir quotas"><span aria-hidden="true">↻</span></button><em className="quota-refresh-state">{quotaRefreshState}</em></small><div className="quota-providers"><div className="quota-codex"><span>CODEX</span>{codexWindows.length ? <div className="quota-dials">{codexWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{resetCountdown(item.resetsAt)}</em></div>)}</div> : <div className="quota-empty"><strong>—</strong><em>Relevé indisponible</em></div>}</div><div className="quota-antigravity"><span>ANTIGRAVITY</span>{antigravityWindows.length ? <div className="quota-dials">{antigravityWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{resetCountdown(item.resetsAt)}</em></div>)}</div> : <div className="quota-empty"><strong>—</strong><em>Relevé indisponible</em></div>}</div><div className="quota-claude"><span>CLAUDE</span>{claudeWindows.length ? <div className="quota-dials">{claudeWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{resetCountdown(item.resetsAt)}</em></div>)}</div> : <div className="quota-empty"><strong>{quotas.claude?.status === "loggedOut" ? "Déconnecté" : "—"}</strong><em>{quotas.claude?.status === "loggedOut" ? "Reconnecte Claude" : "Reset inconnu"}</em></div>}</div></div></div></article>
      </section>

      <section className="panel agents-panel">
        <div className="panel-head"><div><h3>Agents actifs</h3><p>Sessions tmux sur ce PC</p></div><button className="ghost" onClick={onNew}>+ Lancer</button></div>
        <div className="agent-grid grouped-agent-grid">
          {agentItems.map((item) => item.sessions ? (
            <details className="agent-group" key={item.sessions[0].projectId}>
              <summary><span className="agent-group-chevron">›</span><strong>{item.project?.name || "Projet"}</strong><small>{item.sessions.length} agents actifs</small></summary>
              <div className="agent-group-grid">
                {item.sessions.map((session) => <DashboardAgentCard key={session.id} session={session} onOpen={onOpen} onEdit={onEdit} onFavorite={onFavorite} onArchive={onArchive} />)}
              </div>
            </details>
          ) : <DashboardAgentCard key={item.session.id} session={item.session} onOpen={onOpen} onEdit={onEdit} onFavorite={onFavorite} onArchive={onArchive} />)}
          {!sessions.length && (
            <button className="empty-agent" onClick={onNew}><span>+</span><strong>Lancer premier agent</strong><small>Codex, Claude ou terminal</small></button>
          )}
        </div>
        <AgentArchives onOpen={onOpen} />
      </section>

      <section className="panel project-preview">
        <div className="panel-head"><div><h3>Projets</h3><p>Agents rattachés par travail</p></div><button className="ghost" onClick={onProjects}>Gérer</button></div>
        <div className="project-preview-grid">
          {projects.slice(0, 4).map((project) => {
            const count = sessions.filter((session) => session.projectId === project.id).length;
            return <button key={project.id} onClick={onProjects}><ProjectIcon project={project} small /><span><strong>{project.name}</strong><small>{count} agent{count > 1 ? "s" : ""} actif{count > 1 ? "s" : ""}</small></span><b>›</b></button>;
          })}
          {!projects.length && <button className="empty-project" onClick={onProjects}><span>＋</span><strong>Créer premier projet</strong></button>}
        </div>
      </section>

      <section className="future-grid">
        <article className="panel"><span>NOUVEAU</span><h3>Budget</h3><p>Capacité épargne, enveloppes et alertes mensuelles.</p><button onClick={onFinances}>Ouvrir</button></article>
      </section>
    </div>
  );
}

function ModuleSchedule({ moduleId, schedule, onSave }) {
  const [time, setTime] = useState(schedule.time);
  const [saving, setSaving] = useState(false);
  useEffect(() => setTime(schedule.time), [schedule.time]);
  async function save() {
    setSaving(true);
    try {
      await onSave(moduleId, schedule.id, time);
    } finally {
      setSaving(false);
    }
  }
  const nextRun = schedule.nextRun?.match(/\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/)?.[1];
  return <label className="module-schedule"><span><strong>{schedule.label}</strong><small>{schedule.active ? `Prochain ${nextRun || time}` : "Timer arrêté"}</small></span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /><button onClick={save} disabled={saving || time === schedule.time}>{saving ? "…" : "OK"}</button></label>;
}

function ModuleKnowledge({ module, onConfigured }) {
  const [open, setOpen] = useState(false);
  const [stack, setStack] = useState([]);
  const [items, setItems] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const [pages, setPages] = useState([]);
  const [selectedRoot, setSelectedRoot] = useState("");
  const [showConfig, setShowConfig] = useState(false);

  const notion = module.knowledge?.provider === "notion";
  const configured = module.knowledge?.status?.configured;

  const loadPages = useCallback(async () => {
    if (!notion) return;
    try {
      const result = await api(`/api/modules/${encodeURIComponent(module.id)}/knowledge/pages`);
      setPages(result.pages || []);
      if (module.knowledge?.status?.rootPageId) {
        setSelectedRoot(module.knowledge.status.rootPageId);
      }
    } catch { /* ignore */ }
  }, [module.id, notion, module.knowledge?.status?.rootPageId]);

  useEffect(() => {
    if (open && notion && configured) {
      loadPages();
    }
  }, [open, notion, configured, loadPages]);

  async function load(folder = null, nextStack = stack) {
    setBusy(true);
    setError("");
    try {
      const query = folder?.id ? `?folderId=${encodeURIComponent(folder.id)}` : "";
      const result = await api(`/api/modules/${encodeURIComponent(module.id)}/knowledge${query}`);
      setItems(result.items || []);
      setStack(nextStack);
      setPreview(null);
      setOpen(true);
      if (notion) loadPages();
    } catch (reason) {
      setError(reason.message);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function openItem(item) {
    if (item.kind === "folder") return load(item, [...stack, item]);
    if (!item.readable) return window.open(item.url, "_blank", "noopener,noreferrer");
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/modules/${encodeURIComponent(module.id)}/knowledge/content?itemId=${encodeURIComponent(item.id)}&kind=${encodeURIComponent(item.kind)}`);
      setPreview({ ...item, content: result.content || "", truncated: result.truncated });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function configureNotion(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {};
      if (token.trim()) body.token = token.trim();
      if (selectedRoot) body.rootPageId = selectedRoot;
      if (pageUrl.trim()) body.pageUrl = pageUrl.trim();
      await api(`/api/modules/${encodeURIComponent(module.id)}/knowledge/config`, { method: "PATCH", body: JSON.stringify(body) });
      setToken("");
      setPageUrl("");
      setShowConfig(false);
      await onConfigured?.();
      await load(null, []);
    } catch (reason) {
      setError(reason.message);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  if (!module.knowledge) return null;
  const rootLabel = module.knowledge.status?.rootPageName
    ? `Racine : ${module.knowledge.status.rootPageName}`
    : module.knowledge.status?.rootPageId
      ? "Page racine connectée"
      : configured
        ? "Toutes les pages"
        : null;

  return <>
    <button className="primary" onClick={() => open ? setOpen(false) : (notion && !configured ? (setOpen(true), setShowConfig(true)) : load())}>
      {open ? "Fermer contenu" : module.knowledge.label}
    </button>
    {open && <section className="module-knowledge">
      {notion && (showConfig || !configured) && <form className="module-knowledge-config" onSubmit={configureNotion}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>{configured ? "Réglages Notion & Page racine" : "Connecter Notion"}</strong>
          {configured && <button type="button" className="ghost" onClick={() => setShowConfig(false)}>Fermer</button>}
        </div>
        {!configured && <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Token Notion ntn_…" autoComplete="off" required />}
        {pages.length > 0 && (
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={{ fontSize: "10px", color: "var(--c-a0aaa2)" }}>Choisir la page racine :</span>
            <select value={selectedRoot} onChange={(event) => setSelectedRoot(event.target.value)}>
              <option value="all">Toutes les pages partagées ({pages.length})</option>
              {pages.map((page) => (
                <option value={page.id} key={page.id}>{page.name}</option>
              ))}
            </select>
          </label>
        )}
        <input value={pageUrl} onChange={(event) => setPageUrl(event.target.value)} placeholder="Ou coller URL de page Notion…" />
        {configured && <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Nouveau token Notion (optionnel)…" autoComplete="off" />}
        <button className="primary" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer et appliquer"}</button>
      </form>}

      {(!notion || configured) && !showConfig && <>
        <header>
          <button disabled={!stack.length || busy} onClick={() => { const next = stack.slice(0, -1); load(next.at(-1) || null, next); }}>←</button>
          <strong title={stack.at(-1)?.name || rootLabel || (notion ? "Pages Notion" : "Drive Atlas")}>
            {stack.at(-1)?.name || (notion ? (rootLabel || "Pages Notion") : "Drive Atlas")}
          </strong>
          <div style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
            {notion && <button type="button" onClick={() => (loadPages(), setShowConfig(true))} title="Changer la page racine ou le token" aria-label="Réglages">⚙</button>}
            <button onClick={() => load(stack.at(-1) || null, stack)} disabled={busy} aria-label="Rafraîchir">↻</button>
          </div>
        </header>
        {!preview ? (
          <div className="module-knowledge-list">
            {items.map((item) => (
              <button key={item.id} onClick={() => openItem(item)}>
                <i>{item.kind === "folder" ? "▸" : item.kind === "page" ? "N" : "·"}</i>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.kind === "folder" ? "dossier / sous-pages" : "page"}{item.modified ? ` · ${item.modified.slice(0, 10)}` : ""}</small>
                </span>
                <b>{item.kind === "folder" ? "›" : "↗"}</b>
              </button>
            ))}
            {!items.length && !busy && <span>Aucun contenu visible.</span>}
          </div>
        ) : (
          <div className="module-knowledge-preview">
            <header><strong>{preview.name}</strong><a href={preview.url} target="_blank" rel="noreferrer">Ouvrir ↗</a></header>
            <pre>{preview.content.slice(0, 30_000)}</pre>
            {preview.truncated && <small>Page tronquée par Notion.</small>}
            <button onClick={() => setPreview(null)}>← Liste</button>
          </div>
        )}
      </>}
      {busy && <small className="module-knowledge-loading">Chargement…</small>}
      {error && <small className="module-knowledge-error">{error}</small>}
    </section>}
  </>;
}

function formatFileSize(bytes) {
  if (!bytes || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function ModuleDeviceBuild({ module, onBuild, onRefreshBuilds }) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const deviceBuild = module.deviceBuild;
  if (!deviceBuild) return null;
  const platforms = deviceBuild.platforms || (deviceBuild.platform ? [deviceBuild.platform] : ["android", "ios"]);
  const hasAndroid = platforms.includes("android");
  const hasIos = platforms.includes("ios");
  const run = deviceBuild.run;
  const isRunning = run && ["queued", "building", "installing"].includes(run.state);

  useEffect(() => {
    if (!isRunning || (!run?.startedAt && !run?.requestedAt)) return;
    const start = new Date(run.startedAt || run.requestedAt).getTime();
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [isRunning, run?.startedAt, run?.requestedAt]);

  const formatElapsed = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
  };

  async function startBuild(platform) {
    if (busy || isRunning) return;
    const label = platform === "ios" ? "IPA (iOS)" : "APK (Android)";
    const executor = platform === "android" && deviceBuild.capabilities?.localAndroid ? "sur machine Noyau" : "par agent disponible";
    if (!window.confirm(`Lancer production build ${label} ${executor} ?`)) return;
    setBusy(platform);
    try {
      await onBuild?.(module.id, platform);
    } finally {
      setBusy(false);
    }
  }

  async function refreshLatest() {
    if (busy) return;
    setBusy("refresh");
    try {
      const res = await onRefreshBuilds?.(module.id);
      if (res?.imported) {
        window.alert(`Nouveau build importé : ${res.imported}`);
      } else {
        window.alert("Builds synchronisés.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function openBuild(build, install = false) {
    if (busy) return;
    setBusy(`${install ? "install" : "download"}:${build.id}`);
    try {
      const access = await api(`/api/modules/${encodeURIComponent(module.id)}/builds/${encodeURIComponent(build.id)}/access`, { method: "POST" });
      const target = install ? access.installUrl : access.downloadUrl;
      if (!target) throw new Error(install ? "Installation OTA indisponible." : "Téléchargement indisponible.");
      window.location.assign(target);
    } catch (error) {
      window.alert(error.message);
    } finally {
      setBusy(false);
    }
  }

  const statusClass = run?.state === "installed" ? "installed" : run?.state === "error" ? "error" : isRunning ? "running" : "";

  return (
    <section className="module-device-build">
      <div className="module-device-build-head">
        <strong>Builds & Appareils</strong>
        <div className="module-device-build-actions">
          <button
            className="ghost"
            onClick={refreshLatest}
            disabled={!!busy || isRunning}
            title="Rechercher et synchroniser les derniers builds du projet"
          >
            {busy === "refresh" ? "…" : "Rafraîchir"}
          </button>
          {hasAndroid && (
            <button
              className="primary"
              onClick={() => startBuild("android")}
              disabled={!!busy || isRunning}
              title="Compiler APK sur machine Noyau puis tenter installation ADB"
            >
              {isRunning && run?.platform === "android" ? `APK en cours… (${formatElapsed(elapsed)})` : busy === "android" ? "Lancement…" : "Construire APK"}
            </button>
          )}
          {hasIos && (
            <button
              className={hasAndroid ? "secondary" : "primary"}
              onClick={() => startBuild("ios")}
              disabled={!!busy || isRunning}
              title="Produire IPA via Mac/Xcode ou agent disponible"
            >
              {isRunning && run?.platform === "ios" ? `IPA en cours… (${formatElapsed(elapsed)})` : busy === "ios" ? "Lancement…" : "Construire IPA"}
            </button>
          )}
        </div>
      </div>
      {run && (
        <div className={`module-device-build-status ${statusClass}`}>
          {isRunning && <span className="module-build-spinner" />}
          <span>
            {run.state === "installed" && `✓ APK installée sur ${run.device?.serial || "l'appareil"}${run.output ? ` · ${run.output}` : ""}`}
            {run.state === "download-ready" && `${run.platform === "ios" ? "IPA" : "APK"} prête · ${run.output || ""}`}
            {run.state === "installation-requested" && `IPA prête · ${run.output || "Demande transmise à l'agent."}`}
            {run.state === "building" && `Production en cours (${run.platform === "ios" ? "IPA iOS" : "APK Android"} · ${run.agent?.name || "agent"}) · ${run.output || ""}`}
            {run.state === "queued" && `En attente (${run.platform === "ios" ? "IPA" : "APK"} · ${run.agent?.name || "agent"})…`}
            {run.state === "installing" && `Installation en cours sur l'appareil…`}
            {run.state === "error" && `Erreur build: ${run.output || "échec"}`}
          </span>
          {isRunning && <span className="module-build-timer">{formatElapsed(elapsed)}</span>}
        </div>
      )}
      {(deviceBuild.builds || []).length > 0 && (
        <div className="module-build-list">
          {deviceBuild.builds.map((build) => (
            <div className="module-build-item" key={build.id}>
              <div>
                <div className="module-build-name" title={build.name}>{build.name}</div>
                <div className="module-build-meta">
                  <span className={`module-build-platform ${build.platform === "ios" ? "ios" : "android"}`}>
                    {build.platform === "ios" ? "iOS · IPA" : "Android · APK"}
                  </span>
                  {build.version && <span className="module-build-tag">{build.version}</span>}
                  {build.commit && <span className="module-build-commit">#{build.commit}</span>}
                  <small>{formatFileSize(build.size)}</small>
                  <small>· {new Date(build.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</small>
                </div>
              </div>
              <div className="module-build-buttons">
                {build.platform === "ios" && deviceBuild.capabilities?.iosOta && (
                  <button onClick={() => openBuild(build, true)} disabled={!!busy}>Installer IPA</button>
                )}
                <button onClick={() => openBuild(build, false)} disabled={!!busy}>
                  Télécharger {build.platform === "ios" ? "IPA" : "APK"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectModule({ module, onToggle, onAction, onSchedule, onBuild, onRefreshBuilds, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  async function toggle() {
    if (module.enabled && !window.confirm(`Désactiver ${module.name} et ses horaires ?`)) return;
    setBusy(true);
    try {
      await onToggle(module.id, !module.enabled);
    } finally {
      setBusy(false);
    }
  }
  async function actionRun(action) {
    if (action.confirm && !window.confirm(action.confirm)) return;
    setBusy(true);
    setActionNotice(`${action.label} · lancement…`);
    try {
      const response = await onAction(module.id, action.id);
      setActionNotice(response?.run ? `${action.label} · action lancée` : `${action.label} · lancement échoué`);
    } finally {
      setBusy(false);
    }
  }
  const latestAction = (module.actions || []).filter((action) => action.run).sort((left, right) => String(right.run.startedAt).localeCompare(String(left.run.startedAt)))[0];
  const latestRun = latestAction?.run;
  const runLabel = latestRun?.state === "running"
    ? `${latestAction.label} · exécution en cours…`
    : latestRun?.state === "success"
      ? `${latestAction.label} · terminé${latestRun.output ? ` · ${latestRun.output}` : ""}`
      : latestRun ? `${latestAction.label} · erreur: ${latestRun.output || "échec"}` : actionNotice;
  return (
    <details className="project-module" style={{ "--module-accent": module.accent }}>
      <summary>
        <span className="module-glyph">{module.glyph}</span>
        <div>
          <strong>{module.name}</strong>
          <small>{module.description}</small>
        </div>
        {module.controllable ? (
          <button
            className={`module-toggle ${module.enabled ? "enabled" : ""}`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
            disabled={busy}
            role="switch"
            aria-checked={module.enabled}
          >
            <i />
            <span>{module.enabled ? "Actif" : "Arrêté"}</span>
          </button>
        ) : (
          <span className={`module-status ${module.setup?.status === "required" ? "required" : "ready"}`}>
            {module.setup?.status === "required" ? "À configurer" : "Prêt"}
          </span>
        )}
        <b className="module-chevron">›</b>
      </summary>
      <div className="project-module-body">
        {module.setup && (
          <p className={`module-setup ${module.setup.status}`}>
            <strong>{module.setup.label}</strong>
            {module.setup.description && <small>{module.setup.description}</small>}
          </p>
        )}
        {(module.schedules || []).length > 0 && (
          <div className="module-schedules">
            {(module.schedules || []).map((schedule) => (
              <ModuleSchedule key={schedule.id} moduleId={module.id} schedule={schedule} onSave={onSchedule} />
            ))}
          </div>
        )}
        {(module.knowledge || (module.links || []).length > 0 || (module.actions || []).length > 0) && (
          <div className="module-actions">
            <ModuleKnowledge module={module} onConfigured={onRefresh} />
            {(module.links || []).map((link) => (
              <a key={link.id} className={link.tone} href={link.url} target="_blank" rel="noreferrer" title={link.description}>
                {link.label}
              </a>
            ))}
            {(module.actions || []).map((action) => (
              <button key={action.id} className={action.tone} onClick={() => actionRun(action)} disabled={busy || action.run?.state === "running"}>
                {action.run?.state === "running" ? "Exécution…" : action.label}
              </button>
            ))}
          </div>
        )}
        {module.deviceBuild && <ModuleDeviceBuild module={module} onBuild={onBuild} onRefreshBuilds={onRefreshBuilds} />}
        {runLabel && <small className={`module-run ${latestRun?.state || "running"}`}>{runLabel}</small>}
      </div>
    </details>
  );
}

function TodoInlineText({ text, onSave, disabled, expanded = false, onOverflow = null, placeholder = "Tâche sans titre…" }) {
  const [val, setVal] = useState(text || "");
  const [editing, setEditing] = useState(false);
  const field = React.useRef(null);

  useEffect(() => {
    if (!editing) setVal(text || "");
  }, [text, editing]);

  // Le champ suit son contenu quand il est ouvert, et reste tronque a deux lignes au repos.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    const full = node.scrollHeight;
    const line = parseFloat(getComputedStyle(node).lineHeight) || 18;
    const clamped = Math.round(line * 3) + 8;
    // Au repos la carte montre trois lignes au maximum, le reste attend le depliage.
    node.style.height = `${editing || expanded ? full : Math.min(full, clamped)}px`;
    onOverflow?.(full > clamped + 1);
  }, [val, editing, expanded, onOverflow]);

  const commit = () => {
    const trimmed = val.trim();
    setEditing(false);
    if (trimmed && trimmed !== text) onSave(trimmed);
    else setVal(text || "");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setVal(text || "");
      setEditing(false);
      e.target.blur();
    }
  };

  return (
    <textarea
      ref={field}
      rows={1}
      className={`todo-text-input ${editing || expanded ? "open" : ""}`}
      value={val}
      disabled={disabled}
      placeholder={placeholder}
      title="Cliquer pour modifier le texte"
      aria-label="Modifier le texte de la tâche"
      maxLength={300}
      onFocus={() => setEditing(true)}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

// Module de suivi: le projet et chacun de ses agents peuvent couper le reporting evolutions / bugs.
function ProjectReporting({ project, agents, todos, onRefresh }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const projectOn = project.todoTracking !== false;
  const activeAgents = agents.filter((session) => session.todoTracking !== false).length;
  const pending = todos.filter((todo) => todo.status === "review").length;

  async function toggle(key, request) {
    setBusy(key);
    setError("");
    try {
      await request();
      await onRefresh?.();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <details className="project-reporting">
      <summary>
        <span>Suivi évolutions / bugs</span>
        <small>{projectOn ? `${activeAgents}/${agents.length} agent${agents.length > 1 ? "s" : ""} · ${pending} à valider` : "désactivé"}</small>
        <b>›</b>
      </summary>
      <div className="project-reporting-body">
        <p className="project-reporting-hint">Chaque demande envoyée à un agent suivi crée un to-do du projet, ou commente celui qui existe déjà. L'agent le passe ensuite en « À tester / valider » — jamais en « Terminé », c'est toi qui valides.</p>
        <label className="reporting-switch">
          <input
            type="checkbox"
            checked={projectOn}
            disabled={busy === "project" || project.canEdit === false}
            onChange={(event) => toggle("project", () => api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ name: project.name, shared: Boolean(project.shared), todoTracking: event.target.checked }) }))}
          />
          <span><strong>Projet {project.name}</strong><small>Coupe le suivi pour tous ses agents</small></span>
        </label>
        {agents.map((session) => (
          <label className="reporting-switch agent" key={session.id}>
            <input
              type="checkbox"
              checked={projectOn && session.todoTracking !== false}
              disabled={!projectOn || busy === session.id || session.canEdit === false}
              onChange={(event) => toggle(session.id, () => api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ todoTracking: event.target.checked }) }))}
            />
            <span><strong>{session.name}</strong><small>{assistantMeta[session.assistant]?.label || session.assistant}</small></span>
          </label>
        ))}
        {!agents.length && <span className="project-empty">Aucun agent rattaché à suivre.</span>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </details>
  );
}

function ProjectsView({ projects, sessions, modules, moduleProposals, onOpenAgent, onNew, onEdit, onDelete, onInstallModule, onModuleToggle, onModuleAction, onModuleSchedule, onModuleBuild, onModuleBuildRefresh, onOpenTodos, onReorder, onRefresh }) {
  // Le cache Todo porte { todos, folders } depuis la refonte par dossier: on accepte les deux formes.
  const [todos, setTodos] = useState(() => {
    const cached = cachedView("todos");
    return (Array.isArray(cached) ? cached : cached?.todos) || [];
  });
  const [todoBusy, setTodoBusy] = useState("");
  const [draggedProject, setDraggedProject] = useState("");
  const cardRefs = React.useRef(new Map());
  const dragRef = React.useRef(null);

  const loadTodos = useCallback(async () => {
    try {
      const result = await api("/api/todos");
      setTodos(result.todos || []);
      storeView("todos", { todos: result.todos || [], folders: result.folders || [] });
    } catch { /* on garde la derniere liste connue */ }
  }, []);

  useEffect(() => { loadTodos(); }, [loadTodos]);

  async function toggleTodo(todo) {
    const current = todo.status || (todo.completed ? "done" : "todo");
    const next = current === "todo" ? "review" : current === "review" ? "done" : "todo";
    setTodoBusy(todo.id);
    setTodos((prev) => prev.map((t) => t.id === todo.id ? { ...t, status: next, completed: next === "done" } : t));
    try {
      await api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      await loadTodos();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setTodoBusy("");
    }
  }

  async function updateTodoText(todo, newText) {
    setTodoBusy(todo.id);
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, text: newText } : t)));
    try {
      await api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ text: newText }) });
      await loadTodos();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setTodoBusy("");
    }
  }

  function startDrag(event, project) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const order = projects.map((item) => item.id);
    dragRef.current = { pointerId: event.pointerId, id: project.id, order, initialOrder: [...order] };
    setDraggedProject(project.id);
  }

  function dragOver(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const currentIndex = drag.order.indexOf(drag.id);
    if (currentIndex < 0) return;

    for (let i = 0; i < drag.order.length; i++) {
      if (i === currentIndex) continue;
      const cardId = drag.order[i];
      const node = cardRefs.current.get(cardId);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        const midY = rect.top + rect.height / 2;
        if ((i > currentIndex && event.clientY > midY) || (i < currentIndex && event.clientY < midY)) {
          const nextOrder = drag.order.filter((id) => id !== drag.id);
          nextOrder.splice(i, 0, drag.id);
          drag.order = nextOrder;
          onReorder?.(nextOrder, false);
          break;
        }
      }
    }
  }

  async function endDrag(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finalOrder = [...drag.order];
    const initialOrder = drag.initialOrder || [];
    dragRef.current = null;
    setDraggedProject("");
    if (finalOrder.join() !== initialOrder.join()) {
      await onReorder?.(finalOrder, true);
    }
  }

  return (
    <div className="page projects-page">
      <section className="hero-row"><div><p className="eyebrow">ORGANISATION</p><h1>Projets.</h1><p className="muted">Regroupe agents liés au même travail, sans imposer dossier.</p></div></section>
      <div className="projects-grid">
        {projects.map((project) => {
          const agents = sessions.filter((session) => session.projectId === project.id);
          const projectModules = modules
            .filter((module) => module.projectId === project.id)
            .sort((a, b) => (b.deviceBuild ? 1 : 0) - (a.deviceBuild ? 1 : 0));
          const proposals = moduleProposals
            .filter((module) => module.projectId === project.id)
            .sort((a, b) => (b.id?.includes("build") ? 1 : 0) - (a.id?.includes("build") ? 1 : 0));
          const projectTodos = todos.filter((todo) => todo.projectId === project.id);
          const openTodos = projectTodos.filter((todo) => (todo.status || (todo.completed ? "done" : "todo")) === "todo");
          const reviewTodos = projectTodos.filter((todo) => todo.status === "review");
          const doneTodos = projectTodos.filter((todo) => todo.status === "done" || todo.completed);
          return (
            <article
              className={`panel project-card ${draggedProject === project.id ? "dragging" : ""}`}
              key={project.id}
              ref={(node) => { if (node) cardRefs.current.set(project.id, node); else cardRefs.current.delete(project.id); }}
            >
              <header><button className="project-drag" onPointerDown={(event) => startDrag(event, project)} onPointerMove={dragOver} onPointerUp={endDrag} onPointerCancel={endDrag} title="Glisser pour changer ordre" aria-label={`Déplacer ${project.name}`}>⠿</button><ProjectIcon project={project} /><span><strong>{project.name}{project.canEdit === false ? <b className="shared-chip" title={`Projet partagé par ${project.owner?.name || "autre profil"}`}>⇄ {project.owner?.name || "partagé"}</b> : project.shared ? <b className="shared-chip own" title="Projet partagé avec les autres profils">⇄ partagé</b> : null}</strong><small>{project.rootPath || "Dossiers propres aux agents"}</small></span>{project.canEdit !== false && <div><button onClick={() => onEdit(project.id)}>Éditer</button><button className="project-delete" onClick={() => onDelete(project)}>×</button></div>}</header>
              <p>{agents.length} agent{agents.length > 1 ? "s" : ""} actif{agents.length > 1 ? "s" : ""}</p>
              <div className="project-agents">
                {agents.map((session) => <button key={session.id} onClick={() => onOpenAgent(session.id)}><AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small /><span><strong>{session.favorite && <i className="favorite-star">★</i>}{session.name}</strong><small><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {assistantMeta[session.assistant]?.label} · {session.agentStatus?.label || "Disponible"}</small></span><b>›</b></button>)}
                {!agents.length && <span className="project-empty">Aucun agent rattaché.</span>}
              </div>
              <ProjectReporting project={project} agents={agents} todos={projectTodos} onRefresh={onRefresh} />
              <details className="project-todos"><summary><span>Todo</span><small>{openTodos.length} en cours{reviewTodos.length ? ` · ${reviewTodos.length} à vérifier` : ""} · {doneTodos.length} faite{doneTodos.length > 1 ? "s" : ""}</small><b>›</b></summary><div className="project-todo-list">
                {projectTodos.map((todo) => {
                  const status = todo.status || (todo.completed ? "done" : "todo");
                  const isDone = status === "done";
                  const isReview = status === "review";
                  return (
                    <div className={isDone ? "project-todo done" : isReview ? "project-todo review" : "project-todo"} key={todo.id}>
                      <button
                        type="button"
                        className={`todo-tri-box status-${status}`}
                        onClick={() => toggleTodo(todo)}
                        disabled={todoBusy === todo.id}
                        title={status === "todo" ? "À faire (cliquer pour : À vérifier)" : isReview ? "À vérifier (cliquer pour : Terminée)" : "Terminée (cliquer pour : À faire)"}
                      >
                        {isDone && <span className="todo-tri-icon done-check">✓</span>}
                        {isReview && <span className="todo-tri-icon review-bar" />}
                      </button>
                      <span>
                        <TodoInlineText
                          text={todo.text}
                          onSave={(newText) => updateTodoText(todo, newText)}
                          disabled={todoBusy === todo.id}
                        />
                        <small className={todo.dueDate && todo.dueDate < localIsoDate() && !isDone ? "overdue" : isReview ? "status-review-label" : ""}>
                          {isReview ? "◐ À vérifier / tester" : todoDueLabel(todo.dueDate)}
                          {todo.comments?.length ? ` · 💬 ${todo.comments.length}` : ""}
                        </small>
                      </span>
                    </div>
                  );
                })}
                {!projectTodos.length && <span className="project-empty">Aucune tâche liée.</span>}
                <button className="project-todo-link" onClick={onOpenTodos}>Ouvrir la liste complète ›</button>
              </div></details>
              {(projectModules.length > 0 || proposals.length > 0) && <details className="project-modules"><summary><span>Modules</span><small>{projectModules.length} installé{projectModules.length > 1 ? "s" : ""}{projectModules.some((module) => module.enabled) ? " · actif" : ""}</small><b>›</b></summary><div className="project-module-list">{projectModules.map((module) => <ProjectModule key={module.id} module={module} onToggle={onModuleToggle} onAction={onModuleAction} onSchedule={onModuleSchedule} onBuild={onModuleBuild} onRefreshBuilds={onModuleBuildRefresh} onRefresh={onRefresh} />)}{proposals.map((module) => <button className="module-proposal" key={module.id} onClick={() => onInstallModule(module.id)} style={{ "--module-accent": module.accent }}><span>{module.glyph}</span><div><strong>Ajouter {module.name}</strong><small>{module.description}</small></div><b>＋</b></button>)}</div></details>}
            </article>
          );
        })}
        {!projects.length && <button className="panel empty-project-card" onClick={onNew}><span>＋</span><strong>Créer premier projet</strong><small>Nom uniquement</small></button>}
      </div>
    </div>
  );
}

function BankingPanel({ banks, month, onSynced }) {
  const callbackUrl = `${location.origin}/api/finance/banking/callback`;
  const [status, setStatus] = useState(null);
  const [institutions, setInstitutions] = useState({});
  const [selected, setSelected] = useState({});
  const [config, setConfig] = useState({ appId: "", redirectUrl: callbackUrl, privateKey: "" });
  const [busy, setBusy] = useState("");
  const [cooldown, setCooldown] = useCountdown();
  const [error, setError] = useState(() => new URLSearchParams(location.search).get("bankError") || "");

  const load = useCallback(async () => {
    try {
      const next = await api("/api/finance/banking/status");
      setStatus(next);
      setConfig((current) => ({ ...current, appId: next.appId || current.appId, redirectUrl: next.redirectUrl || callbackUrl }));
      if (next.configured) {
        const response = await api("/api/finance/banking/institutions");
        setInstitutions(response.institutions);
        setSelected((current) => Object.fromEntries(Object.entries(response.institutions).map(([id, options]) => [id, current[id] || options[0]?.name || ""])));
      }
    } catch (reason) {
      if (reason.status === 429) setCooldown(reason.retryAfter || 60);
      setError(reason.message);
    }
  }, [callbackUrl]);

  useEffect(() => { load(); }, [load]);

  async function saveConfig(event) {
    event.preventDefault();
    setBusy("config");
    setError("");
    try {
      const body = { appId: config.appId.trim(), redirectUrl: config.redirectUrl.trim() };
      if (config.privateKey) body.privateKey = config.privateKey;
      await api("/api/finance/banking/config", { method: "PATCH", body: JSON.stringify(body) });
      setConfig((current) => ({ ...current, privateKey: "" }));
      await load();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy("");
    }
  }

  async function readKey(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 16_384) {
      setError("Clé PEM trop grande.");
      event.target.value = "";
      return;
    }
    setConfig((current) => ({ ...current, privateKey: "" }));
    try {
      const value = await file.text();
      setConfig((current) => ({ ...current, privateKey: value }));
    } catch {
      setError("Lecture clé PEM impossible.");
    }
  }

  async function connect(bankId) {
    setBusy(bankId);
    setError("");
    try {
      const authorization = await api("/api/finance/banking/connect", { method: "POST", body: JSON.stringify({ bankId, institutionName: selected[bankId] }) });
      location.assign(authorization.url);
    } catch (reason) {
      setError(reason.message);
      setBusy("");
    }
  }

  async function sync(bankId = null) {
    setBusy(bankId || "sync");
    setError("");
    try {
      await api("/api/finance/banking/sync", { method: "POST", body: JSON.stringify({ bankId, month }) });
      await load();
      await onSynced();
    } catch (reason) {
      if (reason.status === 429) setCooldown(reason.retryAfter || 60);
      setError(reason.message);
    } finally {
      setBusy("");
    }
  }

  async function disconnect(bankId) {
    if (!window.confirm("Délier cette banque ? Opérations déjà importées restent locales.")) return;
    setBusy(bankId);
    try {
      await api(`/api/finance/banking/connections/${encodeURIComponent(bankId)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="panel bank-connectors">
      <div className="panel-head"><div><h3>Connexions bancaires</h3><p>Enable Banking · clé privée protégée localement par fichier 0600</p></div><span className={status?.configured ? "ready" : "pending"}>{status?.configured ? "PRÊT" : "À CONFIGURER"}</span></div>
      {error && <p className="bank-error">{error}</p>}
      <details className="bank-config" open={!status?.configured}>
        <summary><span><i aria-hidden="true">⚙</i>Réglages Enable Banking</span><small>{status?.configured ? (status?.keyStored ? "Clé stockée" : "Clé à charger") : "À configurer"}</small><b>›</b></summary>
        <form onSubmit={saveConfig}>
          <p>URL VPN HTTPS fonctionne directement: retour bancaire arrive dans navigateur du téléphone connecté au VPN. Aucun relais public ni exposition dashboard. Enregistre URL exacte, puis charge clé privée RSA PEM.</p>
          <label><span>Application ID</span><input value={config.appId} onChange={(event) => setConfig({ ...config, appId: event.target.value })} required autoComplete="off" placeholder="ID application" /></label>
          <label className="wide"><span>URL retour à enregistrer</span><input value={config.redirectUrl} onChange={(event) => setConfig({ ...config, redirectUrl: event.target.value })} required inputMode="url" /></label>
          <label className="wide bank-key-file"><span>Clé privée RSA (.pem)</span><input type="file" accept=".pem,.key,text/plain" onChange={readKey} required={!status?.keyStored} /><small>{config.privateKey ? "Clé chargée, prête à enregistrer" : status?.keyStored ? "Clé déjà stockée; laisse vide pour conserver" : "Clé requise"}</small></label>
          <a className="ghost bank-account-link" href="https://enablebanking.com/sign-in/" target="_blank" rel="noreferrer">Ouvrir Enable Banking</a>
          <button className="primary" disabled={busy === "config"}>{busy === "config" ? "Vérification…" : "Enregistrer et vérifier"}</button>
        </form>
      </details>
      {status?.configured && <div className="bank-toolbar"><small>{status.connections.length} banque{status.connections.length > 1 ? "s" : ""} liée{status.connections.length > 1 ? "s" : ""}{cooldown > 0 ? ` · attente ${cooldown}s` : ""}</small>{status.connections.length > 0 && <button className="ghost" onClick={() => sync()} disabled={Boolean(busy) || cooldown > 0}>{busy === "sync" ? "Synchronisation…" : cooldown > 0 ? `Réessayer dans ${cooldown}s` : "Tout synchroniser"}</button>}</div>}
      <div className="bank-list">{banks.map((bank) => {
        const connection = status?.connections.find(({ bankId }) => bankId === bank.id);
        const options = institutions[bank.id] || [];
        return <article key={bank.id}><i>{bank.name[0]}</i><span><strong>{bank.name}</strong><small>{connection ? `${connection.accountCount} compte · synchro ${connection.lastSyncAt ? new Date(connection.lastSyncAt).toLocaleDateString("fr-FR") : "jamais"}` : bank.access}</small></span>{options.length > 1 && !connection && <select value={selected[bank.id] || ""} onChange={(event) => setSelected({ ...selected, [bank.id]: event.target.value })}>{options.map((option) => <option key={option.name}>{option.name}</option>)}</select>}{connection ? <div className="bank-actions"><button onClick={() => sync(bank.id)} disabled={Boolean(busy) || cooldown > 0}>Synchroniser</button><button onClick={() => disconnect(bank.id)} disabled={Boolean(busy)}>Délier</button></div> : <button onClick={() => connect(bank.id)} disabled={Boolean(busy) || !options.length}>{busy === bank.id ? "Ouverture…" : options.length ? "Lier cette banque" : "Indisponible"}</button>}</article>;
      })}</div>
    </section>
  );
}

function BudgetMenu({ onView }) {
  return (
    <details className="finance-more">
      <summary aria-label="Ouvrir menu Budget" title="Menu Budget">＋</summary>
      <nav>
        <button onClick={() => onView("finance-transactions")}><span>±</span><b>Opérations</b><small>Saisie et historique</small></button>
        <button onClick={() => onView("finance-modules")}><span>◇</span><b>Modules financiers</b><small>Actifs, charges, enveloppes</small></button>
        <button onClick={() => onView("finance-banking")}><span>⌁</span><b>Connexions bancaires</b><small>Comptes, Enable Banking, synchronisation</small></button>
      </nav>
    </details>
  );
}

function FinanceAgentDock({ month, onExpand, onChanged }) {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  async function send(event) {
    event.preventDefault();
    const content = message.trim();
    if (!content || sending) return;
    setSending(true);
    setReply("Codex analyse budget et historique…");
    try {
      const response = await api("/api/finance/agent/message", { method: "POST", body: JSON.stringify({ message: content, month }) });
      setReply(response.reply);
      setMessage("");
      await onChanged?.();
    } catch (error) {
      setReply(`Erreur: ${error.message}`);
    } finally {
      setSending(false);
    }
  }
  return createPortal(
    <aside className="finance-agent-dock">
      <header><span><i />Agent finances · Codex</span><button onClick={onExpand} aria-label="Agrandir Agent finances" title="Agrandir">↗</button></header>
      {reply && <p>{reply}</p>}
      <form onSubmit={send}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Parler budget, charges, prévisions…" maxLength="1000" enterKeyHint="send" /><button disabled={sending || !message.trim()}>{sending ? "…" : "↑"}</button></form>
    </aside>,
    document.body,
  );
}

function settingsForm(settings) {
  if (!settings) return null;
  return {
    ...settings,
    savingsGoal: String(settings.savingsGoal || ""),
    safetyBuffer: String(settings.safetyBuffer || ""),
    budgets: Object.fromEntries(Object.entries(settings.budgets || {}).map(([id, value]) => [id, String(value || "")])),
  };
}

function FinanceAdvicePanel({ month }) {
  const [state, setState] = useState(() => cachedView(`insights-${month}`) || { insights: [], headline: "", generatedAt: null, provider: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/finance/insights?month=${encodeURIComponent(month)}`).then((next) => {
      setState(next);
      storeView(`insights-${month}`, next);
    }).catch(() => {});
  }, [month]);

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const next = await api("/api/finance/insights", { method: "POST", body: JSON.stringify({ month }) });
      setState(next);
      storeView(`insights-${month}`, next);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  const providerLabel = state.provider === "claude" ? "Claude" : state.provider === "codex" ? "Codex" : null;
  return (
    <section className="panel finance-advice">
      <div className="panel-head">
        <div><h3>Conseils IA</h3><p>{state.generatedAt ? `${providerLabel} · ${new Date(state.generatedAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "Analyse à la demande, agent selon quota disponible"}</p></div>
        <button className="ghost" onClick={refresh} disabled={busy}>{busy ? "Analyse…" : state.generatedAt ? "Actualiser" : "Analyser"}</button>
      </div>
      {error && <p className="finance-error">{error}</p>}
      {state.headline && <p className="advice-headline">{state.headline}</p>}
      <div className="advice-list">
        {state.insights.map((item) => (
          <article className={`advice-${item.impact}`} key={item.title}>
            <header><strong>{item.title}</strong>{Number.isFinite(item.amount) && item.amount !== null && <b>{euro(item.amount)}</b>}</header>
            <p>{item.detail}</p>
            <small>→ {item.action}</small>
          </article>
        ))}
        {!state.insights.length && !busy && <p className="finance-empty">Aucune analyse encore. Lance-la quand tu veux un vrai avis chiffré.</p>}
        {busy && <p className="finance-empty">L'agent lit le mois complet, compte 30 à 60 secondes.</p>}
      </div>
    </section>
  );
}

function FinanceView({ onView }) {
  const today = localIsoDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState(() => cachedView(`finance-${today.slice(0, 7)}`));
  const [settings, setSettings] = useState(() => settingsForm(cachedView(`finance-${today.slice(0, 7)}`)?.settings));
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [syncCooldown, setSyncCooldown] = useCountdown();
  const [showPlanned, setShowPlanned] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const known = cachedView(`finance-${month}`);
      if (known) {
        setData(known);
        setSettings((current) => current || settingsForm(known.settings));
      }
      const payload = await api(`/api/finance?month=${encodeURIComponent(month)}`);
      setData(payload);
      storeView(`finance-${month}`, payload);
      setSettings(settingsForm(payload.settings));
    } catch (reason) {
      if (reason.status === 429) setSyncCooldown(reason.retryAfter || 60);
      setError(reason.message);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  function shiftMonth(offset) {
    const [year, value] = month.split("-").map(Number);
    const next = new Date(Date.UTC(year, value - 1 + offset, 1));
    setMonth(next.toISOString().slice(0, 7));
  }

  async function updateBudget() {
    setUpdating(true);
    setError("");
    try {
      const payload = await api("/api/finance/banking/sync", {
        method: "POST",
        body: JSON.stringify({ month }),
      });
      setData(payload.finance);
      setUpdatedAt(new Date());
    } catch (reason) {
      if (reason.status === 429) setSyncCooldown(reason.retryAfter || 60);
      setError(reason.message);
    } finally {
      setUpdating(false);
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = await api("/api/finance/settings", {
        method: "PATCH",
        body: JSON.stringify({
          month,
          savingsGoal: Number(settings.savingsGoal || 0),
          safetyBuffer: Number(settings.safetyBuffer || 0),
          emergencyMonths: Number(settings.emergencyMonths),
          budgets: Object.fromEntries(Object.entries(settings.budgets).map(([id, value]) => [id, Number(value || 0)])),
        }),
      });
      setData(payload);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  }

  function useRealisticBudgets() {
    setSettings((current) => ({
      ...current,
      budgets: Object.fromEntries(data.categories.map((category) => {
        const suggestion = summary.monthlyPlan.categoryLimits[category.id] || 0;
        return [category.id, String(suggestion || current.budgets[category.id] || "")];
      })),
    }));
  }

  const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  if (!data || !settings) return <div className="page finance-page"><section className="hero-row"><div><p className="eyebrow">ARGENT</p><h1>Finances.</h1><p className="muted">{error || "Chargement données locales…"}</p></div></section></div>;
  const { summary } = data;
  const confidenceLabel = { low: "provisoire", medium: "correcte", high: "solide" }[summary.dataConfidence] || "provisoire";
  const plannedCategories = data.categories.map((category) => ({ ...category, ...summary.categoryPlans[category.id] })).filter(({ remaining }) => remaining > 0).sort((a, b) => b.remaining - a.remaining);
  const monthExpenseTransactions = data.transactions.filter((transaction) => !transaction.excluded && transaction.amount < 0);
  const spentCategories = data.categories.map((category) => ({
    category,
    spent: summary.spentByCategory[category.id] || 0,
    transactions: monthExpenseTransactions.filter((transaction) => transaction.category === category.id).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || b.date.localeCompare(a.date)),
  })).filter(({ spent, transactions }) => spent > 0 || transactions.length).sort((a, b) => b.spent - a.spent);
  return (
    <div className="page finance-page has-finance-dock">
      <section className="hero-row finance-hero">
        <div><p className="eyebrow">ARGENT · DONNÉES LOCALES</p><h1>Budget.</h1><p className="muted">Objectif: épargner sans perdre vue du reste à vivre.</p><p className="finance-sync-line">{bankSyncLabel(data.banking)}</p></div>
        <div className="finance-hero-actions"><BudgetMenu onView={onView} /><button className={`finance-refresh ${updating ? "updating" : ""}`} onClick={updateBudget} disabled={updating || syncCooldown > 0} aria-label={syncCooldown > 0 ? `Synchronisation disponible dans ${syncCooldown} secondes` : "Mettre à jour depuis banques"} title={syncCooldown > 0 ? `Réessayer dans ${syncCooldown}s` : updatedAt ? `À jour à ${updatedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "Mettre à jour depuis banques"}><span aria-hidden="true">↻</span>{syncCooldown > 0 && <small>{syncCooldown}</small>}</button><div className="month-switch"><button onClick={() => shiftMonth(-1)} aria-label="Mois précédent">‹</button><strong>{monthName}</strong><button onClick={() => shiftMonth(1)} aria-label="Mois suivant">›</button></div></div>
      </section>

      {error && <p className="finance-error">{error}</p>}

      <nav className="finance-shortcuts" aria-label="Navigation Budget">
        <button onClick={() => onView("finance-modules")}><span>◇</span><b>Modules financiers</b><small>{data.modules.length} actifs/configurables · LEP, PEA, loyer, transferts</small><i>›</i></button>
        <button onClick={() => onView("finance-transactions")}><span>±</span><b>Opérations</b><small>{data.transactions.length} ce mois · détail et saisie</small><i>›</i></button>
      </nav>

      <section className="finance-metrics">
        <article className={summary.currentCash >= 0 ? "positive cash-metric" : "negative cash-metric"}><small>SOLDE COMPTES COURANTS</small><strong>{euro(summary.currentCash)}</strong><span>{summary.currentAccounts.length} compte{summary.currentAccounts.length > 1 ? "s" : ""} bancaire{summary.currentAccounts.length > 1 ? "s" : ""}</span></article>
        <button className="planned-metric" onClick={() => setShowPlanned((value) => !value)} aria-expanded={showPlanned}><small>ENCORE PRÉVU</small><strong>{euro(summary.remainingPlannedExpenses)}</strong><span>Détail par catégorie {showPlanned ? "↑" : "↓"}</span></button>
        <button className="budget-month-metric" aria-controls="current-accounts-panel" onClick={() => { const panel = document.getElementById("current-accounts-panel"); if (!panel) return; panel.open = true; panel.scrollIntoView({ behavior: "smooth", block: "start" }); }}><small>BUDGET DU MOIS</small><strong>{euro(summary.expenses)}</strong><span>Payés · {euro(summary.projectedExpenses)} prévus ›</span></button>
        <article className={summary.safeToSpend > 0 ? "positive safe-metric" : "negative safe-metric"}><small>ENCORE DÉPENSABLE</small><strong>{euro(summary.safeToSpend)}</strong><span>{euro(summary.dailyAllowance)} / jour sans toucher réserves</span></article>
      </section>

      {showPlanned && <section className="panel planned-breakdown">
        <div className="panel-head"><div><h3>Dépenses encore prévues</h3><p>Projection restante, jamais déjà dépensée</p></div><b>{euro(summary.remainingPlannedExpenses)}</b></div>
        <div>{plannedCategories.map((category) => <article key={category.id}><span><strong>{category.label}</strong><small>{euro(category.spent)} déjà dépensés · {category.budget ? `budget ${euro(category.budget)}` : category.recurringExpected > category.spent ? `charge connue ${euro(category.recurringExpected)}` : category.essential ? `historique ${euro(category.historicalAverage)} + rythme réel` : "rythme réel du mois"}</small></span><b>+ {euro(category.remaining)}</b></article>)}{!plannedCategories.length && <p className="finance-empty">Aucune dépense supplémentaire projetée.</p>}</div>
        <footer>Total mois probable: {euro(summary.projectedExpenses)} = réel {euro(summary.expenses)} + encore prévu {euro(summary.remainingPlannedExpenses)}.</footer>
      </section>}

      <details className="panel current-accounts foldable" id="current-accounts-panel">
        <summary className="panel-head"><div><h3>Comptes courants</h3><p>Soldes bancaires réels · placements exclus</p></div><b>{euro(summary.currentCash)}</b><i>›</i></summary>
        <div className="current-account-grid">{summary.currentAccounts.map((account) => <article key={`${account.bank}-${account.name}`}><span><strong>{account.bank}</strong><small>{account.name} · actualisé {account.balanceAt ? new Date(account.balanceAt).toLocaleDateString("fr-FR") : "date inconnue"}</small></span><b className={account.balance >= 0 ? "positive" : "negative"}>{euro(account.balance)}</b></article>)}{!summary.currentAccounts.length && <p className="finance-empty">Aucun solde bancaire disponible.</p>}</div>
        <section className="account-month-budget">
          <header><span><strong>Budget du mois</strong><small>{monthExpenseTransactions.length} paiement{monthExpenseTransactions.length > 1 ? "s" : ""} · transferts exclus</small></span><div><b>{euro(summary.expenses)} payés</b><button className="ghost" onClick={useRealisticBudgets}>Limites réalistes</button></div></header>
          <div className="budget-list">
            {spentCategories.map(({ category, spent, transactions: categoryTransactions }) => {
              const budget = Number(settings.budgets[category.id] || 0);
              const plan = summary.categoryPlans[category.id];
              const limit = budget || summary.monthlyPlan.categoryLimits[category.id];
              const ratio = limit ? Math.round((spent / limit) * 100) : 0;
              return <details className="budget-category" key={category.id}><summary className="budget-row"><span><strong>{category.label}{plan.essential && <em>essentiel</em>}</strong><small>{euro(spent)} payé · {euro(plan.projected)} prévu · {limit ? `${euro(limit)} limite` : "sans limite"}</small></span><div><i style={{ width: `${Math.min(100, ratio)}%` }} className={ratio >= 100 ? "over" : ratio >= 80 ? "near" : ""} /></div><b>{categoryTransactions.length} ›</b></summary><div className="category-transactions">{categoryTransactions.map((transaction) => <article key={transaction.id}><span><strong>{transaction.description}</strong><small>{operationDate(transaction)} · {transaction.account}</small></span><b>− {euro(Math.abs(transaction.amount))}</b></article>)}</div></details>;
            })}
            {!spentCategories.length && <p className="finance-empty">Aucune dépense payée ce mois.</p>}
          </div>
        </section>
      </details>

      <details className="panel monthly-targets foldable">
        <summary className="panel-head"><div><h3>Plan mensuel conseillé</h3><p>Répartition du salaire {euro(summary.monthlyPlan.income)}</p></div><b>ÉPARGNER {euro(summary.monthlyPlan.recommendedSavings)}</b><i>›</i></summary>
        <p className="plan-equation">{euro(summary.monthlyPlan.fixedCosts)} charges + {euro(summary.monthlyPlan.flexibleLimit)} dépenses courantes + {euro(summary.monthlyPlan.recommendedSavings)} épargne + {euro(summary.monthlyPlan.unallocated)} libre = {euro(summary.monthlyPlan.income)} de salaire. Le coussin de {euro(summary.monthlyPlan.safetyBuffer)} est un stock déjà en banque, il ne se prélève pas chaque mois.</p>
        <div className="monthly-target-grid">
          <article><small>CHARGES FIXES</small><strong>{euro(summary.monthlyPlan.fixedCosts)}</strong><span>Logement, contrats, taxes</span></article>
          <article><small>VIREMENT {summary.monthlyPlan.flexibleAccount.toUpperCase()}</small><strong>{euro(summary.monthlyPlan.flexibleLimit)}</strong><span>Plafond dépenses courantes</span></article>
          <article className="positive"><small>ÉPARGNE AUTOMATIQUE</small><strong>{euro(summary.monthlyPlan.recommendedSavings)}</strong><span>Objectif soutenable calculé</span></article>
          <article><small>NON ALLOUÉ</small><strong>{euro(summary.monthlyPlan.unallocated)}</strong><span>Marge restante du salaire</span></article>
        </div>
        <details><summary>Charges fixes retenues · {euro(summary.monthlyPlan.fixedCosts)} <b>›</b></summary><div className="monthly-limit-list fixed-charge-list">{summary.monthlyPlan.fixedChargeBreakdown.map((item) => {
          const category = data.categories.find(({ id }) => id === item.category);
          const basis = item.basis === "budget" ? "budget configuré" : item.basis === "configured" ? "charge configurée" : "médiane 3 mois";
          return <article key={item.category}><span><strong>{category?.label || item.category}</strong><small>{basis} · ce mois {euro(item.current)}{item.contracts.length ? ` · ${item.contracts.map(({ name }) => name).join(", ")}` : ""}</small></span><b>{euro(item.amount)}</b></article>;
        })}</div></details>
        <details><summary>Voir limites fixes + enveloppe <b>›</b></summary><div className="monthly-limit-list">{data.categories.filter(({ id }) => summary.monthlyPlan.categoryLimits[id] > 0).map((category) => <article key={category.id}><span>{category.label}</span><b>{euro(summary.monthlyPlan.categoryLimits[category.id])}</b></article>)}</div></details>
        <details><summary>Récurrents détectés · {summary.detectedRecurring.length} <b>›</b></summary><div className="monthly-limit-list">{summary.detectedRecurring.map((item) => <article key={item.id}><span>{item.name}<small>{data.categories.find(({ id }) => id === item.category)?.label || "Autres"} · {item.months} mois</small></span><b>{euro(item.monthlyNet)} / mois</b></article>)}</div></details>
        {summary.spendingEnvelopes[0] && <footer>{summary.spendingEnvelopes[0].name}: médiane historique {euro(summary.spendingEnvelopes[0].historicalMedian)} · plafond conseillé −10% {euro(summary.spendingEnvelopes[0].recommendedFunding)} · toutes dépenses variables passent ici; achat ailleurs s’ajoute au plafond.</footer>}
      </details>

      <details className="panel spending-plan foldable">
        <summary className="panel-head"><div><h3>Calcul réaliste</h3><p>Chaque euro protégé avant dépenses libres</p></div><span className={`confidence ${summary.dataConfidence}`}>FIABILITÉ {confidenceLabel.toUpperCase()}</span><i>›</i></summary>
        <div className="spending-plan-body">
          <div className="money-equation">
            <span><small>{summary.incomeSource === "history" ? `Salaire estimé · ${summary.incomeHistoryMonths} mois` : "Revenus reçus"}</small><b>{euro(summary.income)}</b></span>
            <span><small>Déjà dépensé</small><b>− {euro(summary.expenses)}</b></span>
            <span><small>Charges essentielles restantes</small><b>− {euro(summary.futureEssentialExpenses)}</b></span>
            <span><small>Réserve imprévus {summary.safetyBufferAutomatic ? "auto" : "fixe"}</small><b>− {euro(summary.safetyBuffer)}</b></span>
            <span><small>Épargne soutenable protégée</small><b>− {euro(summary.protectedSavings)}</b></span>
            {summary.spendingEnvelopes.map((envelope) => <span key={envelope.id}><small>{envelope.name} restante</small><b className={envelope.remaining < 0 ? "negative" : "positive"}>{envelope.remaining < 0 ? "− " : "+ "}{euro(Math.abs(envelope.remaining))}</b></span>)}
            {summary.flexibleBudgetApplied && <span><small>Plafond budgets libres</small><b>{euro(summary.flexibleBudgetRemaining)}</b></span>}
          </div>
          <div className="month-forecast">
            <small>PROJECTION FIN DE MOIS</small><strong>{euro(summary.projectedExpenses)}</strong><span>dépenses probables</span>
            <div><b className={summary.projectedSavings >= 0 ? "positive" : "negative"}>{summary.projectedSavings >= 0 ? "+" : "−"}{euro(Math.abs(summary.projectedSavings))}</b><small>{summary.projectedSavings >= 0 ? "marge avant imprévus" : "déficit projeté"}</small></div>
            <p>{summary.historyMonths} mois historique · {summary.transactionCount} opérations utiles · {summary.excludedTransactionCount} transferts ignorés</p>
          </div>
        </div>
      </details>

      <details className="panel finance-assets foldable">
        <summary className="panel-head"><div><h3>Actifs suivis</h3><p>{summary.assets.source === "banque" ? "Soldes réels des livrets et placements" : "Épargne disponible et placements bloqués, hors comptes courants"}{summary.savedThisMonth > 0 ? ` · ${euro(summary.savedThisMonth)} placés ce mois` : ""}</p></div><b className="asset-split"><span>{euro(summary.assets.liquid)} dispo</span><em>{euro(summary.assets.invested)} investi</em></b><i>›</i></summary>
        <div>{summary.assets.entries.map((asset) => <article key={asset.id}><span><strong>{asset.name}</strong><small>{asset.bucket === "liquid" ? "Disponible" : "Investi · non mobilisable"}{asset.institution ? ` · ${asset.institution}` : ""}{asset.source === "banque" ? " · solde bancaire" : ""}{asset.contributions ? ` · ${asset.contributions > 0 ? "+" : "−"}${euro(Math.abs(asset.contributions))} depuis la saisie` : ""}</small></span><b>{euro(asset.amount)}</b></article>)}{!summary.assets.entries.length && <p className="finance-empty">Aucun actif configuré.</p>}</div>
        <footer><button className="ghost" onClick={() => onView("finance-modules")}>Gérer modules</button></footer>
      </details>

      <section className="finance-layout">
        <FinanceAdvicePanel month={month} />

        <details className="panel finance-insights foldable">
          <summary className="panel-head"><div><h3>Alertes & leviers</h3><p>Repères automatiques, pas conseil financier</p></div><b>{summary.warnings.length + summary.recommendations.length}</b><i>›</i></summary>
          <div className="insight-list">
            {summary.warnings.map((warning) => <article className={warning.tone} key={warning.id}><i /><span><strong>{warning.title}</strong><small>{warning.detail}</small></span></article>)}
            {summary.recommendations.map((recommendation, index) => <article className="tip" key={recommendation}><i>{index + 1}</i><span><strong>Optimisation</strong><small>{recommendation}</small></span></article>)}
            {!summary.warnings.length && !summary.recommendations.length && <p className="finance-empty">Importe opérations pour générer analyse.</p>}
          </div>
        </details>
      </section>

      <details className="panel finance-excluded">
        <summary><span><strong>Virements et mouvements exclus</strong><small>{summary.excludedTransactionCount} ce mois · non comptés comme revenu ou dépense</small></span><b>›</b></summary>
        <div>{data.transactions.filter(({ excluded }) => excluded).map((transaction) => <article key={transaction.id}><span><strong>{transaction.description}</strong><small>{operationDate(transaction)} · {transaction.account} · {exclusionLabel(transaction.exclusionReason)}</small></span><b className={transaction.amount >= 0 ? "income" : "expense"}>{transaction.amount >= 0 ? "+" : "−"}{euro(Math.abs(transaction.amount))}</b></article>)}{!summary.excludedTransactionCount && <p className="finance-empty">Aucun mouvement exclu.</p>}</div>
      </details>

      <section className="finance-forms">
        <form className="panel finance-settings" onSubmit={saveSettings}>
          <details className="finance-settings-fold" open={false}>
          <summary className="panel-head"><div><h3>Plan mensuel</h3><p>Base calcul épargne</p></div><i>›</i></summary>
          <div className="finance-form-grid">
            <label><span>Objectif épargne / mois</span><input type="number" min="0" step="0.01" value={settings.savingsGoal} onChange={(event) => setSettings({ ...settings, savingsGoal: event.target.value })} placeholder="0 €" /></label>
            <label><span>Réserve imprévus (0 = auto)</span><input type="number" min="0" step="0.01" value={settings.safetyBuffer} onChange={(event) => setSettings({ ...settings, safetyBuffer: event.target.value })} placeholder="Auto" /></label>
            <label><span>Fonds sécurité</span><select value={settings.emergencyMonths} onChange={(event) => setSettings({ ...settings, emergencyMonths: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6, 9, 12].map((value) => <option key={value} value={value}>{value} mois</option>)}</select></label>
          </div>
          <div className="budget-inputs">{data.categories.map((category) => <label key={category.id}><span>{category.label}</span><input type="number" min="0" step="0.01" value={settings.budgets[category.id]} onChange={(event) => setSettings({ ...settings, budgets: { ...settings.budgets, [category.id]: event.target.value } })} placeholder="Budget €" /></label>)}</div>
          <div className="finance-settings-actions"><button className="primary" disabled={saving}>{saving ? "…" : "Enregistrer"}</button></div>
          </details>
        </form>
      </section>
      <FinanceAgentDock month={month} onExpand={() => onView("finance-agent")} onChanged={load} />
    </div>
  );
}

function FinanceBankingView({ onView }) {
  const month = localIsoDate().slice(0, 7);
  const [data, setData] = useState(() => cachedView(`finance-${month}`));
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setError("");
      const payload = await api(`/api/finance?month=${encodeURIComponent(month)}`);
      setData(payload);
      storeView(`finance-${month}`, payload);
    } catch (reason) {
      setError(reason.message);
    }
  }, [month]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page finance-page">
      <section className="hero-row finance-hero"><div><p className="eyebrow">BUDGET · RÉGLAGES</p><h1>Banques.</h1><p className="muted">Connexions, configuration et synchronisation.</p></div><div className="budget-child-actions"><button className="ghost" onClick={() => onView("finances")}>← Budget</button><BudgetMenu onView={onView} /></div></section>
      {error && <p className="finance-error">{error}</p>}
      {data ? <BankingPanel banks={data.banking.banks} month={month} onSynced={load} /> : !error && <section className="panel"><p className="finance-empty">Chargement connexions…</p></section>}
    </div>
  );
}

function financeModuleDraft(module = {}) {
  return {
    moduleType: module.moduleType || "asset",
    name: module.name || "",
    enabled: module.enabled !== false,
    amount: module.amount === undefined ? "" : String(module.amount),
    bucket: module.bucket || "liquid",
    institution: module.institution || "",
    accountMatch: module.accountMatch || "",
    transactionMatch: module.transactionMatch || "",
    category: module.category || "housing",
    startDate: module.startDate || localIsoDate(),
    endDate: module.endDate || "",
    dayOfMonth: module.dayOfMonth || 1,
  };
}

function FinanceModuleFields({ draft, onChange, categories, lockType = false }) {
  const field = (key, value) => onChange({ ...draft, [key]: value });
  return (
    <div className="finance-module-fields">
      <label><span>Type</span><select value={draft.moduleType} disabled={lockType} onChange={(event) => field("moduleType", event.target.value)}><option value="asset">Actif</option><option value="recurring">Charge récurrente</option><option value="envelope">Enveloppe dépenses</option><option value="transfer">Règle transfert interne</option></select></label>
      <label className="wide"><span>Nom</span><input value={draft.name} onChange={(event) => field("name", event.target.value)} maxLength="120" required placeholder="Nom libre" /></label>
      {draft.moduleType === "asset" && <>
        <label><span>Valeur actuelle</span><input type="number" min="0" step="0.01" value={draft.amount} onChange={(event) => field("amount", event.target.value)} required placeholder="0,00 €" /></label>
        <label><span>Classe</span><select value={draft.bucket} onChange={(event) => field("bucket", event.target.value)}><option value="liquid">Liquide</option><option value="invested">Investi</option></select></label>
        <label><span>Établissement</span><input value={draft.institution} onChange={(event) => field("institution", event.target.value)} maxLength="80" placeholder="Optionnel" /></label>
        <label className="wide"><span>Motifs transferts à exclure</span><input value={draft.transactionMatch} onChange={(event) => field("transactionMatch", event.target.value)} maxLength="240" placeholder="Sépare avec virgules" /></label>
      </>}
      {draft.moduleType === "recurring" && <>
        <label><span>Montant mensuel</span><input type="number" min="0.01" step="0.01" value={draft.amount} onChange={(event) => field("amount", event.target.value)} required /></label>
        <label><span>Catégorie</span><select value={draft.category} onChange={(event) => field("category", event.target.value)}>{categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}</select></label>
        <label><span>Jour</span><input type="number" min="1" max="31" value={draft.dayOfMonth} onChange={(event) => field("dayOfMonth", event.target.value)} required /></label>
        <label><span>Début</span><input type="date" value={draft.startDate} onChange={(event) => field("startDate", event.target.value)} required /></label>
        <label><span>Fin</span><input type="date" value={draft.endDate} onChange={(event) => field("endDate", event.target.value)} /></label>
        <label className="wide"><span>Motifs bancaires pour catégorie</span><input value={draft.transactionMatch} onChange={(event) => field("transactionMatch", event.target.value)} maxLength="240" placeholder="Nom créancier, séparé par virgules" /></label>
      </>}
      {draft.moduleType === "envelope" && <label className="wide"><span>Nom du compte à suivre</span><input value={draft.accountMatch} onChange={(event) => field("accountMatch", event.target.value)} maxLength="120" required placeholder="Correspondance partielle" /></label>}
      {draft.moduleType === "transfer" && <label className="wide"><span>Motifs transactions à exclure</span><input value={draft.transactionMatch} onChange={(event) => field("transactionMatch", event.target.value)} maxLength="240" required placeholder="Sépare avec virgules" /></label>}
      <label className="module-enabled"><input type="checkbox" checked={draft.enabled} onChange={(event) => field("enabled", event.target.checked)} /><span>Module actif</span></label>
    </div>
  );
}

function FinanceModuleEditor({ module, categories, onSaved, onRemoved }) {
  const [draft, setDraft] = useState(() => financeModuleDraft(module));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/api/finance/modules/${encodeURIComponent(module.id)}`, { method: "PATCH", body: JSON.stringify({ ...draft, amount: Number(draft.amount || 0), dayOfMonth: Number(draft.dayOfMonth), endDate: draft.endDate || null }) });
      await onSaved();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!window.confirm(`Supprimer module « ${module.name} » ?`)) return;
    setBusy(true);
    try {
      await api(`/api/finance/modules/${encodeURIComponent(module.id)}`, { method: "DELETE" });
      await onRemoved();
    } catch (reason) {
      setError(reason.message);
      setBusy(false);
    }
  }
  const typeLabel = { asset: "ACTIF", recurring: "CHARGE", envelope: "ENVELOPPE", transfer: "TRANSFERT" }[module.moduleType];
  const detail = module.moduleType === "asset" ? `${euro(module.amount)} · ${module.institution || (module.bucket === "liquid" ? "liquide" : "investi")}` : module.moduleType === "recurring" ? `${euro(module.amount)} / mois · jour ${module.dayOfMonth}` : module.moduleType === "envelope" ? module.accountMatch : "Mouvements exclus du budget";
  return <details className="panel finance-module-card"><summary><span><strong>{module.name}</strong><small>{typeLabel} · {module.enabled === false ? "désactivé" : detail}</small></span><b>›</b></summary><form onSubmit={save}>{error && <p className="finance-error">{error}</p>}<FinanceModuleFields draft={draft} onChange={setDraft} categories={categories} lockType /><footer className="finance-module-actions"><button type="button" className="danger-link" onClick={remove} disabled={busy} aria-label={`Supprimer ${module.name}`}>×</button><button className="primary" disabled={busy}>{busy ? "…" : "Enregistrer"}</button></footer></form></details>;
}

function FinanceModulesView({ onView }) {
  const [data, setData] = useState(() => cachedView(`finance-${localIsoDate().slice(0, 7)}`));
  const [draft, setDraft] = useState(() => financeModuleDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const payload = await api(`/api/finance?month=${localIsoDate().slice(0, 7)}`);
      setData(payload);
      storeView(`finance-${localIsoDate().slice(0, 7)}`, payload);
      setError("");
    } catch (reason) {
      setError(reason.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function add(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/finance/modules", { method: "POST", body: JSON.stringify({ ...draft, amount: Number(draft.amount || 0), dayOfMonth: Number(draft.dayOfMonth), endDate: draft.endDate || null }) });
      setDraft(financeModuleDraft());
      await load();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  const modules = data?.modules || [];
  return (
    <div className="page finance-page finance-modules-page">
      <section className="hero-row finance-hero"><div><p className="eyebrow">BUDGET · COMPOSANTS</p><h1>Modules financiers.</h1><p className="muted">Données et règles configurables. Aucun compte personnel codé dans moteur.</p></div><div className="budget-child-actions"><button className="ghost" onClick={() => onView("finances")}>← Budget</button><BudgetMenu onView={onView} /></div></section>
      {error && <p className="finance-error">{error}</p>}
      <section className="finance-module-list">{modules.map((module) => <FinanceModuleEditor key={module.id} module={module} categories={data.categories} onSaved={load} onRemoved={load} />)}{data && !modules.length && <section className="panel"><p className="finance-empty">Aucun module.</p></section>}</section>
      <details className="panel new-module"><summary><span><strong>Ajouter module</strong><small>Actif, charge, enveloppe ou règle transfert</small></span><b>＋</b></summary><form onSubmit={add}><FinanceModuleFields draft={draft} onChange={setDraft} categories={data?.categories || []} /><footer><button className="primary" disabled={busy}>{busy ? "Ajout…" : "Ajouter module"}</button></footer></form></details>
    </div>
  );
}

function FinanceTransactionsView({ onView }) {
  const today = localIsoDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState(() => cachedView(`finance-${today.slice(0, 7)}`));
  const [transaction, setTransaction] = useState({ kind: "expense", amount: "", description: "", category: "food", date: today, account: "" });
  const [adding, setAdding] = useState(false);
  const [categorizing, setCategorizing] = useState(false);
  const [sortOrder, setSortOrder] = useState("date-desc");
  const [grouped, setGrouped] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setError("");
      const payload = await api(`/api/finance?month=${encodeURIComponent(month)}`);
      setData(payload);
      storeView(`finance-${month}`, payload);
    } catch (reason) {
      setError(reason.message);
    }
  }, [month]);
  useEffect(() => { load(); }, [load]);
  function shiftMonth(offset) {
    const [year, value] = month.split("-").map(Number);
    setMonth(new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7));
  }
  async function addTransaction(event) {
    event.preventDefault();
    setAdding(true);
    try {
      await api("/api/finance/transactions", { method: "POST", body: JSON.stringify({ ...transaction, amount: Number(transaction.amount) }) });
      setTransaction((current) => ({ ...current, amount: "", description: "" }));
      await load();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setAdding(false);
    }
  }
  const assetModules = (data?.modules || []).filter(({ moduleType, enabled }) => moduleType === "asset" && enabled !== false);

  async function assignAsset(id, assetId) {
    try {
      const result = await api(`/api/finance/transactions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ assetId: assetId || null, month }) });
      setData(result.finance);
      setError("");
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function removeTransaction(id) {
    if (!window.confirm("Supprimer cette opération ?")) return;
    try {
      await api(`/api/finance/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(reason.message);
    }
  }
  async function categorizeTransactions() {
    setCategorizing(true);
    setError("");
    try {
      const response = await api("/api/finance/transactions/categorize", { method: "POST", body: JSON.stringify({ month, force: true }) });
      setData(response.finance);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setCategorizing(false);
    }
  }
  const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  const lastSync = data?.banking?.lastSyncAt ? new Date(data.banking.lastSyncAt) : null;
  const sortedTransactions = useMemo(() => [...(data?.transactions || [])].sort((a, b) => {
    if (sortOrder === "amount-desc") return Math.abs(b.amount) - Math.abs(a.amount) || b.date.localeCompare(a.date);
    if (sortOrder === "amount-asc") return Math.abs(a.amount) - Math.abs(b.amount) || b.date.localeCompare(a.date);
    return b.date.localeCompare(a.date) || String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  }), [data?.transactions, sortOrder]);
  // Achats repetes (cafes, courses…): on les empile sous une seule ligne depliable.
  const groups = useMemo(() => {
    if (!grouped) return sortedTransactions.map((item) => ({ key: item.id, items: [item] }));
    const buckets = new Map();
    for (const item of sortedTransactions) {
      const key = `${item.kind}:${merchantKey(item.description)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
    }
    return [...buckets.entries()].map(([key, items]) => ({ key, items }));
  }, [sortedTransactions, grouped]);

  function transactionRow(item) {
    return (
      <article className={item.excluded ? "excluded" : ""} key={item.id}>
        <span className={`transaction-kind ${item.kind}`}>{item.excluded ? "↔" : item.kind === "income" ? "+" : "−"}</span>
        <span><strong>{item.description}</strong><small title={item.categoryReason || ""}>{operationDate(item)} · {item.account} · {item.excluded ? exclusionLabel(item.exclusionReason) : data.categories.find(({ id }) => id === item.category)?.label || "Revenu"}{item.categorySource === "codex" ? ` · Codex: ${item.categoryReason}` : ""}</small></span>
        <b className={item.amount >= 0 ? "income" : "expense"}>{item.amount >= 0 ? "+" : "−"}{euro(Math.abs(item.amount))}</b>
        <button onClick={() => removeTransaction(item.id)} aria-label={`Supprimer ${item.description}`}>×</button>
        {(item.excluded || item.assetId || item.assetAuto) && assetModules.length > 0 && (
          <label className="transaction-asset">
            <span>{item.assetAuto && !item.assetId ? "Épargne détectée" : "Versé sur"}</span>
            <select value={item.assetId || item.assetAuto || ""} onChange={(event) => assignAsset(item.id, event.target.value)} aria-label="Rattacher à un actif">
              <option value="">Aucun actif</option>
              {assetModules.map((module) => <option value={module.id} key={module.id}>{module.name}</option>)}
            </select>
          </label>
        )}
      </article>
    );
  }

  function transactionGroup({ key, items }) {
    if (items.length === 1) return transactionRow(items[0]);
    const total = items.reduce((sum, item) => sum + item.amount, 0);
    const dates = items.map((item) => item.date).sort();
    return (
      <details className="transaction-group" key={key}>
        <summary>
          <span className={`transaction-kind ${items[0].kind}`}>{items.length}×</span>
          <span><strong>{items[0].description}</strong><small>{items.length} opérations · du {dates[0].split("-").reverse().join("/")} au {dates.at(-1).split("-").reverse().join("/")}</small></span>
          <b className={total >= 0 ? "income" : "expense"}>{total >= 0 ? "+" : "−"}{euro(Math.abs(total))}</b>
        </summary>
        {items.map(transactionRow)}
      </details>
    );
  }

  return (
    <div className="page finance-page finance-operations-page has-finance-dock">
      <section className="hero-row finance-hero"><div><p className="eyebrow">BUDGET · HISTORIQUE LOCAL</p><h1>Opérations.</h1><p className="muted">Saisie manuelle et imports bancaires{lastSync ? ` · synchro ${lastSync.toLocaleDateString("fr-FR")} ${lastSync.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}.</p></div><div className="budget-child-actions"><button className="ghost" onClick={() => onView("finances")}>← Budget</button><BudgetMenu onView={onView} /><div className="month-switch"><button onClick={() => shiftMonth(-1)}>‹</button><strong>{monthName}</strong><button onClick={() => shiftMonth(1)}>›</button></div></div></section>
      {error && <p className="finance-error">{error}</p>}
      <section className="operations-layout">
        <form className="panel transaction-form" onSubmit={addTransaction}>
          <div className="panel-head"><div><h3>Ajouter opération</h3><p>Dépense ou revenu manuel</p></div></div>
          <div className="transaction-fields">
            <label><span>Type</span><select value={transaction.kind} onChange={(event) => setTransaction({ ...transaction, kind: event.target.value })}><option value="expense">Dépense</option><option value="income">Revenu</option></select></label>
            <label><span>Montant</span><input type="number" min="0.01" step="0.01" value={transaction.amount} onChange={(event) => setTransaction({ ...transaction, amount: event.target.value })} required placeholder="0,00 €" /></label>
            <label className="wide"><span>Description</span><input value={transaction.description} onChange={(event) => setTransaction({ ...transaction, description: event.target.value })} required maxLength="120" placeholder="Courses, loyer, salaire…" /></label>
            {transaction.kind === "expense" && <label><span>Catégorie</span><select value={transaction.category} onChange={(event) => setTransaction({ ...transaction, category: event.target.value })}>{(data?.categories || []).map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>}
            <label><span>Date</span><input type="date" value={transaction.date} onChange={(event) => setTransaction({ ...transaction, date: event.target.value })} required /></label>
            <label className="wide"><span>Compte</span><input value={transaction.account} onChange={(event) => setTransaction({ ...transaction, account: event.target.value })} maxLength="60" placeholder="Optionnel" /></label>
            <button className="primary wide" disabled={adding}>{adding ? "Ajout…" : "Ajouter"}</button>
          </div>
        </form>
        <section className="panel finance-transactions">
          <div className="panel-head"><div><h3>Historique</h3><p>{data?.transactions.length || 0} opérations · {data?.classification.categorizedByCodex || 0}/{data?.classification.bankTransactions || 0} classées Codex</p></div><div className="transaction-tools"><button className={grouped ? "ghost active" : "ghost"} onClick={() => setGrouped((value) => !value)}>{grouped ? "Groupés" : "Détaillés"}</button><button className="ghost" onClick={categorizeTransactions} disabled={categorizing}>{categorizing ? "Codex classe…" : "Reclasser Codex"}</button><label className="transaction-sort"><span>Trier</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}><option value="date-desc">Date récente</option><option value="amount-desc">Montant décroissant</option><option value="amount-asc">Montant croissant</option></select></label></div></div>
          <div className="transaction-list">
            {groups.map(transactionGroup)}
            {data && !data.transactions.length && <p className="finance-empty">Aucune opération ce mois.</p>}
          </div>
        </section>
      </section>
      <FinanceAgentDock month={month} onExpand={() => onView("finance-agent")} onChanged={load} />
    </div>
  );
}

function FinanceAgentView({ onView }) {
  const month = localIsoDate().slice(0, 7);
  const [messages, setMessages] = useState([]);
  const [recurring, setRecurring] = useState([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await api(`/api/finance?month=${month}`);
      setMessages(data.agent.history);
      setRecurring(data.recurring);
    } catch (reason) {
      setError(reason.message);
    }
  }, [month]);
  useEffect(() => { load(); }, [load]);
  async function send(event, suggested = "") {
    event?.preventDefault();
    const content = (suggested || message).trim();
    if (!content || sending) return;
    setSending(true);
    setError("");
    setMessages((current) => [...current, { id: `local-${Date.now()}`, role: "user", content }]);
    setMessage("");
    try {
      const response = await api("/api/finance/agent/message", { method: "POST", body: JSON.stringify({ message: content, month }) });
      setMessages(response.history);
      setRecurring(response.recurring);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSending(false);
    }
  }
  async function removeRule(id) {
    if (!window.confirm("Supprimer cette charge des prévisions ?")) return;
    try {
      await api(`/api/finance/recurring/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(reason.message);
    }
  }
  return (
    <div className="page finance-agent-page">
      <section className="hero-row finance-hero"><div><p className="eyebrow">BUDGET · CODEX</p><h1>Agent finances.</h1><p className="muted">Connaît comptes, transactions, catégories, modules et calculs Noyau.</p></div><div className="budget-child-actions"><button className="ghost" onClick={() => onView("finances")}>− Réduire</button><BudgetMenu onView={onView} /></div></section>
      {error && <p className="finance-error">{error}</p>}
      <section className="finance-agent-layout">
        <section className="panel finance-chat">
          <div className="panel-head"><div><h3>Discussion Codex</h3><p>Snapshot financier envoyé au compte Codex configuré sur ce PC</p></div><span className="ready">CODEX</span></div>
          <div className="finance-chat-messages">
            {!messages.length && <article className="assistant"><strong>Agent finances · Codex</strong><p>Demande explication, analyse, prévision ou modification de charge mensuelle.</p></article>}
            {messages.map((item) => <article className={item.role} key={item.id}><strong>{item.role === "user" ? "Toi" : "Agent finances · Codex"}</strong><p>{item.content}</p></article>)}
          </div>
          <div className="finance-prompts"><button onClick={(event) => send(event, "Chaque mois je paye 950 euros de loyer")}>Ajouter loyer</button><button onClick={(event) => send(event, "Combien je peux encore dépenser ce mois ?")}>Reste dépensable</button><button onClick={(event) => send(event, "Liste mes charges mensuelles")}>Lister charges</button></div>
          <form className="finance-chat-input" onSubmit={send}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Pourquoi prévision élevée ? Où réduire ?…" maxLength="1000" enterKeyHint="send" /><button className="primary" disabled={sending || !message.trim()}>{sending ? "Analyse…" : "Envoyer"}</button></form>
        </section>
        <section className="panel recurring-panel">
          <div className="panel-head"><div><h3>Charges prévues</h3><p>{recurring.filter(({ endDate }) => !endDate).length} active{recurring.filter(({ endDate }) => !endDate).length > 1 ? "s" : ""}</p></div></div>
          <div className="recurring-list">{recurring.map((rule) => <article className={rule.endDate ? "ended" : ""} key={rule.id}><span><strong>{rule.description}</strong><small>Le {rule.dayOfMonth} · depuis {rule.startDate.split("-").reverse().join("/")}{rule.endDate ? ` · fin ${rule.endDate.split("-").reverse().join("/")}` : ""}</small></span><b>{euro(rule.amount)}</b>{!rule.endDate && <button onClick={() => removeRule(rule.id)} aria-label={`Supprimer ${rule.description}`}>×</button>}</article>)}{!recurring.length && <p className="finance-empty">Aucune charge. Écris première règle dans discussion.</p>}</div>
        </section>
      </section>
    </div>
  );
}

function todoDueLabel(value) {
  if (!value) return "Sans échéance";
  const today = localIsoDate();
  if (value === today) return "Aujourd’hui";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (value === localIsoDate(tomorrow)) return "Demain";
  if (value < today) return `En retard · ${value.split("-").reverse().join("/")}`;
  return `Pour le ${value.split("-").reverse().join("/")}`;
}

async function writeClipboard(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* on retombe sur la methode historique */ }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}

// Les agents coupent une URL sur plusieurs lignes: on recolle les morceaux d'une ligne pleine
// tant que la suite ne contient que des caracteres d'URL.
function extractLinks(rows, width) {
  const safe = /^[A-Za-z0-9%&=_\-.~:/?#[\]@!$'()*+,;]+$/;
  const links = [];
  for (let index = 0; index < rows.length; index += 1) {
    const matches = rows[index].matchAll(/https?:\/\/[^\s"'<>)\]]+/g);
    for (const match of matches) {
      let url = match[0].replace(/[.,;:)]+$/, "");
      let cursor = index;
      while (cursor + 1 < rows.length) {
        const filled = rows[cursor].replace(/\s+$/, "").length >= width - 4;
        const next = rows[cursor + 1].trim();
        if (!filled || next.length < 3 || !safe.test(next)) break;
        url += next;
        cursor += 1;
      }
      links.push(url.replace(/[.,;:)]+$/, ""));
    }
  }
  return [...new Set(links)];
}

function completedLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `Terminé le ${date.toLocaleDateString("fr-FR")} à ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

function formatCommentDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function TodosView() {
  const cached = cachedView("todos");
  const [todos, setTodos] = useState(() => (Array.isArray(cached) ? cached : cached?.todos) || []);
  const [folders, setFolders] = useState(() => (Array.isArray(cached) ? [] : cached?.folders) || []);
  const [storage, setStorage] = useState("Obsidian · NAS");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [datePanel, setDatePanel] = useState(null);
  const [openComments, setOpenComments] = useState({});
  const [newComment, setNewComment] = useState({});
  const [filterTab, setFilterTab] = useState("all");
  const [viewMode, setViewMode] = useState(() => { try { return localStorage.getItem(profileCacheKey("todo-view-mode")) || "board"; } catch { return "board"; } });
  const [addingInColumn, setAddingInColumn] = useState(null);
  const [columnText, setColumnText] = useState("");
  const [openFolder, setOpenFolder] = useState(() => { try { return localStorage.getItem(profileCacheKey("todo-folder")) || null; } catch { return null; } });
  const [showDone, setShowDone] = useState({});
  const [columns, setColumns] = useState(() => (Array.isArray(cached) ? null : cached?.columns) || DEFAULT_COLUMNS);
  const [expandedCards, setExpandedCards] = useState({});
  const [overflowCards, setOverflowCards] = useState({});
  const [correction, setCorrection] = useState(() => (Array.isArray(cached) ? true : cached?.correction !== false));
  const [collapsedColumns, setCollapsedColumns] = useState(() => {
    // La colonne « Terminé » demarre repliee: elle ne mange pas la largeur utile du tableau.
    try { return JSON.parse(localStorage.getItem(profileCacheKey("todo-collapsed-columns"))) || { done: true }; } catch { return { done: true }; }
  });
  const [renamingColumn, setRenamingColumn] = useState(null);
  const [dragging, setDragging] = useState("");
  const dragRef = React.useRef(null);
  const rowRefs = React.useRef(new Map());
  const seenRef = React.useRef(new Set());

  const apply = useCallback((result) => {
    if (!result) return;
    // Une reponse partie avant le marquage ne doit pas rallumer une pastille deja lue.
    const nextTodos = (result.todos || []).map((todo) => (seenRef.current.has(todo.id) ? { ...todo, unread: 0 } : todo));
    const nextFolders = result.folders || [];
    const nextColumns = result.columns?.length ? result.columns : DEFAULT_COLUMNS;
    const nextCorrection = result.correction !== false;
    setTodos(nextTodos);
    setFolders(nextFolders);
    setColumns(nextColumns);
    setCorrection(nextCorrection);
    storeView("todos", { todos: nextTodos, folders: nextFolders, columns: nextColumns, correction: nextCorrection });
    window.dispatchEvent(new CustomEvent("noyau:todos-unread", { detail: nextTodos.reduce((total, todo) => total + (todo.unread || 0), 0) }));
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await api("/api/todos");
      apply(result);
      setStorage(result.storage || "Obsidian");
      setError("");
    } catch (reason) {
      setError(reason.message);
    }
  }, [apply]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    const visible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);

  async function run(key, task) {
    setBusy(key);
    try {
      apply(await task());
      setError("");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy("");
    }
  }

  async function add(event) {
    event.preventDefault();
    if (!text.trim()) return;
    const targetFolderId = !openFolder || openFolder === "all" || openFolder === ROOT_FOLDER ? null : openFolder;
    await run("new", async () => {
      const result = await api("/api/todos", { method: "POST", body: JSON.stringify({ text, folderId: targetFolderId }) });
      setText("");
      return result;
    });
  }

  async function addWithStatus(event, targetStatus) {
    event?.preventDefault();
    const raw = columnText.trim();
    if (!raw) return;
    setColumnText("");
    setAddingInColumn(null);
    const targetFolderId = !openFolder || openFolder === "all" || openFolder === ROOT_FOLDER ? null : openFolder;
    await run("new", async () => {
      const result = await api("/api/todos", { method: "POST", body: JSON.stringify({ text: raw, folderId: targetFolderId }) });
      if (targetStatus && targetStatus !== "todo" && result.todo?.id) {
        return await api(`/api/todos/${encodeURIComponent(result.todo.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: targetStatus }),
        });
      }
      return result;
    });
  }

  const update = (todo, changes) => {
    // Optimistic update
    setTodos((prev) => prev.map((item) => {
      if (item.id !== todo.id) return item;
      const next = { ...item, ...changes };
      if (changes.status !== undefined) {
        next.status = changes.status;
        next.completed = changes.status === "done";
        if (changes.status === "done" && !next.completedAt) next.completedAt = new Date().toISOString();
        if (changes.status !== "done") next.completedAt = null;
      } else if (changes.completed !== undefined) {
        next.completed = changes.completed === true;
        next.status = next.completed ? "done" : "todo";
        next.completedAt = next.completed ? (next.completedAt || new Date().toISOString()) : null;
      }
      return next;
    }));
    return run(todo.id, () => api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: "PATCH", body: JSON.stringify(changes) }));
  };
  const move = (todo, direction) => run(todo.id, () => api(`/api/todos/${encodeURIComponent(todo.id)}/move`, { method: "POST", body: JSON.stringify({ direction }) }));

  async function addComment(todo, event) {
    event?.preventDefault();
    const commentText = (newComment[todo.id] || "").trim();
    if (!commentText) return;
    await run(`comment:${todo.id}`, async () => {
      const result = await api(`/api/todos/${encodeURIComponent(todo.id)}/comments`, { method: "POST", body: JSON.stringify({ text: commentText }) });
      setNewComment((prev) => ({ ...prev, [todo.id]: "" }));
      return result;
    });
  }

  async function removeComment(todo, commentId) {
    await run(`comment-del:${commentId}`, () => api(`/api/todos/${encodeURIComponent(todo.id)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }));
  }

  const noteOverflow = useCallback((id, value) => {
    setOverflowCards((current) => (current[id] === value ? current : { ...current, [id]: value }));
  }, []);

  async function removeTodo(todo) {
    if (!window.confirm(`Supprimer la tâche « ${todo.text} » ? Action définitive.`)) return;
    await run(`del:${todo.id}`, () => api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: "DELETE" }));
  }

  const statusOf = (todo) => todo.status || (todo.completed ? "done" : "todo");
  // Vue tableau: la derniere activite remonte en tete de colonne.
  const byActivity = (a, b) => String(b.activityAt || "").localeCompare(String(a.activityAt || ""));

  async function markSeen(ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return;
    for (const id of list) seenRef.current.add(id);
    setTodos((prev) => prev.map((item) => (list.includes(item.id) ? { ...item, unread: 0 } : item)));
    try {
      const result = await api("/api/todos/seen", { method: "POST", body: JSON.stringify({ ids: list }) });
      for (const id of list) if ((result.todos || []).find((todo) => todo.id === id)?.unread === 0) seenRef.current.delete(id);
      apply(result);
      window.dispatchEvent(new Event("noyau:todos"));
    } catch { /* le compteur se recalera au prochain chargement */ }
  }
  const knownStatus = useMemo(() => new Set(columns.map((column) => column.id)), [columns]);
  // Une tache dont la zone a disparu retombe visuellement dans « A faire ».
  const inColumn = useCallback(
    (list, columnId) => list
      .filter((todo) => statusOf(todo) === columnId || (columnId === "todo" && !knownStatus.has(statusOf(todo))))
      .sort((a, b) => String(b.activityAt || "").localeCompare(String(a.activityAt || ""))),
    [knownStatus],
  );

  async function addColumn() {
    const name = window.prompt("Nom de la nouvelle zone ?");
    if (!name?.trim()) return;
    await run("column", () => api("/api/todos/columns", { method: "POST", body: JSON.stringify({ name }) }));
  }

  async function renameColumn(column, name) {
    setRenamingColumn(null);
    if (!name?.trim() || name.trim() === column.name) return;
    await run(`column:${column.id}`, () => api(`/api/todos/columns/${encodeURIComponent(column.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }));
  }

  async function removeColumn(column) {
    if (!window.confirm(`Supprimer la zone « ${column.name} » ? Ses tâches repartent dans « À faire ».`)) return;
    await run(`column:${column.id}`, () => api(`/api/todos/columns/${encodeURIComponent(column.id)}`, { method: "DELETE" }));
  }

  async function toggleCorrection() {
    const next = !correction;
    setCorrection(next);
    await run("correction", () => api("/api/todos/settings", { method: "PATCH", body: JSON.stringify({ correction: next }) }));
  }

  function toggleColumn(column) {
    setCollapsedColumns((current) => {
      const next = { ...current, [column.id]: !current[column.id] };
      try { localStorage.setItem(profileCacheKey("todo-collapsed-columns"), JSON.stringify(next)); } catch { /* stockage optionnel */ }
      return next;
    });
  }

  async function shiftColumn(column, offset) {
    const order = columns.map((item) => item.id);
    const index = order.indexOf(column.id);
    const target = index + offset;
    if (index === -1 || target < 0 || target >= order.length) return;
    order.splice(target, 0, ...order.splice(index, 1));
    setColumns(order.map((id) => columns.find((item) => item.id === id)));
    await run(`column:${column.id}`, () => api("/api/todos/columns/order", { method: "PATCH", body: JSON.stringify({ ids: order }) }));
  }

  // Un dossier a la fois: la page liste les dossiers, le clic ouvre son contenu.
  function selectFolder(id) {
    setOpenFolder(id);
    setDatePanel(null);
    setFilterTab("all");
    setAddingInColumn(null);
    setColumnText("");
    try {
      if (id) localStorage.setItem(profileCacheKey("todo-folder"), id);
      else localStorage.removeItem(profileCacheKey("todo-folder"));
    } catch { /* stockage optionnel */ }
  }

  function switchViewMode(mode) {
    setViewMode(mode);
    try {
      localStorage.setItem(profileCacheKey("todo-view-mode"), mode);
    } catch { /* stockage optionnel */ }
  }

  async function createFolder() {
    const name = window.prompt("Nom du dossier ?");
    if (!name?.trim()) return;
    await run("folder", () => api("/api/todos/folders", { method: "POST", body: JSON.stringify({ name }) }));
  }

  async function renameFolder(folder) {
    const name = window.prompt("Nouveau nom du dossier ?", folder.name);
    if (!name?.trim() || name === folder.name) return;
    await run(folder.id, () => api(`/api/todos/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }));
  }

  async function removeFolder(folder) {
    if (!window.confirm(`Supprimer dossier « ${folder.name} » ? Les tâches repartent hors dossier.`)) return;
    await run(folder.id, () => api(`/api/todos/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }));
  }

  // Les projets ouvrent la liste, les dossiers libres suivent, le hors-dossier ferme la marche.
  const sections = useMemo(() => {
    const rank = (folder) => folder.projectId ? 0 : folder.id === ROOT_FOLDER ? 2 : 1;
    return [...folders]
      .sort((a, b) => rank(a) - rank(b))
      .map((folder) => ({ folder, items: todos.filter((todo) => (todo.folderId || ROOT_FOLDER) === folder.id) }))
      .filter((section) => section.folder.id !== ROOT_FOLDER || section.items.length);
  }, [folders, todos]);

  // Glisser-deposer: on reordonne localement avec hysteresis sans jitter, on confirme au relachement.
  function startDrag(event, todo, items) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      id: todo.id,
      folderId: todo.folderId || ROOT_FOLDER,
      items,
      startIndex: items.findIndex((item) => item.id === todo.id),
      targetIndex: items.findIndex((item) => item.id === todo.id),
      startY: event.clientY,
      lastHysteresisY: event.clientY,
    };
    setDragging(todo.id);
  }

  function dragOver(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaY = event.clientY - drag.lastHysteresisY;
    const HYSTERESIS_THRESHOLD = 18;
    if (Math.abs(deltaY) < HYSTERESIS_THRESHOLD) return;
    let nextIndex = drag.targetIndex;
    for (let index = 0; index < drag.items.length; index += 1) {
      const node = rowRefs.current.get(drag.items[index].id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (event.clientY >= rect.top && event.clientY <= rect.bottom) {
        nextIndex = index;
        break;
      }
    }
    if (nextIndex !== drag.targetIndex) {
      drag.targetIndex = nextIndex;
      drag.lastHysteresisY = event.clientY;
    }
  }

  async function endDrag(event) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging("");
    event.currentTarget.releasePointerCapture?.(drag.pointerId);
    if (drag.targetIndex === drag.startIndex) return;

    const source = drag.items[drag.startIndex];
    const isDone = source.status === "done" || source.completed;
    const target = drag.items[drag.targetIndex];
    let beforeId = drag.targetIndex > drag.startIndex ? drag.items[drag.targetIndex + 1]?.id || null : target?.id || null;

    if (!beforeId && !isDone) {
      const activeDone = todos.filter((t) => (t.folderId || ROOT_FOLDER) === (drag.folderId || ROOT_FOLDER) && (t.completed || t.status === "done"));
      if (activeDone.length > 0) {
        beforeId = activeDone[0].id;
      }
    }

    await run(drag.id, () => api(`/api/todos/${encodeURIComponent(drag.id)}/move`, { method: "POST", body: JSON.stringify({ beforeId }) }));
  }

  function handleBoardDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function handleBoardDrop(event, targetStatus) {
    event.preventDefault();
    const todoId = event.dataTransfer.getData("text/plain");
    if (!todoId) return;
    const targetTodo = todos.find((t) => t.id === todoId);
    if (!targetTodo) return;
    const currentStatus = targetTodo.status || (targetTodo.completed ? "done" : "todo");
    if (currentStatus !== targetStatus) {
      update(targetTodo, { status: targetStatus });
    }
  }

  function renderBoardCard(todo, currentColumn) {
    const columnIndex = columns.findIndex((item) => item.id === currentColumn);
    const column = columns[columnIndex] || columns[0];
    const previousColumn = columns[columnIndex - 1] || null;
    const nextColumn = columns[columnIndex + 1] || null;
    const isDone = column?.kind === "done";
    const isReview = column?.kind === "review";
    const overdue = todo.dueDate && todo.dueDate < localIsoDate() && !isDone;
    const commentsCount = todo.comments?.length || 0;
    const commentsOpen = !!openComments[todo.id];
    const expanded = !!expandedCards[todo.id];
    const overflows = !!overflowCards[todo.id];
    const folderObj = folders.find((f) => f.id === (todo.folderId || ROOT_FOLDER));
    const reference = todoRef(todo.id);

    return (
      <div
        key={todo.id}
        className={`todo-board-card ${isDone ? "completed" : ""} ${isReview ? "in-review" : ""} ${expanded ? "expanded" : ""}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", todo.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <div
          className="todo-card-top"
          onClick={() => { if (overflows || expanded) setExpandedCards((prev) => ({ ...prev, [todo.id]: !prev[todo.id] })); }}
        >
          <button
            type="button"
            className={`todo-tri-box status-${column?.kind || "custom"}`}
            onClick={(event) => { event.stopPropagation(); update(todo, { status: (columns[(columnIndex + 1) % columns.length] || columns[0]).id }); }}
            disabled={busy === todo.id}
            title={`${column?.name || "Zone"} — cliquer pour : ${(columns[(columnIndex + 1) % columns.length] || columns[0])?.name}`}
          >
            {isDone && <span className="todo-tri-icon done-check">✓</span>}
            {isReview && <span className="todo-tri-icon review-bar" />}
          </button>
          <div className="todo-card-text">
            <TodoInlineText
              text={todo.text}
              expanded={expanded}
              onOverflow={(value) => noteOverflow(todo.id, value)}
              onSave={(newText) => update(todo, { text: newText })}
              disabled={busy === todo.id}
            />
          </div>
          {(overflows || expanded) && (
            <button
              type="button"
              className="todo-card-expand"
              onClick={(event) => { event.stopPropagation(); setExpandedCards((prev) => ({ ...prev, [todo.id]: !prev[todo.id] })); }}
              title={expanded ? "Replier le texte" : "Déplier le texte"}
              aria-label={expanded ? "Replier le texte" : "Déplier le texte"}
            >{expanded ? "⌃" : "⌄"}</button>
          )}
        </div>

        <div className="todo-card-meta">
          <div className="todo-card-pills">
            <button
              type="button"
              className="todo-ref-pill"
              onClick={() => writeClipboard(reference)}
              title={`Référence ${reference} — cliquer pour copier (utilisable dans un prompt d'agent)`}
            >{reference}</button>
            <button
              className={`todo-date-pill ${overdue ? "overdue" : ""} ${todo.dueDate ? "" : "empty"} ${datePanel === todo.id ? "active" : ""}`}
              onClick={() => setDatePanel((c) => (c === todo.id ? null : todo.id))}
              disabled={busy === todo.id}
              title={todo.dueDate ? `Date limite ${todo.dueDate}` : "Ajouter une date limite"}
            >
              {todo.dueDate ? todo.dueDate.slice(5).split("-").reverse().join("/") : "📅"}
            </button>
            {todo.unread > 0 && (
              <button
                type="button"
                className="todo-unread-pill"
                onClick={() => markSeen(todo.id)}
                title={`${todo.unread} nouveauté${todo.unread > 1 ? "s" : ""} depuis ta dernière lecture — cliquer pour marquer comme lu`}
              >● {todo.unread}</button>
            )}
            {openFolder === "all" && folderObj && (
              <span className="todo-folder-pill" title={`Dossier : ${folderObj.name}`}>{folderObj.name}</span>
            )}
          </div>

          <div className="todo-card-shift-actions">
            <button
              className={`todo-comments-trigger ${commentsCount > 0 ? "has-comments" : ""} ${commentsOpen ? "active" : ""}`}
              onClick={() => {
                setOpenComments((prev) => ({ ...prev, [todo.id]: !prev[todo.id] }));
                if (todo.unread) markSeen(todo.id);
              }}
              title={`Commentaires (${commentsCount})`}
            >
              💬{commentsCount > 0 ? ` ${commentsCount}` : ""}
            </button>
            <button
              type="button"
              className="todo-shift-btn"
              onClick={() => previousColumn && update(todo, { status: previousColumn.id })}
              disabled={!previousColumn || busy === todo.id}
              title={previousColumn ? `Déplacer vers : ${previousColumn.name}` : "Première zone"}
            >‹</button>
            <button
              type="button"
              className="todo-shift-btn"
              onClick={() => nextColumn && update(todo, { status: nextColumn.id })}
              disabled={!nextColumn || busy === todo.id}
              title={nextColumn ? `Déplacer vers : ${nextColumn.name}` : "Dernière zone"}
            >›</button>
            <details className="todo-card-menu">
              <summary title="Actions sur la tâche">⋯</summary>
              <div className="todo-card-menu-panel">
                {(overflows || expanded) && <button onClick={() => setExpandedCards((prev) => ({ ...prev, [todo.id]: !prev[todo.id] }))}>{expanded ? "Replier le texte" : "Déplier le texte"}</button>}
                <button onClick={() => setDatePanel((c) => (c === todo.id ? null : todo.id))}>{todo.dueDate ? "Modifier la date" : "Ajouter une date"}</button>
                <label className="todo-card-menu-move">
                  <span>Déplacer vers</span>
                  <select
                    value={todo.folderId || ROOT_FOLDER}
                    onChange={(event) => update(todo, { folderId: event.target.value })}
                    disabled={busy === todo.id}
                    aria-label="Déplacer la tâche vers un autre projet ou dossier"
                  >
                    {folders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <button className="danger" onClick={() => removeTodo(todo)} disabled={busy === `del:${todo.id}`}>Supprimer la tâche</button>
              </div>
            </details>
          </div>
        </div>

        {datePanel === todo.id && (
          <div className="todo-date-popover">
            <button type="button" onClick={async () => { await update(todo, { dueDate: localIsoDate() }); setDatePanel(null); }}>Auj.</button>
            <button type="button" onClick={async () => { await update(todo, { dueDate: shiftIsoDate(1) }); setDatePanel(null); }}>Demain</button>
            <button type="button" onClick={async () => { await update(todo, { dueDate: shiftIsoDate(7) }); setDatePanel(null); }}>+7 j</button>
            <input
              type="date"
              value={todo.dueDate || ""}
              onChange={async (event) => { await update(todo, { dueDate: event.target.value || null }); setDatePanel(null); }}
              disabled={busy === todo.id}
              aria-label="Date limite"
            />
            <button
              type="button"
              className="clear"
              onClick={async () => { await update(todo, { dueDate: null }); setDatePanel(null); }}
              disabled={busy === todo.id || !todo.dueDate}
              title="Effacer la date"
            >×</button>
          </div>
        )}

        {commentsOpen && (
          <div className="todo-comments-panel">
            <div className="todo-comments-header">
              <strong>Commentaires ({commentsCount})</strong>
              <small>Discussions et notes illimitées</small>
            </div>
            <div className="todo-comments-list">
              {todo.comments && todo.comments.map((comment) => (
                <div className="todo-comment-item" key={comment.id}>
                  <div className="todo-comment-meta">
                    {comment.author && <strong className={`todo-comment-author ${comment.kind === "agent" ? "agent" : ""}`}>{comment.kind === "agent" ? `IA · ${comment.author}` : comment.author}</strong>}
                    <span className="todo-comment-time">{formatCommentDate(comment.createdAt)}</span>
                    <button
                      className="todo-comment-delete"
                      onClick={() => removeComment(todo, comment.id)}
                      disabled={busy === `comment-del:${comment.id}`}
                      title="Supprimer ce commentaire"
                    >×</button>
                  </div>
                  <p className="todo-comment-text">{comment.text}</p>
                </div>
              ))}
              {(!todo.comments || !todo.comments.length) && (
                <p className="todo-comments-empty">Aucun commentaire pour le moment.</p>
              )}
            </div>
            <form className="todo-comment-form" onSubmit={(e) => addComment(todo, e)}>
              <input
                value={newComment[todo.id] || ""}
                onChange={(e) => setNewComment({ ...newComment, [todo.id]: e.target.value })}
                placeholder="Ajouter un commentaire ou une note…"
                maxLength="2000"
              />
              <button className="primary" disabled={busy === `comment:${todo.id}` || !(newComment[todo.id] || "").trim()}>
                {busy === `comment:${todo.id}` ? "…" : "Commenter"}
              </button>
            </form>
          </div>
        )}
      </div>
    );
  }

  function folderRow(todo, items) {
    const status = todo.status || (todo.completed ? "done" : "todo");
    const isDone = status === "done";
    const isReview = status === "review";
    const overdue = todo.dueDate && todo.dueDate < localIsoDate() && !isDone;
    const commentsCount = todo.comments?.length || 0;
    const commentsOpen = !!openComments[todo.id];

    function cycleStatus() {
      const next = status === "todo" ? "review" : status === "review" ? "done" : "todo";
      update(todo, { status: next });
    }

    return (
      <React.Fragment key={todo.id}>
        <article
          className={`${isDone ? "completed" : ""} ${isReview ? "in-review" : ""} ${dragging === todo.id ? "dragging" : ""}`}
          ref={(node) => { if (node) rowRefs.current.set(todo.id, node); else rowRefs.current.delete(todo.id); }}
        >
          <button
            className="todo-drag"
            onPointerDown={(event) => startDrag(event, todo, items)}
            onPointerMove={dragOver}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            aria-label={`Déplacer ${todo.text}`}
          >⠿</button>
          <div className="todo-item-main">
            <button
              type="button"
              className={`todo-tri-box status-${status}`}
              onClick={cycleStatus}
              disabled={busy === todo.id}
              title={
                status === "todo" ? "À faire (cliquer pour : À vérifier / tester)" :
                status === "review" ? "À vérifier (cliquer pour : Terminée)" :
                "Terminée (cliquer pour : À faire)"
              }
              aria-label={`Changer état de ${todo.text}`}
            >
              {isDone && <span className="todo-tri-icon done-check">✓</span>}
              {isReview && <span className="todo-tri-icon review-bar" />}
            </button>
            <div className="todo-text-group">
              <TodoInlineText
                text={todo.text}
                onSave={(newText) => update(todo, { text: newText })}
                disabled={busy === todo.id}
              />
              <small className={overdue ? "overdue" : isReview ? "status-review-label" : ""}>
                {isDone ? completedLabel(todo.completedAt) || "Terminée" : isReview ? "◐ À vérifier / tester" : todoDueLabel(todo.dueDate)}
              </small>
            </div>
          </div>
          <div className="todo-actions">
            <button
              className={`todo-comments-trigger ${commentsCount > 0 ? "has-comments" : ""} ${commentsOpen ? "active" : ""}`}
              onClick={() => {
                setOpenComments((prev) => ({ ...prev, [todo.id]: !prev[todo.id] }));
                if (todo.unread) markSeen(todo.id);
              }}
              title={`Commentaires (${commentsCount})`}
            >
              💬{commentsCount > 0 ? ` ${commentsCount}` : ""}
            </button>
            {todo.unread > 0 && <button type="button" className="todo-unread-pill" onClick={() => markSeen(todo.id)} title="Marquer comme lu">● {todo.unread}</button>}
            <button className={todo.dueDate ? "todo-date-trigger dated" : "todo-date-trigger"} onClick={() => setDatePanel((current) => current === todo.id ? null : todo.id)} disabled={busy === todo.id} aria-label="Modifier date limite"><span aria-hidden="true">▣</span>{todo.dueDate ? todo.dueDate.slice(5).split("-").reverse().join("/") : "Date"}</button>
            <select value={todo.folderId || ROOT_FOLDER} onChange={(event) => update(todo, { folderId: event.target.value })} disabled={busy === todo.id} aria-label="Dossier">{folders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
            <button className="todo-ref-pill" onClick={() => writeClipboard(todoRef(todo.id))} title={`Référence ${todoRef(todo.id)} — cliquer pour copier`}>{todoRef(todo.id)}</button>
            <button className="todo-card-delete" onClick={() => removeTodo(todo)} disabled={busy === `del:${todo.id}`} title="Supprimer la tâche" aria-label="Supprimer la tâche">🗑</button>
          </div>
          {datePanel === todo.id && <div className="todo-inline-panel todo-date-panel"><span>Date limite</span><input type="date" value={todo.dueDate || ""} onChange={async (event) => { await update(todo, { dueDate: event.target.value || null }); setDatePanel(null); }} disabled={busy === todo.id} /><button onClick={async () => { await update(todo, { dueDate: null }); setDatePanel(null); }} disabled={busy === todo.id || !todo.dueDate}>Effacer</button></div>}
        </article>
        {commentsOpen && (
          <div className="todo-comments-panel">
            <div className="todo-comments-header">
              <strong>Commentaires ({commentsCount})</strong>
              <small>Discussions et notes illimitées</small>
            </div>
            <div className="todo-comments-list">
              {todo.comments && todo.comments.map((comment) => (
                <div className="todo-comment-item" key={comment.id}>
                  <div className="todo-comment-meta">
                    {comment.author && <strong className={`todo-comment-author ${comment.kind === "agent" ? "agent" : ""}`}>{comment.kind === "agent" ? `IA · ${comment.author}` : comment.author}</strong>}
                    <span className="todo-comment-time">{formatCommentDate(comment.createdAt)}</span>
                    <button
                      className="todo-comment-delete"
                      onClick={() => removeComment(todo, comment.id)}
                      disabled={busy === `comment-del:${comment.id}`}
                      title="Supprimer ce commentaire"
                    >×</button>
                  </div>
                  <p className="todo-comment-text">{comment.text}</p>
                </div>
              ))}
              {(!todo.comments || !todo.comments.length) && (
                <p className="todo-comments-empty">Aucun commentaire pour le moment.</p>
              )}
            </div>
            <form className="todo-comment-form" onSubmit={(e) => addComment(todo, e)}>
              <input
                value={newComment[todo.id] || ""}
                onChange={(e) => setNewComment({ ...newComment, [todo.id]: e.target.value })}
                placeholder="Ajouter un commentaire ou une note…"
                maxLength="2000"
              />
              <button className="primary" disabled={busy === `comment:${todo.id}` || !(newComment[todo.id] || "").trim()}>
                {busy === `comment:${todo.id}` ? "…" : "Commenter"}
              </button>
            </form>
          </div>
        )}
      </React.Fragment>
    );
  }

  const openCount = todos.filter((todo) => (todo.status || (todo.completed ? "done" : "todo")) === "todo").length;
  const reviewCount = todos.filter((todo) => todo.status === "review").length;
  const doneCount = todos.filter((todo) => (todo.status === "done" || todo.completed)).length;
  const globalUnread = todos.reduce((total, todo) => total + (todo.unread || 0), 0);
  const active = openFolder === "all"
    ? { folder: { id: "all", name: "Toutes les tâches" }, items: todos }
    : (sections.find((section) => section.folder.id === openFolder) || null);

  if (!active) {
    return (
      <div className="page todos-page">
        <section className="hero-row todos-hero">
          <div>
            <p className="eyebrow">OBSIDIAN · NAS</p>
            <h1>Todo.</h1>
            <p className="muted">
              {openCount} à faire
              {reviewCount > 0 ? ` · ${reviewCount} à vérifier` : ""}
              {doneCount > 0 ? ` · ${doneCount} terminée${doneCount > 1 ? "s" : ""}` : ""} · {storage}
            </p>
          </div>
          <div className="todo-hero-right">
            <div className="todo-view-switcher">
              <button
                type="button"
                className={viewMode === "board" ? "active" : ""}
                onClick={() => switchViewMode("board")}
                title="Vue Tableau Trello (3 colonnes)"
              >
                <span className="view-icon">⊞</span> Trello
              </button>
              <button
                type="button"
                className={viewMode === "classic" ? "active" : ""}
                onClick={() => switchViewMode("classic")}
                title="Vue Liste classique"
              >
                <span className="view-icon">📋</span> Classique
              </button>
            </div>
            <button
              type="button"
              className={`todo-correction-toggle ${correction ? "active" : ""}`}
              onClick={toggleCorrection}
              disabled={busy === "correction"}
              title={correction ? "Reformulation LLM active — cliquer pour désactiver" : "Reformulation LLM désactivée — cliquer pour activer"}
            >
              <span className="view-icon">✨</span> {correction ? "LLM on" : "LLM off"}
            </button>
            <button className="ghost" onClick={createFolder} disabled={busy === "folder"}>+ Dossier</button>
          </div>
        </section>
        {error && <p className="finance-error todo-error">{error}</p>}
        <section className="todo-folder-grid">
          <button className="panel todo-folder-card all-tasks" onClick={() => selectFolder("all")}>
            <span className="todo-folder-name">📁 Toutes les tâches{globalUnread > 0 && <b className="todo-unread-badge" title={`${globalUnread} changement${globalUnread > 1 ? "s" : ""} non lu${globalUnread > 1 ? "s" : ""}`}>{globalUnread}</b>}</span>
            <span className="todo-folder-meta">
              {openCount} à faire{reviewCount > 0 ? ` · ${reviewCount} à vérifier` : ""}{doneCount > 0 ? ` · ${doneCount} terminée${doneCount > 1 ? "s" : ""}` : ""}
            </span>
          </button>
          {sections.map(({ folder, items }) => {
            const folderTodos = items.filter((todo) => (todo.status || (todo.completed ? "done" : "todo")) === "todo");
            const folderReviews = items.filter((todo) => todo.status === "review");
            const folderDone = items.filter((todo) => todo.status === "done" || todo.completed);
            const late = folderTodos.filter((todo) => todo.dueDate && todo.dueDate < localIsoDate()).length;
            const folderUnread = items.reduce((total, todo) => total + (todo.unread || 0), 0);
            return (
              <button className="panel todo-folder-card" onClick={() => selectFolder(folder.id)} key={folder.id}>
                <span className="todo-folder-name">{folder.name || "Dossier"}{folderUnread > 0 && <b className="todo-unread-badge" title={`${folderUnread} changement${folderUnread > 1 ? "s" : ""} non lu${folderUnread > 1 ? "s" : ""}`}>{folderUnread}</b>}</span>
                <span className="todo-folder-meta">
                  {folderTodos.length ? `${folderTodos.length} à faire` : "0 à faire"}
                  {folderReviews.length ? ` · ${folderReviews.length} à vérifier` : ""}
                  {folderDone.length ? ` · ${folderDone.length} terminée${folderDone.length > 1 ? "s" : ""}` : ""}
                  {late ? ` · ${late} en retard` : ""}
                </span>
                {(folder.projectId || folder.ownerProfileId) && (
                  <span className="todo-folder-badges">
                    {folder.projectId && <b className="todo-folder-tag">PROJET</b>}
                    {folder.ownerProfileId && <b className="shared-chip">⇄ {folder.ownerName}</b>}
                  </span>
                )}
              </button>
            );
          })}
          {!sections.length && !error && <p className="finance-empty">Aucune tâche. Liste Obsidian vide.</p>}
        </section>
      </div>
    );
  }

  const { folder, items } = active;
  const boardUnread = items.reduce((total, todo) => total + (todo.unread || 0), 0);
  const todoItems = inColumn(items, "todo");
  const reviewItems = items.filter((todo) => statusOf(todo) === "review");
  const doneItems = items.filter((todo) => statusOf(todo) === "done" || todo.completed);

  const displayedItems = filterTab === "todo" ? todoItems
    : filterTab === "review" ? reviewItems
    : filterTab === "done" ? doneItems
    : items;

  const openList = displayedItems.filter((t) => t.status !== "done" && !t.completed);
  const doneList = displayedItems.filter((t) => t.status === "done" || t.completed);

  return (
    <div className="page todos-page">
      <section className="hero-row todos-hero">
        <div>
          <button className="todo-back" onClick={() => selectFolder(null)}>‹ Tous les dossiers</button>
          <h1>{folder.name}</h1>
          <p className="muted">
            {todoItems.length} à faire
            {reviewItems.length ? ` · ${reviewItems.length} à vérifier` : ""}
            {doneItems.length ? ` · ${doneItems.length} terminée${doneItems.length > 1 ? "s" : ""}` : ""}
          </p>
        </div>
        <div className="todo-hero-right">
          <div className="todo-view-switcher">
            <button
              type="button"
              className={viewMode === "board" ? "active" : ""}
              onClick={() => switchViewMode("board")}
              title="Vue Tableau Trello (3 colonnes)"
            >
              <span className="view-icon">⊞</span> Trello
            </button>
            <button
              type="button"
              className={viewMode === "classic" ? "active" : ""}
              onClick={() => switchViewMode("classic")}
              title="Vue Liste classique"
            >
              <span className="view-icon">📋</span> Classique
            </button>
          </div>
          <button
            type="button"
            className={`todo-correction-toggle ${correction ? "active" : ""}`}
            onClick={toggleCorrection}
            disabled={busy === "correction"}
            title={correction ? "Reformulation LLM active à la création d'un to-do ou d'un commentaire — cliquer pour désactiver" : "Reformulation LLM désactivée — cliquer pour activer"}
          >
            <span className="view-icon">✨</span> {correction ? "LLM on" : "LLM off"}
          </button>
          {!folder.projectId && folder.id !== ROOT_FOLDER && folder.id !== "all" && (
            <div className="todo-folder-actions">
              <button onClick={() => renameFolder(folder)} disabled={busy === folder.id} aria-label={`Renommer ${folder.name}`}>Renommer</button>
              <button onClick={() => removeFolder(folder)} disabled={busy === folder.id} aria-label={`Supprimer ${folder.name}`}>Supprimer</button>
            </div>
          )}
        </div>
      </section>

      <form className="panel todo-add" onSubmit={add}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={`Ajouter dans ${folder.name}…`} maxLength="300" />
        <button className="primary" disabled={busy === "new" || !text.trim()}>{busy === "new" ? "…" : "Ajouter"}</button>
      </form>

      {error && <p className="finance-error todo-error">{error}</p>}

      {viewMode === "board" ? (
        <div className="todo-board-wrap">
          <div className="todo-board-toolbar">
            <small>
              {columns.length} zone{columns.length > 1 ? "s" : ""} · {items.length} tâche{items.length > 1 ? "s" : ""}
              {boardUnread > 0 && <b className="todo-unread-inline"> · {boardUnread} non lu{boardUnread > 1 ? "s" : ""}</b>}
            </small>
            {boardUnread > 0 && <button className="todo-mark-seen-btn" onClick={() => markSeen(items.filter((todo) => todo.unread).map((todo) => todo.id))} title="Marquer toutes les nouveautés comme lues">Tout lu</button>}
            <button className="todo-add-column-btn" onClick={addColumn} disabled={busy === "column"} title="Ajouter une zone" aria-label="Ajouter une zone">＋</button>
          </div>
          <div className="todo-board">
            {columns.map((column, index) => {
              const columnItems = inColumn(items, column.id);
              const renaming = renamingColumn === column.id;
              const collapsed = !!collapsedColumns[column.id];
              if (collapsed) {
                return (
                  <button
                    key={column.id}
                    className={`todo-board-column collapsed column-${column.kind}`}
                    onClick={() => toggleColumn(column)}
                    onDragOver={handleBoardDragOver}
                    onDrop={(e) => handleBoardDrop(e, column.id)}
                    title={`Déplier ${column.name}`}
                  >
                    <span className="todo-column-count">{columnItems.length}</span>
                    <span className="todo-collapsed-title">{column.name}</span>
                    <span className="todo-collapsed-chevron">›</span>
                  </button>
                );
              }
              return (
                <div
                  className={`todo-board-column column-${column.kind} ${column.kind === "done" ? "muted" : ""}`}
                  key={column.id}
                  onDragOver={handleBoardDragOver}
                  onDrop={(e) => handleBoardDrop(e, column.id)}
                >
                  <header className="todo-column-header">
                    <div className="todo-column-title">
                      <button className="todo-column-fold" onClick={() => toggleColumn(column)} title={`Replier ${column.name}`} aria-label={`Replier ${column.name}`}>⌄</button>
                      {renaming ? (
                        <input
                          autoFocus
                          className="todo-column-rename"
                          defaultValue={column.name}
                          onBlur={(e) => renameColumn(column, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.target.blur();
                            if (e.key === "Escape") setRenamingColumn(null);
                          }}
                          aria-label="Renommer la zone"
                        />
                      ) : (
                        <h3 onDoubleClick={() => setRenamingColumn(column.id)} title="Double-clic pour renommer">{column.name}</h3>
                      )}
                      <span className="todo-column-count">{columnItems.length}</span>
                    </div>
                    <div className="todo-column-tools">
                      {column.kind !== "done" && (
                        <button className="todo-column-add-btn" onClick={() => setAddingInColumn((c) => (c === column.id ? null : column.id))} title={`Ajouter une tâche dans ${column.name}`}>+</button>
                      )}
                      <details className="todo-column-menu">
                        <summary title="Options de la zone">⋯</summary>
                        <div className="todo-column-menu-panel">
                          <button onClick={() => setRenamingColumn(column.id)}>Renommer</button>
                          <button onClick={() => shiftColumn(column, -1)} disabled={index === 0}>Déplacer à gauche</button>
                          <button onClick={() => shiftColumn(column, 1)} disabled={index === columns.length - 1}>Déplacer à droite</button>
                          {column.kind === "custom" && <button className="danger" onClick={() => removeColumn(column)}>Supprimer la zone</button>}
                        </div>
                      </details>
                    </div>
                  </header>
                  {addingInColumn === column.id && (
                    <form className="todo-board-quick-add" onSubmit={(e) => addWithStatus(e, column.id)}>
                      <input
                        autoFocus
                        value={columnText}
                        onChange={(e) => setColumnText(e.target.value)}
                        placeholder={`Nouvelle tâche · ${column.name}…`}
                        onKeyDown={(e) => { if (e.key === "Escape") setAddingInColumn(null); }}
                      />
                      <div className="quick-add-actions">
                        <button type="submit" className="primary" disabled={!columnText.trim()}>Ajouter</button>
                        <button type="button" className="ghost" onClick={() => setAddingInColumn(null)}>Annuler</button>
                      </div>
                    </form>
                  )}
                  <div className="todo-column-cards">
                    {columnItems.map((todo) => renderBoardCard(todo, column.id))}
                    {!columnItems.length && addingInColumn !== column.id && <p className="todo-column-empty">Aucune tâche</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="todo-filter-tabs">
            <button className={filterTab === "all" ? "active" : ""} onClick={() => setFilterTab("all")}>Toutes ({items.length})</button>
            <button className={filterTab === "todo" ? "active" : ""} onClick={() => setFilterTab("todo")}>À faire ({todoItems.length})</button>
            <button className={filterTab === "review" ? "active" : ""} onClick={() => setFilterTab("review")}>À vérifier / tester ({reviewItems.length})</button>
            <button className={filterTab === "done" ? "active" : ""} onClick={() => setFilterTab("done")}>Terminées ({doneItems.length})</button>
          </div>
          <section className="panel todo-list">
            {openList.map((todo) => folderRow(todo, openList))}
            {!openList.length && !doneList.length && <p className="finance-empty">Aucune tâche dans cette vue.</p>}
            {doneList.length > 0 && (
              <>
                <button className="todo-done-toggle" onClick={() => setShowDone((current) => ({ ...current, [folder.id]: !current[folder.id] }))}>
                  {showDone[folder.id] ? "▾" : "▸"} {doneList.length} terminée{doneList.length > 1 ? "s" : ""}
                </button>
                {showDone[folder.id] && doneList.map((todo) => folderRow(todo, doneList))}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ProfilesSettings({ profiles, profileId, onSwitch, onChanged }) {
  const active = profiles.find((item) => item.id === profileId);
  const [name, setName] = useState(active?.name || "");
  const [theme, setTheme] = useState(active?.theme || "noyau");
  const [todoFile, setTodoFile] = useState(active?.todoFile || "");
  const [todoMountUri, setTodoMountUri] = useState(active?.todoMountUri || "");
  const [newName, setNewName] = useState("");
  const [newTheme, setNewTheme] = useState("aurora");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(task) {
    setBusy(true);
    setError("");
    try {
      await task();
      await onChanged();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(async () => {
    const result = await api(`/api/profiles/${encodeURIComponent(profileId)}`, { method: "PATCH", body: JSON.stringify({ name, theme, todoFile, todoMountUri: todoMountUri || null }) });
    applyTheme(result.profile.theme);
  });

  const create = () => run(async () => {
    await api("/api/profiles", { method: "POST", body: JSON.stringify({ name: newName, theme: newTheme }) });
    setNewName("");
  });

  const activeName = active?.name || "Profil";
  return (
    <>
      <section className="panel profiles-settings">
        <header className="panel-head"><div><strong>Profils</strong><small>Agents, projets, todo et budget séparés</small></div></header>
        <div className="profiles-grid">
          {profiles.map((item) => (
            <button className={item.id === profileId ? "active" : ""} onClick={() => onSwitch(item.id)} key={item.id}>
              <strong>{item.name}</strong>
              <small>{THEMES[item.theme]?.label || item.theme}{item.primary ? " · principal" : ""}</small>
              <em>{item.id === profileId ? "Profil actif" : "Basculer"}</em>
            </button>
          ))}
        </div>
        {error && <p className="form-error">{error}</p>}
      </section>
      <details className="panel foldable settings-fold">
        <summary className="panel-head"><div><h3>Réglages de {activeName}</h3><p>Nom, thème, fichier Todo Obsidian</p></div><i>›</i></summary>
        <div className="profile-form">
          <label htmlFor="profile-name">Nom du profil</label>
          <input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} />
          <label htmlFor="profile-theme">Thème</label>
          <select id="profile-theme" value={theme} onChange={(event) => setTheme(event.target.value)}>{Object.entries(THEMES).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select>
          <label htmlFor="profile-todo">Fichier Todo Obsidian</label>
          <input id="profile-todo" value={todoFile} onChange={(event) => setTodoFile(event.target.value)} placeholder="/chemin/absolu/TO DO.md" />
          <label htmlFor="profile-mount">Montage SMB (optionnel)</label>
          <input id="profile-mount" value={todoMountUri} onChange={(event) => setTodoMountUri(event.target.value)} placeholder="smb://nas/partage" />
          <div className="modal-actions"><button className="primary" onClick={save} disabled={busy}>{busy ? "Application…" : "Enregistrer"}</button></div>
        </div>
      </details>
      <details className="panel foldable settings-fold">
        <summary className="panel-head"><div><h3>Nouveau profil</h3><p>Son propre espace et son propre thème</p></div><i>›</i></summary>
        <div className="profile-form">
          <label htmlFor="profile-new">Prénom</label>
          <input id="profile-new" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Prénom" />
          <label htmlFor="profile-new-theme">Thème</label>
          <select id="profile-new-theme" value={newTheme} onChange={(event) => setNewTheme(event.target.value)}>{Object.entries(THEMES).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select>
          <div className="modal-actions"><button className="ghost" onClick={create} disabled={busy || !newName.trim()}>Créer le profil</button></div>
        </div>
      </details>
    </>
  );
}

function SettingsView({ permission, onNotifications, onRefresh, onView, profiles, profileId, onSwitchProfile, onProfilesChanged }) {
  const [refreshing, setRefreshing] = useState(false);
  const [versionInfo, setVersionInfo] = useState(null);
  const [osk, setOsk] = useState(oskMode);
  const [confirmMode, setConfirmMode] = useState(() => {
    try { return localStorage.getItem(CONFIRM_KEY) || "on"; } catch { return "on"; }
  });

  const activeProfile = profiles.find((item) => item.id === profileId) || profiles[0];
  const quotaNotify = activeProfile?.quotaResetNotify || { codex: true, claude: true, antigravity: false };

  async function toggleQuotaReset(providerKey) {
    const current = quotaNotify;
    const next = { ...current, [providerKey]: !current[providerKey] };
    try {
      await api(`/api/profiles/${encodeURIComponent(profileId || activeProfile?.id || "principal")}`, {
        method: "PATCH",
        body: JSON.stringify({ quotaResetNotify: next }),
      });
      if (onProfilesChanged) await onProfilesChanged();
    } catch (error) {
      window.alert(`Erreur mise à jour réglages: ${error.message}`);
    }
  }

  function chooseConfirm(value) {
    setConfirmMode(value);
    try { localStorage.setItem(CONFIRM_KEY, value); } catch { /* stockage optionnel */ }
  }

  function chooseOsk(value) {
    setOsk(value);
    try {
      localStorage.setItem(OSK_KEY, value);
      if (value === "always") localStorage.removeItem(PHYSICAL_KEY);
    } catch { /* stockage optionnel */ }
  }
  const notificationLabel = { active: "Tester notification", insecure: "HTTPS requis", denied: "Alertes bloquées" }[permission] || "Activer alertes";
  useEffect(() => {
    fetch("/version.json", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then(setVersionInfo).catch(() => {});
  }, []);
  async function refreshApp() {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  }
  return (
    <div className="page settings-page">
      <section className="hero-row"><div><p className="eyebrow">APPLICATION</p><h1>Réglages.</h1><p className="muted">Alertes et accès appareil.</p></div></section>
      <section className="panel settings-list">
        <article><span className="setting-symbol">◉</span><div><strong>Notifications agents</strong><small>Fin réponse, attente validation, migration terminée.</small></div><button className={`ghost ${permission === "active" ? "active" : ""}`} onClick={onNotifications}>{notificationLabel}</button></article>
        <article>
          <span className="setting-symbol">⚡</span>
          <div>
            <strong>Alertes reset quotas</strong>
            <small>Notification push dès qu'un quota se réinitialise.</small>
          </div>
          <div className="quota-reset-toggles">
            <button
              type="button"
              className={`quota-toggle-btn ${quotaNotify.codex ? "active" : ""}`}
              onClick={() => toggleQuotaReset("codex")}
              title="Alerte reset pour Codex"
            >
              Codex <b>{quotaNotify.codex ? "ON" : "OFF"}</b>
            </button>
            <button
              type="button"
              className={`quota-toggle-btn ${quotaNotify.claude ? "active" : ""}`}
              onClick={() => toggleQuotaReset("claude")}
              title="Alerte reset pour Claude"
            >
              Claude <b>{quotaNotify.claude ? "ON" : "OFF"}</b>
            </button>
            <button
              type="button"
              className={`quota-toggle-btn ${quotaNotify.antigravity ? "active" : ""}`}
              onClick={() => toggleQuotaReset("antigravity")}
              title="Alerte reset pour Antigravity"
            >
              Antigravity <b>{quotaNotify.antigravity ? "ON" : "OFF"}</b>
            </button>
          </div>
        </article>
        <article><span className="setting-symbol update-symbol"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.2M20 5v6h-6" /></svg></span><div><strong>Mise à jour interface</strong><small>{versionInfo ? `Version ${versionInfo.version} · build ${versionInfo.build}` : "Lecture version…"}</small></div><button className="ghost" onClick={refreshApp} disabled={refreshing}>{refreshing ? "Actualisation…" : "Recharger dernière version"}</button></article>
        <article><span className="setting-symbol">⌁</span><div><strong>Connexions bancaires</strong><small>Enable Banking: application ID, URL de retour, clé privée, banques liées.</small></div><button className="ghost" onClick={() => onView("finance-banking")}>Ouvrir réglages</button></article>
        <article className="setting-select-row"><span className="setting-symbol">✓</span><div><strong>Confirmations</strong><small>{confirmMode === "off" ? "Redémarrage et changement de fournisseur immédiats" : "Demandées avant redémarrage et changement de fournisseur"} · suppressions toujours confirmées</small></div><select className="setting-select" value={confirmMode} onChange={(event) => chooseConfirm(event.target.value)} aria-label="Confirmations"><option value="on">Demander</option><option value="off">Sans confirmation</option></select></article>
        <article className="setting-select-row"><span className="setting-symbol">⌨</span><div><strong>Clavier virtuel</strong><small>Réglage propre à cet appareil · {osk === "auto" ? (wantsOnScreenKeyboard() ? "ouvert au toucher ici" : "désactivé ici (clavier physique ou PC)") : osk === "always" ? "toujours ouvert au toucher" : "jamais ouvert"}</small></div><select className="setting-select" value={osk} onChange={(event) => chooseOsk(event.target.value)} aria-label="Clavier virtuel"><option value="auto">Automatique</option><option value="always">Toujours</option><option value="never">Jamais</option></select></article>
        <article><span className="setting-symbol">⌁</span><div><strong>Connexion privée</strong><small>{window.isSecureContext ? "HTTPS actif · notifications compatibles" : "Ouvre version HTTPS via VPN"}</small></div><b className={window.isSecureContext ? "setting-ok" : "setting-warn"}>{window.isSecureContext ? "ACTIF" : "REQUIS"}</b></article>
      </section>
      {profiles.length > 0 && <ProfilesSettings key={profileId} profiles={profiles} profileId={profileId} onSwitch={onSwitchProfile} onChanged={onProfilesChanged} />}
    </div>
  );
}

function TerminalView({ session, onBack, onKilled, onMigrated, onRefresh, quotas, assistants }) {
  const terminalNode = React.useRef(null);
  const terminalRef = React.useRef(null);
  const socketRef = React.useRef(null);
  const keyboardRef = React.useRef(null);
  const touchRef = React.useRef(null);
  const migrationRef = React.useRef(session.migrationState === "summarizing");
  const snapBottomRef = React.useRef(true);
  const ctrlRef = React.useRef(false);
  const altRef = React.useRef(false);
  const viewportRefreshRef = React.useRef(() => {});
  const tapRef = React.useRef(null);
  const tapDoneRef = React.useRef(0);
  const [connected, setConnected] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [todoPicker, setTodoPicker] = useState(false);
  const [todoDetail, setTodoDetail] = useState(null);
  const todoLinkRef = React.useRef(null);
  const [copiedLink, setCopiedLink] = useState(null);
  const snapshotRef = React.useRef(null);
  const [oskEnabled, setOskEnabled] = useState(wantsOnScreenKeyboard);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [migrating, setMigrating] = useState(session.migrationState === "summarizing");

  useEffect(() => {
    if (session.migrationState === "summarizing") migrationRef.current = true;
    setMigrating(session.migrationState === "summarizing");
    if (session.migrationState === "complete" && session.migratedTo && migrationRef.current) {
      migrationRef.current = false;
      onMigrated(session.migratedTo);
    }
    // Bascule en echec: le selecteur redevient utilisable au lieu de rester bloque.
    if (session.migrationState === "failed" && migrationRef.current) {
      migrationRef.current = false;
      setMigrating(false);
      if (session.migrationError) window.alert(`Bascule impossible: ${session.migrationError}`);
    }
  }, [session.migrationState, session.migratedTo, session.migrationError, onMigrated]);

  useEffect(() => {
    const viewport = window.visualViewport;
    document.documentElement.classList.add("terminal-open");
    document.body.classList.add("terminal-open");
    let timer = null;
    let baseHeight = Math.max(Math.floor(window.innerHeight), Math.floor(viewport?.height || 0));
    const applyHeight = () => {
      const rootStyle = document.documentElement.style;
      const inputFocused = document.activeElement === keyboardRef.current;
      const layoutHeight = Math.floor(window.innerHeight);
      const visibleHeight = Math.floor(viewport?.height || layoutHeight);
      if (!inputFocused) {
        baseHeight = Math.max(layoutHeight, visibleHeight);
        rootStyle.removeProperty("--terminal-height");
        rootStyle.removeProperty("--terminal-top");
        return;
      }
      const keyboardVisible = baseHeight - visibleHeight > 100;
      if (!keyboardVisible) {
        rootStyle.removeProperty("--terminal-height");
        rootStyle.removeProperty("--terminal-top");
        return;
      }
      rootStyle.setProperty("--terminal-height", `${visibleHeight}px`);
      rootStyle.setProperty("--terminal-top", `${Math.max(0, Math.floor(viewport?.offsetTop || 0))}px`);
    };
    const updateHeight = (immediate = false) => {
      clearTimeout(timer);
      if (immediate === true) applyHeight();
      else timer = setTimeout(applyHeight, 90);
    };
    viewportRefreshRef.current = updateHeight;
    const restoreViewport = () => {
      if (document.visibilityState === "hidden") return;
      keyboardRef.current?.blur();
      setKeyboardActive(false);
      document.documentElement.style.removeProperty("--terminal-height");
      document.documentElement.style.removeProperty("--terminal-top");
      baseHeight = Math.max(Math.floor(window.innerHeight), Math.floor(viewport?.height || 0));
      window.scrollTo(0, 0);
      requestAnimationFrame(() => updateHeight(true));
    };
    applyHeight();
    viewport?.addEventListener("resize", updateHeight);
    viewport?.addEventListener("scroll", updateHeight);
    window.addEventListener("resize", updateHeight);
    window.addEventListener("pageshow", restoreViewport);
    document.addEventListener("visibilitychange", restoreViewport);
    return () => {
      viewport?.removeEventListener("resize", updateHeight);
      viewport?.removeEventListener("scroll", updateHeight);
      window.removeEventListener("resize", updateHeight);
      window.removeEventListener("pageshow", restoreViewport);
      document.removeEventListener("visibilitychange", restoreViewport);
      clearTimeout(timer);
      viewportRefreshRef.current = () => {};
      document.documentElement.style.removeProperty("--terminal-height");
      document.documentElement.style.removeProperty("--terminal-top");
      document.documentElement.classList.remove("terminal-open");
      document.body.classList.remove("terminal-open");
    };
  }, []);

  useEffect(() => {
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    // Sans clavier virtuel, l'agent recoit les touches directement: pas de champ de capture cache.
    const touchTerminal = (TOUCH_MODE || coarsePointer) && oskEnabled;
    // Capture au niveau du document seulement la ou un clavier systeme peut surgir:
    // sur un poste souris-clavier, xterm garde sa saisie native, plus fiable.
    const captureMode = (TOUCH_MODE || coarsePointer) && !oskEnabled;
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: touchTerminal || captureMode,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      scrollback: touchTerminal ? 0 : 5000,
      // Les agents activent le suivi de souris: sans ces options, un clic part dans l'agent
      // au lieu de selectionner. Option+glisser (macOS) et clic droit reprennent la main.
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      altClickMovesCursor: false,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalNode.current);
    fit.fit();
    terminalRef.current = terminal;
    // Une reference *XXXX ecrite par l'agent s'ouvre comme un lien vers la tache.
    terminal.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const line = terminal.buffer.active.getLine(lineNumber - 1)?.translateToString(true) || "";
        const links = [];
        for (const match of line.matchAll(/\*[0-9A-Fa-f]{4}\b/g)) {
          const start = match.index + 1;
          links.push({
            range: { start: { x: start, y: lineNumber }, end: { x: start + match[0].length - 1, y: lineNumber } },
            text: match[0],
            activate: () => todoLinkRef.current?.(match[0].toUpperCase()),
          });
        }
        callback(links.length ? links : undefined);
      },
    });
    const xtermViewport = terminalNode.current.querySelector(".xterm-viewport");
    if (touchTerminal || captureMode) {
      const helper = terminalNode.current.querySelector(".xterm-helper-textarea");
      if (helper) {
        helper.readOnly = true;
        helper.inputMode = "none";
        helper.tabIndex = -1;
      }
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket = null;
    let reconnectTimer = null;
    let resizeTimer = null;
    let disposed = false;

    const resize = () => {
      try {
        const buffer = terminal.buffer.active;
        const wasAtBottom = buffer.viewportY >= buffer.baseY;
        const viewportLine = buffer.viewportY;
        const previousCols = terminal.cols;
        const previousRows = terminal.rows;
        fit.fit();
        if (wasAtBottom) terminal.scrollToBottom();
        else terminal.scrollToLine(Math.min(viewportLine, terminal.buffer.active.baseY));
        if ((terminal.cols !== previousCols || terminal.rows !== previousRows) && socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      } catch { /* terminal disposed */ }
    };
    const scheduleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 100);
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(terminalNode.current);
    const inputDisposable = terminal.onData((data) => {
      const activeSocket = socketRef.current;
      if (activeSocket?.readyState !== WebSocket.OPEN) return;
      if (data === "\r") {
        activeSocket.send(JSON.stringify({ type: "key", key: "Enter" }));
        return;
      }
      if (data === "\x7f") {
        activeSocket.send(JSON.stringify({ type: "key", key: "Backspace" }));
        return;
      }
      let output = data;
      if (ctrlRef.current && data.length === 1) output = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
      if (altRef.current) output = `\x1b${output}`;
      ctrlRef.current = false;
      altRef.current = false;
      setCtrl(false);
      setAlt(false);
      activeSocket.send(JSON.stringify({ type: "input", data: output }));
    });
    const beginTouchScroll = (x, y, pointerId = null) => {
      terminal.clearSelection();
      touchRef.current = { x, y, latestY: y, pointerId, scrollTimer: null, moved: false, scrolling: false };
    };
    const sendTouchScroll = (gesture) => {
      const delta = gesture.latestY - gesture.y;
      if (Math.abs(delta) < 10 || socketRef.current?.readyState !== WebSocket.OPEN) return;
      socketRef.current.send(JSON.stringify({
        type: "scroll",
        direction: delta > 0 ? "up" : "down",
        count: Math.min(80, Math.max(1, Math.floor(Math.abs(delta) / 8))),
      }));
      gesture.y = gesture.latestY;
    };
    const continueTouchScroll = (x, y) => {
      if (!touchRef.current) return;
      touchRef.current.latestY = y;
      const deltaX = x - touchRef.current.x;
      const deltaY = y - touchRef.current.y;
      if (!touchRef.current.moved && Math.hypot(deltaX, deltaY) > 8) {
        touchRef.current.moved = true;
        touchRef.current.scrolling = Math.abs(deltaY) > Math.abs(deltaX);
      }
      if (touchRef.current.scrolling && xtermViewport) {
        clearTimeout(touchRef.current.scrollTimer);
        const gesture = touchRef.current;
        gesture.scrollTimer = setTimeout(() => {
          if (touchRef.current === gesture) sendTouchScroll(gesture);
        }, 80);
      }
    };
    const finishTouchScroll = (y) => {
      const gesture = touchRef.current;
      if (gesture?.scrolling) {
        clearTimeout(gesture.scrollTimer);
        gesture.latestY = y ?? gesture.latestY;
        sendTouchScroll(gesture);
      }
      if (gesture && !gesture.moved) focusKeyboard();
      touchRef.current = null;
    };
    const cancelTouchScroll = () => {
      clearTimeout(touchRef.current?.scrollTimer);
      touchRef.current = null;
    };
    const stopPointerEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const pointerStart = (event) => {
      if (!touchTerminal || (!TOUCH_MODE && event.pointerType !== "touch")) return;
      stopPointerEvent(event);
      terminalNode.current.setPointerCapture?.(event.pointerId);
      beginTouchScroll(event.clientX, event.clientY, event.pointerId);
    };
    const pointerMove = (event) => {
      if (touchRef.current?.pointerId !== event.pointerId) return;
      stopPointerEvent(event);
      continueTouchScroll(event.clientX, event.clientY);
    };
    const pointerEnd = (event) => {
      if (touchRef.current?.pointerId !== event.pointerId) return;
      stopPointerEvent(event);
      terminalNode.current.releasePointerCapture?.(event.pointerId);
      finishTouchScroll(event.clientY);
    };
    const pointerCancel = (event) => {
      if (touchRef.current?.pointerId !== event.pointerId) return;
      stopPointerEvent(event);
      cancelTouchScroll();
    };
    const touchStart = (event) => {
      if (!touchTerminal || !event.touches[0]) return;
      beginTouchScroll(event.touches[0].clientX, event.touches[0].clientY);
    };
    const touchMove = (event) => {
      if (!touchRef.current || !event.touches[0]) return;
      continueTouchScroll(event.touches[0].clientX, event.touches[0].clientY);
      if (touchRef.current?.scrolling) stopPointerEvent(event);
    };
    const touchEnd = (event) => {
      if (!touchRef.current) return;
      if (touchRef.current.scrolling || !touchRef.current.moved) stopPointerEvent(event);
      finishTouchScroll(event.changedTouches[0]?.clientY);
    };
    const pointerGestures = TOUCH_MODE && "PointerEvent" in window;
    if (pointerGestures) {
      terminalNode.current.addEventListener("pointerdown", pointerStart, true);
      terminalNode.current.addEventListener("pointermove", pointerMove, true);
      terminalNode.current.addEventListener("pointerup", pointerEnd, true);
      terminalNode.current.addEventListener("pointercancel", pointerCancel, true);
    } else {
      terminalNode.current.addEventListener("touchstart", touchStart, { capture: true, passive: true });
      terminalNode.current.addEventListener("touchmove", touchMove, { capture: true, passive: false });
      terminalNode.current.addEventListener("touchend", touchEnd, { capture: true, passive: false });
      terminalNode.current.addEventListener("touchcancel", cancelTouchScroll, { capture: true, passive: true });
    }
    // La molette fait toujours defiler l'historique du pane. Sans cela, xterm la traduit en
    // fleches des qu'une interface occupe l'ecran, et l'agent croit qu'on navigue au clavier.
    let wheelRemainder = 0;
    const wheelScroll = (event) => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? terminal.rows * 16 : 40;
      wheelRemainder += event.deltaY / step;
      const lines = Math.trunc(wheelRemainder);
      if (!lines) return;
      wheelRemainder -= lines;
      socketRef.current.send(JSON.stringify({ type: "scroll", direction: lines < 0 ? "up" : "down", count: Math.min(20, Math.abs(lines) * 3) }));
    };
    terminalNode.current.addEventListener("wheel", wheelScroll, { capture: true, passive: false });
    const openKeyboard = () => focusKeyboard();
    terminalNode.current.addEventListener("click", openKeyboard);
    // Sans clavier virtuel, aucun champ n'est focalise (sinon le clavier du systeme surgit):
    // on capte les touches au niveau du document et on les envoie telles quelles a l'agent.
    const specialKeys = { Enter: "Enter", Backspace: "Backspace", Tab: "Tab", Escape: "Escape", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", PageUp: "PageUp", PageDown: "PageDown" };
    const editableTarget = (node) => node instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) || node.isContentEditable);
    const captureKey = (event) => {
      if (!captureMode || event.metaKey || event.defaultPrevented || editableTarget(event.target)) return;
      if (specialKeys[event.key]) {
        event.preventDefault();
        sendSpecial(specialKeys[event.key]);
        return;
      }
      if (event.ctrlKey && /^[a-zA-Z]$/.test(event.key)) {
        event.preventDefault();
        send(String.fromCharCode(event.key.toLowerCase().charCodeAt(0) - 96));
        return;
      }
      if (event.ctrlKey || event.altKey || event.key.length !== 1) return;
      event.preventDefault();
      send(event.key);
    };
    const inField = (node) => node instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) || node.isContentEditable);
    const copyShortcut = (event) => {
      const selection = terminalRef.current?.getSelection?.() || "";
      if (!shouldCopyTerminal({ event, targetInField: inField(event.target), browserSelectionCollapsed: window.getSelection()?.isCollapsed !== false, terminalSelection: selection })) return;
      event.preventDefault();
      event.stopPropagation();
      void copyTerminal();
    };
    const nativeCopy = (event) => {
      // Une copie faite dans un champ ou dans le panneau texte appartient au navigateur.
      if (inField(event.target) || !window.getSelection()?.isCollapsed) return;
      const selection = terminalRef.current?.getSelection?.();
      if (!selection || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", selection);
      event.preventDefault();
    };
    // Coller une image: on l'intercepte avant tout, quel que soit le mode de saisie.
    // xterm garde le focus sur sa propre zone de saisie: un collage d'image y arrive aussi,
    // on ne l'ignore que dans les champs de l'application (modales, formulaires).
    const inTerminal = (node) => node instanceof HTMLElement && node.closest(".terminal-frame, .terminal-controls");
    const pasteFile = (event) => {
      if (editableTarget(event.target) && !inTerminal(event.target)) return false;
      const file = [...(event.clipboardData?.files || [])][0]
        || [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file").map((item) => item.getAsFile())[0];
      if (!file) return false;
      event.preventDefault();
      // Chemin insere sans validation: tu ajoutes ta consigne autour avant d'envoyer.
      sendFile(file, { submit: false });
      return true;
    };
    const dropFile = (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      sendFile(file, { submit: false });
    };
    const allowDrop = (event) => event.preventDefault();
    const capturePaste = (event) => {
      if (pasteFile(event)) return;
      if (!captureMode || editableTarget(event.target)) return;
      const text = event.clipboardData?.getData("text");
      if (!text) return;
      event.preventDefault();
      send(text);
    };
    window.addEventListener("keydown", copyShortcut, true);
    window.addEventListener("copy", nativeCopy);
    window.addEventListener("keydown", captureKey);
    window.addEventListener("paste", capturePaste);
    terminalNode.current.addEventListener("dragover", allowDrop);
    terminalNode.current.addEventListener("drop", dropFile);
    // Les agents demandent le suivi de souris, ce qui detourne tout glisser vers eux.
    // On retire ces sequences: la selection redevient native sur toutes les plateformes.
    const MOUSE_TRACKING = /\u001b\[\?(?:1000|1001|1002|1003|1005|1006|1015|1016)[hl]/g;
    let pendingEscape = "";
    const withoutMouseTracking = (chunk) => {
      const data = pendingEscape + chunk;
      pendingEscape = "";
      const start = data.lastIndexOf("\u001b[?");
      if (start >= 0 && data.length - start < 10 && !/[hl]/.test(data.slice(start + 3))) {
        pendingEscape = data.slice(start);
        return data.slice(0, start).replace(MOUSE_TRACKING, "");
      }
      return data.replace(MOUSE_TRACKING, "");
    };
    const handleMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "output") {
        terminal.write(withoutMouseTracking(message.data), () => {
          if (snapBottomRef.current) {
            terminal.scrollToBottom();
            snapBottomRef.current = false;
          }
        });
      }
    };
    const connect = () => {
      if (disposed || socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;
      const terminalSize = new URLSearchParams({ cols: String(terminal.cols), rows: String(terminal.rows) });
      socket = new WebSocket(`${protocol}//${location.host}/ws/terminal/${session.id}?${terminalSize}`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        snapBottomRef.current = true;
        setConnected(true);
        resize();
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
        if (!captureMode) terminal.focus();
      });
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 1000);
        }
      });
      socket.addEventListener("error", () => socket.close());
    };
    const resumeConnection = () => {
      if (document.visibilityState !== "visible" || disposed) return;
      if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(socketRef.current?.readyState)) socketRef.current.close();
      else connect();
    };
    document.addEventListener("visibilitychange", resumeConnection);
    window.addEventListener("online", resumeConnection);
    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", resumeConnection);
      window.removeEventListener("online", resumeConnection);
      observer.disconnect();
      clearTimeout(resizeTimer);
      terminalNode.current?.removeEventListener("pointerdown", pointerStart, true);
      terminalNode.current?.removeEventListener("pointermove", pointerMove, true);
      terminalNode.current?.removeEventListener("pointerup", pointerEnd, true);
      terminalNode.current?.removeEventListener("pointercancel", pointerCancel, true);
      terminalNode.current?.removeEventListener("touchstart", touchStart, true);
      terminalNode.current?.removeEventListener("touchmove", touchMove, true);
      terminalNode.current?.removeEventListener("touchend", touchEnd, true);
      terminalNode.current?.removeEventListener("touchcancel", cancelTouchScroll, true);
      terminalNode.current?.removeEventListener("click", openKeyboard);
      terminalNode.current?.removeEventListener("wheel", wheelScroll, true);
      window.removeEventListener("keydown", copyShortcut, true);
      window.removeEventListener("copy", nativeCopy);
      window.removeEventListener("keydown", captureKey);
      window.removeEventListener("paste", capturePaste);
      terminalNode.current?.removeEventListener("dragover", allowDrop);
      terminalNode.current?.removeEventListener("drop", dropFile);
      inputDisposable.dispose();
      socket?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [session.id, session.name, oskEnabled]);

  function send(data) {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "input", data }));
  }

  function sendSpecial(key) {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "key", key }));
    ctrlRef.current = false;
    altRef.current = false;
    setCtrl(false);
    setAlt(false);
  }

  function focusKeyboard(force = false) {
    // Poste souris-clavier: xterm garde le focus natif, on ne detourne rien.
    if (!force && !oskEnabled) {
      if (!(TOUCH_MODE || window.matchMedia("(pointer: coarse)").matches)) terminalRef.current?.focus();
      return;
    }
    if (force || TOUCH_MODE || window.matchMedia("(pointer: coarse)").matches) {
      const input = keyboardRef.current;
      if (input) input.inputMode = "text";
      try {
        input?.focus({ preventScroll: true });
      } catch {
        input?.focus();
      }
      input?.setSelectionRange(0, 0);
      setKeyboardActive(true);
      return;
    }
    terminalRef.current?.focus();
  }

  function toggleModifier(kind) {
    if (kind === "ctrl") {
      setCtrl((value) => {
        ctrlRef.current = !value;
        return !value;
      });
    } else {
      setAlt((value) => {
        altRef.current = !value;
        return !value;
      });
    }
    focusKeyboard();
  }

  function pressSpecial(key) {
    sendSpecial(key);
    focusKeyboard();
  }

  // iOS avale le click des boutons dans la barre scrollable: on valide le tap au pointerup.
  function tapKey(action) {
    return {
      onPointerDown: (event) => {
        if (event.pointerType === "mouse") return;
        tapRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      },
      onPointerUp: (event) => {
        if (event.pointerType === "mouse") return;
        const tap = tapRef.current;
        tapRef.current = null;
        if (!tap || tap.id !== event.pointerId) return;
        if (Math.abs(event.clientX - tap.x) > 12 || Math.abs(event.clientY - tap.y) > 12) return;
        tapDoneRef.current = Date.now();
        action();
      },
      onPointerCancel: () => { tapRef.current = null; },
      onClick: () => {
        if (Date.now() - tapDoneRef.current < 700) return;
        action();
      },
    };
  }

  // Une image du presse-papiers ne peut pas traverser tmux: on la depose sur le PC
  // et on donne son chemin a l'agent, exactement comme une piece jointe.
  async function sendFile(file, { submit = true } = {}) {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sessionId", session.id);
      const uploaded = await api("/api/uploads/file", { method: "POST", body: form });
      if (socketRef.current?.readyState !== WebSocket.OPEN) throw new Error("Terminal déconnecté. Réessaie après reconnexion.");
      socketRef.current.send(JSON.stringify(submit
        ? { type: "submit", data: `${uploaded.image ? "Image" : "Fichier"} joint à examiner : ${uploaded.path}` }
        : { type: "input", data: uploaded.path }));
    } catch (error) {
      window.alert(error.message);
    } finally {
      setUploading(false);
    }
  }

  async function attachFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // Chemin insere sans validation: la consigne s'ecrit autour avant d'envoyer.
    await sendFile(file, { submit: false });
    focusKeyboard();
  }

  function sendKeyboardData(data) {
    let output = data;
    if (ctrlRef.current && data.length === 1) output = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
    if (altRef.current) output = `\x1b${output}`;
    send(output);
    ctrlRef.current = false;
    altRef.current = false;
    setCtrl(false);
    setAlt(false);
  }

  function nativeInput(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.nativeEvent.inputType === "deleteContentBackward") {
      sendSpecial("Backspace");
      return;
    }
    const data = event.currentTarget.value;
    if (data) sendKeyboardData(data);
    event.currentTarget.value = "";
  }

  function nativePaste(event) {
    const data = event.clipboardData?.getData("text");
    if (!data) return;
    event.preventDefault();
    sendKeyboardData(data);
    event.currentTarget.value = "";
  }

  async function pasteClipboard() {
    try {
      if (!window.isSecureContext || !navigator.clipboard?.readText) throw new Error("insecure");
      const data = await navigator.clipboard.readText();
      if (!data) throw new Error("Presse-papiers vide.");
      sendKeyboardData(data);
    } catch (error) {
      if (error.message === "Presse-papiers vide.") return window.alert(error.message);
      // Sans contexte securise, la lecture du presse-papiers est interdite: saisie manuelle.
      const manual = window.prompt("Colle ici le texte à envoyer à l\'agent (Cmd+V) :", "");
      if (manual) sendKeyboardData(manual);
    }
  }

  // Les agents redessinent leur interface en continu, ce qui efface la selection en cours:
  // on fige le texte dans un panneau ou la selection tient, avec les liens isoles.
  // Reference cliquable dans la sortie de l'agent: on ouvre la tache sans quitter la conversation.
  const openTodoByRef = useCallback(async (reference) => {
    try {
      const result = await api("/api/todos");
      const todo = (result.todos || []).find((item) => todoRef(item.id) === String(reference).toUpperCase());
      if (!todo) {
        window.alert(`Tâche ${reference} introuvable.`);
        return;
      }
      setTodoDetail(todo);
      await api("/api/todos/seen", { method: "POST", body: JSON.stringify({ ids: [todo.id] }) }).catch(() => {});
      window.dispatchEvent(new Event("noyau:todos"));
    } catch (error) {
      window.alert(error.message);
    }
  }, []);

  useEffect(() => { todoLinkRef.current = openTodoByRef; }, [openTodoByRef]);

  // Taguer une tache: l'agent recoit la reference, le texte, l'etat et les derniers commentaires.
  function tagTodo(todo) {
    const comments = (todo.comments || []).slice(-3)
      .map((comment) => `${formatCommentDate(comment.createdAt)}${comment.author ? ` ${comment.author}` : ""}: ${comment.text.replace(/\s+/g, " ")}`)
      .join(" · ");
    const block = `${todoRef(todo.id)} « ${todo.text} » [${todo.status || "todo"}]${todo.dueDate ? ` échéance ${todo.dueDate}` : ""}${comments ? ` — derniers commentaires: ${comments}` : ""} `;
    setTodoPicker(false);
    sendKeyboardData(block);
    focusKeyboard();
  }

  function openSnapshot() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const rows = [];
    const first = Math.max(0, buffer.length - 600);
    for (let row = first; row < buffer.length; row += 1) rows.push(buffer.getLine(row)?.translateToString(true) || "");
    setSnapshot({
      text: rows.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
      links: extractLinks(rows, terminal.cols),
    });
  }

  async function copyText(value) {
    if (!await writeClipboard(value)) window.alert("Copie refusée par le navigateur.");
  }

  async function copyTerminal() {
    try {
      const terminal = terminalRef.current;
      if (!terminal) throw new Error("Terminal indisponible.");
      let content = terminal.getSelection();
      if (!content) {
        const buffer = terminal.buffer.active;
        const start = Math.max(0, buffer.viewportY);
        const lines = [];
        for (let row = start; row < Math.min(buffer.length, start + terminal.rows); row += 1) lines.push(buffer.getLine(row)?.translateToString(true) || "");
        content = lines.join("\n").trimEnd();
      }
      if (!content) throw new Error("Terminal vide.");
      if (!await writeClipboard(content)) throw new Error("Copie refusée par le navigateur.");
    } catch (error) {
      window.alert(error.message || "Copie presse-papiers refusée.");
    }
  }

  function nativeKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      sendSpecial("Enter");
    } else if (event.key === "Backspace") {
      event.preventDefault();
      sendSpecial("Backspace");
    }
  }

  // Redemarrage: le pane repart avec la meme conversation, la connexion terminal se remet toute seule.
  async function restart() {
    if (restarting || !confirmAction("Redémarrer l'agent en reprenant la conversation en cours ?")) return;
    setRestarting(true);
    try {
      const result = await api(`/api/sessions/${session.id}/restart`, { method: "POST" });
      if (!result?.resumed) window.alert("Agent redémarré. Aucune conversation précédente à reprendre.");
      onRefresh?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setRestarting(false);
    }
  }

  // Fermer un agent l'archive: on garde son fil pour pouvoir le relancer plus tard.
  async function kill() {
    if (!window.confirm(`Archiver « ${session.name} » ? L'agent se ferme et reste restaurable depuis « Agents archivés ».`)) return;
    await api(`/api/sessions/${session.id}/archive`, { method: "POST" });
    window.dispatchEvent(new Event("noyau:archives"));
    onKilled();
  }

  async function migrate(target) {
    if (!target || target === session.assistant) return;
    if (!confirmAction(`Basculer « ${session.name} » vers ${assistantMeta[target]?.label || target} ? Le contexte de la conversation est transmis au nouvel agent.`)) return;
    setMigrating(true);
    try {
      const result = await api(`/api/sessions/${session.id}/migrate`, { method: "POST", body: JSON.stringify({ target }) });
      if (result?.mode === "transcript" && result.session?.id) {
        migrationRef.current = false;
        setMigrating(false);
        if (!result.history) window.alert("Aucun historique lisible: le nouvel agent repart de l'état du dépôt.");
        onMigrated(result.session.id);
        return;
      }
      migrationRef.current = true;
      onRefresh();
    } catch (error) {
      setMigrating(false);
      window.alert(error.message);
    }
  }

  return (
    <div className="terminal-page">
      <div className="terminal-toolbar">
        <button className="icon-button" onClick={onBack} aria-label="Retour">‹</button>
        <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small />
        <div className="terminal-identity"><strong><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /><span>{session.name}</span></strong><small>{session.agentStatus?.label || "Disponible"} · {connected ? "Connecté" : "Déconnecté"} · {session.cwd}</small></div>
        <div className="terminal-actions">
          <span className="usage-pill" title="Contexte restant">{session.usage?.estimated ? "~" : ""}{formatTokens(session.usage?.remainingTokens)} · {session.usage?.contextPercent ?? "—"}%</span>
          {["codex", "claude", "antigravity"].includes(session.assistant) && (
            <label className="provider-switch" title={migrating ? "Bascule en cours… (choisir pour forcer immédiatement)" : "Changer de fournisseur en gardant le contexte"}>
              <select value={session.assistant} onChange={(event) => migrate(event.target.value)} aria-label="Fournisseur">
                {["codex", "claude", "antigravity"].filter((id) => id === session.assistant || assistants?.[id] !== false).map((id) => {
                  const quota = providerQuota(quotas, id);
                  return <option value={id} key={id}>{assistantMeta[id].label}{quota ? ` · ${quota.percent}%` : ""}</option>;
                })}
              </select>
              {migrating && <em title="Passation en cours…">…</em>}
            </label>
          )}
          {session.managed && !session.core && <button className="danger-link" onClick={kill} aria-label="Archiver agent" title="Archiver: ferme l'agent en gardant son fil">⏻</button>}
        </div>
      </div>
      <div className="terminal-frame" ref={terminalNode} />
      {snapshot !== null && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSnapshot(null)}>
          <section className="modal terminal-snapshot">
            <div className="modal-head"><div><p className="eyebrow">TEXTE DE L’ÉCRAN</p><h2>Copier</h2></div><button className="icon-button" onClick={() => setSnapshot(null)}>×</button></div>
            {snapshot.links?.length > 0 && (
              <div className="snapshot-links">
                {snapshot.links.map((link) => (
                  <div className="snapshot-link" key={link}>
                    <span title={link}>{link}</span>
                    <button
                      className={`ghost ${copiedLink === link ? "copied" : ""}`}
                      onClick={() => {
                        copyText(link);
                        setCopiedLink(link);
                        setTimeout(() => setCopiedLink(null), 2000);
                      }}
                    >
                      {copiedLink === link ? "Copié !" : "Copier"}
                    </button>
                    <a className="ghost" href={link} target="_blank" rel="noreferrer">Ouvrir</a>
                  </div>
                ))}
              </div>
            )}
            <textarea className="snapshot-text" ref={snapshotRef} value={snapshot.text} readOnly spellCheck="false" />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setSnapshot(null)}>Fermer</button>
              <button className="ghost" onClick={() => { snapshotRef.current?.focus(); snapshotRef.current?.select(); }}>Tout sélectionner</button>
              <button className="primary" onClick={() => copyText(snapshot.text)}>Tout copier</button>
            </div>
          </section>
        </div>
      )}
      {todoPicker && <TodoTagPicker onPick={tagTodo} onClose={() => setTodoPicker(false)} projectId={session.projectId || null} projectName={session.project?.name || null} />}
      {todoDetail && <TodoDetailOverlay todo={todoDetail} onClose={() => setTodoDetail(null)} onTag={tagTodo} />}
      <div className={`terminal-controls ${keyboardActive ? "keyboard-active" : ""}`}>
        <input
          ref={keyboardRef}
          className="terminal-keyboard-capture"
          type="text"
          onInput={nativeInput}
          onPaste={nativePaste}
          onKeyDown={nativeKeyDown}
          onFocus={() => { setKeyboardActive(true); viewportRefreshRef.current(true); }}
          onBlur={() => { setKeyboardActive(false); viewportRefreshRef.current(true); }}
          aria-label="Clavier terminal"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck="false"
          inputMode="text"
          enterKeyHint="enter"
          autoFocus={new URLSearchParams(location.search).get("reply") === "1"}
        />
        <div className="key-row">
          <button className="keyboard-key" {...tapKey(() => { setOskEnabled(true); focusKeyboard(true); })} aria-label="Afficher le clavier">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M9.5 13.5h6.5" /></svg>
          </button>
          <label className={`upload-key ${uploading ? "disabled" : ""}`} aria-label="Joindre photo ou fichier">
            <input type="file" onChange={attachFile} disabled={uploading} />
            <span>{uploading ? "…" : "＋"}</span>
          </label>
          {session.managed && <button className="restart-key" {...tapKey(restart)} aria-label="Redémarrer l'agent">
            {restarting ? "…" : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.2M20 5v6h-6" /></svg>}
          </button>}
          <button className="todo-key" {...tapKey(() => setTodoPicker(true))} aria-label="Taguer une tâche" title="Taguer une tâche: envoie sa référence, son texte et ses derniers commentaires">✱</button>
          <button className="text-key" {...tapKey(openSnapshot)} aria-label="Texte de l'écran">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h8l4 4v12H6z" /><path d="M14 4v4h4M9 13h6M9 16.5h4" /></svg>
          </button>
          <button className="copy-key" {...tapKey(copyTerminal)} aria-label="Copier l'écran">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" /></svg>
          </button>
          <button className="paste-key" {...tapKey(pasteClipboard)} aria-label="Coller">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 5V3.8A.8.8 0 0 1 9.8 3h4.4a.8.8 0 0 1 .8.8V5M9 12h6M9 16h4" /></svg>
          </button>
          <button {...tapKey(() => pressSpecial("Escape"))}>Esc</button>
          <button className={ctrl ? "selected" : ""} {...tapKey(() => toggleModifier("ctrl"))}>Ctrl</button>
          <button className={alt ? "selected" : ""} {...tapKey(() => toggleModifier("alt"))}>Alt</button>
          <button {...tapKey(() => pressSpecial("Tab"))}>Tab</button>
          <button {...tapKey(() => pressSpecial("ArrowLeft"))}>←</button>
          <button {...tapKey(() => pressSpecial("ArrowUp"))}>↑</button>
          <button {...tapKey(() => pressSpecial("ArrowDown"))}>↓</button>
          <button {...tapKey(() => pressSpecial("ArrowRight"))}>→</button>
          <button className="enter-key" {...tapKey(() => pressSpecial("Enter"))}>Entrée</button>
        </div>
      </div>
    </div>
  );
}

function NewSessionModal({ projects, sessions, assistants, onClose, onCreated }) {
  const [assistant, setAssistant] = useState("codex");
  const [name, setName] = useState("");
  const [yolo, setYolo] = useState(false);
  const [projectLogo, setProjectLogo] = useState(true);
  const [projectId, setProjectId] = useState("");
  const [cwd, setCwd] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api("/api/sessions", { method: "POST", body: JSON.stringify({ assistant, name, cwd: cwd.trim() || undefined, yolo, projectLogo, projectId: projectId || null, favorite }) });
      onCreated(result.session);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-head"><div><p className="eyebrow">NOUVELLE SESSION</p><h2>Lancer agent</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
        <form onSubmit={submit}>
          <label>Type</label>
          <div className="assistant-choice">
            {LAUNCHABLE_ASSISTANTS.map((id) => {
              const meta = assistantMeta[id];
              const missing = assistants?.[id] === false;
              return (
                <button type="button" className={`${assistant === id ? "selected" : ""} ${missing ? "missing" : ""}`} onClick={() => setAssistant(id)} disabled={missing} title={missing ? `${meta.label} n'est pas installé sur ce PC` : meta.label} key={id}>
                  <AgentIcon assistant={id} /><span>{meta.label}{missing ? " · absent" : ""}</span>
                </button>
              );
            })}
          </div>
          <label htmlFor="name">Nom</label>
          <input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder={`Ex. ${assistant === "shell" ? "Serveur local" : "Refonte dashboard"}`} />
          <label htmlFor="project">Projet</label>
          <select id="project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Sans projet</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
          <label htmlFor="cwd">Dossier de travail</label>
          <input id="cwd" list="agent-directories" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/home/user/projects/mon-projet" autoComplete="off" spellCheck="false" />
          <datalist id="agent-directories">{[...new Set(sessions.map((session) => session.cwd).filter(Boolean))].map((directory) => <option value={directory} key={directory} />)}</datalist>
          <p className="form-hint">Chemin existant sur ce PC. Vide = dossier projets par défaut. Projet sert seulement au classement.</p>
          {assistant !== "shell" && <label className="checkbox-option"><input type="checkbox" checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span><strong>Sans confirmation</strong><small>{assistant === "codex" ? "Codex --yolo" : `${assistantMeta[assistant]?.label} --dangerously-skip-permissions`}</small></span></label>}
          <label className="checkbox-option"><input type="checkbox" checked={projectLogo} onChange={(event) => setProjectLogo(event.target.checked)} /><span><strong>Logo projet auto</strong><small>Cherche logo/icon dans dossier projet</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} /><span><strong>Agent favori</strong><small>Affiché avant autres agents</small></span></label>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Annuler</button><button className="primary" disabled={loading}>{loading ? "Lancement…" : "Lancer"}</button></div>
        </form>
      </section>
    </div>
  );
}

function EditSessionModal({ session, projects, onClose, onSaved }) {
  const [name, setName] = useState(session.name);
  const [assistant, setAssistant] = useState(session.assistant);
  const [yolo, setYolo] = useState(Boolean(session.yolo));
  const [projectLogo, setProjectLogo] = useState(Boolean(session.projectLogo));
  const [projectId, setProjectId] = useState(session.projectId || "");
  const [favorite, setFavorite] = useState(Boolean(session.favorite));
  const [shared, setShared] = useState(Boolean(session.shared));
  const [todoTracking, setTodoTracking] = useState(session.todoTracking !== false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (assistant !== session.assistant && !window.confirm(`Basculer « ${name} » vers ${assistantMeta[assistant]?.label} ? L'agent actuel est arrêté et le nouveau reprend la dernière conversation.`)) {
        setLoading(false);
        return;
      }
      const result = await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ name, assistant, yolo, projectLogo, projectId: projectId || null, favorite, shared, todoTracking }) });
      onSaved(result.session, { switched: Boolean(result.switched) });
      if (result.switched && !result.history) window.alert("Aucun historique lisible: le nouvel agent repart de l'état du dépôt.");
      if (result.pending) window.alert("Mode permissions appliqué après prochaine réponse agent.");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-head"><div><p className="eyebrow">RÉGLAGES AGENT</p><h2>Éditer</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
        <form onSubmit={submit}>
          <label htmlFor="edit-name">Nom</label>
          <input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} />
          {["codex", "claude", "antigravity"].includes(session.assistant) && <>
            <label htmlFor="edit-assistant">Agent</label>
            <select id="edit-assistant" value={assistant} onChange={(event) => setAssistant(event.target.value)}>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="antigravity">Antigravity</option>
            </select>
            {assistant !== session.assistant && <p className="form-hint">Bascule immédiate: historique de la dernière conversation transmis au nouvel agent.</p>}
          </>}
          <label htmlFor="edit-project">Projet</label>
          <select id="edit-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Sans projet</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
          {session.assistant !== "shell" && <label className="checkbox-option"><input type="checkbox" checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span><strong>Sans confirmation</strong><small>{session.assistant === "codex" ? "Codex --yolo" : `${assistantMeta[session.assistant]?.label} --dangerously-skip-permissions`}</small></span></label>}
          <label className="checkbox-option"><input type="checkbox" checked={projectLogo} onChange={(event) => setProjectLogo(event.target.checked)} /><span><strong>Logo projet auto</strong><small>Remplace icône agent si logo trouvé</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} /><span><strong>Agent favori</strong><small>Affiché avant autres agents</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /><span><strong>Partager l’agent</strong><small>Visible et utilisable depuis les autres profils</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={todoTracking} onChange={(event) => setTodoTracking(event.target.checked)} /><span><strong>Reporting évolutions / bugs</strong><small>Chaque demande envoyée à cet agent est tracée dans les to-do du projet</small></span></label>
          {session.permissionRestartPending && <p className="form-hint">Changement permissions en attente prochaine réponse.</p>}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Annuler</button><button className="primary" disabled={loading}>{loading ? "Application…" : "Enregistrer"}</button></div>
        </form>
      </section>
    </div>
  );
}

function ProjectModal({ project, onClose, onSaved }) {
  const [name, setName] = useState(project?.name || "");
  const [shared, setShared] = useState(Boolean(project?.shared));
  const [todoTracking, setTodoTracking] = useState(project?.todoTracking !== false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api(project ? `/api/projects/${project.id}` : "/api/projects", { method: project ? "PATCH" : "POST", body: JSON.stringify({ name, rootPath: null, shared, todoTracking }) });
      onSaved(result.project);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-head"><div><p className="eyebrow">{project ? "RÉGLAGES PROJET" : "NOUVEAU PROJET"}</p><h2>{project ? "Éditer projet" : "Créer projet"}</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
        <form onSubmit={submit}>
          <label htmlFor="project-name">Nom</label><input id="project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex. Noyau" autoFocus />
          <label className="checkbox-option"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /><span><strong>Partager le projet</strong><small>Visible par les autres profils, avec ses agents, todos et modules</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={todoTracking} onChange={(event) => setTodoTracking(event.target.checked)} /><span><strong>Reporting évolutions / bugs</strong><small>Les demandes adressées aux agents du projet créent ou commentent un to-do</small></span></label>
          <p className="form-hint">Agents peuvent utiliser dossiers différents. Logo repris depuis premier agent rattaché.</p>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Annuler</button><button className="primary" disabled={loading}>{loading ? "Enregistrement…" : "Enregistrer"}</button></div>
        </form>
      </section>
    </div>
  );
}

// Un ecran qui plante ne doit pas laisser une page noire: on affiche l'erreur et un retour possible.
class ViewBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(previous) {
    if (previous.viewKey !== this.props.viewKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <section className="panel view-error">
          <strong>Cet écran a planté.</strong>
          <p>{String(this.state.error?.message || this.state.error)}</p>
          <div className="modal-actions">
            <button className="ghost" onClick={() => this.setState({ error: null })}>Réessayer</button>
            <button className="primary" onClick={() => location.reload()}>Recharger</button>
          </div>
        </section>
      </div>
    );
  }
}

function App() {
  const [auth, setAuth] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [modules, setModules] = useState([]);
  const [moduleProposals, setModuleProposals] = useState([]);
  const [quotas, setQuotas] = useState({ codex: null, claude: null });
  const [assistants, setAssistants] = useState(null);
  const [activeId, setActiveId] = useState(() => new URLSearchParams(location.search).get("session"));
  const [view, setView] = useState(() => ["projects", "todos", "finances", "finance-transactions", "finance-agent", "finance-modules", "settings"].includes(new URLSearchParams(location.search).get("view")) ? new URLSearchParams(location.search).get("view") : "dashboard");
  const [modal, setModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [projectModalId, setProjectModalId] = useState(null);
  const [menu, setMenu] = useState(false);
  const [bootOffline, setBootOffline] = useState(false);
  const [bootAttempts, setBootAttempts] = useState(0);
  const [bootNonce, setBootNonce] = useState(0);
  const [bootPercent, setBootPercent] = useState(8);
  const [bootStep, setBootStep] = useState("Démarrage…");
  const [bootDetail, setBootDetail] = useState("");
  const [permission, setPermission] = useState(!window.isSecureContext ? "insecure" : (typeof Notification === "undefined" ? "denied" : Notification.permission));
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState(() => activeProfileId());
  const [todoUnread, setTodoUnread] = useState(0);

  // Compteur de changements non lus: alimente la pastille de l'onglet Todo.
  useEffect(() => {
    if (!auth) return undefined;
    let disposed = false;
    const load = () => api("/api/todos").then((result) => { if (!disposed) setTodoUnread(result.unread || 0); }).catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    const direct = (event) => { if (!disposed && typeof event.detail === "number") setTodoUnread(event.detail); };
    window.addEventListener("noyau:todos", load);
    window.addEventListener("noyau:todos-unread", direct);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("noyau:todos", load); window.removeEventListener("noyau:todos-unread", direct); };
  }, [auth, profileId]);

  const refresh = useCallback(async () => {
    try {
      const [{ sessions: nextSessions, quotas: nextQuotas, assistants: nextAssistants }, { projects: nextProjects }, nextModules] = await Promise.all([api("/api/sessions"), api("/api/projects"), api("/api/modules")]);
      setSessions(nextSessions);
      setAssistants(nextAssistants || null);
      setQuotas(nextQuotas || { codex: null, claude: null });
      setProjects(nextProjects);
      setModules(nextModules.modules || []);
      setModuleProposals(nextModules.proposals || []);
    } catch (error) {
      if (/autorisé|401/i.test(error.message)) setAuth(false);
    }
  }, []);

  const refreshQuotas = useCallback(async () => {
    const result = await api(`/api/quotas/refresh?refresh=${Date.now()}`, { method: "POST", cache: "no-store" });
    if (result?.quotas) setQuotas(result.quotas);
    return result;
  }, []);

  const advance = useCallback((percent, step) => {
    setBootPercent((current) => Math.max(current, percent));
    if (step) setBootStep(step);
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer = null;
    let creepTimer = null;
    let controller = null;
    let attempt = 0;

    // Progression douce entre deux etapes reelles: la barre ne doit jamais paraitre figee.
    function creepTo(ceiling) {
      clearInterval(creepTimer);
      creepTimer = setInterval(() => {
        if (disposed) return;
        setBootPercent((current) => (current >= ceiling ? current : current + Math.max(0.4, (ceiling - current) / 18)));
      }, 120);
    }

    async function authenticate() {
      controller?.abort();
      controller = new AbortController();
      advance(12, attempt ? `Nouvelle tentative (${attempt + 1})…` : "Contact du serveur…");
      creepTo(70);
      // VPN/Wi-Fi qui se reveille peut depasser 4s: laisser 12s avant d'abandonner la tentative.
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        await api("/api/auth/session", { signal: controller.signal });
        if (disposed) return;
        clearInterval(creepTimer);
        advance(80, "Session validée…");
        setBootOffline(false);
        setBootDetail("");
        setAuth(true);
      } catch (error) {
        if (disposed) return;
        clearInterval(creepTimer);
        if (error.status === 401) {
          advance(100, "Authentification requise");
          setBootOffline(false);
          setAuth(false);
          return;
        }
        attempt += 1;
        setBootAttempts(attempt);
        setBootDetail(error.name === "AbortError"
          ? "Aucune réponse après 12 s. Serveur éteint, hors du réseau local, ou certificat non approuvé."
          : `Échec réseau : ${error.message}`);
        if (attempt >= 3) setBootOffline(true);
        // Backoff: 1s, 2s, 4s… plafonne a 15s au lieu de marteler le reseau chaque seconde.
        retryTimer = setTimeout(authenticate, Math.min(1000 * 2 ** (attempt - 1), 15000));
      } finally {
        clearTimeout(timeout);
      }
    }

    authenticate();
    const wake = () => { clearTimeout(retryTimer); attempt = 0; setBootAttempts(0); authenticate(); };
    window.addEventListener("online", wake);
    return () => {
      disposed = true;
      controller?.abort();
      window.removeEventListener("online", wake);
      clearTimeout(retryTimer);
      clearInterval(creepTimer);
    };
  }, [bootNonce, advance]);

  // Une frappe hors champ de saisie ne peut venir que d'un vrai clavier: on s'en souvient.
  useEffect(() => {
    const hardwareOnly = new Set(["Tab", "Escape", "Control", "Alt", "Meta", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Insert", "Delete"]);
    const detect = (event) => {
      if (!event.isTrusted || event.key === "Unidentified") return;
      const target = event.target;
      const inField = target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName);
      if (inField && !hardwareOnly.has(event.key) && !/^F\d{1,2}$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      markPhysicalKeyboard();
    };
    window.addEventListener("keydown", detect);
    return () => window.removeEventListener("keydown", detect);
  }, []);

  // Tant que cet ecran est au premier plan, il est aux commandes: les alertes lui reviennent.
  useEffect(() => {
    if (!auth) return undefined;
    const ping = () => document.visibilityState === "visible" && api("/api/presence", { method: "POST", body: JSON.stringify({ sessionId: activeId, deviceId: deviceId() }) }).catch(() => {});
    ping();
    const timer = setInterval(ping, 30_000);
    document.addEventListener("visibilitychange", ping);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", ping); };
  }, [auth, activeId]);

  useEffect(() => {
    if (!auth) return;
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [auth, refresh]);

  // Le profil pilote le theme et le cloisonnement des donnees: on l'aligne des l'ouverture de session.
  const refreshProfiles = useCallback(async () => {
    const { profiles: list, activeProfileId: current } = await api("/api/profiles");
    setProfiles(list);
    setProfileId(current);
    try { localStorage.setItem(PROFILE_KEY, current); } catch { /* stockage optionnel */ }
    const active = list.find((item) => item.id === current);
    applyTheme(active?.theme);
    applyInstallIdentity(active);
    return list;
  }, []);

  useEffect(() => {
    if (!auth) return;
    refreshProfiles().catch(() => { /* profils indisponibles: on garde le theme courant */ });
  }, [auth, refreshProfiles]);

  // Version du build: tout changement purge les caches et recharge, sans action manuelle.
  useEffect(() => {
    let disposed = false;
    let timer = null;
    async function check() {
      try {
        const response = await fetch("/version.json", { cache: "no-store" });
        if (!response.ok) return;
        const info = await response.json();
        const version = info.release || info.build || info.version;
        if (!version || disposed) return;
        const known = localStorage.getItem(VERSION_KEY);
        if (known && known !== version) {
          if (document.fullscreenElement) return;
          localStorage.setItem(VERSION_KEY, version);
          await purgeClient();
          // Une mise a jour ne doit pas fermer la conversation ouverte: on garde la destination courante.
          const current = new URLSearchParams(location.search);
          const keep = Object.fromEntries(["session", "view", "reply"].filter((key) => current.get(key)).map((key) => [key, current.get(key)]));
          location.replace(appPath({ ...keep, v: version }));
          return;
        }
        if (!known) localStorage.setItem(VERSION_KEY, version);
      } catch { /* hors ligne: on reverifiera */ }
    }
    check();
    timer = setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    document.addEventListener("fullscreenchange", check);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", check); document.removeEventListener("fullscreenchange", check); };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Notification ouverte alors que l'app tourne deja: iOS ne navigue pas, on route en interne.
    const receiveNavigation = (url) => {
      const target = new URL(url, location.origin);
      const session = target.searchParams.get("session");
      const nextView = target.searchParams.get("view");
      history.replaceState({}, "", `${target.pathname}${target.search}`);
      if (session) {
        setActiveId(session);
        setMenu(false);
        return;
      }
      setActiveId(null);
      if (nextView) setView(nextView);
    };
    // Notification tapee alors que l'app etait fermee: la destination attend dans le cache.
    const consumePending = async () => {
      try {
        const cache = await caches.open("pending-navigation");
        const stored = await cache.match("/pending");
        if (!stored) return;
        await cache.delete("/pending");
        const pending = await stored.json();
        if (pending?.url && Date.now() - (pending.at || 0) < 180_000) receiveNavigation(pending.url);
      } catch { /* pas de cache disponible */ }
    };
    const receiveUpdate = (event) => {
      if (event.data?.type === "NOYAU_NAVIGATE" && event.data.url) receiveNavigation(event.data.url);
    };
    // Le controle de version gere seul le rechargement pour eviter les boucles a l'activation du worker.
    navigator.serviceWorker.addEventListener("message", receiveUpdate);
    navigator.serviceWorker.register("/sw.js").then((registration) => registration.update()).catch(() => {});
    consumePending();
    const wake = () => document.visibilityState === "visible" && consumePending();
    document.addEventListener("visibilitychange", wake);
    return () => {
      navigator.serviceWorker.removeEventListener("message", receiveUpdate);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  useEffect(() => {
    if (!auth || !window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => subscription && setPermission("active"))
      .catch(() => {});
  }, [auth]);

  const active = sessions.find((session) => session.id === activeId);
  // Bascule de fournisseur: l'agent repart sous un nouvel identifiant, on suit le fil sans rien faire.
  useEffect(() => {
    if (!activeId || active) return;
    const replacement = sessions.find((session) => session.migratedFrom === activeId);
    if (replacement) setActiveId(replacement.id);
  }, [activeId, active, sessions]);
  const editingSession = sessions.find((session) => session.id === editingId);
  const editingProject = projects.find((project) => project.id === projectModalId);
  const orderedSessions = useMemo(() => sortAgents(sessions), [sessions]);
  if (auth === null) {
    return (
      <Boot
        percent={bootPercent}
        step={bootStep}
        offline={bootOffline}
        detail={bootDetail}
        attempts={bootAttempts}
        onRetry={() => { setBootOffline(false); setBootAttempts(0); setBootPercent(8); setBootNonce((value) => value + 1); }}
        onReset={hardReset}
      />
    );
  }
  if (!auth) return <Login onLogin={() => setAuth(true)} />;

  async function logout() {
    await api("/api/logout", { method: "POST" });
    setAuth(false);
  }

  async function switchProfile(id) {
    if (!id || id === profileId) return;
    const nextProfile = profiles.find((item) => item.id === id);
    if (!nextProfile) return;
    try { localStorage.setItem(PROFILE_KEY, id); } catch { /* stockage optionnel */ }
    setProfileId(id);
    applyTheme(nextProfile.theme);
    applyInstallIdentity(nextProfile);
    setActiveId(null);
    setView("dashboard");
    setModal(false);
    setEditingId(null);
    setProjectModalId(null);
    setMenu(false);
    history.replaceState({}, "", appPath());
    await refresh();
  }

  async function enableNotifications() {
    try {
      if (!window.isSecureContext) throw new Error("HTTPS requis pour notifications iPhone.");
      if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Notifications push non prises en charge.");
      const granted = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (granted !== "granted") {
        setPermission(granted);
        return;
      }
      const [{ publicKey }, registration] = await Promise.all([api("/api/notifications"), navigator.serviceWorker.ready]);
      async function register(reset = false) {
        let subscription = await registration.pushManager.getSubscription();
        if (reset && subscription) {
          await api("/api/notifications/subscribe", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
          await subscription.unsubscribe();
          subscription = null;
        }
        subscription ||= await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        });
        await api("/api/notifications/subscribe", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON(), deviceId: deviceId() }) });
      }
      await register();
      setPermission("active");
      try {
        await api("/api/notifications/test", { method: "POST" });
      } catch (error) {
        if (!error.message.includes("Aucun appareil push actif")) throw error;
        await register(true);
        await api("/api/notifications/test", { method: "POST" });
      }
    } catch (error) {
      window.alert(error.message);
    }
  }

  async function reloadLatest() {
    let version = Date.now().toString(36);
    try {
      const response = await fetch("/version.json", { cache: "no-store" });
      if (response.ok) {
        const info = await response.json();
        version = info.release || info.build || info.version || version;
      }
    } catch { /* recharge reseau reste possible */ }
    await purgeClient();
    try { localStorage.setItem(VERSION_KEY, version); } catch { /* stockage optionnel */ }
    location.replace(appPath({ view: "settings", v: version, refresh: Date.now() }));
  }

  async function deleteProject(project) {
    if (!window.confirm(`Supprimer projet « ${project.name} » ? Agents seront détachés, pas arrêtés.`)) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    refresh();
  }

  async function toggleFavorite(session) {
    const favorite = !session.favorite;
    setSessions((items) => items.map((item) => item.id === session.id ? { ...item, favorite } : item));
    try {
      await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ favorite }) });
    } catch (error) {
      await refresh();
      window.alert(error.message);
    }
  }

  async function archiveAgent(session) {
    if (!window.confirm(`Archiver « ${session.name} » ? L'agent se ferme et reste restaurable depuis « Agents archivés ».`)) return;
    try {
      await api(`/api/sessions/${session.id}/archive`, { method: "POST" });
      setSessions((items) => items.filter((item) => item.id !== session.id));
      window.dispatchEvent(new Event("noyau:archives"));
      await refresh();
    } catch (error) {
      window.alert(error.message);
    }
  }

  async function moduleRequest(path, options) {
    try {
      const result = await api(path, options);
      await refresh();
      return result;
    } catch (error) {
      window.alert(error.message);
      return null;
    }
  }

  const installModule = (id) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/install`, { method: "POST" });
  const toggleModule = (id, enabled) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/toggle`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  const runModuleAction = (id, actionId) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`, { method: "POST" });
  const saveModuleSchedule = (id, scheduleId, time) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: JSON.stringify({ time }) });
  const buildModule = (id, platform = "android") => moduleRequest(`/api/modules/${encodeURIComponent(id)}/builds`, { method: "POST", body: JSON.stringify({ platform }) });
  const refreshModuleBuilds = (id) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/builds/refresh`, { method: "POST" });
  async function reorderProjects(ids, persist = true) {
    const byId = new Map(projects.map((project) => [project.id, project]));
    setProjects(ids.map((id) => byId.get(id)).filter(Boolean));
    if (!persist) return;
    try {
      const result = await api("/api/projects/order", { method: "PATCH", body: JSON.stringify({ ids }) });
      setProjects(result.projects || []);
    } catch (error) {
      await refresh();
      window.alert(error.message);
    }
  }

  return (
    <div className={`app-shell ${TOUCH_MODE ? "touch-shell" : ""}`}>
      {TOUCH_MODE && <TouchSystemBar sessions={orderedSessions} onHome={() => { setActiveId(null); setView("dashboard"); }} onNew={() => setModal(true)} />}
      <Sidebar sessions={orderedSessions} activeId={activeId} view={view} onOpen={setActiveId} onView={setView} onNew={() => setModal(true)} onLogout={logout} open={menu} onClose={() => setMenu(false)} profiles={profiles} profileId={profileId} onSwitchProfile={switchProfile} todoUnread={todoUnread} />
      {menu && <button className="menu-backdrop" onClick={() => setMenu(false)} aria-label="Fermer menu" />}
      <main className="content">
        <ViewBoundary viewKey={`${view}:${activeId || ""}`}>
        {!active ? (
          <>
            {view === "dashboard" && <><Header title="Accueil" subtitle="Vue générale" onMenu={() => setMenu(true)} onAction={() => setModal(true)} /><Dashboard sessions={orderedSessions} projects={projects} quotas={quotas} onRefreshQuotas={refreshQuotas} onOpen={setActiveId} onNew={() => setModal(true)} onEdit={setEditingId} onFavorite={toggleFavorite} onArchive={archiveAgent} onProjects={() => setView("projects")} onFinances={() => setView("finances")} /></>}
            {view === "projects" && <><Header title="Projets" subtitle="Agents et modules" onMenu={() => setMenu(true)} actionLabel="Nouveau projet" onAction={() => setProjectModalId("new")} /><ProjectsView projects={projects} sessions={orderedSessions} modules={modules} moduleProposals={moduleProposals} onOpenAgent={setActiveId} onNew={() => setProjectModalId("new")} onEdit={setProjectModalId} onDelete={deleteProject} onInstallModule={installModule} onModuleToggle={toggleModule} onModuleAction={runModuleAction} onModuleSchedule={saveModuleSchedule} onModuleBuild={buildModule} onModuleBuildRefresh={refreshModuleBuilds} onOpenTodos={() => setView("todos")} onReorder={reorderProjects} onRefresh={refresh} /></>}
            {view === "todos" && <><Header title="Todo" subtitle="Obsidian · NAS" onMenu={() => setMenu(true)} /><TodosView /></>}
            {view === "finances" && <><Header title="Budget" subtitle="Dépenses et épargne" onMenu={() => setMenu(true)} /><FinanceView onView={setView} /></>}
            {view === "finance-transactions" && <><Header title="Budget · Opérations" subtitle="Saisie et historique" onMenu={() => setMenu(true)} /><FinanceTransactionsView onView={setView} /></>}
            {view === "finance-agent" && <><Header title="Budget · Agent" subtitle="Charges et prévisions" onMenu={() => setMenu(true)} /><FinanceAgentView onView={setView} /></>}
            {view === "finance-modules" && <><Header title="Budget · Modules" subtitle="Actifs et règles" onMenu={() => setMenu(true)} /><FinanceModulesView onView={setView} /></>}
            {view === "finance-banking" && <><Header title="Budget · Banques" subtitle="Connexions et synchronisation" onMenu={() => setMenu(true)} /><FinanceBankingView onView={setView} /></>}
            {view === "settings" && <><Header title="Réglages" subtitle="Application" onMenu={() => setMenu(true)} /><SettingsView permission={permission} onNotifications={enableNotifications} onRefresh={reloadLatest} onView={setView} profiles={profiles} profileId={profileId} onSwitchProfile={switchProfile} onProfilesChanged={refreshProfiles} /></>}
          </>
        ) : (
          <TerminalView session={active} quotas={quotas} assistants={assistants} onBack={() => setActiveId(null)} onKilled={() => { setActiveId(null); refresh(); }} onMigrated={(id) => { setActiveId(id); refresh(); }} onRefresh={refresh} />
        )}
        </ViewBoundary>
      </main>
      {modal && <NewSessionModal projects={projects} sessions={orderedSessions} assistants={assistants} onClose={() => setModal(false)} onCreated={(session) => { setModal(false); setActiveId(session.id); refresh(); }} />}
      {editingSession && <EditSessionModal session={editingSession} projects={projects} onClose={() => setEditingId(null)} onSaved={(next, meta) => { setEditingId(null); if (meta?.switched && next?.id) { if (activeId === editingSession.id) setActiveId(next.id); } refresh(); }} />}
      {projectModalId && <ProjectModal project={editingProject} onClose={() => setProjectModalId(null)} onSaved={() => { setProjectModalId(null); refresh(); }} />}
    </div>
  );
}

window.__noyauMounted = true;
createRoot(document.getElementById("root")).render(<App />);
