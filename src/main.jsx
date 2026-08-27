import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./theme-castle.css";

const assistantMeta = {
  codex: { label: "Codex", glyph: "C", color: "green" },
  claude: { label: "Claude", glyph: "A", color: "orange" },
  shell: { label: "Terminal", glyph: ">_", color: "blue" },
};

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

function formatReset(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Reset inconnu";
  return `Reset ${new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))}`;
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

function operationDate(item) {
  const actual = item.date.split("-").reverse().join("/");
  return item.bookingDate ? `${actual} · comptabilisé ${item.bookingDate.split("-").reverse().join("/")}` : actual;
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

function Sidebar({ sessions, activeId, view, onOpen, onView, onNew, onLogout, open, onClose, profiles, profileId, onSwitchProfile }) {
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><Mark /><span>Noyau</span><button className="icon-button close-menu" onClick={onClose} aria-label="Fermer">×</button></div>
      <ProfileSwitcher profiles={profiles} profileId={profileId} onSwitch={onSwitchProfile} onLogout={onLogout} />
      <nav className="main-nav">
        <button className={!activeId && view === "dashboard" ? "active" : ""} onClick={() => { onOpen(null); onView("dashboard"); onClose(); }}><span>⌂</span>Accueil</button>
        <button className={!activeId && view === "projects" ? "active" : ""} onClick={() => { onOpen(null); onView("projects"); onClose(); }}><span>◫</span>Projets</button>
        <button className={!activeId && view === "todos" ? "active" : ""} onClick={() => { onOpen(null); onView("todos"); onClose(); }}><span>✓</span>Todo</button>
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
    </aside>
  );
}

function Header({ title, subtitle, onMenu, actionLabel = "Nouvel agent", onAction }) {
  return (
    <header className="topbar">
      <button className="icon-button menu-button" onClick={onMenu} aria-label="Menu">☰</button>
      <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      {onAction && <div className="top-actions"><button className="primary" onClick={onAction}><span>+</span> {actionLabel}</button></div>}
    </header>
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
      <button className="touch-system-sleep" onClick={sleepDisplay} disabled={sleeping} title="Éteindre écran jusqu’au prochain toucher">◐ Écran</button>
      <time dateTime={now.toISOString()}><strong>{time}</strong><small>{date}</small></time>
    </header>
  );
}

function DashboardAgentCard({ session, onOpen, onEdit, onFavorite }) {
  return (
    <article className="agent-card">
      <button className="agent-card-open" onClick={() => onOpen(session.id)}>
        <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} />
        <span className="agent-info"><strong><b className={`assistant-chip ${session.assistant}`} title={`${assistantMeta[session.assistant]?.label || session.assistant}${session.switchedFrom ? ` · basculé depuis ${assistantMeta[session.switchedFrom]?.label || session.switchedFrom}` : ""}`}>{assistantMeta[session.assistant]?.glyph || "?"}</b>{session.switchedFrom && <i className="switched-mark" title={`Basculé depuis ${assistantMeta[session.switchedFrom]?.label || session.switchedFrom}`}>↔</i>}<span className="agent-name">{session.name}</span>{session.canEdit === false && <b className="shared-chip" title={`Agent partagé par ${session.owner?.name || "autre profil"}`}>⇄ {session.owner?.name || "partagé"}</b>}{session.canEdit !== false && session.shared && <b className="shared-chip own" title="Agent partagé avec les autres profils">⇄ partagé</b>}</strong><small>{session.project?.name || "Sans projet"} · {session.cwd || session.id}</small><em><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {session.agentStatus?.label || "Disponible"} · {session.usage?.contextPercent ?? "—"}% contexte · <RelativeTime date={session.activityAt} /></em></span>
        <span className="open-arrow">›</span>
      </button>
      {session.managed && session.canEdit !== false && <div className="agent-card-actions"><button className={`agent-card-favorite ${session.favorite ? "active" : ""}`} onClick={() => onFavorite(session)} aria-label={`${session.favorite ? "Retirer" : "Ajouter"} favori`}>★</button><button className="agent-card-edit" onClick={() => onEdit(session.id)} aria-label={`Éditer ${session.name}`}>Éditer</button></div>}
    </article>
  );
}

function Dashboard({ sessions, projects, quotas, onOpen, onNew, onEdit, onFavorite, onProjects, onFinances, onRefreshQuotas }) {
  const [refreshingQuotas, setRefreshingQuotas] = useState(false);
  const [weather, setWeather] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("noyau-weather"));
      return cached && Date.now() - new Date(cached.retrievedAt).getTime() < 30 * 60 * 1000 ? cached : null;
    } catch {
      return null;
    }
  });
  const codexCount = sessions.filter((session) => session.assistant === "codex").length;
  const claudeCount = sessions.filter((session) => session.assistant === "claude").length;
  const shellCount = sessions.filter((session) => session.assistant === "shell").length;
  const linkedProjects = new Set(sessions.map((session) => session.projectId).filter(Boolean)).size;
  const favoriteCount = sessions.filter((session) => session.favorite).length;
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
        <article className="active-agents-metric"><span className="metric-symbol green">◎</span><div className="active-agents-content"><small>AGENTS ACTIFS</small><div className="active-agents-data"><div className="active-total-block"><strong className="active-total">{sessions.length}</strong><em>en ligne</em></div><div className="agent-breakdown"><span><b>{codexCount}</b><em>Codex</em></span><span><b>{claudeCount}</b><em>Claude</em></span><span><b>{shellCount}</b><em>Terminal</em></span></div></div><p className="active-agents-footer"><span>{linkedProjects} projet{linkedProjects > 1 ? "s" : ""} lié{linkedProjects > 1 ? "s" : ""}</span><span>{favoriteCount} favori{favoriteCount > 1 ? "s" : ""}</span></p></div></article>
        <article className="quota-metric"><span className="metric-symbol blue">↗</span><div><small className="quota-title">QUOTAS IA<button className={refreshingQuotas ? "quota-refresh updating" : "quota-refresh"} onClick={async () => { setRefreshingQuotas(true); try { await onRefreshQuotas(); } finally { setRefreshingQuotas(false); } }} disabled={refreshingQuotas} aria-label="Rafraîchir quotas" title="Rafraîchir quotas"><span aria-hidden="true">↻</span></button></small><div className="quota-providers"><div className="quota-codex"><span>CODEX</span>{codexWindows.length ? <div className="quota-dials">{codexWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{formatReset(item.resetsAt).replace("Reset ", "")}</em></div>)}</div> : <div className="quota-empty"><strong>—</strong><em>Aucun agent Codex actif</em></div>}</div><div className="quota-claude"><span>CLAUDE</span>{claudeWindows.length ? <div className="quota-dials">{claudeWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{formatReset(item.resetsAt).replace("Reset ", "")}</em></div>)}</div> : <div className="quota-empty"><strong>{quotas.claude?.status === "loggedOut" ? "Déconnecté" : "—"}</strong><em>{quotas.claude?.status === "loggedOut" ? "Reconnecte Claude" : "Reset inconnu"}</em></div>}</div></div></div></article>
      </section>

      <section className="panel agents-panel">
        <div className="panel-head"><div><h3>Agents actifs</h3><p>Sessions tmux sur ce PC</p></div><button className="ghost" onClick={onNew}>+ Lancer</button></div>
        <div className="agent-grid grouped-agent-grid">
          {agentItems.map((item) => item.sessions ? (
            <details className="agent-group" key={item.sessions[0].projectId}>
              <summary><span className="agent-group-chevron">›</span><strong>{item.project?.name || "Projet"}</strong><small>{item.sessions.length} agents actifs</small></summary>
              <div className="agent-group-grid">
                {item.sessions.map((session) => <DashboardAgentCard key={session.id} session={session} onOpen={onOpen} onEdit={onEdit} onFavorite={onFavorite} />)}
              </div>
            </details>
          ) : <DashboardAgentCard key={item.session.id} session={item.session} onOpen={onOpen} onEdit={onEdit} onFavorite={onFavorite} />)}
          {!sessions.length && (
            <button className="empty-agent" onClick={onNew}><span>+</span><strong>Lancer premier agent</strong><small>Codex, Claude ou terminal</small></button>
          )}
        </div>
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

function ProjectModule({ module, onToggle, onAction, onSchedule }) {
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
  const latestAction = module.actions.filter((action) => action.run).sort((left, right) => String(right.run.startedAt).localeCompare(String(left.run.startedAt)))[0];
  const latestRun = latestAction?.run;
  const runLabel = latestRun?.state === "running"
    ? `${latestAction.label} · exécution en cours…`
    : latestRun?.state === "success"
      ? `${latestAction.label} · terminé${latestRun.output ? ` · ${latestRun.output}` : ""}`
      : latestRun ? `${latestAction.label} · erreur: ${latestRun.output || "échec"}` : actionNotice;
  return (
    <article className="project-module" style={{ "--module-accent": module.accent }}>
      <header><span className="module-glyph">{module.glyph}</span><div><strong>{module.name}</strong><small>{module.description}</small></div><button className={`module-toggle ${module.enabled ? "enabled" : ""}`} onClick={toggle} disabled={busy} role="switch" aria-checked={module.enabled}><i /><span>{module.enabled ? "Actif" : "Arrêté"}</span></button></header>
      <div className="module-schedules">{module.schedules.map((schedule) => <ModuleSchedule key={schedule.id} moduleId={module.id} schedule={schedule} onSave={onSchedule} />)}</div>
      <div className="module-actions">{module.actions.map((action) => <button key={action.id} className={action.tone} onClick={() => actionRun(action)} disabled={busy || action.run?.state === "running"}>{action.run?.state === "running" ? "Exécution…" : action.label}</button>)}</div>
      {runLabel && <small className={`module-run ${latestRun?.state || "running"}`}>{runLabel}</small>}
    </article>
  );
}

function ProjectsView({ projects, sessions, modules, moduleProposals, onOpenAgent, onNew, onEdit, onDelete, onInstallModule, onModuleToggle, onModuleAction, onModuleSchedule, onOpenTodos }) {
  const [todos, setTodos] = useState(() => cachedView("todos") || []);
  const [todoBusy, setTodoBusy] = useState("");

  const loadTodos = useCallback(async () => {
    try {
      const result = await api("/api/todos");
      setTodos(result.todos || []);
      storeView("todos", result.todos || []);
    } catch { /* on garde la derniere liste connue */ }
  }, []);

  useEffect(() => { loadTodos(); }, [loadTodos]);

  async function toggleTodo(todo) {
    setTodoBusy(todo.id);
    try {
      await api(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ completed: !todo.completed }) });
      await loadTodos();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setTodoBusy("");
    }
  }

  return (
    <div className="page projects-page">
      <section className="hero-row"><div><p className="eyebrow">ORGANISATION</p><h1>Projets.</h1><p className="muted">Regroupe agents liés au même travail, sans imposer dossier.</p></div></section>
      <div className="projects-grid">
        {projects.map((project) => {
          const agents = sessions.filter((session) => session.projectId === project.id);
          const projectModules = modules.filter((module) => module.projectId === project.id);
          const proposals = moduleProposals.filter((module) => module.projectId === project.id);
          const projectTodos = todos.filter((todo) => todo.projectId === project.id);
          const openTodos = projectTodos.filter((todo) => !todo.completed);
          return (
            <article className="panel project-card" key={project.id}>
              <header><ProjectIcon project={project} /><span><strong>{project.name}{project.canEdit === false ? <b className="shared-chip" title={`Projet partagé par ${project.owner?.name || "autre profil"}`}>⇄ {project.owner?.name || "partagé"}</b> : project.shared ? <b className="shared-chip own" title="Projet partagé avec les autres profils">⇄ partagé</b> : null}</strong><small>{project.rootPath || "Dossiers propres aux agents"}</small></span>{project.canEdit !== false && <div><button onClick={() => onEdit(project.id)}>Éditer</button><button className="project-delete" onClick={() => onDelete(project)}>×</button></div>}</header>
              <p>{agents.length} agent{agents.length > 1 ? "s" : ""} actif{agents.length > 1 ? "s" : ""}</p>
              <div className="project-agents">
                {agents.map((session) => <button key={session.id} onClick={() => onOpenAgent(session.id)}><AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small /><span><strong>{session.favorite && <i className="favorite-star">★</i>}{session.name}</strong><small><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {assistantMeta[session.assistant]?.label} · {session.agentStatus?.label || "Disponible"}</small></span><b>›</b></button>)}
                {!agents.length && <span className="project-empty">Aucun agent rattaché.</span>}
              </div>
              <details className="project-todos"><summary><span>Todo</span><small>{openTodos.length} en cours · {projectTodos.length - openTodos.length} faite{projectTodos.length - openTodos.length > 1 ? "s" : ""}</small><b>›</b></summary><div className="project-todo-list">
                {projectTodos.map((todo) => (
                  <label className={todo.completed ? "project-todo done" : "project-todo"} key={todo.id}>
                    <input type="checkbox" checked={todo.completed} disabled={todoBusy === todo.id} onChange={() => toggleTodo(todo)} />
                    <span><strong>{todo.text}</strong><small className={todo.dueDate && todo.dueDate < localIsoDate() && !todo.completed ? "overdue" : ""}>{todoDueLabel(todo.dueDate)}</small></span>
                  </label>
                ))}
                {!projectTodos.length && <span className="project-empty">Aucune tâche liée.</span>}
                <button className="project-todo-link" onClick={onOpenTodos}>Ouvrir la liste complète ›</button>
              </div></details>
              {(projectModules.length > 0 || proposals.length > 0) && <details className="project-modules"><summary><span>Modules</span><small>{projectModules.length} installé{projectModules.length > 1 ? "s" : ""}{projectModules.some((module) => module.enabled) ? " · actif" : ""}</small><b>›</b></summary><div className="project-module-list">{projectModules.map((module) => <ProjectModule key={module.id} module={module} onToggle={onModuleToggle} onAction={onModuleAction} onSchedule={onModuleSchedule} />)}{proposals.map((module) => <button className="module-proposal" key={module.id} onClick={() => onInstallModule(module.id)} style={{ "--module-accent": module.accent }}><span>{module.glyph}</span><div><strong>Ajouter {module.name}</strong><small>{module.description}</small></div><b>＋</b></button>)}</div></details>}
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
        <div><p className="eyebrow">ARGENT · DONNÉES LOCALES</p><h1>Budget.</h1><p className="muted">Objectif: épargner sans perdre vue du reste à vivre.</p></div>
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
        <summary className="panel-head"><div><h3>Actifs suivis</h3><p>Épargne disponible et placements bloqués, hors comptes courants</p></div><b className="asset-split"><span>{euro(summary.assets.liquid)} dispo</span><em>{euro(summary.assets.invested)} investi</em></b><i>›</i></summary>
        <div>{summary.assets.entries.map((asset) => <article key={asset.id}><span><strong>{asset.name}</strong><small>{asset.bucket === "liquid" ? "Disponible" : "Investi · non mobilisable"}{asset.institution ? ` · ${asset.institution}` : ""}</small></span><b>{euro(asset.amount)}</b></article>)}{!summary.assets.entries.length && <p className="finance-empty">Aucun actif configuré.</p>}</div>
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
  const sortedTransactions = useMemo(() => [...(data?.transactions || [])].sort((a, b) => {
    if (sortOrder === "amount-desc") return Math.abs(b.amount) - Math.abs(a.amount) || b.date.localeCompare(a.date);
    if (sortOrder === "amount-asc") return Math.abs(a.amount) - Math.abs(b.amount) || b.date.localeCompare(a.date);
    return b.date.localeCompare(a.date) || String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  }), [data?.transactions, sortOrder]);
  return (
    <div className="page finance-page finance-operations-page has-finance-dock">
      <section className="hero-row finance-hero"><div><p className="eyebrow">BUDGET · HISTORIQUE LOCAL</p><h1>Opérations.</h1><p className="muted">Saisie manuelle et imports bancaires.</p></div><div className="budget-child-actions"><button className="ghost" onClick={() => onView("finances")}>← Budget</button><BudgetMenu onView={onView} /><div className="month-switch"><button onClick={() => shiftMonth(-1)}>‹</button><strong>{monthName}</strong><button onClick={() => shiftMonth(1)}>›</button></div></div></section>
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
          <div className="panel-head"><div><h3>Historique</h3><p>{data?.transactions.length || 0} opérations · {data?.classification.categorizedByCodex || 0}/{data?.classification.bankTransactions || 0} classées Codex</p></div><div className="transaction-tools"><button className="ghost" onClick={categorizeTransactions} disabled={categorizing}>{categorizing ? "Codex classe…" : "Reclasser Codex"}</button><label className="transaction-sort"><span>Trier</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value)}><option value="date-desc">Date récente</option><option value="amount-desc">Montant décroissant</option><option value="amount-asc">Montant croissant</option></select></label></div></div>
          <div className="transaction-list">
            {sortedTransactions.map((item) => <article className={item.excluded ? "excluded" : ""} key={item.id}><span className={`transaction-kind ${item.kind}`}>{item.excluded ? "↔" : item.kind === "income" ? "+" : "−"}</span><span><strong>{item.description}</strong><small title={item.categoryReason || ""}>{operationDate(item)} · {item.account} · {item.excluded ? exclusionLabel(item.exclusionReason) : data.categories.find(({ id }) => id === item.category)?.label || "Revenu"}{item.categorySource === "codex" ? ` · Codex: ${item.categoryReason}` : ""}</small></span><b className={item.amount >= 0 ? "income" : "expense"}>{item.amount >= 0 ? "+" : "−"}{euro(Math.abs(item.amount))}</b><button onClick={() => removeTransaction(item.id)} aria-label={`Supprimer ${item.description}`}>×</button></article>)}
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

function completedLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `Terminé le ${date.toLocaleDateString("fr-FR")} à ${date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
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
  const [openFolder, setOpenFolder] = useState(() => { try { return localStorage.getItem(profileCacheKey("todo-folder")) || null; } catch { return null; } });
  const [showDone, setShowDone] = useState({});
  const [dragging, setDragging] = useState("");
  const dragRef = React.useRef(null);
  const rowRefs = React.useRef(new Map());

  const apply = useCallback((result) => {
    if (!result) return;
    const nextTodos = result.todos || [];
    const nextFolders = result.folders || [];
    setTodos(nextTodos);
    setFolders(nextFolders);
    storeView("todos", { todos: nextTodos, folders: nextFolders });
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
    await run("new", async () => {
      const result = await api("/api/todos", { method: "POST", body: JSON.stringify({ text, folderId: !openFolder || openFolder === ROOT_FOLDER ? null : openFolder }) });
      setText("");
      return result;
    });
  }

  const update = (todo, changes) => run(todo.id, () => api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: "PATCH", body: JSON.stringify(changes) }));
  const move = (todo, direction) => run(todo.id, () => api(`/api/todos/${encodeURIComponent(todo.id)}/move`, { method: "POST", body: JSON.stringify({ direction }) }));

  // Un dossier a la fois: la page liste les dossiers, le clic ouvre son contenu.
  function selectFolder(id) {
    setOpenFolder(id);
    setDatePanel(null);
    try {
      if (id) localStorage.setItem(profileCacheKey("todo-folder"), id);
      else localStorage.removeItem(profileCacheKey("todo-folder"));
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

  // Glisser-deposer: on reordonne localement pendant le geste, on confirme au relachement.
  function startDrag(event, todo, items) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const order = items.map((item) => item.id);
    dragRef.current = { pointerId: event.pointerId, id: todo.id, folderId: todo.folderId || ROOT_FOLDER, order };
    setDragging(todo.id);
  }

  function dragOver(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const rows = drag.order.map((id) => ({ id, node: rowRefs.current.get(id) })).filter((row) => row.node);
    const hovered = rows.find((row) => {
      const box = row.node.getBoundingClientRect();
      return event.clientY < box.bottom - box.height / 2;
    });
    const nextOrder = drag.order.filter((id) => id !== drag.id);
    const at = hovered && hovered.id !== drag.id ? nextOrder.indexOf(hovered.id) : nextOrder.length;
    nextOrder.splice(at < 0 ? nextOrder.length : at, 0, drag.id);
    if (nextOrder.join() === drag.order.join()) return;
    drag.order = nextOrder;
    setTodos((items) => {
      const inFolder = new Map(items.filter((item) => nextOrder.includes(item.id)).map((item) => [item.id, item]));
      const queue = nextOrder.map((id) => inFolder.get(id));
      return items.map((item) => (inFolder.has(item.id) ? queue.shift() : item));
    });
  }

  async function endDrag(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging("");
    const position = drag.order.indexOf(drag.id);
    const beforeId = drag.order[position + 1] || null;
    await run(drag.id, () => api(`/api/todos/${encodeURIComponent(drag.id)}/move`, { method: "POST", body: JSON.stringify({ beforeId }) }));
  }

  function folderRow(todo, items) {
    const overdue = todo.dueDate && todo.dueDate < localIsoDate() && !todo.completed;
    return (
      <article
        className={`${todo.completed ? "completed" : ""} ${dragging === todo.id ? "dragging" : ""}`}
        ref={(node) => { if (node) rowRefs.current.set(todo.id, node); else rowRefs.current.delete(todo.id); }}
        key={todo.id}
      >
        <button
          className="todo-drag"
          onPointerDown={(event) => startDrag(event, todo, items)}
          onPointerMove={dragOver}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label={`Déplacer ${todo.text}`}
        >⠿</button>
        <label className="todo-check">
          <input type="checkbox" checked={todo.completed} onChange={(event) => update(todo, { completed: event.target.checked })} disabled={busy === todo.id} />
          <span>
            <strong>{todo.text}</strong>
            <small className={overdue ? "overdue" : ""}>{todo.completed ? completedLabel(todo.completedAt) || "Terminée" : todoDueLabel(todo.dueDate)}</small>
          </span>
        </label>
        <div className="todo-actions">
          <button className={todo.dueDate ? "todo-date-trigger dated" : "todo-date-trigger"} onClick={() => setDatePanel((current) => current === todo.id ? null : todo.id)} disabled={busy === todo.id} aria-label="Modifier date limite"><span aria-hidden="true">▣</span>{todo.dueDate ? todo.dueDate.slice(5).split("-").reverse().join("/") : "Date"}</button>
          <select value={todo.folderId || ROOT_FOLDER} onChange={(event) => update(todo, { folderId: event.target.value })} disabled={busy === todo.id} aria-label="Dossier">{folders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
        </div>
        {datePanel === todo.id && <div className="todo-inline-panel todo-date-panel"><span>Date limite</span><input type="date" value={todo.dueDate || ""} onChange={async (event) => { await update(todo, { dueDate: event.target.value || null }); setDatePanel(null); }} disabled={busy === todo.id} /><button onClick={async () => { await update(todo, { dueDate: null }); setDatePanel(null); }} disabled={busy === todo.id || !todo.dueDate}>Effacer</button></div>}
      </article>
    );
  }

  const openCount = todos.filter((todo) => !todo.completed).length;
  const active = sections.find((section) => section.folder.id === openFolder) || null;

  if (!active) {
    return (
      <div className="page todos-page">
        <section className="hero-row todos-hero">
          <div><p className="eyebrow">OBSIDIAN · NAS</p><h1>Todo.</h1><p className="muted">{openCount} tâche{openCount > 1 ? "s" : ""} à faire · {storage}</p></div>
          <button className="ghost" onClick={createFolder} disabled={busy === "folder"}>+ Dossier</button>
        </section>
        {error && <p className="finance-error todo-error">{error}</p>}
        <section className="todo-folder-grid">
          {sections.map(({ folder, items }) => {
            const open = items.filter((todo) => !todo.completed);
            const late = open.filter((todo) => todo.dueDate && todo.dueDate < localIsoDate()).length;
            return (
              <button className="panel todo-folder-card" onClick={() => selectFolder(folder.id)} key={folder.id}>
                <span className="todo-folder-name">{folder.name || "Dossier"}</span>
                <span className="todo-folder-meta">
                  {open.length ? `${open.length} à faire` : "Rien à faire"}
                  {items.length - open.length ? ` · ${items.length - open.length} terminée${items.length - open.length > 1 ? "s" : ""}` : ""}
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
  const open = items.filter((todo) => !todo.completed);
  const done = items.filter((todo) => todo.completed);
  return (
    <div className="page todos-page">
      <section className="hero-row todos-hero">
        <div>
          <button className="todo-back" onClick={() => selectFolder(null)}>‹ Tous les dossiers</button>
          <h1>{folder.name}</h1>
          <p className="muted">{open.length} à faire{done.length ? ` · ${done.length} terminée${done.length > 1 ? "s" : ""}` : ""}</p>
        </div>
        {!folder.projectId && folder.id !== ROOT_FOLDER && (
          <div className="todo-folder-actions">
            <button onClick={() => renameFolder(folder)} disabled={busy === folder.id} aria-label={`Renommer ${folder.name}`}>Renommer</button>
            <button onClick={() => removeFolder(folder)} disabled={busy === folder.id} aria-label={`Supprimer ${folder.name}`}>Supprimer</button>
          </div>
        )}
      </section>
      <form className="panel todo-add" onSubmit={add}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={`Ajouter dans ${folder.name}…`} maxLength="300" />
        <button className="primary" disabled={busy === "new" || !text.trim()}>{busy === "new" ? "…" : "Ajouter"}</button>
      </form>
      {error && <p className="finance-error todo-error">{error}</p>}
      <section className="panel todo-list">
        {open.map((todo) => folderRow(todo, open))}
        {!open.length && !done.length && <p className="finance-empty">Dossier vide.</p>}
        {done.length > 0 && (
          <>
            <button className="todo-done-toggle" onClick={() => setShowDone((current) => ({ ...current, [folder.id]: !current[folder.id] }))}>
              {showDone[folder.id] ? "▾" : "▸"} {done.length} terminée{done.length > 1 ? "s" : ""}
            </button>
            {showDone[folder.id] && done.map((todo) => folderRow(todo, done))}
          </>
        )}
      </section>
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

  return (
    <section className="panel profiles-settings">
      <header className="panel-head"><div><strong>Profils</strong><small>Chaque profil garde ses agents, projets, todo et budget.</small></div></header>
      <div className="profiles-grid">
        {profiles.map((item) => (
          <button className={item.id === profileId ? "active" : ""} onClick={() => onSwitch(item.id)} key={item.id}>
            <strong>{item.name}</strong>
            <small>{THEMES[item.theme]?.label || item.theme}{item.primary ? " · principal" : ""}</small>
            <em>{item.id === profileId ? "Profil actif" : "Basculer"}</em>
          </button>
        ))}
      </div>
      <div className="profile-form">
        <label htmlFor="profile-name">Nom du profil actif</label>
        <input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="profile-theme">Thème</label>
        <select id="profile-theme" value={theme} onChange={(event) => setTheme(event.target.value)}>{Object.entries(THEMES).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select>
        <label htmlFor="profile-todo">Fichier Todo Obsidian</label>
        <input id="profile-todo" value={todoFile} onChange={(event) => setTodoFile(event.target.value)} placeholder="/chemin/absolu/TO DO.md" />
        <label htmlFor="profile-mount">Montage SMB (optionnel)</label>
        <input id="profile-mount" value={todoMountUri} onChange={(event) => setTodoMountUri(event.target.value)} placeholder="smb://nas/partage" />
        <div className="modal-actions"><button className="primary" onClick={save} disabled={busy}>{busy ? "Application…" : "Enregistrer profil"}</button></div>
      </div>
      <div className="profile-form">
        <label htmlFor="profile-new">Nouveau profil</label>
        <input id="profile-new" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Prénom" />
        <select value={newTheme} onChange={(event) => setNewTheme(event.target.value)}>{Object.entries(THEMES).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select>
        <div className="modal-actions"><button className="ghost" onClick={create} disabled={busy || !newName.trim()}>Créer profil</button></div>
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function SettingsView({ permission, onNotifications, onRefresh, onView, profiles, profileId, onSwitchProfile, onProfilesChanged }) {
  const [refreshing, setRefreshing] = useState(false);
  const [versionInfo, setVersionInfo] = useState(null);
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
        <article><span className="setting-symbol update-symbol"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.2M20 5v6h-6" /></svg></span><div><strong>Mise à jour interface</strong><small>{versionInfo ? `Version ${versionInfo.version} · build ${versionInfo.build}` : "Lecture version…"}</small></div><button className="ghost" onClick={refreshApp} disabled={refreshing}>{refreshing ? "Actualisation…" : "Recharger dernière version"}</button></article>
        <article><span className="setting-symbol">⌁</span><div><strong>Connexions bancaires</strong><small>Enable Banking: application ID, URL de retour, clé privée, banques liées.</small></div><button className="ghost" onClick={() => onView("finance-banking")}>Ouvrir réglages</button></article>
        <article><span className="setting-symbol">⌁</span><div><strong>Connexion privée</strong><small>{window.isSecureContext ? "HTTPS actif · notifications compatibles" : "Ouvre version HTTPS via VPN"}</small></div><b className={window.isSecureContext ? "setting-ok" : "setting-warn"}>{window.isSecureContext ? "ACTIF" : "REQUIS"}</b></article>
      </section>
      {profiles.length > 0 && <ProfilesSettings key={profileId} profiles={profiles} profileId={profileId} onSwitch={onSwitchProfile} onChanged={onProfilesChanged} />}
    </div>
  );
}

function TerminalView({ session, onBack, onKilled, onMigrated, onRefresh }) {
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
  }, [session.migrationState, session.migratedTo, onMigrated]);

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
    applyHeight();
    viewport?.addEventListener("resize", updateHeight);
    viewport?.addEventListener("scroll", updateHeight);
    window.addEventListener("resize", updateHeight);
    return () => {
      viewport?.removeEventListener("resize", updateHeight);
      viewport?.removeEventListener("scroll", updateHeight);
      window.removeEventListener("resize", updateHeight);
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
    const touchTerminal = TOUCH_MODE || coarsePointer;
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: touchTerminal,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      scrollback: touchTerminal ? 0 : 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalNode.current);
    fit.fit();
    terminalRef.current = terminal;
    const xtermViewport = terminalNode.current.querySelector(".xterm-viewport");
    if (touchTerminal) {
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
    const openKeyboard = () => focusKeyboard();
    terminalNode.current.addEventListener("click", openKeyboard);
    const handleMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "output") {
        terminal.write(message.data, () => {
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
        if (!touchTerminal) terminal.focus();
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
      inputDisposable.dispose();
      socket?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [session.id, session.name]);

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

  function focusKeyboard() {
    if (TOUCH_MODE || window.matchMedia("(pointer: coarse)").matches) {
      const input = keyboardRef.current;
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

  async function attachFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sessionId", session.id);
      const uploaded = await api("/api/uploads/file", { method: "POST", body: form });
      if (socketRef.current?.readyState !== WebSocket.OPEN) throw new Error("Terminal déconnecté. Réessaie après reconnexion.");
      socketRef.current.send(JSON.stringify({ type: "submit", data: `${uploaded.image ? "Image" : "Fichier"} joint à examiner : ${uploaded.path}` }));
      focusKeyboard();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setUploading(false);
    }
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
      const data = await navigator.clipboard.readText();
      if (!data) throw new Error("Presse-papiers vide.");
      sendKeyboardData(data);
    } catch (error) {
      focusKeyboard();
      window.alert(error.message === "Presse-papiers vide." ? error.message : "Accès presse-papiers refusé. Touche zone terminal puis utilise Coller du clavier iOS.");
    }
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
      await navigator.clipboard.writeText(content);
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
    if (restarting || !window.confirm("Redémarrer l'agent en reprenant la conversation en cours ?")) return;
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

  async function kill() {
    if (!window.confirm(`Arrêter définitivement session « ${session.name} » ?`)) return;
    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
    onKilled();
  }

  async function migrate() {
    const target = session.assistant === "codex" ? "claude" : "codex";
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
          {["codex", "claude"].includes(session.assistant) && <button className="migrate-link" onClick={migrate} title={migrating ? "Appuie à nouveau pour basculer sans attendre le récap" : "Basculer d'agent en gardant le contexte"}>{migrating ? "Récap… ↻" : `→ ${session.assistant === "codex" ? "Claude" : "Codex"}`}</button>}
          {session.managed && !session.core && <button className="danger-link" onClick={kill} aria-label="Arrêter agent" title="Arrêter">⏻</button>}
        </div>
      </div>
      <div className="terminal-frame" ref={terminalNode} />
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
          <button className="keyboard-key" {...tapKey(focusKeyboard)} aria-label="Afficher le clavier">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M9.5 13.5h6.5" /></svg>
          </button>
          <label className={`upload-key ${uploading ? "disabled" : ""}`} aria-label="Joindre photo ou fichier">
            <input type="file" onChange={attachFile} disabled={uploading} />
            <span>{uploading ? "…" : "＋"}</span>
          </label>
          {session.managed && <button className="restart-key" {...tapKey(restart)} aria-label="Redémarrer l'agent">
            {restarting ? "…" : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.2M20 5v6h-6" /></svg>}
          </button>}
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

function NewSessionModal({ projects, sessions, onClose, onCreated }) {
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
            {Object.entries(assistantMeta).map(([id, meta]) => <button type="button" className={assistant === id ? "selected" : ""} onClick={() => setAssistant(id)} key={id}><AgentIcon assistant={id} /><span>{meta.label}</span></button>)}
          </div>
          <label htmlFor="name">Nom</label>
          <input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder={`Ex. ${assistant === "shell" ? "Serveur local" : "Refonte dashboard"}`} />
          <label htmlFor="project">Projet</label>
          <select id="project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Sans projet</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
          <label htmlFor="cwd">Dossier de travail</label>
          <input id="cwd" list="agent-directories" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/home/user/projects/mon-projet" autoComplete="off" spellCheck="false" />
          <datalist id="agent-directories">{[...new Set(sessions.map((session) => session.cwd).filter(Boolean))].map((directory) => <option value={directory} key={directory} />)}</datalist>
          <p className="form-hint">Chemin existant sur ce PC. Vide = dossier projets par défaut. Projet sert seulement au classement.</p>
          {assistant !== "shell" && <label className="checkbox-option"><input type="checkbox" checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span><strong>Sans confirmation</strong><small>{assistant === "codex" ? "Codex --yolo" : "Claude --dangerously-skip-permissions"}</small></span></label>}
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
      const result = await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ name, assistant, yolo, projectLogo, projectId: projectId || null, favorite, shared }) });
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
          {["codex", "claude"].includes(session.assistant) && <>
            <label htmlFor="edit-assistant">Agent</label>
            <select id="edit-assistant" value={assistant} onChange={(event) => setAssistant(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option></select>
            {assistant !== session.assistant && <p className="form-hint">Bascule immédiate: historique de la dernière conversation transmis au nouvel agent.</p>}
          </>}
          <label htmlFor="edit-project">Projet</label>
          <select id="edit-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Sans projet</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
          {session.assistant !== "shell" && <label className="checkbox-option"><input type="checkbox" checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span><strong>Sans confirmation</strong><small>{session.assistant === "codex" ? "Codex --yolo" : "Claude --dangerously-skip-permissions"}</small></span></label>}
          <label className="checkbox-option"><input type="checkbox" checked={projectLogo} onChange={(event) => setProjectLogo(event.target.checked)} /><span><strong>Logo projet auto</strong><small>Remplace icône agent si logo trouvé</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} /><span><strong>Agent favori</strong><small>Affiché avant autres agents</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /><span><strong>Partager l’agent</strong><small>Visible et utilisable depuis les autres profils</small></span></label>
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api(project ? `/api/projects/${project.id}` : "/api/projects", { method: project ? "PATCH" : "POST", body: JSON.stringify({ name, rootPath: null, shared }) });
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

  const refresh = useCallback(async () => {
    try {
      const [{ sessions: nextSessions, quotas: nextQuotas }, { projects: nextProjects }, nextModules] = await Promise.all([api("/api/sessions"), api("/api/projects"), api("/api/modules")]);
      setSessions(nextSessions);
      setQuotas(nextQuotas || { codex: null, claude: null });
      setProjects(nextProjects);
      setModules(nextModules.modules || []);
      setModuleProposals(nextModules.proposals || []);
    } catch (error) {
      if (/autorisé|401/i.test(error.message)) setAuth(false);
    }
  }, []);

  const refreshQuotas = useCallback(async () => {
    try {
      const result = await api("/api/quotas/refresh", { method: "POST" });
      if (result?.quotas) setQuotas(result.quotas);
    } catch { /* quotas indisponibles, on garde l'affichage courant */ }
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
    return () => { disposed = true; clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let reloading = false;
    const refresh = () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    };
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
    const receiveUpdate = (event) => {
      if (event.data?.type === "NOYAU_UPDATE") return refresh();
      if (event.data?.type === "NOYAU_NAVIGATE" && event.data.url) receiveNavigation(event.data.url);
    };
    navigator.serviceWorker.addEventListener("controllerchange", refresh);
    navigator.serviceWorker.addEventListener("message", receiveUpdate);
    navigator.serviceWorker.register("/sw.js").then((registration) => registration.update()).catch(() => {});
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", refresh);
      navigator.serviceWorker.removeEventListener("message", receiveUpdate);
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

  function switchProfile(id) {
    if (!id || id === profileId) return;
    try { localStorage.setItem(PROFILE_KEY, id); } catch { /* stockage optionnel */ }
    applyTheme(profiles.find((item) => item.id === id)?.theme);
    // Sessions, terminal et caches sont lies au profil: on repart d'une page propre, sans reconnexion.
    location.assign(appPath());
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
        await api("/api/notifications/subscribe", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
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

  return (
    <div className={`app-shell ${TOUCH_MODE ? "touch-shell" : ""}`}>
      {TOUCH_MODE && <TouchSystemBar sessions={orderedSessions} onHome={() => { setActiveId(null); setView("dashboard"); }} onNew={() => setModal(true)} />}
      <Sidebar sessions={orderedSessions} activeId={activeId} view={view} onOpen={setActiveId} onView={setView} onNew={() => setModal(true)} onLogout={logout} open={menu} onClose={() => setMenu(false)} profiles={profiles} profileId={profileId} onSwitchProfile={switchProfile} />
      {menu && <button className="menu-backdrop" onClick={() => setMenu(false)} aria-label="Fermer menu" />}
      <main className="content">
        <ViewBoundary viewKey={`${view}:${activeId || ""}`}>
        {!active ? (
          <>
            {view === "dashboard" && <><Header title="Accueil" subtitle="Vue générale" onMenu={() => setMenu(true)} onAction={() => setModal(true)} /><Dashboard sessions={orderedSessions} projects={projects} quotas={quotas} onRefreshQuotas={refreshQuotas} onOpen={setActiveId} onNew={() => setModal(true)} onEdit={setEditingId} onFavorite={toggleFavorite} onProjects={() => setView("projects")} onFinances={() => setView("finances")} /></>}
            {view === "projects" && <><Header title="Projets" subtitle="Agents et modules" onMenu={() => setMenu(true)} actionLabel="Nouveau projet" onAction={() => setProjectModalId("new")} /><ProjectsView projects={projects} sessions={orderedSessions} modules={modules} moduleProposals={moduleProposals} onOpenAgent={setActiveId} onNew={() => setProjectModalId("new")} onEdit={setProjectModalId} onDelete={deleteProject} onInstallModule={installModule} onModuleToggle={toggleModule} onModuleAction={runModuleAction} onModuleSchedule={saveModuleSchedule} onOpenTodos={() => setView("todos")} /></>}
            {view === "todos" && <><Header title="Todo" subtitle="Obsidian · NAS" onMenu={() => setMenu(true)} /><TodosView /></>}
            {view === "finances" && <><Header title="Budget" subtitle="Dépenses et épargne" onMenu={() => setMenu(true)} /><FinanceView onView={setView} /></>}
            {view === "finance-transactions" && <><Header title="Budget · Opérations" subtitle="Saisie et historique" onMenu={() => setMenu(true)} /><FinanceTransactionsView onView={setView} /></>}
            {view === "finance-agent" && <><Header title="Budget · Agent" subtitle="Charges et prévisions" onMenu={() => setMenu(true)} /><FinanceAgentView onView={setView} /></>}
            {view === "finance-modules" && <><Header title="Budget · Modules" subtitle="Actifs et règles" onMenu={() => setMenu(true)} /><FinanceModulesView onView={setView} /></>}
            {view === "finance-banking" && <><Header title="Budget · Banques" subtitle="Connexions et synchronisation" onMenu={() => setMenu(true)} /><FinanceBankingView onView={setView} /></>}
            {view === "settings" && <><Header title="Réglages" subtitle="Application" onMenu={() => setMenu(true)} /><SettingsView permission={permission} onNotifications={enableNotifications} onRefresh={reloadLatest} onView={setView} profiles={profiles} profileId={profileId} onSwitchProfile={switchProfile} onProfilesChanged={refreshProfiles} /></>}
          </>
        ) : (
          <TerminalView session={active} onBack={() => setActiveId(null)} onKilled={() => { setActiveId(null); refresh(); }} onMigrated={(id) => { setActiveId(id); refresh(); }} onRefresh={refresh} />
        )}
        </ViewBoundary>
      </main>
      {modal && <NewSessionModal projects={projects} sessions={orderedSessions} onClose={() => setModal(false)} onCreated={(session) => { setModal(false); setActiveId(session.id); refresh(); }} />}
      {editingSession && <EditSessionModal session={editingSession} projects={projects} onClose={() => setEditingId(null)} onSaved={(next, meta) => { setEditingId(null); if (meta?.switched && next?.id) { if (activeId === editingSession.id) setActiveId(next.id); } refresh(); }} />}
      {projectModalId && <ProjectModal project={editingProject} onClose={() => setProjectModalId(null)} onSaved={() => { setProjectModalId(null); refresh(); }} />}
    </div>
  );
}

window.__noyauMounted = true;
createRoot(document.getElementById("root")).render(<App />);
