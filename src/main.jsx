import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./theme-castle.css";
import { shouldCopyTerminal } from "./terminal-shortcuts.js";
import TelegramGrowthChat from "./telegram-growth-chat.jsx";

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
const SOUND_KEY = "noyau:sound";
const VOICE_HINT_KEY = "noyau:voice-hint";

export function soundMuted() {
  try { return localStorage.getItem(SOUND_KEY) === "off"; } catch { return false; }
}

function setSoundMuted(muted) {
  try { localStorage.setItem(SOUND_KEY, muted ? "off" : "on"); } catch { /* stockage optionnel */ }
}

// Sons courts synthetises: aucun fichier a charger, donc aucun delai au premier declenchement.
let audioContext = null;
function playTone(steps) {
  if (soundMuted()) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audioContext = audioContext || new Context();
    if (audioContext.state === "suspended") audioContext.resume();
    const start = audioContext.currentTime;
    steps.forEach(({ frequency, at, duration, gain = 0.06 }) => {
      const oscillator = audioContext.createOscillator();
      const volume = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      volume.gain.setValueAtTime(0, start + at);
      volume.gain.linearRampToValueAtTime(gain, start + at + 0.012);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + at + duration);
      oscillator.connect(volume).connect(audioContext.destination);
      oscillator.start(start + at);
      oscillator.stop(start + at + duration + 0.02);
    });
  } catch { /* audio indisponible */ }
}

export const sounds = {
  agentWaiting: () => playTone([{ frequency: 880, at: 0, duration: 0.12 }, { frequency: 1174, at: 0.1, duration: 0.16 }]),
  agentDone: () => playTone([{ frequency: 660, at: 0, duration: 0.1 }, { frequency: 990, at: 0.09, duration: 0.14 }]),
  voiceHeard: () => playTone([{ frequency: 1320, at: 0, duration: 0.07, gain: 0.045 }]),
};

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
  "moving-castle": { label: "Château ambulant", terminal: { background: "#0f1119", foreground: "#eeeae3", cursor: "#e1b047", selectionBackground: "#e1b04744" } },
};

function applyTheme(theme) {
  const value = THEMES[theme] ? theme : "noyau";
  document.documentElement.dataset.theme = value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", value === "moving-castle" ? "#0f1119" : "#080b0a");
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

const OFFLINE_QUEUE_KEY = "noyau-offline-queue";

function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]"); } catch { return []; }
}

function enqueueOfflineMutation(mutation) {
  const queue = getOfflineQueue();
  queue.push({
    id: `mut-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...mutation,
  });
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  window.dispatchEvent(new CustomEvent("noyau:offline-queue", { detail: { count: queue.length } }));
}

async function flushOfflineQueue() {
  const queue = getOfflineQueue();
  if (!queue.length) return { flushed: 0 };
  const remaining = [];
  let flushed = 0;
  for (const item of queue) {
    try {
      const res = await fetch(item.path, {
        method: item.method || "POST",
        headers: {
          "Content-Type": "application/json",
          ...(item.profileId ? { "X-Noyau-Profile": item.profileId } : {}),
        },
        body: item.body ? (typeof item.body === "string" ? item.body : JSON.stringify(item.body)) : undefined,
      });
      if (res.ok || res.status < 500) {
        flushed++;
      } else {
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
  window.dispatchEvent(new CustomEvent("noyau:offline-queue", { detail: { count: remaining.length } }));
  return { flushed, remaining: remaining.length };
}

async function api(path, options = {}) {
  const multipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const profileId = activeProfileId();
  const method = (options.method || "GET").toUpperCase();
  const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);

  try {
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
  } catch (error) {
    if (isMutation && (!error.status || error.status >= 500 || error.name === "TypeError" || /failed to fetch/i.test(error.message))) {
      enqueueOfflineMutation({ path, method, body: options.body, profileId });
      return { offlineQueued: true, success: true };
    }
    throw error;
  }
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

function Boot({ percent, step, offline, detail, attempts, onRetry, onReset, onEnterOffline }) {
  const [vpnGuideOpen, setVpnGuideOpen] = useState(false);
  const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && !window.MSStream;

  const handleWireGuardClick = () => {
    if (isApple) {
      setVpnGuideOpen(true);
    } else {
      try {
        window.location.href = "intent://#Intent;package=com.wireguard.android;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end";
      } catch {
        try {
          window.location.href = "wireguard://";
        } catch {
          setVpnGuideOpen(true);
        }
      }
    }
  };

  return (
    <div className="boot">
      <div className="boot-content">
        <Mark />
        <strong>Noyau</strong>
        {!offline && <BootRing percent={percent} />}
        <small className={offline ? "boot-step error" : "boot-step"}>{offline ? "VPN déconnecté" : step}</small>
        {offline && (
          <div className="boot-vpn-box">
            <div className="vpn-prompt-card" onClick={handleWireGuardClick} role="button" tabIndex={0} title="Cliquer pour instructions WireGuard">
              <div className="vpn-shield-badge">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              </div>
              <strong className="vpn-badge-title">TURN ON VPN FIRST</strong>
              <p className="vpn-badge-sub">Le Noyau tourne sur ton serveur privé local. Active WireGuard pour synchroniser en direct.</p>
              <button type="button" className="vpn-redirect-button" onClick={(e) => { e.stopPropagation(); handleWireGuardClick(); }}>
                🛡️ Ouvrir l’application WireGuard
              </button>
            </div>

            <p className="muted boot-detail">{detail || "Vérifie le tunnel WireGuard / le Wi-Fi local."} ({attempts} tentative{attempts > 1 ? "s" : ""})</p>

            <div className="boot-actions boot-vpn-actions">
              <button type="button" className="primary highlight-offline" onClick={onEnterOffline}>
                ⚡ Accéder au Noyau en hors-ligne
              </button>
              <button type="button" className="ghost" onClick={onRetry}>Réessayer connexion</button>
              <button type="button" className="ghost danger" onClick={onReset}>Réinitialiser</button>
            </div>
          </div>
        )}
      </div>

      {vpnGuideOpen && (
        <div className="modal-backdrop" onClick={() => setVpnGuideOpen(false)}>
          <div className="modal vpn-guide-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>🛡️ Activer WireGuard {isApple ? "sur iOS" : "sur mobile"}</h2>
              <button type="button" className="icon-button" onClick={() => setVpnGuideOpen(false)}>×</button>
            </div>
            <div className="vpn-guide-content">
              <p className="muted small">
                Sur iOS, Safari bloque l'ouverture directe d'applications VPN tierces (adresse invalide).
              </p>
              <div className="vpn-guide-steps">
                <div className="vpn-guide-step">
                  <span className="step-num">1</span>
                  <div>
                    <strong>Ouvrir l’app WireGuard</strong>
                    <small>Ouvre WireGuard depuis ton écran d'accueil et active ton tunnel.</small>
                  </div>
                </div>
                <div className="vpn-guide-step highlight">
                  <span className="step-num">2</span>
                  <div>
                    <strong>⚡ Recommandé : Activer « Sur demande » (On-Demand)</strong>
                    <small>Dans WireGuard, modifie ton tunnel et active <strong>« Sur demande »</strong> (Wi-Fi et Cellulaire). WireGuard s'allumera automatiquement chaque fois que tu ouvriras Noyau !</small>
                  </div>
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="primary" onClick={() => { setVpnGuideOpen(false); onEnterOffline(); }}>
                  ⚡ Accéder au Noyau en hors-ligne
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Login({ onLogin }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState(() => {
    try {
      return new URLSearchParams(location.search).get("profile") || localStorage.getItem(PROFILE_KEY) || "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    fetch("/api/auth/profiles", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.profiles?.length) {
          setProfiles(data.profiles);
          setSelectedProfileId((current) => {
            if (current && data.profiles.some((p) => p.id === current)) return current;
            return data.profiles.find((p) => p.primary)?.id || data.profiles[0]?.id || "";
          });
        }
      })
      .catch(() => {});
  }, []);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await api("/api/auth", {
        method: "POST",
        body: JSON.stringify({
          password: token,
          token,
          profileId: selectedProfileId || undefined,
          remember,
        }),
      });
      if (res?.profile?.id) {
        try { localStorage.setItem(PROFILE_KEY, res.profile.id); } catch { /* ignore */ }
      }
      onLogin();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  return (
    <main className="login-shell">
      <section className="login-card">
        <Mark />
        <p className="eyebrow">CENTRE DE CONTRÔLE LOCAL</p>
        <h1>Noyau</h1>
        <p className="muted">Tes agents. Ton ordinateur. Depuis partout.</p>
        {profiles.length > 1 && (
          <div className="login-profile-picker">
            <span className="login-profile-label">Profil de connexion</span>
            <div className="login-profiles-list">
              {profiles.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`login-profile-btn ${p.id === selectedProfileId ? "active" : ""}`}
                  onClick={() => { setSelectedProfileId(p.id); setError(""); }}
                >
                  <strong>{p.name}</strong>
                  <small>{THEMES[p.theme]?.label || p.theme}{p.hasPassword ? " · code" : ""}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        <form onSubmit={submit}>
          <label htmlFor="token">
            {selectedProfile ? `Mot de passe (${selectedProfile.name})` : "Mot de passe ou clé d’accès"}
          </label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoFocus
            autoComplete="current-password"
            placeholder={selectedProfile?.hasPassword ? "Mot de passe du profil" : "Mot de passe ou clé master"}
          />
          <label className="login-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>Garder la session active (2h max)</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary wide" disabled={!token || loading}>{loading ? "Connexion…" : "Entrer"}</button>
        </form>
        <p className="login-hint">Session limitée à 2h max pour ta sécurité. Clé master dans terminal en secours.</p>
      </section>
    </main>
  );
}

function SwitchProfileModal({ target, onClose, onConfirm }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onConfirm(password);
    } catch (err) {
      setError(err.message || "Mot de passe incorrect pour ce profil.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <h2>Accéder à {target.name}</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Fermer">✕</button>
        </header>
        <form onSubmit={submit}>
          <p className="muted" style={{ marginBottom: "16px" }}>
            Entre le mot de passe pour basculer sur le profil <strong>{target.name}</strong>.
          </p>
          <label htmlFor="switch-profile-pwd">Mot de passe</label>
          <input
            id="switch-profile-pwd"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            placeholder={target.hasPassword ? "Mot de passe du profil" : "Mot de passe ou clé master"}
            autoComplete="current-password"
          />
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>Annuler</button>
            <button type="submit" className="primary" disabled={!password || busy}>
              {busy ? "Vérification…" : "Basculer"}
            </button>
          </div>
        </form>
      </div>
    </div>
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
  useEffect(() => setFailed(false), [project?.logoUrl]);
  if (project?.logoUrl && !failed) return <span className={`agent-icon project-logo ${small ? "small" : ""}`}><img src={project.logoUrl} alt="" onError={() => setFailed(true)} /></span>;
  return <span className={`agent-icon violet ${small ? "small" : ""}`}>{project ? "P" : "📁"}</span>;
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

const AGENT_SORT_MODES = ["recent", "alpha", "project"];

const AGENT_SORT_LABELS = {
  recent: "Récents",
  alpha: "A-Z",
  project: "Projets",
};

const AGENT_SORT_TOOLTIPS = {
  recent: "Tri : Plus récemment utilisés (favoris d'abord)",
  alpha: "Tri : Alphabétique A-Z (favoris d'abord)",
  project: "Tri : Par projet (favoris d'abord)",
};

function getAgentTimestamp(session, lastInteractedMap = {}) {
  const interacted = Number(lastInteractedMap?.[session.id]);
  if (Number.isFinite(interacted) && interacted > 0) {
    return interacted;
  }
  return session.createdAt ? Date.parse(session.createdAt) || 0 : 0;
}

function sortAgents(sessions, mode = "recent", lastInteractedMap = {}) {
  if (mode === "project") {
    const projectStats = new Map();
    for (const session of sessions) {
      const pId = session.projectId || "__none__";
      const stats = projectStats.get(pId) || { maxTime: 0, hasFav: false, name: session.project?.name || "" };
      const time = getAgentTimestamp(session, lastInteractedMap);
      if (time > stats.maxTime) stats.maxTime = time;
      if (session.favorite) stats.hasFav = true;
      if (!stats.name && session.project?.name) stats.name = session.project.name;
      projectStats.set(pId, stats);
    }

    return [...sessions].sort((a, b) => {
      const pIdA = a.projectId || "__none__";
      const pIdB = b.projectId || "__none__";
      if (pIdA !== pIdB) {
        if (pIdA === "__none__") return 1;
        if (pIdB === "__none__") return -1;
        const statsA = projectStats.get(pIdA);
        const statsB = projectStats.get(pIdB);
        if (statsA.hasFav !== statsB.hasFav) return statsB.hasFav ? 1 : -1;
        if (statsA.maxTime !== statsB.maxTime) return statsB.maxTime - statsA.maxTime;
        return (statsA.name || "").localeCompare(statsB.name || "", "fr");
      }
      // Inside same project:
      const favA = a.favorite ? 1 : 0;
      const favB = b.favorite ? 1 : 0;
      if (favA !== favB) return favB - favA;
      const timeDiff = getAgentTimestamp(b, lastInteractedMap) - getAgentTimestamp(a, lastInteractedMap);
      if (timeDiff !== 0) return timeDiff;
      return (a.name || "").localeCompare(b.name || "", "fr");
    });
  }

  return [...sessions].sort((a, b) => {
    // 1. Toujours les favoris d'abord
    const favA = a.favorite ? 1 : 0;
    const favB = b.favorite ? 1 : 0;
    if (favA !== favB) return favB - favA;

    // 2. Récents : le plus récemment utilisé (parlé ou lettre saisie) en premier
    if (mode === "recent") {
      const timeDiff = getAgentTimestamp(b, lastInteractedMap) - getAgentTimestamp(a, lastInteractedMap);
      if (timeDiff !== 0) return timeDiff;
      return (a.name || "").localeCompare(b.name || "", "fr");
    }

    // 3. Alphabétique
    if (mode === "alpha") {
      return (a.name || "").localeCompare(b.name || "", "fr", { sensitivity: "base" });
    }

    return 0;
  });
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

function Sidebar({ sessions, projects = [], activeId, view, onOpen, onView, onNew, onLogout, open, onClose, profiles, profileId, onSwitchProfile, todoUnread = 0, sortMode = "recent", onCycleSort, lastInteractedMap = {} }) {
  const [expandedProjects, setExpandedProjects] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(profileCacheKey("agents-expanded-projects"))) || {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(profileCacheKey("agents-expanded-projects")));
      setExpandedProjects(stored || {});
    } catch {
      setExpandedProjects({});
    }
  }, [profileId]);

  const toggleProjectCollapse = useCallback((projectId, isOpen) => {
    setExpandedProjects((prev) => {
      const isCurrentlyOpen = Boolean(prev[projectId]);
      if (isCurrentlyOpen === isOpen) return prev;
      const next = { ...prev };
      if (isOpen) {
        next[projectId] = true;
      } else {
        delete next[projectId];
      }
      try {
        localStorage.setItem(profileCacheKey("agents-expanded-projects"), JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);


  const projectGroups = useMemo(() => {
    const groupsMap = new Map();
    const noProjectSessions = [];

    sessions.forEach((session) => {
      const pId = session.projectId;
      if (!pId) {
        noProjectSessions.push(session);
        return;
      }
      let group = groupsMap.get(pId);
      if (!group) {
        const projectObj = projects.find((p) => p.id === pId) || session.project || { id: pId, name: session.project?.name || "Projet" };
        group = {
          projectId: pId,
          project: projectObj,
          name: projectObj.name || session.project?.name || "Projet",
          sessions: [],
          hasWorking: false,
          hasFavorite: false,
          maxTime: 0,
        };
        groupsMap.set(pId, group);
      }
      group.sessions.push(session);
      if (session.favorite) group.hasFavorite = true;
      if (session.agentStatus?.state === "working") group.hasWorking = true;
      const t = getAgentTimestamp(session, lastInteractedMap);
      if (t > group.maxTime) group.maxTime = t;
    });

    const list = Array.from(groupsMap.values());

    if (sortMode === "alpha") {
      list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "fr"));
    } else {
      list.sort((a, b) => {
        if (a.hasFavorite !== b.hasFavorite) return b.hasFavorite ? 1 : -1;
        if (a.maxTime !== b.maxTime) return b.maxTime - a.maxTime;
        return (a.name || "").localeCompare(b.name || "", "fr");
      });
    }

    list.forEach((g) => {
      g.sessions.sort((a, b) => {
        const favA = a.favorite ? 1 : 0;
        const favB = b.favorite ? 1 : 0;
        if (favA !== favB) return favB - favA;

        if (sortMode === "alpha") {
          return (a.name || "").localeCompare(b.name || "", "fr", { sensitivity: "base" });
        }
        const timeDiff = getAgentTimestamp(b, lastInteractedMap) - getAgentTimestamp(a, lastInteractedMap);
        if (timeDiff !== 0) return timeDiff;
        return (a.name || "").localeCompare(b.name || "", "fr");
      });
    });

    if (noProjectSessions.length > 0) {
      noProjectSessions.sort((a, b) => {
        const favA = a.favorite ? 1 : 0;
        const favB = b.favorite ? 1 : 0;
        if (favA !== favB) return favB - favA;
        if (sortMode === "alpha") {
          return (a.name || "").localeCompare(b.name || "", "fr", { sensitivity: "base" });
        }
        const timeDiff = getAgentTimestamp(b, lastInteractedMap) - getAgentTimestamp(a, lastInteractedMap);
        if (timeDiff !== 0) return timeDiff;
        return (a.name || "").localeCompare(b.name || "", "fr");
      });
      list.push({
        projectId: "__none__",
        project: null,
        name: "Sans projet",
        sessions: noProjectSessions,
        hasWorking: noProjectSessions.some((s) => s.agentStatus?.state === "working"),
      });
    }
    return list;
  }, [sessions, projects, sortMode, lastInteractedMap]);

  const renderSessionButton = (session) => (
    <button className={activeId === session.id ? "active" : ""} onClick={() => { onOpen(session.id); onClose(); }} key={session.id}>
      <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small />
      <span><strong>{session.favorite && <b className="favorite-star">★</b>}{session.name}{(session.shared || session.canEdit === false) && <b className="shared-star" title={session.canEdit === false ? `Partagé par ${session.owner?.name || "autre profil"}` : "Partagé avec les autres profils"}>⇄</b>}</strong><small>{session.canEdit === false ? `${session.owner?.name || "Autre profil"} · ` : ""}{assistantMeta[session.assistant]?.label || "Terminal"} · {session.agentStatus?.label || "Disponible"}</small></span>
      <i className={`live-dot ${session.agentStatus?.state || "available"}`} title={session.agentStatus?.label || "Disponible"} />
    </button>
  );

  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><Mark /><span>Noyau</span><button className="icon-button close-menu" onClick={onClose} aria-label="Fermer">×</button></div>
      <ProfileSwitcher profiles={profiles} profileId={profileId} onSwitch={onSwitchProfile} onLogout={onLogout} />
      <nav className="main-nav">
        <button className={!activeId && view === "dashboard" ? "active" : ""} onClick={() => { onOpen(null); onView("dashboard"); onClose(); }}><span>⌂</span>Accueil</button>
        <button className={!activeId && view === "projects" ? "active" : ""} onClick={() => { onOpen(null); onView("projects"); onClose(); }}><span className="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg></span>Projets</button>
        <button className={!activeId && view === "calendar" ? "active" : ""} onClick={() => { onOpen(null); onView("calendar"); onClose(); }}><span className="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /><circle cx="8" cy="14" r=".75" fill="currentColor" /><circle cx="12" cy="14" r=".75" fill="currentColor" /><circle cx="16" cy="14" r=".75" fill="currentColor" /><circle cx="8" cy="18" r=".75" fill="currentColor" /><circle cx="12" cy="18" r=".75" fill="currentColor" /><circle cx="16" cy="18" r=".75" fill="currentColor" /></svg></span>Calendrier</button>
        <button className={!activeId && view === "todos" ? "active" : ""} onClick={() => { onOpen(null); onView("todos"); onClose(); }}><span>✓</span>Todo{todoUnread > 0 && <b className="nav-badge" title={`${todoUnread} changement${todoUnread > 1 ? "s" : ""} non lu${todoUnread > 1 ? "s" : ""}`}>{todoUnread > 99 ? "99+" : todoUnread}</b>}</button>
        <button className={!activeId && ["finances", "finance-transactions", "finance-agent", "finance-modules"].includes(view) ? "active" : ""} onClick={() => { onOpen(null); onView("finances"); onClose(); }}><span>€</span>Budget</button>
        <button className={!activeId && view === "settings" ? "active" : ""} onClick={() => { onOpen(null); onView("settings"); onClose(); }}><span className="nav-settings-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h10m4 0h2M4 17h2m4 0h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg></span>Réglages</button>
      </nav>
      <div className="sidebar-title">
        <div className="sidebar-title-left">
          {onCycleSort && (
            <button
              type="button"
              className="sidebar-sort-btn"
              onClick={onCycleSort}
              title={AGENT_SORT_TOOLTIPS[sortMode] || "Trier les agents"}
              aria-label={AGENT_SORT_TOOLTIPS[sortMode] || "Trier les agents"}
            >
              {sortMode === "alpha" ? (
                <span className="sidebar-sort-text" aria-hidden="true">AZ</span>
              ) : sortMode === "project" ? (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              )}
            </button>
          )}
          <span>AGENTS</span>
        </div>
        <button onClick={onNew} aria-label="Nouvelle session">+</button>
      </div>
      <div className="session-list">
        {projectGroups.map((group) => {
          // Un projet a agent unique n'a pas besoin d'accordeon: l'agent s'affiche directement.
          if (group.sessions.length === 1) return renderSessionButton(group.sessions[0]);
          const hasActive = activeId && group.sessions.some((s) => s.id === activeId);
          const isOpen = Boolean(expandedProjects[group.projectId]) || Boolean(hasActive);
          return (
            <details
              className="sidebar-agent-group"
              key={group.projectId}
              open={isOpen}
              onToggle={(e) => toggleProjectCollapse(group.projectId, e.currentTarget.open)}
            >
            <summary className="sidebar-group-summary">
              <span className="sidebar-group-chevron">›</span>
              <ProjectIcon project={group.project} small />
              <span className="sidebar-group-name" title={group.name}>{group.name}</span>
              <span className="sidebar-group-meta">
                {group.hasWorking && <i className="live-dot working" title="Un agent travaille" />}
                <small className="sidebar-group-count">{group.sessions.length}</small>
              </span>
            </summary>
            <div className="sidebar-group-items">
              {group.sessions.map(renderSessionButton)}
            </div>
          </details>
        );
      })}
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

const CONTEXT_DISMISS_KEY = "noyau:context-dismissed";
const CONTEXT_GAUGE_STEPS = 10;

function readDismissed() {
  try { return JSON.parse(localStorage.getItem(CONTEXT_DISMISS_KEY)) || {}; } catch { return {}; }
}

function writeDismissed(next) {
  try { localStorage.setItem(CONTEXT_DISMISS_KEY, JSON.stringify(next)); } catch { /* stockage optionnel */ }
}

// Jauge graduee: chaque cran represente 10% de fenetre consommee.
function ContextGauge({ advice, small = false }) {
  if (!advice) return null;
  const used = Math.max(0, Math.min(100, 100 - advice.percent));
  const lit = Math.round((used / 100) * CONTEXT_GAUGE_STEPS);
  return (
    <span className={`context-gauge ${advice.level}${small ? " small" : ""}`} title={`${advice.percent}% de contexte restant${advice.message ? ` · ${advice.message}` : ""}`}>
      <span className="context-gauge-steps" aria-hidden="true">
        {Array.from({ length: CONTEXT_GAUGE_STEPS }, (_, index) => <i key={index} className={index < lit ? "on" : ""} />)}
      </span>
      <b>{advice.estimated ? "~" : ""}{advice.percent}%</b>
    </span>
  );
}

// Contexte de l'agent, en un seul endroit: la jauge dit ou on en est, le menu agit.
function ContextControl({ session, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [audit, setAudit] = useState(null);
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState("");
  const advice = session.contextAdvice;
  const level = advice?.level || "ok";
  const auditable = ["claude", "claude-design", "codex", "antigravity"].includes(session.assistant);

  async function optimize(mode) {
    setBusy(mode);
    try {
      await api(`/api/sessions/${session.id}/optimize`, { method: "POST", body: JSON.stringify({ mode }) });
      setOpen(false);
      onRefresh?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setBusy("");
    }
  }

  async function analyse() {
    setBusy("audit");
    setNote("");
    try {
      const result = await api(`/api/sessions/${session.id}/context-audit`, { method: "POST" });
      setAudit(result);
      setPicked(result.proposals.filter((item) => item.advised).map((item) => item.id));
      if (!result.proposals.length) setNote("Rien d'inutile trouvé: tout ce qui est chargé a déjà servi ici.");
    } catch (error) {
      setNote(error.message);
    } finally {
      setBusy("");
    }
  }

  async function applyAudit() {
    setBusy("apply");
    try {
      const result = await api(`/api/sessions/${session.id}/context-audit/apply`, { method: "POST", body: JSON.stringify({ ids: picked }) });
      setNote(`${result.applied.length} élément(s) retirés pour cet agent · ~${formatTokens(result.savedTokens)} jetons par tour${result.restarted ? ", agent relancé sur sa conversation" : ", effectif au prochain démarrage"}.`);
      setAudit((current) => (current ? { ...current, proposals: [], revertible: true } : current));
    } catch (error) {
      setNote(error.message);
    } finally {
      setBusy("");
    }
  }

  async function revertAudit() {
    setBusy("revert");
    try {
      await api(`/api/sessions/${session.id}/context-audit/revert`, { method: "POST" });
      setAudit(null);
      setNote("Réglages d'origine rétablis pour cet agent.");
    } catch (error) {
      setNote(error.message);
    } finally {
      setBusy("");
    }
  }

  function toggle(id) {
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  const savings = (audit?.proposals || []).filter((item) => picked.includes(item.id)).reduce((total, item) => total + item.savedTokens, 0);

  return (
    <span className="context-control">
      <button
        className={`context-control-toggle ${level}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={advice?.message || `Contexte: ${advice?.percent ?? "—"}% restant`}
      >
        {advice ? <ContextGauge advice={advice} small /> : <b>{session.usage?.contextPercent ?? "—"}%</b>}
        <i aria-hidden="true">⚡</i>
      </button>
      {open && (
        <div className={`context-control-menu ${audit ? "wide" : ""}`}>
          <p className="context-control-state">
            {advice?.message || "Contexte encore large: rien à faire pour l'instant."}
            {session.usage?.remainingTokens ? <em>{session.usage.estimated ? "~" : ""}{formatTokens(session.usage.remainingTokens)} disponibles</em> : null}
          </p>
          <button className={advice?.action === "compact" ? "primary" : ""} disabled={busy === "compact"} onClick={() => optimize("compact")}>
            {busy === "compact" ? "…" : "Réduire le contexte"}<small>Résume la conversation et garde l'essentiel</small>
          </button>
          <button className={advice?.action === "clear" ? "primary" : ""} disabled={busy === "clear"} onClick={() => optimize("clear")}>
            {busy === "clear" ? "…" : "Repartir propre"}<small>Vide la conversation, l'agent recommence à zéro</small>
          </button>
          {auditable && (
            <button disabled={busy === "audit"} onClick={analyse}>
              {busy === "audit" ? "Analyse en cours…" : "Alléger l'agent"}<small>Plugins, skills et serveurs jamais utilisés · ne touche que cet agent</small>
            </button>
          )}
          {audit?.proposals?.length > 0 && (
            <div className="context-audit">
              {audit.proposals.map((item) => (
                <label key={item.id} className={picked.includes(item.id) ? "picked" : ""}>
                  <input type="checkbox" checked={picked.includes(item.id)} onChange={() => toggle(item.id)} />
                  <span>
                    <strong>{item.label}<b>~{formatTokens(item.savedTokens)}</b></strong>
                    <small>{item.detail} · {item.reason}{item.risk === "medium" ? " · retire une capacité" : ""}</small>
                  </span>
                </label>
              ))}
              <button className="primary" disabled={!picked.length || busy === "apply"} onClick={applyAudit}>
                {busy === "apply" ? "…" : `Appliquer · ~${formatTokens(savings)} jetons par tour`}
              </button>
            </div>
          )}
          {audit?.revertible && (
            <button disabled={busy === "revert"} onClick={revertAudit}>
              {busy === "revert" ? "…" : "Annuler l'allègement"}<small>Remet les plugins et skills retirés</small>
            </button>
          )}
          {note && <p className="context-control-note">{note}</p>}
        </div>
      )}
    </span>
  );
}

function DashboardAgentCard({ session, onOpen, onEdit, onFavorite, onArchive }) {
  const [descOpen, setDescOpen] = useState(false);
  return (
    <article className="agent-card">
      <button className="agent-card-open" onClick={() => onOpen(session.id)}>
        <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} />
        <span className="agent-info">
          <strong>
            <b className={`assistant-chip ${session.assistant}`} title={`${assistantMeta[session.assistant]?.label || session.assistant}${session.switchedFrom ? ` · basculé depuis ${assistantMeta[session.switchedFrom]?.label || session.switchedFrom}` : ""}`}>{assistantMeta[session.assistant]?.glyph || "?"}</b>
            {session.switchedFrom && <i className="switched-mark" title={`Basculé depuis ${assistantMeta[session.switchedFrom]?.label || session.switchedFrom}`}>↔</i>}
            <span className="agent-name">{session.name}</span>
            <span
              className="agent-desc-btn"
              title={session.description ? `Description : ${session.description}` : "Voir la description de l'agent"}
              onClick={(event) => {
                event.stopPropagation();
                setDescOpen((v) => !v);
              }}
              role="button"
              tabIndex={0}
              aria-label="Description de l'agent"
            >
              ℹ
            </span>
            {session.canEdit === false && <b className="shared-chip" title={`Agent partagé par ${session.owner?.name || "autre profil"}`}>⇄ {session.owner?.name || "partagé"}</b>}
            {session.canEdit !== false && session.shared && <b className="shared-chip own" title="Agent partagé avec les autres profils">⇄ partagé</b>}
          </strong>
          {session.description ? (
            <small className="agent-desc-line" title={session.description}>
              <span className="agent-desc-text">{session.description}</span>
              <span className="agent-desc-sub"> · {session.project?.name || "Sans projet"}</span>
            </small>
          ) : (
            <small>{session.project?.name || "Sans projet"} · {session.cwd || session.id}</small>
          )}
          <em><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {session.agentStatus?.label || "Disponible"} · {session.contextAdvice ? <ContextGauge advice={session.contextAdvice} small /> : <>{session.usage?.contextPercent ?? "—"}% contexte</>} · <RelativeTime date={session.activityAt} /></em>
        </span>
        <span className="open-arrow">›</span>
      </button>
      {descOpen && (
        <>
          <div className="agent-desc-backdrop" onClick={(e) => { e.stopPropagation(); setDescOpen(false); }} />
          <div className="agent-desc-popover card-desc-popover" onClick={(e) => e.stopPropagation()}>
          <div className="agent-desc-popover-head">
            <strong>{session.name}</strong>
            <button type="button" onClick={() => setDescOpen(false)} aria-label="Fermer">×</button>
          </div>
          <p>{session.description || "Aucune description renseignée pour cet agent."}</p>
          {session.managed && session.canEdit !== false && onEdit && (
            <button
              type="button"
              className="agent-desc-edit-link"
              onClick={() => {
                setDescOpen(false);
                onEdit(session.id);
              }}
            >
              Modifier
            </button>
          )}
        </div>
      </>)}
      {session.managed && session.canEdit !== false && (
        <div className="agent-card-actions">
          <button className={`agent-card-favorite ${session.favorite ? "active" : ""}`} onClick={() => onFavorite(session)} aria-label={`${session.favorite ? "Retirer" : "Ajouter"} favori`}>★</button>
          {!session.core && <button className="agent-card-archive" onClick={() => onArchive(session)} title="Archiver: ferme l'agent en gardant son fil pour le restaurer" aria-label={`Archiver ${session.name}`}>⇩</button>}
          <button className="agent-card-edit" onClick={() => onEdit(session.id)} aria-label={`Éditer ${session.name}`}>Éditer</button>
        </div>
      )}
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
        // Les taches du projet de l'agent passent devant, les terminees ferment la marche,
        // puis l'activite la plus recente departage.
        const folderIds = new Set((result.folders || []).filter((folder) => projectId && folder.projectId === projectId).map((folder) => folder.id));
        const ranked = [...(result.todos || [])]
          .map((todo) => ({ ...todo, inProject: folderIds.has(todo.folderId) }))
          .sort((a, b) => {
            if (a.inProject !== b.inProject) return a.inProject ? -1 : 1;
            const done = (todo) => (todo.status === "done" ? 1 : 0);
            if (done(a) !== done(b)) return done(a) - done(b);
            return String(b.activityAt || "").localeCompare(String(a.activityAt || ""));
          });
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
        <select
          className={`todo-assignee-select assignee-${getTodoAssignee(entry)}`}
          value={getTodoAssignee(entry)}
          onChange={async (e) => {
            const nextVal = e.target.value;
            const isBoth = nextVal === "all" || nextVal === "both";
            try {
              const res = await api(`/api/todos/${encodeURIComponent(entry.id)}`, {
                method: "PATCH",
                body: JSON.stringify({ assignee: nextVal, shared: isBoth }),
              });
              setEntry(res.todo || { ...entry, assignee: nextVal, shared: isBoth });
              window.dispatchEvent(new Event("noyau:todos"));
            } catch {}
          }}
          title="Changer l'attribution"
          aria-label="Attribution de la tâche"
        >
          <option value="aurora">🌸 Aurora</option>
          <option value="main">👤 Moi</option>
          <option value="all">👥 Tout le monde</option>
        </select>
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
          {(entry.comments || []).map((item) => {
            const isAgent = isCommentByAgent(item);
            const authorText = item.author
              ? (isAgent ? (item.author.startsWith("IA ·") ? item.author : `IA · ${item.author}`) : item.author)
              : (isAgent ? "IA" : "Vous");
            return (
              <div className={`todo-comment-item ${isAgent ? "comment-agent" : "comment-user"}`} key={item.id}>
                <div className="todo-comment-meta">
                  <span className={`todo-comment-avatar ${isAgent ? "agent" : "user"}`}>
                    {isAgent ? "🤖" : "👤"}
                  </span>
                  <strong className={`todo-comment-author ${isAgent ? "agent" : "user"}`}>
                    {authorText}
                  </strong>
                  <span className="todo-comment-time">{formatCommentDate(item.createdAt)}</span>
                </div>
                <p className="todo-comment-text">{item.text}</p>
              </div>
            );
          })}
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

function formatMb(value) {
  if (value === null || value === undefined) return "—";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} Go` : `${value} Mo`;
}

function resourceLevel(value, warn = 70, alert = 85) {
  if (!Number.isFinite(value)) return "idle";
  return value >= alert ? "alert" : value >= warn ? "warn" : "ok";
}

function ResourceGauge({ label, percent, detail, warn = 70, alert = 85 }) {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  return (
    <div className={`resource-gauge ${resourceLevel(value, warn, alert)}`} title={detail}>
      <span className="resource-gauge__label">{label}</span>
      <b>{value === null ? "—" : `${value}%`}</b>
      <i className="resource-gauge__bar"><i style={{ width: `${value ?? 0}%` }} /></i>
    </div>
  );
}

function ResourcesPanel({ onOpen, onSessionsChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [tab, setTab] = useState("cpu");
  const [killing, setKilling] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(profileCacheKey("resources-open")) === "1"; } catch { return false; }
  });

  useEffect(() => {
    let disposed = false;
    let timer = null;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const next = await api("/api/system/resources");
          if (!disposed) { setData(next); setError(""); }
        } catch (reason) {
          if (!disposed) setError(reason.message);
        }
      }
      if (!disposed) timer = setTimeout(tick, 8000);
    };
    tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [refreshKey]);

  async function kill(item) {
    const label = item.projectName ? `${item.name} (${item.projectName})` : item.name;
    const launched = (item.detachedApps || []).filter((app) => !app.gui);
    const spared = (item.detachedApps || []).filter((app) => app.gui);
    const message = item.kind === "session"
      ? [
        `Archiver « ${label} » et tuer ses ${item.processes} processus (${formatMb(item.rssMb)}) ?`,
        launched.length ? `Aussi fermés (lancés par l'agent) : ${launched.map((app) => `${app.name} ${formatMb(app.rssMb)}`).join(", ")}.` : "",
        spared.length ? `Conservés (applis graphiques) : ${spared.map((app) => `${app.name} ${formatMb(app.rssMb)}`).join(", ")}.` : "",
        "L'agent reste restaurable depuis « Agents archivés ».",
      ].filter(Boolean).join("\n\n")
      : `Tuer « ${label} » (pid ${item.pid}, ${item.processes} processus, ${formatMb(item.rssMb)}) ? Session hors Noyau : non restaurable.`;
    if (!window.confirm(message)) return;
    setKilling(item.id);
    try {
      const body = item.kind === "session" ? { sessionId: item.id } : { pid: item.pid };
      const result = await api("/api/system/resources/kill", { method: "POST", body: JSON.stringify(body) });
      const freed = item.rssMb + (item.detachedApps || []).filter((app) => !app.gui).reduce((total, app) => total + app.rssMb, 0);
      setStatus(`${result.name} fermé · ~${formatMb(freed)} libérés`);
      setData((current) => current && { ...current, agents: current.agents.filter((a) => a.id !== item.id) });
      if (item.kind === "session") {
        window.dispatchEvent(new Event("noyau:archives"));
        onSessionsChanged?.();
      }
      setTimeout(() => setRefreshKey((k) => k + 1), 3000);
    } catch (reason) {
      window.alert(reason.message);
    } finally {
      setKilling("");
    }
  }

  function toggle(event) {
    const next = event.currentTarget.open;
    setOpen(next);
    try { localStorage.setItem(profileCacheKey("resources-open"), next ? "1" : "0"); } catch {}
  }

  async function optimize(event) {
    event.preventDefault();
    event.stopPropagation();
    setBusy(true);
    setStatus("");
    try {
      const result = await api("/api/system/resources/optimize", { method: "POST" });
      setStatus(result.reused ? "Instantané envoyé" : "Agent lancé");
      if (result.agentId) setTimeout(() => onOpen?.(result.agentId), 1200);
    } catch (reason) {
      setStatus(reason.message);
    } finally {
      setBusy(false);
    }
  }

  const memory = data?.memory;
  const gpus = data?.gpus || [];
  const hints = data?.hints || [];
  const worst = hints.some((h) => h.level === "high") ? "high" : hints.some((h) => h.level === "medium") ? "medium" : hints.length ? "low" : "";
  const rows = (tab === "ram" ? data?.topMemory : tab === "agents" ? data?.agents : data?.topCpu) || [];
  const maxCpu = Math.max(100, ...rows.map((r) => r.cpuPercent || 0));
  const maxRss = Math.max(1, ...rows.map((r) => r.rssMb || 0));
  const gpuShort = (name) => name.replace(/Graphics/i, "").replace(/Iris Xe/i, "Xe").trim() || "GPU";

  return (
    <details className="panel resources-panel" open={open} onToggle={toggle}>
      <summary className="resources-summary">
        <span className="resources-summary__title">
          <span className="resources-chevron" aria-hidden="true">›</span>
          <strong>Ressources</strong>
          {worst && <em className={`resources-alert-dot ${worst}`} title={hints.map((h) => h.text).join("\n")}>{hints.length}</em>}
        </span>
        {data ? (
          <span className="resource-gauges">
            <ResourceGauge label="CPU" percent={data.cpu.percent} detail={`Load ${data.cpu.loadAvg.join(" · ")} / ${data.cpu.cores} threads`} />
            <ResourceGauge label="RAM" percent={memory.percent} detail={`${formatMb(memory.usedMb)} / ${formatMb(memory.totalMb)} · ${formatMb(memory.availableMb)} dispo`} />
            {memory.swapTotalMb > 0 && <ResourceGauge label="Swap" percent={memory.swapPercent} detail={`${formatMb(memory.swapUsedMb)} / ${formatMb(memory.swapTotalMb)}`} warn={50} alert={75} />}
            {gpus.map((gpu) => (
              <ResourceGauge key={gpu.id} label={gpuShort(gpu.name)} percent={gpu.busyPercent} detail={`${gpu.name}${gpu.freqMhz ? ` · ${gpu.freqMhz}/${gpu.maxFreqMhz} MHz` : ""}`} />
            ))}
          </span>
        ) : (
          <small className="resources-loading">{error || "Mesure…"}</small>
        )}
        <button type="button" className="resources-optimize" onClick={optimize} disabled={busy || !data} title="Un agent analyse et propose des optimisations. Il ne stoppe rien sans ta confirmation.">
          {busy ? "…" : status || "⚙ Optimiser"}
        </button>
      </summary>
      {data && (
        <div className="resources-detail">
          {hints.length > 0 && (
            <ul className="resource-hints">
              {hints.map((hint) => <li key={hint.text} className={hint.level}>{hint.text}</li>)}
            </ul>
          )}
          <div className="resources-detail__bar">
            <div className="resource-tabs" role="tablist">
              {[["cpu", "Top CPU"], ["ram", "Top RAM"], ["agents", "Sessions IA"]].map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>
            <small>{data.processCount} processus · {data.cpu.cores} threads · load {data.cpu.loadAvg[0]}</small>
          </div>
          <div className="resource-table" role="table">
            <div className={`resource-row head ${tab === "agents" ? "with-action" : ""}`} role="row"><span>{tab === "agents" ? "Session" : "Processus"}</span><span>CPU</span><span>RAM</span>{tab === "agents" && <span />}</div>
            {rows.slice(0, tab === "agents" ? 20 : 6).map((item) => (
              <div className={`resource-row ${tab === "agents" ? "with-action" : ""} ${item.kind === "external" ? "external" : ""}`} role="row" key={item.id || item.pid} title={item.command || item.name}>
                <span className="resource-row__name">
                  <b>{item.name}</b>
                  <small>
                    {tab === "agents"
                      ? [item.projectName ? `📁 ${item.projectName}` : item.kind === "session" ? "Sans projet" : null, item.assistant, `${item.processes} proc.`].filter(Boolean).join(" · ")
                      : item.agentName || `pid ${item.pid}`}
                  </small>
                  {tab === "agents" && item.detachedApps?.length > 0 && (
                    <small className="resource-row__launched" title="Processus lancés par l'agent, détachés de sa session">
                      ↳ a lancé : {item.detachedApps.slice(0, 3).map((app) => `${app.name} ${formatMb(app.rssMb)}${app.gui ? " 🔒" : ""}`).join(" · ")}
                    </small>
                  )}
                </span>
                <span className="resource-row__metric">
                  <i className={resourceLevel(item.cpuPercent, 50, 90)} style={{ width: `${Math.min(100, (item.cpuPercent / maxCpu) * 100)}%` }} />
                  <em>{item.cpuPercent}%</em>
                </span>
                <span className="resource-row__metric">
                  <i className="ram" style={{ width: `${(item.rssMb / maxRss) * 100}%` }} />
                  <em>{formatMb(item.rssMb)}</em>
                </span>
                {tab === "agents" && (
                  item.killable ? (
                    <button type="button" className="resource-kill" onClick={() => kill(item)} disabled={killing === item.id} title={item.kind === "session" ? "Archiver et tuer tous ses processus" : "Tuer cette session hors Noyau"}>
                      {killing === item.id ? "…" : item.kind === "session" ? "Archiver" : "Kill"}
                    </button>
                  ) : <span className="resource-kill-locked" title="Agent de base ou d'un autre profil">🔒</span>
                )}
              </div>
            ))}
            {tab === "agents" && rows.length === 0 && <p className="resource-empty">Aucune session IA détectée.</p>}
          </div>
        </div>
      )}
    </details>
  );
}

function Dashboard({ sessions, projects, quotas, onSessionsChanged, onOpen, onNew, onEdit, onFavorite, onArchive, onProjects, onFinances, onRefreshQuotas, voice, onVoice, muted, onMuted, power, onTogglePower, powerBusy, sortMode = "recent", onSetSortMode, profileId, lastInteractedMap = {} }) {
  const [refreshingQuotas, setRefreshingQuotas] = useState(false);
  const [quotaRefreshState, setQuotaRefreshState] = useState("");
  const [hardware, setHardware] = useState(null);
  const [weather, setWeather] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem("noyau-weather"));
      return cached && Date.now() - new Date(cached.retrievedAt).getTime() < 30 * 60 * 1000 ? cached : null;
    } catch {
      return null;
    }
  });
  const [expandedProjects, setExpandedProjects] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(profileCacheKey("agents-expanded-projects-dashboard"))) || {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(profileCacheKey("agents-expanded-projects-dashboard")));
      setExpandedProjects(stored || {});
    } catch {
      setExpandedProjects({});
    }
  }, [profileId]);

  const toggleProjectCollapse = useCallback((projectId, isOpen) => {
    setExpandedProjects((prev) => {
      const isCurrentlyOpen = Boolean(prev[projectId]);
      if (isCurrentlyOpen === isOpen) return prev;
      const next = { ...prev };
      if (isOpen) {
        next[projectId] = true;
      } else {
        delete next[projectId];
      }
      try {
        localStorage.setItem(profileCacheKey("agents-expanded-projects-dashboard"), JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

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

  const projectGroups = useMemo(() => {
    if (sortMode !== "project") return [];
    const groupsMap = new Map();
    const noProjectSessions = [];

    sessions.forEach((session) => {
      const pId = session.projectId;
      if (!pId) {
        noProjectSessions.push(session);
        return;
      }
      let group = groupsMap.get(pId);
      if (!group) {
        const projectObj = projects.find((p) => p.id === pId) || session.project || { id: pId, name: session.project?.name || "Projet" };
        group = {
          projectId: pId,
          project: projectObj,
          name: projectObj.name || session.project?.name || "Projet",
          sessions: [],
          hasWorking: false,
        };
        groupsMap.set(pId, group);
      }
      group.sessions.push(session);
      if (session.agentStatus?.state === "working") {
        group.hasWorking = true;
      }
    });

    const list = Array.from(groupsMap.values());
    if (noProjectSessions.length > 0) {
      list.push({
        projectId: "__none__",
        project: null,
        name: "Sans projet",
        sessions: noProjectSessions,
        hasWorking: noProjectSessions.some((s) => s.agentStatus?.state === "working"),
      });
    }
    return list;
  }, [sessions, projects, sortMode]);
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

  useEffect(() => {
    let disposed = false;
    const fetchHw = () => {
      api("/api/system/hardware")
        .then((data) => {
          if (!disposed && data) setHardware(data);
        })
        .catch(() => {});
    };
    fetchHw();
    const interval = setInterval(fetchHw, 6000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  const now = new Date();
  const weekday = new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(now).toLocaleUpperCase("fr-FR");
  const greeting = now.getHours() < 12 ? "Bonjour" : now.getHours() < 18 ? "Bon après-midi" : "Bonsoir";
  return (
    <div className="page dashboard">
      <section className="hero-row">
        <div>
          <p className="eyebrow">{weekday} · CENTRE DE CONTRÔLE</p>
          <div className="hero-title">
            <h1>{greeting}.</h1>
            {weather && <span className={`weather-inline ${weather.isDay ? "day" : "night"}`} title={`Ressenti ${Math.round(weather.apparentTemperature)}°C`}><i /><b>{Math.round(weather.temperature)}°</b><span>{weatherLabel(weather.code)}</span><small>Open-Meteo</small></span>}
            {hardware && (
              <span
                className={`hardware-inline ${hardware.state || "normal"}`}
                title={`${hardware.alertLabel || "Monitoring PC"} — CPU: ${hardware.cpuTemp || "—"}°C · Coque: ${hardware.skinTemp || "—"}°C · Ventilo: ${hardware.fanRpm ? `${hardware.fanRpm} RPM` : "inactif"}`}
              >
                <i className="hardware-pulse-dot" />
                <b>{hardware.cpuTemp !== null && hardware.cpuTemp !== undefined ? `${hardware.cpuTemp}°` : "—"}</b>
                <span>CPU</span>
                {hardware.skinTemp !== null && hardware.skinTemp !== undefined && (
                  <>
                    <small className="hw-sep">·</small>
                    <b>{hardware.skinTemp}°</b>
                    <span>Coque</span>
                  </>
                )}
                {hardware.fanRpm ? (
                  <>
                    <small className="hw-sep">·</small>
                    <span className="hw-fan">🌀 {Math.round(hardware.fanRpm / 100) / 10}k</span>
                  </>
                ) : null}
              </span>
            )}
          </div>
        </div>
        <div className="system-state">
          <div className="system-state__row"><i /><span><strong>Système opérationnel</strong><small>Connexion locale chiffrable via VPN</small></span></div>
          <div className="system-controls">
            {onTogglePower && (
              <button
                type="button"
                className={`system-power__toggle ${power?.sleeping ? "sleeping" : ""}`}
                onClick={onTogglePower}
                disabled={powerBusy}
                aria-pressed={Boolean(power?.sleeping)}
                title={power?.sleeping ? "Mode basse consommation actif (conteneurs Docker gelés) · Cliquer pour réveiller" : "Mettre en veille basse consommation (pause conteneurs Docker)"}
              >
                <span className="system-power__icon" aria-hidden="true">{power?.sleeping ? "⚡" : "🌙"}</span>
                <span>
                  <strong>{powerBusy ? "Action en cours…" : power?.sleeping ? "Sortir de veille" : "Veille éco"}</strong>
                  <small>
                    {power?.sleeping
                      ? `${power?.pausedContainers?.length || 0} conteneur${(power?.pausedContainers?.length || 0) > 1 ? "s" : ""} gelé${(power?.pausedContainers?.length || 0) > 1 ? "s" : ""}`
                      : "Pause Docker · 0% CPU"}
                  </small>
                </span>
              </button>
            )}
            <div className={`system-voice ${voice?.listening ? "listening" : ""}`}>
              <button
                className="system-voice__toggle"
                onClick={() => onVoice(!voice?.listening)}
                disabled={voice?.installed === false}
                aria-pressed={Boolean(voice?.listening)}
                title={voice?.installed === false ? "Moteurs vocaux absents · scripts/voice-install.sh" : voice?.listening ? "Couper le micro" : "Activer le micro"}
              >
                <span className="system-voice__dot" aria-hidden="true" />
                <span>
                  <strong>{voice?.listening ? "Micro actif" : "Micro éteint"}</strong>
                  <small>
                    {voice?.error ? voice.error
                      : voice?.installed === false ? "Moteurs absents"
                      : voice?.lastHeard ? `« ${voice.lastHeard.text} »`
                      : voice?.listening ? "Dis « Noyau, … »" : "Pilotage vocal"}
                  </small>
                </span>
              </button>
              <button
                className={`system-voice__mute ${muted ? "muted" : ""}`}
                onClick={() => onMuted(!muted)}
                title={muted ? "Réactiver les sons" : "Couper les sons"}
                aria-label={muted ? "Réactiver les sons" : "Couper les sons"}
              >{muted ? "🔇" : "🔔"}</button>
            </div>
          </div>
        </div>
      </section>

      <section className="metrics">
        <article className="active-agents-metric"><span className="metric-symbol green">◎</span><div className="active-agents-content"><small>AGENTS ACTIFS</small><div className="active-agents-data"><div className="active-total-block"><strong className="active-total">{sessions.length}</strong><em>en ligne</em></div><div className="agent-breakdown"><span><b>{codexCount}</b><em>Codex</em></span><span><b>{claudeCount}</b><em>Claude</em></span>{antigravityCount > 0 && <span><b>{antigravityCount}</b><em>Antigravity</em></span>}<span><b>{shellCount}</b><em>Terminal</em></span></div></div><p className="active-agents-footer"><span>{linkedProjects} projet{linkedProjects > 1 ? "s" : ""} lié{linkedProjects > 1 ? "s" : ""}</span><span>{favoriteCount} favori{favoriteCount > 1 ? "s" : ""}</span></p></div></article>
        <article className="quota-metric"><span className="metric-symbol blue">↗</span><div><small className="quota-title">QUOTAS IA<button className={refreshingQuotas ? "quota-refresh updating" : "quota-refresh"} onClick={async () => { setRefreshingQuotas(true); setQuotaRefreshState("Actualisation…"); try { const result = await onRefreshQuotas(); const failed = Object.entries(result?.refreshed || {}).filter(([, state]) => !state.ok).map(([provider]) => provider); setQuotaRefreshState(failed.length ? `Échec: ${failed.join(", ")}` : `Actualisé ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`); } catch (error) { setQuotaRefreshState(error.message || "Actualisation impossible"); } finally { setRefreshingQuotas(false); } }} disabled={refreshingQuotas} aria-label="Rafraîchir quotas" title="Rafraîchir quotas"><span aria-hidden="true">↻</span></button><em className="quota-refresh-state">{quotaRefreshState}</em></small><div className="quota-providers"><div className="quota-codex"><span>CODEX</span>{codexWindows.length ? <div className="quota-dials">{codexWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{resetCountdown(item.resetsAt)}</em></div>)}</div> : <div className="quota-empty"><strong>—</strong><em>Relevé indisponible</em></div>}</div><div className="quota-antigravity"><span>ANTIGRAVITY</span>{antigravityWindows.length ? <div className="quota-dials">{antigravityWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{resetCountdown(item.resetsAt)}</em></div>)}</div> : <div className="quota-empty"><strong>—</strong><em>Relevé indisponible</em></div>}</div><div className="quota-claude"><span>CLAUDE</span>{claudeWindows.length ? <div className="quota-dials">{claudeWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{resetCountdown(item.resetsAt)}</em></div>)}</div> : <div className="quota-empty"><strong>{quotas.claude?.status === "loggedOut" ? "Déconnecté" : "—"}</strong><em>{quotas.claude?.status === "loggedOut" ? "Reconnecte Claude" : "Reset inconnu"}</em></div>}</div></div></div></article>
      </section>

      <ResourcesPanel onOpen={onOpen} onSessionsChanged={onSessionsChanged} />

      <section className="panel agents-panel">
        <div className="panel-head">
          <div>
            <h3>Agents actifs</h3>
            <p>Sessions tmux sur ce PC</p>
          </div>
          <div className="panel-head-actions">
            {onSetSortMode && (
              <div className="agent-sort-switcher" role="group" aria-label="Mode de tri des agents">
                <button
                  type="button"
                  className={`agent-sort-btn ${sortMode === "recent" ? "active" : ""}`}
                  onClick={() => onSetSortMode("recent")}
                  title={AGENT_SORT_TOOLTIPS.recent || "Plus récemment utilisés"}
                >
                  Récents
                </button>
                <button
                  type="button"
                  className={`agent-sort-btn ${sortMode === "alpha" ? "active" : ""}`}
                  onClick={() => onSetSortMode("alpha")}
                  title={AGENT_SORT_TOOLTIPS.alpha || "Alphabétique A-Z"}
                >
                  A-Z
                </button>
                <button
                  type="button"
                  className={`agent-sort-btn ${sortMode === "project" ? "active" : ""}`}
                  onClick={() => onSetSortMode("project")}
                  title={AGENT_SORT_TOOLTIPS.project || "Par projet (accordéons)"}
                >
                  Par projet
                </button>
              </div>
            )}
            <button className="ghost" onClick={onNew}>+ Lancer</button>
          </div>
        </div>
        <div className="agent-grid grouped-agent-grid">
          {sortMode === "project" ? (
            projectGroups.map((group) => group.sessions.length === 1 ? (
              <DashboardAgentCard
                key={group.sessions[0].id}
                session={group.sessions[0]}
                onOpen={onOpen}
                onEdit={onEdit}
                onFavorite={onFavorite}
                onArchive={onArchive}
              />
            ) : (
              <details
                className="agent-group"
                key={group.projectId}
                open={Boolean(expandedProjects[group.projectId])}
                onToggle={(e) => toggleProjectCollapse(group.projectId, e.currentTarget.open)}
              >
                <summary>
                  <span className="agent-group-chevron">›</span>
                  <div className="agent-group-title">
                    <ProjectIcon project={group.project} small />
                    <strong>{group.name}</strong>
                  </div>
                  <div className="agent-group-meta">
                    {group.hasWorking && (
                      <span className="agent-group-badge working" title="Un agent travaille actuellement">
                        <i className="agent-state-dot working" /> En cours
                      </span>
                    )}
                    <small className="agent-group-count">
                      {group.sessions.length} agent{group.sessions.length > 1 ? "s" : ""}
                    </small>
                  </div>
                </summary>
                <div className="agent-group-grid">
                  {group.sessions.map((session) => (
                    <DashboardAgentCard
                      key={session.id}
                      session={session}
                      onOpen={onOpen}
                      onEdit={onEdit}
                      onFavorite={onFavorite}
                      onArchive={onArchive}
                    />
                  ))}
                </div>
              </details>
            ))
          ) : (
            sessions.map((session) => (
              <DashboardAgentCard
                key={session.id}
                session={session}
                onOpen={onOpen}
                onEdit={onEdit}
                onFavorite={onFavorite}
                onArchive={onArchive}
              />
            ))
          )}
          {!sessions.length && (
            <button className="empty-agent" onClick={onNew}>
              <span>+</span>
              <strong>Lancer premier agent</strong>
              <small>Codex, Claude ou terminal</small>
            </button>
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
          <strong title={stack.at(-1)?.name || rootLabel || (notion ? "Pages Notion" : "Drive Octanix")}>
            {stack.at(-1)?.name || (notion ? (rootLabel || "Pages Notion") : "Drive Octanix")}
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

const LONG_ACTION_COUNTS = { warmup: "bonjour", promo: "promo", skipped: "ignorés", failed: "échecs" };

function waitLabel(nextAt) {
  const seconds = Math.max(0, Math.round((new Date(nextAt).getTime() - Date.now()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s` : `${seconds} s`;
}

function ModuleLongAction({ module, action, onAction }) {
  const storageKey = `noyau.moduleInput.${module.id}.${action.id}`;
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(storageKey) || String(action.input?.default ?? ""); } catch { return String(action.input?.default ?? ""); }
  });
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const run = action.run;
  const progress = run?.progress;
  const active = run?.state === "running" || run?.state === "stopping";
  useEffect(() => {
    if (!progress?.nextAt) return undefined;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [progress?.nextAt]);
  async function send(body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try { await onAction(module.id, action.id, body); } finally { setBusy(false); }
  }
  function start() {
    const count = Number(value);
    if (action.input) {
      if (!Number.isInteger(count) || count < action.input.min || count > action.input.max) return window.alert(`${action.input.label} : entre ${action.input.min} et ${action.input.max}.`);
      try { localStorage.setItem(storageKey, String(count)); } catch { /* préférence locale seulement */ }
    }
    const question = action.input ? `${action.confirm || `${action.label} ?`}\n${action.input.label} : ${count}` : action.confirm;
    send(action.input ? { input: count } : {}, question);
  }
  const total = progress?.total || 0;
  const done = progress?.done || 0;
  const status = !run ? "" : run.state === "running"
    ? progress?.phase === "pause" && progress.nextAt ? `${done}/${total} faits · prochain dans ${waitLabel(progress.nextAt)}`
      : progress?.current ? `Groupe ${Math.min(done + 1, total)}/${total} · ${progress.current}${progress.phase ? ` · ${progress.phase}` : ""}`
        : `Démarrage… ${done}/${total}`
    : run.state === "stopping" ? `Arrêt en cours (fin du groupe actuel)… ${done}/${total}`
      : run.state === "stopped" ? `Arrêté à ${done}/${total}`
        : run.state === "success" ? `Terminé · ${done}/${total}`
          : `Erreur à ${done}/${total}${run.output ? ` · ${run.output}` : ""}`;
  const counts = Object.entries(progress?.counts || {}).filter(([, count]) => count > 0).map(([key, count]) => `${LONG_ACTION_COUNTS[key] || key} ${count}`).join(" · ");
  return (
    <div className="module-long">
      <div className="module-long-row">
        {!active && action.input && (
          <label>
            <span>{action.input.label}</span>
            <input type="number" inputMode="numeric" min={action.input.min} max={action.input.max} value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} />
          </label>
        )}
        {!active && <button className={action.tone} onClick={start} disabled={busy}>{action.label}</button>}
        {!active && run?.resumable && <button onClick={() => send({ resume: true }, `Reprendre à ${done}/${total} ?`)} disabled={busy}>Reprendre ({done}/{total})</button>}
        {active && <button className="danger" onClick={() => send({ stop: true }, "Arrêter ? Le groupe en cours est terminé avant l'arrêt.")} disabled={busy || run.state === "stopping"}>{run.state === "stopping" ? "Arrêt…" : "Stop"}</button>}
      </div>
      {run && total > 0 && <div className={`module-long-bar ${run.state}`}><i style={{ width: `${Math.round((done / total) * 100)}%` }} /></div>}
      {status && <small className={`module-run ${run.state === "success" ? "success" : run.state === "error" ? "error" : ""}`}>{action.label} · {status}{counts ? ` · ${counts}` : ""}</small>}
    </div>
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
  const latestAction = (module.actions || []).filter((action) => action.run && !action.longRunning).sort((left, right) => String(right.run.startedAt).localeCompare(String(left.run.startedAt)))[0];
  const latestRun = latestAction?.run;
  const chatRun = (module.actions || []).find((action) => action.longRunning && action.run)?.run;
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
          <small>{module.environment === "production" ? `${module.executionHost || "Ce PC"} · ${{ active: "Actif", inactive: "Arrêté", failed: "En échec", activating: "Démarrage", deactivating: "Arrêt en cours", unknown: "État inconnu" }[module.state] || module.state} · ` : ""}{module.description}</small>
        </div>
        {module.controllable ? (
          <button
            className={`module-toggle ${module.enabled ? "enabled" : ""}`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
            disabled={busy || (!module.enabled && module.setup?.status === "required")}
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
            {(module.actions || []).filter((action) => !action.longRunning).map((action) => (
              <button key={action.id} className={action.tone} onClick={() => actionRun(action)} disabled={busy || action.run?.state === "running"}>
                {action.run?.state === "running" ? "Exécution…" : action.label}
              </button>
            ))}
          </div>
        )}
        {(module.actions || []).filter((action) => action.longRunning).map((action) => <ModuleLongAction key={action.id} module={module} action={action} onAction={onAction} />)}
        {module.chat && <>
          <TelegramGrowthChat
            title={module.name}
            messages={module.chat.messages}
            state={chatRun?.state || (module.state === "failed" ? "error" : "idle")}
            phase={chatRun?.progress?.phase}
            current={chatRun?.progress?.current}
            nextAt={chatRun?.progress?.nextAt}
          />
          <small className="module-run" role="status">
            {module.chat.availability === "unavailable" ? "Historique indisponible — nouvelle tentative automatique."
              : module.chat.availability === "waiting" ? "En attente du premier export de messages."
                : `Actualisation toutes les 5 s${module.chat.updatedAt ? ` · Export du ${new Date(module.chat.updatedAt).toLocaleString("fr-FR")}` : ""}`}
          </small>
        </>}
        {module.deviceBuild && <ModuleDeviceBuild module={module} onBuild={onBuild} onRefreshBuilds={onRefreshBuilds} />}
        {runLabel && (module.chat ? <details className="tgc-technical"><summary>Journal technique · {latestAction?.label || "Action"}</summary><pre>{runLabel}</pre></details>
          : <small className={`module-run ${latestRun?.state || "running"}`}>{runLabel}</small>)}
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

function formatFileBytes(bytes) {
  if (!bytes || bytes === 0) return "0 o";
  const k = 1024;
  const sizes = ["o", "Ko", "Mo", "Go"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function getFileIcon(ext) {
  const e = String(ext || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".bmp", ".ico"].includes(e)) return "🖼️";
  if ([".pdf"].includes(e)) return "📄";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(e)) return "🎬";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(e)) return "🎵";
  if ([".csv", ".tsv"].includes(e)) return "📊";
  if ([".zip", ".tar", ".gz", ".rar", ".7z"].includes(e)) return "📦";
  if ([".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".zsh", ".json", ".html", ".css", ".sql", ".rs", ".go", ".c", ".cpp"].includes(e)) return "💻";
  if ([".md", ".markdown", ".txt", ".doc", ".docx", ".log"].includes(e)) return "📝";
  return "📁";
}

function getFileCategory(ext) {
  const e = String(ext || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].includes(e)) return "image";
  if ([".pdf"].includes(e)) return "pdf";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(e)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(e)) return "audio";
  if ([".csv", ".tsv"].includes(e)) return "csv";
  if ([".json"].includes(e)) return "json";
  if ([".md", ".markdown"].includes(e)) return "markdown";
  if ([
    ".txt", ".text", ".log", ".env", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".jsx",
    ".ts", ".tsx", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".py", ".yml", ".yaml",
    ".xml", ".sql", ".rs", ".go", ".c", ".cpp", ".h", ".hpp", ".php", ".rb", ".toml", ".ini",
    ".conf", ".diff", ".patch", ".dockerfile", ".gitignore", ".gitattributes"
  ].includes(e)) return "text";
  return "other";
}

function parseCsvRows(text) {
  if (!text) return { headers: [], rows: [] };
  const firstLine = text.split(/\r?\n/)[0] || "";
  let delimiter = ",";
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (semis > commas && semis > tabs) delimiter = ";";
  else if (tabs > commas && tabs > semis) delimiter = "\t";

  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = "";
    } else if ((char === "\r" || char === "\n") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c !== "")) rows.push(currentRow);
      currentRow = [];
      currentCell = "";
    } else {
      currentCell += char;
    }
  }
  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((c) => c !== "")) rows.push(currentRow);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0];
  const bodyRows = rows.slice(1);
  return { headers, rows: bodyRows };
}

function ProjectFilePreviewModal({ file, files, project, onClose, onSelectFile, onDownload }) {
  const profileId = activeProfileId();
  const previewUrl = `/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(file.name)}?inline=1${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}`;

  const category = getFileCategory(file.extension);
  const currentIndex = files.findIndex((f) => f.name === file.name);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < files.length - 1;

  const [textContent, setTextContent] = useState("");
  const [loadingText, setLoadingText] = useState(false);
  const [textError, setTextError] = useState("");
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [viewMode, setViewMode] = useState("default");
  const [csvFilter, setCsvFilter] = useState("");

  const [zoomScale, setZoomScale] = useState(1);
  const [imgDimensions, setImgDimensions] = useState(null);

  useEffect(() => {
    setZoomScale(1);
    setImgDimensions(null);
    setCopied(false);
    setCsvFilter("");
    setViewMode("default");

    if (["text", "csv", "json", "markdown"].includes(category)) {
      let active = true;
      setLoadingText(true);
      setTextError("");
      const headers = {};
      const token = localStorage.getItem("token");
      if (token) headers.authorization = `Bearer ${token}`;
      if (profileId) headers["x-noyau-profile"] = profileId;

      fetch(previewUrl, { credentials: "include", headers })
        .then((res) => {
          if (!res.ok) throw new Error(`Erreur ${res.status}`);
          return res.text();
        })
        .then((txt) => {
          if (active) {
            setTextContent(txt);
            setLoadingText(false);
          }
        })
        .catch((err) => {
          if (active) {
            setTextError(err.message || "Erreur de chargement du fichier");
            setLoadingText(false);
          }
        });

      return () => {
        active = false;
      };
    }
  }, [file.name, category, previewUrl, profileId]);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && hasPrev && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        onSelectFile(files[currentIndex - 1]);
      } else if (e.key === "ArrowRight" && hasNext && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        onSelectFile(files[currentIndex + 1]);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasPrev, hasNext, currentIndex, files, onClose, onSelectFile]);

  function copyText() {
    if (!textContent) return;
    navigator.clipboard.writeText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const csvData = useMemo(() => {
    if (category !== "csv" || !textContent) return null;
    return parseCsvRows(textContent);
  }, [category, textContent]);

  const filteredCsvRows = useMemo(() => {
    if (!csvData) return [];
    if (!csvFilter.trim()) return csvData.rows;
    const q = csvFilter.trim().toLowerCase();
    return csvData.rows.filter((row) => row.some((cell) => String(cell).toLowerCase().includes(q)));
  }, [csvData, csvFilter]);

  const formattedJson = useMemo(() => {
    if (category !== "json" || !textContent) return null;
    try {
      return JSON.stringify(JSON.parse(textContent), null, 2);
    } catch {
      return null;
    }
  }, [category, textContent]);

  const displayedText = (category === "json" && viewMode === "default" && formattedJson) ? formattedJson : textContent;
  const linesCount = displayedText ? displayedText.split("\n").length : 0;
  const lineNumbers = useMemo(() => {
    if (linesCount <= 0) return "";
    return Array.from({ length: linesCount }, (_, i) => i + 1).join("\n");
  }, [linesCount]);

  const badgeClass =
    category === "image" ? "image" :
    category === "pdf" ? "pdf" :
    ["csv", "json"].includes(category) ? "data" :
    ["audio", "video"].includes(category) ? "media" : "";

  return createPortal(
    <div className="modal-backdrop project-file-preview-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal project-file-preview-modal" role="dialog" aria-modal="true" aria-label={`Aperçu de ${file.name}`}>
        <header className="project-file-preview-head">
          <div className="project-file-preview-title-area">
            <span className="project-file-preview-icon">{getFileIcon(file.extension)}</span>
            <div className="project-file-preview-titles">
              <div className="project-file-preview-name">
                <h3 title={file.name}>{file.name}</h3>
                <span className={`project-file-badge ${badgeClass}`}>
                  {(file.extension?.replace(/^\./, "") || "fichier").toUpperCase()}
                </span>
              </div>
              <div className="project-file-preview-meta">
                <span>{formatFileBytes(file.size)}</span>
                {imgDimensions && <span> · {imgDimensions.w} × {imgDimensions.h} px</span>}
                {linesCount > 0 && <span> · {linesCount} ligne{linesCount > 1 ? "s" : ""}</span>}
              </div>
            </div>
            {files.length > 1 && (
              <div className="project-file-preview-nav">
                <button
                  type="button"
                  className="project-file-preview-nav-btn"
                  onClick={() => hasPrev && onSelectFile(files[currentIndex - 1])}
                  disabled={!hasPrev}
                  title="Fichier précédent (←)"
                >
                  ‹
                </button>
                <span>{currentIndex + 1} / {files.length}</span>
                <button
                  type="button"
                  className="project-file-preview-nav-btn"
                  onClick={() => hasNext && onSelectFile(files[currentIndex + 1])}
                  disabled={!hasNext}
                  title="Fichier suivant (→)"
                >
                  ›
                </button>
              </div>
            )}
          </div>
          <div className="project-file-preview-actions">
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="ghost"
              title="Ouvrir dans un nouvel onglet"
            >
              ↗ Ouvrir
            </a>
            <button
              type="button"
              className="ghost"
              onClick={() => onDownload(file.name)}
              title="Télécharger sur l'appareil"
            >
              ↓ Télécharger
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              title="Fermer l'aperçu (Échap)"
            >
              ×
            </button>
          </div>
        </header>

        <div className="project-file-preview-body">
          {category === "image" && (
            <div className="project-file-preview-image-container">
              <img
                src={previewUrl}
                alt={file.name}
                className="project-file-preview-image"
                style={{ transform: `scale(${zoomScale})` }}
                onLoad={(e) => {
                  setImgDimensions({ w: e.target.naturalWidth, h: e.target.naturalHeight });
                }}
              />
              <div className="project-file-preview-image-toolbar">
                <button type="button" onClick={() => setZoomScale((s) => Math.max(0.25, s - 0.25))} title="Zoom arrière">－</button>
                <span>{Math.round(zoomScale * 100)}%</span>
                <button type="button" onClick={() => setZoomScale((s) => Math.min(4, s + 0.25))} title="Zoom avant">＋</button>
                <button type="button" onClick={() => setZoomScale(1)} title="Taille réelle (100%)">100%</button>
              </div>
            </div>
          )}

          {category === "pdf" && (
            <iframe
              src={`${previewUrl}#toolbar=1`}
              title={file.name}
              className="project-file-preview-iframe"
            />
          )}

          {category === "audio" && (
            <div className="project-file-preview-media-container">
              <div className="project-file-preview-audio-card">
                <i>🎵</i>
                <strong>{file.name}</strong>
                <audio controls src={previewUrl} autoPlay={false} />
              </div>
            </div>
          )}

          {category === "video" && (
            <div className="project-file-preview-media-container">
              <video controls playsInline src={previewUrl} className="project-file-preview-video" autoPlay={false} />
            </div>
          )}

          {["text", "csv", "json", "markdown"].includes(category) && (
            <>
              <div className="project-file-preview-subbar">
                <div className="project-file-preview-subbar-left">
                  {category === "csv" && (
                    <>
                      <button
                        type="button"
                        className={viewMode !== "raw" ? "active" : ""}
                        onClick={() => setViewMode("default")}
                      >
                        Tableau ({csvData?.rows?.length || 0} lignes)
                      </button>
                      <button
                        type="button"
                        className={viewMode === "raw" ? "active" : ""}
                        onClick={() => setViewMode("raw")}
                      >
                        Texte brut
                      </button>
                      {viewMode !== "raw" && csvData?.rows?.length > 0 && (
                        <input
                          type="text"
                          className="project-file-preview-search"
                          placeholder="Filtrer les lignes…"
                          value={csvFilter}
                          onChange={(e) => setCsvFilter(e.target.value)}
                        />
                      )}
                    </>
                  )}

                  {category === "json" && (
                    <>
                      <button
                        type="button"
                        className={viewMode === "default" ? "active" : ""}
                        onClick={() => setViewMode("default")}
                      >
                        Formaté
                      </button>
                      <button
                        type="button"
                        className={viewMode === "raw" ? "active" : ""}
                        onClick={() => setViewMode("raw")}
                      >
                        Brut
                      </button>
                    </>
                  )}

                  {category !== "csv" || viewMode === "raw" ? (
                    <button
                      type="button"
                      className={wrapLines ? "active" : ""}
                      onClick={() => setWrapLines((w) => !w)}
                    >
                      Retour auto {wrapLines ? "activé" : "désactivé"}
                    </button>
                  ) : null}
                </div>

                <div className="project-file-preview-subbar-right">
                  <button type="button" onClick={copyText} disabled={loadingText || !textContent}>
                    {copied ? "✓ Copié !" : "📋 Copier tout"}
                  </button>
                </div>
              </div>

              {loadingText && (
                <div className="project-file-preview-unsupported">
                  <p>Chargement du fichier en cours…</p>
                </div>
              )}

              {textError && (
                <div className="project-file-preview-unsupported">
                  <p style={{ color: "var(--c-df8087)" }}>{textError}</p>
                </div>
              )}

              {!loadingText && !textError && category === "csv" && viewMode !== "raw" && csvData && (
                <div className="project-file-preview-table-wrap">
                  <table className="project-file-preview-table">
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>#</th>
                        {csvData.headers.map((h, idx) => (
                          <th key={idx}>{h || `Col ${idx + 1}`}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCsvRows.map((row, rIdx) => (
                        <tr key={rIdx}>
                          <td style={{ color: "var(--c-556157)", userSelect: "none" }}>{rIdx + 1}</td>
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} title={cell}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                      {filteredCsvRows.length === 0 && (
                        <tr>
                          <td colSpan={csvData.headers.length + 1} style={{ textAlign: "center", padding: 24, color: "var(--c-667269)" }}>
                            Aucune ligne ne correspond au filtre.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {!loadingText && !textError && (category !== "csv" || viewMode === "raw") && (
                <div className="project-file-preview-text-wrap">
                  <div className="project-file-preview-line-numbers">
                    <pre style={{ margin: 0, font: "inherit", color: "inherit" }}>{lineNumbers}</pre>
                  </div>
                  <pre className={`project-file-preview-code ${wrapLines ? "wrapped" : ""}`}>
                    {displayedText}
                  </pre>
                </div>
              )}
            </>
          )}

          {category === "other" && (
            <div className="project-file-preview-unsupported">
              <span className="project-file-preview-unsupported-icon">{getFileIcon(file.extension)}</span>
              <h4>{file.name}</h4>
              <p>
                L'aperçu direct de ce type de fichier (<strong>{file.extension || "binaire"}</strong>) n'est pas pris en charge dans le navigateur.
              </p>
              <div className="project-file-preview-unsupported-actions">
                <button type="button" className="primary" onClick={() => onDownload(file.name)}>
                  ↓ Télécharger ({formatFileBytes(file.size)})
                </button>
                <a href={previewUrl} target="_blank" rel="noreferrer" className="ghost">
                  ↗ Tenter l'ouverture dans un nouvel onglet
                </a>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}

function ProjectFilesSection({ project, agents }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dialogMode, setDialogMode] = useState(null); // 'share' ou 'ask'
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [targetAgent, setTargetAgent] = useState(agents[0]?.id || "");
  const [customPrompt, setCustomPrompt] = useState("");
  const [sendingAgent, setSendingAgent] = useState(false);
  const fileInputRef = React.useRef(null);

  const loadFiles = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api(`/api/projects/${encodeURIComponent(project.id)}/files`);
      setFiles(res.files || []);
    } catch {
      // Ignorer
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    loadFiles();
    const interval = setInterval(loadFiles, 3000);
    const onFilesChanged = () => loadFiles();
    window.addEventListener("noyau:files", onFilesChanged);
    return () => {
      clearInterval(interval);
      window.removeEventListener("noyau:files", onFilesChanged);
    };
  }, [loadFiles]);

  async function uploadFileBlob(file) {
    if (!file) return;
    const maxBytes = 500 * 1024 * 1024;
    if (file.size > maxBytes) {
      window.alert(`Fichier trop volumineux (${formatBytes(file.size)}). La taille maximale autorisée est de 500 Mo.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const data = new FormData();
      data.append("file", file);
      await api(`/api/projects/${encodeURIComponent(project.id)}/files`, {
        method: "POST",
        body: data,
      });
      window.dispatchEvent(new Event("noyau:files"));
      await loadFiles();
    } catch (err) {
      const msg = err.message === "File too large"
        ? "Fichier trop volumineux (taille maximale autorisée : 500 Mo)."
        : (err.message || "Erreur upload");
      window.alert(msg);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    await uploadFileBlob(file);
  }

  async function handlePasteImage() {
    try {
      if (!window.isSecureContext || !navigator.clipboard?.read) {
        window.alert("Presse-papiers inaccessible. Utilise Ctrl+V / Cmd+V pour coller.");
        return;
      }
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1]?.replace("jpeg", "jpg") || "png";
          const nowStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          const file = new File([blob], `capture-${nowStr}.${ext}`, { type: imageType });
          await uploadFileBlob(file);
          return;
        }
      }
      window.alert("Aucune image trouvée dans le presse-papiers.");
    } catch {
      window.alert("Impossible d'accéder au presse-papiers (vérifie les permissions ou utilise Ctrl+V).");
    }
  }

  async function handleDelete(filename) {
    if (!window.confirm(`Supprimer définitivement « ${filename} » de l'espace partagé ?`)) return;
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(filename)}`, { method: "DELETE" });
      window.dispatchEvent(new Event("noyau:files"));
      if (previewFile?.name === filename) setPreviewFile(null);
      await loadFiles();
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function downloadFile(filename) {
    try {
      const token = localStorage.getItem("token");
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      const profile = activeProfileId();
      if (profile) headers["x-noyau-profile"] = profile;

      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(filename)}`, {
        credentials: "include",
        headers,
      });
      if (!response.ok) {
        throw new Error(`Erreur ${response.status}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
    } catch {
      window.location.href = `/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(filename)}`;
    }
  }

  async function submitAgentAction() {
    if (!targetAgent) {
      window.alert("Sélectionnez un agent destinataire.");
      return;
    }
    setSendingAgent(true);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/files/tell-agent`, {
        method: "POST",
        body: JSON.stringify({
          agentId: targetAgent,
          action: dialogMode === "ask" ? "request_upload" : "share",
          filename: selectedFile?.name || "",
          prompt: customPrompt,
        }),
      });
      window.dispatchEvent(new CustomEvent("noyau:agent-interact", { detail: { id: targetAgent } }));
      window.alert("Demande transmise avec succès à l'agent.");
      setDialogMode(null);
      setSelectedFile(null);
      setCustomPrompt("");
    } catch (err) {
      window.alert(err.message);
    } finally {
      setSendingAgent(false);
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 o";
    const k = 1024;
    const sizes = ["o", "Ko", "Mo", "Go"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  function getFileIcon(ext) {
    if ([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"].includes(ext)) return "🖼️";
    if ([".pdf"].includes(ext)) return "📄";
    if ([".zip", ".tar", ".gz", ".rar"].includes(ext)) return "📦";
    if ([".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".json", ".html", ".css"].includes(ext)) return "💻";
    if ([".md", ".txt", ".doc", ".docx"].includes(ext)) return "📝";
    return "📁";
  }

  return (
    <details className="project-files">
      <summary>
        <span>Fichiers partagés</span>
        <small>{loading ? "chargement…" : `${files.length} fichier${files.length > 1 ? "s" : ""}`}</small>
        <b>›</b>
      </summary>
      <div
        className="project-files-body"
        onPaste={(e) => {
          const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"))
            || [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).find(Boolean);
          if (file) {
            e.preventDefault();
            uploadFileBlob(file);
          }
        }}
      >
        <div className="project-files-upload-zone">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleUpload}
            style={{ display: "none" }}
          />
          <button
            type="button"
            className="project-files-icon-btn upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title={uploading ? "Upload en cours…" : "Uploader / Téléverser un fichier"}
            aria-label="Uploader un fichier"
          >
            {uploading ? "⏳" : "📤"}
          </button>
          <button
            type="button"
            className="project-files-icon-btn paste"
            onClick={handlePasteImage}
            disabled={uploading}
            title="Coller une image ou capture d'écran du presse-papiers (Ctrl+V)"
            aria-label="Coller image du presse-papiers"
          >
            📋
          </button>
          {agents.length > 0 && (
            <button
              type="button"
              className="project-files-icon-btn ask"
              onClick={() => {
                setDialogMode("ask");
                setSelectedFile(null);
                setCustomPrompt("");
                setTargetAgent(agents[0]?.id || "");
              }}
              title="Demander à un agent de déposer un fichier"
              aria-label="Demander à un agent de déposer un fichier"
            >
              🤖
            </button>
          )}
          <span className="project-files-upload-hint">Glisser-déposer ou coller une image (Ctrl+V)</span>
        </div>

        {dialogMode && (
          <div className="project-files-dialog">
            <strong>
              {dialogMode === "ask" ? "🤖 Demander à un agent de déposer un fichier" : `📤 Partager « ${selectedFile?.name} » avec un agent`}
            </strong>
            <label>
              <small>Agent cible :</small>
              <select value={targetAgent} onChange={(e) => setTargetAgent(e.target.value)}>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({assistantMeta[agent.assistant]?.label || agent.assistant})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <small>Instructions / Message personnalisé (optionnel) :</small>
              <input
                type="text"
                placeholder={dialogMode === "ask" ? "Ex: Génère un CSV récapitulatif des données" : "Ex: Lis ce fichier pour analyser les erreurs"}
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
              />
            </label>
            <div className="project-files-dialog-actions">
              <button type="button" className="ghost" onClick={() => setDialogMode(null)} disabled={sendingAgent}>
                Annuler
              </button>
              <button type="button" className="primary" onClick={submitAgentAction} disabled={sendingAgent}>
                {sendingAgent ? "Envoi…" : "Envoyer à l'agent"}
              </button>
            </div>
          </div>
        )}

        <div className="project-files-list">
          {files.map((file) => (
            <div
              className="project-file-item"
              key={file.name}
              onClick={() => setPreviewFile(file)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPreviewFile(file);
                }
              }}
              title="Cliquer pour prévisualiser dans le navigateur"
            >
              <span className="project-file-icon">{getFileIcon(file.extension)}</span>
              <div className="project-file-info">
                <span className="project-file-name" title={file.name}>{file.name}</span>
                <span className="project-file-meta">{formatBytes(file.size)}</span>
              </div>
              <div className="project-file-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="project-file-btn preview"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewFile(file);
                  }}
                  title="Aperçu dans le navigateur (sans télécharger)"
                  aria-label="Aperçu"
                >
                  👁
                </button>
                <a
                  href={`/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(file.name)}`}
                  download={file.name}
                  className="project-file-btn download"
                  onClick={(e) => {
                    e.preventDefault();
                    downloadFile(file.name);
                  }}
                  title="Télécharger sur l'appareil"
                  aria-label="Télécharger"
                >
                  ↓
                </a>
                {agents.length > 0 && (
                  <button
                    type="button"
                    className="project-file-btn share"
                    onClick={() => {
                      setDialogMode("share");
                      setSelectedFile(file);
                      setCustomPrompt("");
                      setTargetAgent(agents[0]?.id || "");
                    }}
                    title="Transmettre le lien et chemin du fichier à un agent"
                    aria-label="Transmettre à un agent"
                  >
                    🤖
                  </button>
                )}
                <button
                  type="button"
                  className="project-file-btn danger"
                  onClick={() => handleDelete(file.name)}
                  title="Supprimer définitivement ce fichier"
                  aria-label="Supprimer"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          {!files.length && !loading && (
            <span className="project-empty">Aucun fichier partagé dans ce projet pour le moment.</span>
          )}
        </div>
      </div>
      {previewFile && (
        <ProjectFilePreviewModal
          file={previewFile}
          files={files}
          project={project}
          onClose={() => setPreviewFile(null)}
          onSelectFile={(f) => setPreviewFile(f)}
          onDownload={(fname) => downloadFile(fname)}
        />
      )}
    </details>
  );
}

function ProjectBudgetSection({ project, onRefresh }) {
  const [budget, setBudget] = useState(() => project.budget || { items: [] });
  const [loading, setLoading] = useState(false);
  const [busyItem, setBusyItem] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    amount: "",
    cadence: "monthly",
    kind: "subscription",
    category: "SaaS / API",
    billingDay: "",
    notes: "",
  });

  useEffect(() => {
    if (project.budget) {
      setBudget(project.budget);
    }
  }, [project.budget]);

  const items = budget.items || [];

  const monthlyEquivalent = (item) => {
    const amt = Number(item.amount) || 0;
    if (item.cadence === "yearly") return amt / 12;
    if (item.cadence === "weekly") return amt * 4.333;
    if (item.cadence === "once") return 0;
    return amt;
  };

  const activeItems = items.filter((item) => item.active !== false);
  const totalMonthly = activeItems.reduce((acc, item) => acc + monthlyEquivalent(item), 0);
  const totalYearly = totalMonthly * 12;
  const subscriptionsCount = activeItems.filter((i) => i.kind === "subscription").length;
  const recurringCount = activeItems.filter((i) => i.kind === "recurring").length;

  async function handleToggle(item) {
    setBusyItem(item.id);
    const nextActive = item.active === false;
    setBudget((prev) => ({
      items: (prev.items || []).map((i) => (i.id === item.id ? { ...i, active: nextActive } : i)),
    }));
    try {
      const res = await api(`/api/projects/${project.id}/budget/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: nextActive }),
      });
      if (res?.budget) setBudget(res.budget);
      onRefresh?.();
    } catch (err) {
      window.alert(err.message);
      setBudget(project.budget || { items: [] });
    } finally {
      setBusyItem("");
    }
  }

  async function handleDelete(item) {
    if (!confirmAction(`Supprimer la dépense « ${item.name} » ?`)) return;
    setBusyItem(item.id);
    setBudget((prev) => ({
      items: (prev.items || []).filter((i) => i.id !== item.id),
    }));
    try {
      const res = await api(`/api/projects/${project.id}/budget/items/${item.id}`, {
        method: "DELETE",
      });
      if (res?.budget) setBudget(res.budget);
      onRefresh?.();
    } catch (err) {
      window.alert(err.message);
      setBudget(project.budget || { items: [] });
    } finally {
      setBusyItem("");
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!formData.name.trim() || !formData.amount) {
      window.alert("Veuillez renseigner au moins le nom et le montant.");
      return;
    }
    setLoading(true);
    try {
      const res = await api(`/api/projects/${project.id}/budget/items`, {
        method: "POST",
        body: JSON.stringify({
          name: formData.name.trim(),
          amount: parseFloat(formData.amount),
          cadence: formData.cadence,
          kind: formData.kind,
          category: formData.category.trim(),
          billingDay: formData.billingDay ? parseInt(formData.billingDay, 10) : null,
          notes: formData.notes.trim(),
        }),
      });
      if (res?.budget) setBudget(res.budget);
      setFormData({
        name: "",
        amount: "",
        cadence: "monthly",
        kind: "subscription",
        category: "SaaS / API",
        billingDay: "",
        notes: "",
      });
      setShowAddForm(false);
      onRefresh?.();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setLoading(false);
    }
  }

  const cadenceLabel = (c) => {
    switch (c) {
      case "monthly": return "/ mois";
      case "yearly": return "/ an";
      case "weekly": return "/ sem";
      case "once": return "ponctuel";
      default: return "";
    }
  };

  return (
    <details className="project-budget">
      <summary>
        <span>Budget & Abonnements</span>
        <small>
          {euro(totalMonthly)}/mois
          {items.length ? ` · ${items.length} dépense${items.length > 1 ? "s" : ""}` : ""}
        </small>
        <b>›</b>
      </summary>
      <div className="project-budget-body">
        <div className="project-budget-kpis">
          <div className="project-budget-kpi">
            <span className="project-budget-kpi-label">Coût mensuel</span>
            <strong className="project-budget-kpi-value">{euro(totalMonthly)}</strong>
            <small>estimé / mois</small>
          </div>
          <div className="project-budget-kpi">
            <span className="project-budget-kpi-label">Projection annuelle</span>
            <strong className="project-budget-kpi-value">{euro(totalYearly)}</strong>
            <small>sur 12 mois</small>
          </div>
          <div className="project-budget-kpi">
            <span className="project-budget-kpi-label">Détail actifs</span>
            <strong className="project-budget-kpi-value">
              {subscriptionsCount} abo{subscriptionsCount > 1 ? "s" : ""}
            </strong>
            <small>{recurringCount} récurrente{recurringCount > 1 ? "s" : ""}</small>
          </div>
        </div>

        <div className="project-budget-actions">
          <button
            type="button"
            className="project-budget-add-btn"
            onClick={() => setShowAddForm((v) => !v)}
          >
            <span>{showAddForm ? "−" : "＋"}</span>
            {showAddForm ? "Fermer le formulaire" : "Ajouter un abonnement ou dépense"}
          </button>
        </div>

        {showAddForm && (
          <form className="project-budget-form" onSubmit={handleAdd}>
            <div className="budget-form-row">
              <label>
                <span>Type</span>
                <select
                  value={formData.kind}
                  onChange={(e) => {
                    const nextKind = e.target.value;
                    setFormData((prev) => ({
                      ...prev,
                      kind: nextKind,
                      category: nextKind === "subscription" ? "SaaS / API" : "Hébergement / Cloud",
                    }));
                  }}
                >
                  <option value="subscription">Abonnement</option>
                  <option value="recurring">Dépense récurrente</option>
                </select>
              </label>

              <label className="flex-2">
                <span>Nom</span>
                <input
                  type="text"
                  placeholder="ex: OpenAI, Hetzner, Vercel, Domaine..."
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </label>

              <label>
                <span>Montant (€)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={formData.amount}
                  onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                  required
                />
              </label>

              <label>
                <span>Cadence</span>
                <select
                  value={formData.cadence}
                  onChange={(e) => setFormData({ ...formData, cadence: e.target.value })}
                >
                  <option value="monthly">Mensuel</option>
                  <option value="yearly">Annuel</option>
                  <option value="weekly">Hebdomadaire</option>
                  <option value="once">Ponctuel</option>
                </select>
              </label>
            </div>

            <div className="budget-form-row">
              <label className="flex-2">
                <span>Catégorie</span>
                <input
                  type="text"
                  list="budget-categories-list"
                  placeholder="ex: SaaS / API, Hébergement, Domaine, Outils..."
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                />
                <datalist id="budget-categories-list">
                  <option value="SaaS / API" />
                  <option value="Hébergement / Cloud" />
                  <option value="Noms de domaine" />
                  <option value="Outils & Licences" />
                  <option value="IA & Modèles" />
                  <option value="Autre" />
                </datalist>
              </label>

              <label>
                <span>Jour de prélèvement</span>
                <input
                  type="number"
                  min="1"
                  max="31"
                  placeholder="ex: 5"
                  value={formData.billingDay}
                  onChange={(e) => setFormData({ ...formData, billingDay: e.target.value })}
                />
              </label>

              <label className="flex-2">
                <span>Notes (optionnel)</span>
                <input
                  type="text"
                  placeholder="ex: Facturé sur carte bancaire pro"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                />
              </label>
            </div>

            <div className="budget-form-submit-row">
              <button type="submit" className="budget-submit-btn" disabled={loading}>
                {loading ? "Ajout…" : "Enregistrer la dépense"}
              </button>
              <button
                type="button"
                className="budget-cancel-btn"
                onClick={() => setShowAddForm(false)}
              >
                Annuler
              </button>
            </div>
          </form>
        )}

        <div className="project-budget-list">
          {items.map((item) => {
            const isPaused = item.active === false;
            const isSub = item.kind === "subscription";
            const equiv = monthlyEquivalent(item);
            return (
              <div
                key={item.id}
                className={`project-budget-item ${isPaused ? "paused" : ""}`}
              >
                <button
                  type="button"
                  className={`budget-toggle-btn ${item.active !== false ? "active" : ""}`}
                  onClick={() => handleToggle(item)}
                  disabled={busyItem === item.id}
                  title={item.active !== false ? "Dépense active (cliquer pour suspendre)" : "Dépense en pause (cliquer pour réactiver)"}
                >
                  <span className="budget-toggle-dot" />
                </button>

                <span className={`budget-kind-badge ${isSub ? "subscription" : "recurring"}`}>
                  {isSub ? "Abonnement" : "Récurrent"}
                </span>

                <div className="project-budget-item-main">
                  <div className="project-budget-item-name-row">
                    <strong>{item.name}</strong>
                    {item.category && <span className="budget-category-pill">{item.category}</span>}
                    {item.billingDay && (
                      <span className="budget-day-pill" title={`Prélèvement le ${item.billingDay} du mois`}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: "-1px", marginRight: "3px" }}>
                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                          <line x1="16" y1="2" x2="16" y2="6" />
                          <line x1="8" y1="2" x2="8" y2="6" />
                          <line x1="3" y1="10" x2="21" y2="10" />
                        </svg>
                        le {item.billingDay}
                      </span>
                    )}
                  </div>
                  {item.notes && <small className="budget-notes">{item.notes}</small>}
                </div>

                <div className="project-budget-item-amount-col">
                  <strong>
                    {euro(item.amount)} <small>{cadenceLabel(item.cadence)}</small>
                  </strong>
                  {item.cadence !== "monthly" && item.cadence !== "once" && (
                    <small className="budget-equiv">~{euro(equiv)}/m</small>
                  )}
                  {isPaused && <small className="budget-paused-badge">en pause</small>}
                </div>

                {project.canEdit !== false && (
                  <button
                    type="button"
                    className="project-budget-delete-btn"
                    onClick={() => handleDelete(item)}
                    disabled={busyItem === item.id}
                    title="Supprimer cette dépense"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          {!items.length && !showAddForm && (
            <div className="project-empty-budget">
              <span>Aucun abonnement ni dépense récurrente enregistrée.</span>
              <button
                type="button"
                className="project-budget-quick-add"
                onClick={() => setShowAddForm(true)}
              >
                ＋ Ajouter le premier abonnement
              </button>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

function ProjectsView({ projects, sessions, modules, moduleProposals, onOpenAgent, onNew, onEdit, onDelete, onInstallModule, onModuleToggle, onModuleAction, onModuleSchedule, onModuleBuild, onModuleBuildRefresh, onOpenTodos, onReorder, onRefresh, profileId }) {
  // Le cache Todo porte { todos, folders } depuis la refonte par dossier: on accepte les deux formes.
  const [todos, setTodos] = useState(() => {
    const cached = cachedView("todos");
    return (Array.isArray(cached) ? cached : cached?.todos) || [];
  });
  const [draggedProject, setDraggedProject] = useState("");
  const cardRefs = React.useRef(new Map());
  const dragRef = React.useRef(null);

  const [expandedProjectAgents, setExpandedProjectAgents] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(profileCacheKey("projects-expanded-agents"))) || {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(profileCacheKey("projects-expanded-agents")));
      setExpandedProjectAgents(stored || {});
    } catch {
      setExpandedProjectAgents({});
    }
  }, [profileId]);

  const toggleProjectAgents = useCallback((projectId, isOpen) => {
    setExpandedProjectAgents((prev) => {
      const isCurrentlyOpen = Boolean(prev[projectId]);
      if (isCurrentlyOpen === isOpen) return prev;
      const next = { ...prev };
      if (isOpen) {
        next[projectId] = true;
      } else {
        delete next[projectId];
      }
      try {
        localStorage.setItem(profileCacheKey("projects-expanded-agents"), JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const loadTodos = useCallback(async () => {
    try {
      const result = await api("/api/todos");
      setTodos(result.todos || []);
      storeView("todos", { todos: result.todos || [], folders: result.folders || [] });
    } catch { /* on garde la derniere liste connue */ }
  }, []);

  useEffect(() => { loadTodos(); }, [loadTodos]);

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
          const isProd = (module) => module.environment === "production";
          const projectModules = modules
            .filter((module) => module.projectId === project.id && !isProd(module))
            .sort((a, b) => (b.deviceBuild ? 1 : 0) - (a.deviceBuild ? 1 : 0));
          const proposals = moduleProposals
            .filter((module) => module.projectId === project.id && !isProd(module))
            .sort((a, b) => (b.id?.includes("build") ? 1 : 0) - (a.id?.includes("build") ? 1 : 0));
          const prodModules = modules.filter((module) => module.projectId === project.id && isProd(module));
          const prodProposals = moduleProposals.filter((module) => module.projectId === project.id && isProd(module));
          const prodHosts = [...new Set([...prodModules, ...prodProposals].map((module) => module.executionHost).filter(Boolean))];
          const prodActive = prodModules.filter((module) => module.enabled).length;
          const prodAlerts = prodModules.filter((module) => module.state === "failed" || module.setup?.status === "required").length;
          const projectTodos = todos.filter((todo) => todo.projectId === project.id);
          return (
            <article
              className={`panel project-card ${draggedProject === project.id ? "dragging" : ""}`}
              key={project.id}
              ref={(node) => { if (node) cardRefs.current.set(project.id, node); else cardRefs.current.delete(project.id); }}
            >
              <header><button className="project-drag" onPointerDown={(event) => startDrag(event, project)} onPointerMove={dragOver} onPointerUp={endDrag} onPointerCancel={endDrag} title="Glisser pour changer ordre" aria-label={`Déplacer ${project.name}`}>⠿</button><ProjectIcon project={project} /><span><strong>{project.name}{project.canEdit === false ? <b className="shared-chip" title={`Projet partagé par ${project.owner?.name || "autre profil"}`}>⇄ {project.owner?.name || "partagé"}</b> : project.shared ? <b className="shared-chip own" title="Projet partagé avec les autres profils">⇄ partagé</b> : null}</strong><small>{project.rootPath || "Dossiers propres aux agents"}</small></span>{project.canEdit !== false && <div><button onClick={() => onEdit(project.id)}>Éditer</button><button className="project-delete" onClick={() => onDelete(project)}>×</button></div>}</header>
              <details
                className="project-agents-accordion"
                open={Boolean(expandedProjectAgents[project.id])}
                onToggle={(e) => toggleProjectAgents(project.id, e.currentTarget.open)}
              >
                <summary>
                  <span>Agents</span>
                  <small>{agents.length} actif{agents.length > 1 ? "s" : ""}{agents.some((s) => s.agentStatus?.state === "working") ? " · en cours" : ""}</small>
                  <b>›</b>
                </summary>
                <div className="project-agents">
                  {agents.map((session) => <button key={session.id} onClick={() => onOpenAgent(session.id)}><AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small /><span><strong>{session.favorite && <i className="favorite-star">★</i>}{session.name}</strong><small><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {assistantMeta[session.assistant]?.label} · {session.agentStatus?.label || "Disponible"}</small></span><b>›</b></button>)}
                  {!agents.length && <span className="project-empty">Aucun agent rattaché.</span>}
                </div>
              </details>
              <ProjectReporting project={project} agents={agents} todos={projectTodos} onRefresh={onRefresh} />
              <ProjectBudgetSection project={project} onRefresh={onRefresh} />
              {(projectModules.length > 0 || proposals.length > 0) && <details className="project-modules"><summary><span>Modules</span><small>{projectModules.length} installé{projectModules.length > 1 ? "s" : ""}{projectModules.some((module) => module.enabled) ? " · actif" : ""}</small><b>›</b></summary><div className="project-module-list">{projectModules.map((module) => <ProjectModule key={module.id} module={module} onToggle={onModuleToggle} onAction={onModuleAction} onSchedule={onModuleSchedule} onBuild={onModuleBuild} onRefreshBuilds={onModuleBuildRefresh} onRefresh={onRefresh} />)}{proposals.map((module) => <button className="module-proposal" key={module.id} onClick={() => onInstallModule(module.id)} style={{ "--module-accent": module.accent }}><span>{module.glyph}</span><div><strong>Ajouter {module.name}</strong><small>{module.description}</small></div><b>＋</b></button>)}</div></details>}
              {(prodModules.length > 0 || prodProposals.length > 0) && <details className="project-modules project-production"><summary><span>Production</span><small className={prodAlerts ? "warn" : ""}>{prodModules.length} service{prodModules.length > 1 ? "s" : ""} · {prodActive} actif{prodActive > 1 ? "s" : ""}{prodAlerts ? ` · ${prodAlerts} à vérifier` : ""}{prodHosts.length ? ` · ${prodHosts.join(", ")}` : ""}</small><b>›</b></summary><div className="project-module-list">{prodModules.map((module) => <ProjectModule key={module.id} module={module} onToggle={onModuleToggle} onAction={onModuleAction} onSchedule={onModuleSchedule} onBuild={onModuleBuild} onRefreshBuilds={onModuleBuildRefresh} onRefresh={onRefresh} />)}{prodProposals.map((module) => <button className="module-proposal" key={module.id} onClick={() => onInstallModule(module.id)} style={{ "--module-accent": module.accent }}><span>{module.glyph}</span><div><strong>Ajouter {module.name}</strong><small>{module.executionHost ? `${module.executionHost} · ` : ""}{module.description}</small></div><b>＋</b></button>)}</div></details>}

              <ProjectFilesSection project={project} agents={agents} />
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

function isCommentByAgent(comment) {
  if (!comment) return false;
  if (comment.kind === "agent" || comment.authorKind === "agent") return true;
  if (comment.kind === "user" || comment.authorKind === "user") return false;
  const author = String(comment.author || "").toLowerCase();
  if (["antigravity", "codex", "claude", "laptop", "noyau", "agent"].includes(author)) {
    if (/demandé à nouveau/i.test(comment.text)) return false;
    return true;
  }
  return false;
}

function FolderCreateModal({ parentFolder, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState(parentFolder ? "📁" : "📁");
  const [userPickedEmoji, setUserPickedEmoji] = useState(false);
  const [loadingEmoji, setLoadingEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const commonEmojis = [
    "💻", "🎨", "📣", "💡", "🐛", "🚀", "📦", "📝",
    "🔧", "🔒", "📊", "⚡", "🎯", "🧪", "🛠️", "📱",
    "🌐", "📚", "💬", "🎬", "✨", "💰", "🔍", "⚙️"
  ];

  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed || userPickedEmoji) return;
    const timer = setTimeout(async () => {
      setLoadingEmoji(true);
      try {
        const res = await fetch(`/api/todos/suggest-emoji?name=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        if (data.emoji && !userPickedEmoji) {
          setEmoji(data.emoji);
        }
      } catch {}
      setLoadingEmoji(false);
    }, 350);
    return () => clearTimeout(timer);
  }, [name, userPickedEmoji]);

  async function submit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const cleanName = trimmed.replace(/^[\p{Extended_Pictographic}\s]+/u, "");
      const fullName = `${emoji} ${cleanName}`.trim();
      await onCreated({
        name: fullName,
        parentId: parentFolder ? parentFolder.id : null,
        projectId: parentFolder ? (parentFolder.projectId || null) : null,
      });
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal todo-folder-modal">
        <div className="modal-head">
          <div>
            <p className="eyebrow">{parentFolder ? "SOUS-DOSSIER" : "DOSSIER"}</p>
            <h2>{parentFolder ? `Sous-dossier dans ${parentFolder.name}` : "Nouveau dossier"}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">×</button>
        </div>
        <form onSubmit={submit}>
          <label>Emoji de la zone</label>
          <div className="todo-folder-emoji-bar">
            <button
              type="button"
              className="todo-folder-emoji-btn"
              onClick={() => setShowPicker(!showPicker)}
              title="Cliquer pour choisir un emoji"
            >
              <span className="todo-folder-emoji-large">{emoji}</span>
              <span className="todo-folder-emoji-label">{loadingEmoji ? "IA…" : "Modifier"}</span>
            </button>
            <div className="todo-folder-emoji-quick">
              {commonEmojis.slice(0, 8).map((em) => (
                <button
                  key={em}
                  type="button"
                  className={`todo-emoji-chip ${emoji === em ? "selected" : ""}`}
                  onClick={() => { setEmoji(em); setUserPickedEmoji(true); }}
                >
                  {em}
                </button>
              ))}
              <button
                type="button"
                className="todo-emoji-chip more"
                onClick={() => setShowPicker(!showPicker)}
                title="Plus d'emojis"
              >
                {showPicker ? "▲" : "▼"}
              </button>
            </div>
          </div>
          {showPicker && (
            <div className="todo-emoji-picker-grid">
              {commonEmojis.map((em) => (
                <button
                  key={em}
                  type="button"
                  className={`todo-emoji-pick ${emoji === em ? "selected" : ""}`}
                  onClick={() => { setEmoji(em); setUserPickedEmoji(true); }}
                >
                  {em}
                </button>
              ))}
            </div>
          )}

          <label htmlFor="folder-name-input">Nom {parentFolder ? "du sous-dossier" : "du dossier"}</label>
          <input
            id="folder-name-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={parentFolder ? "ex: Développement, Design, Idées…" : "ex: Projets, Personnel…"}
            maxLength={100}
          />

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>Annuler</button>
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {busy ? "Création…" : parentFolder ? "Créer sous-dossier" : "Créer dossier"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function CalendarSyncModal({ onClose, onUpdated }) {
  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api("/api/calendar/subscriptions");
      setSubscriptions(res.subscriptions || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setError("");
    try {
      await api("/api/calendar/subscriptions", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || "Mon calendrier", url: url.trim(), color }),
      });
      setName("");
      setUrl("");
      await load();
      onUpdated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api(`/api/calendar/subscriptions/${id}`, { method: "DELETE" });
      await load();
      onUpdated?.();
    } catch (err) {
      setError(err.message);
    }
  }

  const exportUrl = `${window.location.origin}/api/calendar/export.ics`;
  const copyExport = () => {
    navigator.clipboard?.writeText(exportUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal calendar-sync-modal">
        <div className="modal-head">
          <div>
            <p className="eyebrow">CALENDRIERS EXTERNES</p>
            <h2>Liaison iCal / Webcal</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">×</button>
        </div>

        <div className="calendar-sync-body">
          <section className="calendar-sync-section">
            <h3>📥 Synchroniser dans votre calendrier perso</h3>
            <p className="muted small">Abonnez Google Calendar, Apple Calendar ou Outlook à vos tâches Noyau :</p>
            <div className="calendar-export-row">
              <input readOnly value={exportUrl} className="calendar-export-input" />
              <button type="button" className="ghost" onClick={copyExport}>
                {copied ? "✓ Copié" : "Copier lien"}
              </button>
              <a href="/api/calendar/export.ics" download="noyau-todos.ics" className="button ghost">
                Télécharger .ics
              </a>
            </div>
          </section>

          <section className="calendar-sync-section">
            <h3>➕ Ajouter un calendrier perso (iCal / Webcal)</h3>
            <form onSubmit={handleAdd} className="calendar-add-form">
              {error && <p className="finance-error">{error}</p>}
              <div className="calendar-form-row">
                <input
                  type="text"
                  placeholder="Nom (ex: Google Agenda, Apple Cal...)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="calendar-color-picker"
                  title="Couleur des pastilles"
                />
              </div>
              <input
                type="text"
                placeholder="URL iCal (webcal://... ou https://... .ics)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
              <button type="submit" className="primary" disabled={adding || !url.trim()}>
                {adding ? "Connexion…" : "Ajouter ce calendrier"}
              </button>
            </form>
          </section>

          <section className="calendar-sync-section">
            <h3>📋 Vos abonnements actifs ({subscriptions.length})</h3>
            {loading ? (
              <p className="muted">Chargement…</p>
            ) : subscriptions.length === 0 ? (
              <p className="muted small">Aucun calendrier externe configuré pour le moment.</p>
            ) : (
              <ul className="calendar-subs-list">
                {subscriptions.map((sub) => (
                  <li key={sub.id} className="calendar-sub-item">
                    <span className="calendar-sub-dot" style={{ backgroundColor: sub.color || "#3b82f6" }} />
                    <div className="calendar-sub-info">
                      <strong>{sub.name}</strong>
                      <small className="muted">{sub.url}</small>
                    </div>
                    <button
                      type="button"
                      className="icon-button danger-link"
                      onClick={() => handleDelete(sub.id)}
                      title="Supprimer l'abonnement"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>Fermer</button>
        </div>
      </section>
    </div>
  );
}

function getCalendarProjectColor(projectOrId, projects = []) {
  if (!projectOrId) return "#64748b";
  const proj = typeof projectOrId === "object" ? projectOrId : (projects || []).find((p) => p.id === projectOrId);
  const str = proj?.name || proj?.id || (typeof projectOrId === "string" ? projectOrId : "");
  if (!str) return "#64748b";
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i);
  const colors = ["#38bdf8", "#34d399", "#a78bfa", "#f59e0b", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];
  return colors[Math.abs(hash) % colors.length];
}

function resolveCalendarTodoProject(todo, folders = [], projects = []) {
  if (todo?.projectId) {
    return (projects || []).find((p) => p.id === todo.projectId) || { id: todo.projectId, name: "Projet" };
  }
  if (todo?.folderId) {
    const folder = (folders || []).find((f) => f.id === todo.folderId);
    if (folder?.projectId) {
      return (projects || []).find((p) => p.id === folder.projectId) || { id: folder.projectId, name: folder.name || "Projet" };
    }
  }
  return null;
}

// Les compteurs ne montrent que le travail restant: une tache terminee ne compte plus.
const isTodoDone = (todo) => todo.status === "done" || Boolean(todo.completed);
const countOpenTodos = (list) => list.reduce((total, todo) => total + (isTodoDone(todo) ? 0 : 1), 0);

function TodoCalendar({ todos = [], folders = [], projects = [], onSelectDate, onOpenFolder, onTodoClick }) {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("noyau-calendar-collapsed") === "true"; } catch { return false; }
  });
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => localIsoDate());
  const [projectFilter, setProjectFilter] = useState("all");
  const [externalEvents, setExternalEvents] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [widgetMode, setWidgetMode] = useState(false);
  const [newTodoText, setNewTodoText] = useState("");
  const [newTodoProjectId, setNewTodoProjectId] = useState("");
  const [newTodoAssignee, setNewTodoAssignee] = useState(() => {
    try {
      return localStorage.getItem("noyau-todo-last-assignee") || "main";
    } catch {
      return "main";
    }
  });
  const [addingTodo, setAddingTodo] = useState(false);
  const [schedulingId, setSchedulingId] = useState(null);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("noyau-calendar-collapsed", String(next)); } catch {}
      return next;
    });
  };

  const loadCalendarData = useCallback(async () => {
    try {
      const data = await api("/api/calendar/events");
      if (data?.events) setExternalEvents(data.events);
      if (data?.subscriptions) setSubscriptions(data.subscriptions);
    } catch {}
  }, []);

  useEffect(() => {
    loadCalendarData();
    const timer = setInterval(loadCalendarData, 60_000);
    return () => clearInterval(timer);
  }, [loadCalendarData]);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(currentDate);

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const goToday = () => {
    const now = new Date();
    setCurrentDate(now);
    setSelectedDay(localIsoDate(now));
  };

  const firstDayOfMonth = new Date(year, month, 1);
  const startingDayOfWeek = (firstDayOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayIso = localIsoDate();

  const filteredTodos = useMemo(() => {
    if (projectFilter === "all") return todos;
    if (projectFilter === "none") {
      return todos.filter((t) => !resolveCalendarTodoProject(t, folders, projects));
    }
    return todos.filter((t) => {
      const p = resolveCalendarTodoProject(t, folders, projects);
      return p?.id === projectFilter;
    });
  }, [todos, projectFilter, folders, projects]);

  const todosByDay = useMemo(() => {
    const map = new Map();
    for (const todo of filteredTodos) {
      if (todo.dueDate) {
        const list = map.get(todo.dueDate) || [];
        list.push({ ...todo, _calKind: "due" });
        map.set(todo.dueDate, list);
      } else if (todo.completedAt && (todo.status === "done" || todo.completed)) {
        const compDate = todo.completedAt.slice(0, 10);
        const list = map.get(compDate) || [];
        list.push({ ...todo, _calKind: "completed" });
        map.set(compDate, list);
      }
    }
    return map;
  }, [filteredTodos]);

  const unscheduledTodos = useMemo(() => {
    return filteredTodos.filter((t) => !t.dueDate && t.status !== "done" && !t.completed);
  }, [filteredTodos]);

  async function scheduleTodo(todoId, dateStr) {
    setSchedulingId(todoId);
    try {
      await api(`/api/todos/${encodeURIComponent(todoId)}`, {
        method: "PATCH",
        body: JSON.stringify({ dueDate: dateStr }),
      });
      window.dispatchEvent(new CustomEvent("noyau:todos-refresh"));
    } catch (err) {
      window.alert(err.message);
    } finally {
      setSchedulingId(null);
    }
  }

  async function unscheduleTodo(todoId) {
    setSchedulingId(todoId);
    try {
      await api(`/api/todos/${encodeURIComponent(todoId)}`, {
        method: "PATCH",
        body: JSON.stringify({ dueDate: null }),
      });
      window.dispatchEvent(new CustomEvent("noyau:todos-refresh"));
    } catch (err) {
      window.alert(err.message);
    } finally {
      setSchedulingId(null);
    }
  }

  async function toggleTodoStatus(todo) {
    const nextStatus = (todo.status === "done" || todo.completed) ? "todo" : "done";
    try {
      await api(`/api/todos/${encodeURIComponent(todo.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      window.dispatchEvent(new CustomEvent("noyau:todos-refresh"));
    } catch (err) {
      window.alert(err.message);
    }
  }

  async function toggleTodoShared(todo) {
    try {
      await api(`/api/todos/${encodeURIComponent(todo.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ shared: !todo.shared }),
      });
      window.dispatchEvent(new CustomEvent("noyau:todos-refresh"));
    } catch (err) {
      window.alert(err.message);
    }
  }

  const externalEventsByDay = useMemo(() => {
    const map = new Map();
    for (const evt of externalEvents) {
      if (!evt.start) continue;
      const list = map.get(evt.start) || [];
      list.push(evt);
      map.set(evt.start, list);
    }
    return map;
  }, [externalEvents]);

  const selectedTodos = todosByDay.get(selectedDay) || [];
  const selectedExtEvents = externalEventsByDay.get(selectedDay) || [];

  const groupedSelectedTodos = useMemo(() => {
    const groups = new Map();
    for (const todo of selectedTodos) {
      const proj = resolveCalendarTodoProject(todo, folders, projects);
      const key = proj ? proj.id : "__none__";
      const name = proj ? proj.name : "Sans projet";
      const color = proj ? getCalendarProjectColor(proj, projects) : "#64748b";
      if (!groups.has(key)) {
        groups.set(key, { id: key, name, color, isProject: Boolean(proj), items: [] });
      }
      groups.get(key).items.push(todo);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.id === "__none__") return 1;
      if (b.id === "__none__") return -1;
      return a.name.localeCompare(b.name);
    });
  }, [selectedTodos, folders, projects]);

  const groupedUnscheduledTodos = useMemo(() => {
    const groups = new Map();
    for (const todo of unscheduledTodos) {
      const proj = resolveCalendarTodoProject(todo, folders, projects);
      const key = proj ? proj.id : "__none__";
      const name = proj ? proj.name : "Sans projet";
      const color = proj ? getCalendarProjectColor(proj, projects) : "#64748b";
      if (!groups.has(key)) {
        groups.set(key, { id: key, name, color, isProject: Boolean(proj), items: [] });
      }
      groups.get(key).items.push(todo);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.id === "__none__") return 1;
      if (b.id === "__none__") return -1;
      return a.name.localeCompare(b.name);
    });
  }, [unscheduledTodos, folders, projects]);

  async function handleQuickAddTodo(e) {
    e.preventDefault();
    if (!newTodoText.trim() || addingTodo) return;
    setAddingTodo(true);
    try {
      const targetProjectId = newTodoProjectId || (projectFilter !== "all" && projectFilter !== "none" ? projectFilter : null);
      const isBoth = newTodoAssignee === "all" || newTodoAssignee === "both";
      await api("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          text: newTodoText.trim(),
          dueDate: selectedDay,
          projectId: targetProjectId || undefined,
          assignee: newTodoAssignee,
          shared: isBoth,
        }),
      });
      setNewTodoText("");
      window.dispatchEvent(new CustomEvent("noyau:todos-refresh"));
    } catch {} finally {
      setAddingTodo(false);
    }
  }

  const formattedSelectedDay = useMemo(() => {
    try {
      const [y, m, d] = selectedDay.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
    } catch {
      return selectedDay;
    }
  }, [selectedDay]);

  const days = [];
  for (let i = 0; i < startingDayOfWeek; i++) {
    days.push({ dayNumber: null, key: `empty-${i}` });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dayTodos = todosByDay.get(dateStr) || [];
    const dayEvents = externalEventsByDay.get(dateStr) || [];
    days.push({
      dayNumber: d,
      dateStr,
      isToday: dateStr === todayIso,
      isSelected: dateStr === selectedDay,
      todos: dayTodos,
      events: dayEvents,
      key: dateStr,
    });
  }

  const projectCounts = useMemo(() => {
    const counts = {};
    for (const t of todos) {
      if (isTodoDone(t)) continue;
      const p = resolveCalendarTodoProject(t, folders, projects);
      const key = p ? p.id : "__none__";
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [todos, folders, projects]);

  return (
    <div className={`todo-calendar-panel ${collapsed ? "collapsed" : ""}`}>
      {syncModalOpen && (
        <CalendarSyncModal
          onClose={() => setSyncModalOpen(false)}
          onUpdated={loadCalendarData}
        />
      )}

      <div className="todo-calendar-header">
        <div className="todo-calendar-title-group">
          <button type="button" className="cal-collapse-btn" onClick={toggleCollapsed} title={collapsed ? "Déplier le calendrier" : "Replier le calendrier"}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={collapsed ? "chevron-collapsed" : ""}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div className="cal-header-title-box">
            <h2 className="todo-calendar-month-name">{monthName.charAt(0).toUpperCase() + monthName.slice(1)}</h2>
            {!collapsed && (
              <div className="cal-nav-buttons">
                <button type="button" className="cal-nav-btn" onClick={prevMonth} title="Mois précédent" aria-label="Mois précédent">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <button type="button" className="cal-today-btn" onClick={goToday}>
                  Aujourd'hui
                </button>
                <button type="button" className="cal-nav-btn" onClick={nextMonth} title="Mois suivant" aria-label="Mois suivant">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="todo-calendar-actions">
          {subscriptions.length > 0 && (
            <div className="calendar-active-subs-pills">
              {subscriptions.map((s) => (
                <span key={s.id} className="calendar-sub-pill" style={{ borderColor: s.color || "#3b82f6" }}>
                  <span className="dot" style={{ backgroundColor: s.color || "#3b82f6" }} />
                  {s.name}
                </span>
              ))}
            </div>
          )}
          <button type="button" className="cal-action-btn" onClick={() => setSyncModalOpen(true)} title="Lier calendriers Google, Apple ou Outlook">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
            <span>Sync iCal</span>
          </button>
          <a href="/api/calendar/export.ics" download="noyau-todos.ics" className="cal-action-btn" title="Exporter les todos Noyau en flux .ics">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            <span>Export .ics</span>
          </a>
          <button
            type="button"
            className={`cal-action-btn ${widgetMode ? "active" : ""}`}
            onClick={() => setWidgetMode(!widgetMode)}
            title="Basculer entre vue calendrier et vue widgets"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg>
            <span>{widgetMode ? "Vue grille" : "Vue widgets"}</span>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="cal-filter-toolbar">
          <div className="cal-filter-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
            <span>Filtrer par projet :</span>
          </div>
          <div className="cal-project-filter-chips">
            <button
              type="button"
              className={`cal-filter-chip ${projectFilter === "all" ? "active" : ""}`}
              onClick={() => setProjectFilter("all")}
            >
              Tous les projets
              <span className="cal-chip-count">{countOpenTodos(todos)}</span>
            </button>
            {projects.map((p) => {
              const count = projectCounts[p.id] || 0;
              const color = getCalendarProjectColor(p, projects);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`cal-filter-chip ${projectFilter === p.id ? "active" : ""}`}
                  onClick={() => setProjectFilter(p.id)}
                >
                  <span className="cal-chip-dot" style={{ backgroundColor: color }} />
                  <span>{p.name}</span>
                  {count > 0 && <span className="cal-chip-count">{count}</span>}
                </button>
              );
            })}
            {(projectCounts["__none__"] || 0) > 0 && (
              <button
                type="button"
                className={`cal-filter-chip ${projectFilter === "none" ? "active" : ""}`}
                onClick={() => setProjectFilter("none")}
              >
                Sans projet
                <span className="cal-chip-count">{projectCounts["__none__"]}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="todo-calendar-body">
          {!widgetMode ? (
            <div className="todo-calendar-grid-wrap">
              <div className="todo-calendar-weekdays">
                <span>Lun</span><span>Mar</span><span>Mer</span><span>Jeu</span><span>Ven</span><span>Sam</span><span>Dim</span>
              </div>
              <div className="todo-calendar-grid">
                {days.map((item) => {
                  if (!item.dayNumber) {
                    return <div key={item.key} className="todo-calendar-cell empty" />;
                  }
                  const hasItems = item.todos.length > 0 || item.events.length > 0;
                  const openTodos = item.todos.filter((t) => t.status !== "done" && !t.completed && t._calKind === "due");
                  const doneTodos = item.todos.filter((t) => t.status === "done" || t.completed || t._calKind === "completed");

                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`todo-calendar-cell ${item.isToday ? "today" : ""} ${item.isSelected ? "selected" : ""} ${hasItems ? "has-items" : ""}`}
                      onClick={() => {
                        setSelectedDay(item.dateStr);
                        onSelectDate?.(item.dateStr);
                      }}
                    >
                      <div className="cal-cell-header">
                        <span className={`day-number ${item.isToday ? "is-today" : ""}`}>{item.dayNumber}</span>
                        {item.isToday && <span className="cal-cell-today-pill">Auj.</span>}
                      </div>
                      <div className="calendar-markers">
                        {openTodos.slice(0, 3).map((t, idx) => {
                          const p = resolveCalendarTodoProject(t, folders, projects);
                          const color = p ? getCalendarProjectColor(p, projects) : "#f59e0b";
                          return (
                            <span
                              key={t.id || idx}
                              className="cal-dot todo-open"
                              style={{ backgroundColor: color }}
                              title={`[${p?.name || "Tâche"}] ${t.text}`}
                            />
                          );
                        })}
                        {openTodos.length > 3 && (
                          <span className="cal-dot-more">+{openTodos.length - 3}</span>
                        )}
                        {doneTodos.length > 0 && openTodos.length <= 2 && (
                          <span className="cal-dot todo-done" title={`${doneTodos.length} terminée(s)`} />
                        )}
                        {item.events.slice(0, 2).map((evt, idx) => (
                          <span
                            key={evt.uid || idx}
                            className="cal-dot ext-event"
                            style={{ backgroundColor: evt.color || "#38bdf8" }}
                            title={`[${evt.calendarName}] ${evt.title}`}
                          />
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="todo-calendar-widget-view">
              <div className="widget-card widget-today">
                <span className="widget-eyebrow">AUJOURD’HUI</span>
                <strong className="widget-date-num">{new Date().getDate()}</strong>
                <span className="widget-month-sub">{new Intl.DateTimeFormat("fr-FR", { weekday: "long", month: "short" }).format(new Date())}</span>
                <small className="widget-count">
                  {countOpenTodos(todosByDay.get(todayIso) || [])} tâche(s) planifiée(s)
                </small>
              </div>
              <div className="widget-upcoming-list">
                <span className="widget-eyebrow">PROCHAINES ÉCHÉANCES</span>
                {Array.from(todosByDay.entries())
                  .filter(([date]) => date >= todayIso)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .slice(0, 6)
                  .map(([date, list]) => (
                    <div key={date} className="widget-upcoming-row" onClick={() => setSelectedDay(date)}>
                      <span className="widget-upcoming-date">{date.split("-").reverse().slice(0, 2).join("/")}</span>
                      <div className="widget-upcoming-todos">
                        {list.map((t) => {
                          const p = resolveCalendarTodoProject(t, folders, projects);
                          const color = p ? getCalendarProjectColor(p, projects) : "#64748b";
                          return (
                            <span
                              key={t.id}
                              className={`widget-todo-tag ${t.status === "done" ? "done" : ""}`}
                              style={{ borderLeftColor: color }}
                            >
                              {p && <strong style={{ color }}>{p.name}: </strong>}
                              {t.text}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                {Array.from(todosByDay.entries()).filter(([date]) => date >= todayIso).length === 0 && (
                  <p className="muted small">Aucune échéance à venir.</p>
                )}
              </div>
            </div>
          )}

          <div className="todo-calendar-day-detail">
            <div className="day-detail-header">
              <div className="day-detail-title-wrap">
                <span className="cal-day-detail-icon">📅</span>
                <div>
                  <h3 className="day-detail-date-title">
                    {formattedSelectedDay.charAt(0).toUpperCase() + formattedSelectedDay.slice(1)}
                  </h3>
                  <small className="muted">
                    {countOpenTodos(selectedTodos)} tâche{countOpenTodos(selectedTodos) > 1 ? "s" : ""}
                    {selectedExtEvents.length > 0 ? ` · ${selectedExtEvents.length} événement(s)` : ""}
                    {projectFilter !== "all" && projectFilter !== "none" ? ` (filtre: ${projects.find((p) => p.id === projectFilter)?.name || ""})` : ""}
                  </small>
                </div>
              </div>
              {selectedDay === todayIso && (
                <span className="day-detail-today-badge">Aujourd'hui</span>
              )}
            </div>

            <form onSubmit={handleQuickAddTodo} className="day-quick-add-form">
              <input
                type="text"
                placeholder={`+ Ajouter une tâche pour ce jour…`}
                value={newTodoText}
                onChange={(e) => setNewTodoText(e.target.value)}
              />
              {projects.length > 0 && (
                <select
                  value={newTodoProjectId}
                  onChange={(e) => setNewTodoProjectId(e.target.value)}
                  className="day-quick-project-select"
                  title="Assigner directement à un projet"
                >
                  <option value="">(Projet…)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )}
              <select
                value={newTodoAssignee}
                onChange={(e) => {
                  setNewTodoAssignee(e.target.value);
                  try { localStorage.setItem("noyau-todo-last-assignee", e.target.value); } catch {}
                }}
                className={`todo-assignee-select cal-quick-assignee-select assignee-${newTodoAssignee}`}
                title="Attribuer la tâche (Aurora, Moi, ou tout le monde)"
                aria-label="Attribution de la tâche"
              >
                <option value="aurora">🌸 Aurora</option>
                <option value="main">👤 Moi</option>
                <option value="all">👥 Tout le monde</option>
              </select>
              <button type="submit" className="primary mini quick-add-btn" disabled={addingTodo || !newTodoText.trim()}>
                {addingTodo ? "…" : "Ajouter"}
              </button>
            </form>

            <div className="day-detail-items">
              {selectedExtEvents.map((evt) => (
                <div key={evt.uid} className="calendar-event-card">
                  <span className="event-color-bar" style={{ backgroundColor: evt.color || "#38bdf8" }} />
                  <div className="event-content">
                    <div className="event-title-row">
                      <strong>{evt.title}</strong>
                      <span className="event-source-badge" style={{ color: evt.color || "#38bdf8" }}>{evt.calendarName}</span>
                    </div>
                    {evt.description && <p className="event-desc">{evt.description}</p>}
                    {evt.location && <span className="event-loc">📍 {evt.location}</span>}
                  </div>
                </div>
              ))}

              {groupedSelectedTodos.map((group) => (
                <div key={group.id} className="cal-day-project-group">
                  <div className="cal-day-project-header">
                    <span className="cal-chip-dot" style={{ backgroundColor: group.color }} />
                    <span className="cal-day-project-name">{group.name}</span>
                    <span className="cal-day-project-count">{countOpenTodos(group.items)}</span>
                  </div>
                  <div className="cal-day-project-tasks">
                    {group.items.map((todo) => {
                      const isDone = todo.status === "done" || todo.completed;
                      return (
                        <div key={todo.id} className={`calendar-todo-card ${isDone ? "done" : ""}`}>
                          <button
                            type="button"
                            className={`cal-todo-checkbox ${isDone ? "checked" : ""}`}
                            onClick={(e) => { e.stopPropagation(); toggleTodoStatus(todo); }}
                            title={isDone ? "Marquer à faire" : "Marquer terminé"}
                          >
                            {isDone ? "✓" : ""}
                          </button>
                          <span className="todo-text" onClick={() => onTodoClick?.(todo)}>{todo.text}</span>
                          {todo.shared && (
                            <span className="todo-shared-chip" title={todo.ownerName ? `Partagé par ${todo.ownerName}` : "Tâche partagée"}>
                              👥 {todo.ownerName || "Partagée"}
                            </span>
                          )}
                          <button
                            type="button"
                            className={`cal-share-btn ${todo.shared ? "is-shared" : ""}`}
                            onClick={(e) => { e.stopPropagation(); toggleTodoShared(todo); }}
                            title={todo.shared ? "Tâche partagée (cliquer pour rendre privée)" : "Tâche privée (cliquer pour partager)"}
                          >
                            👥
                          </button>
                          {todo._calKind === "completed" && (
                            <span className="todo-completed-tag">✓ Réalisé</span>
                          )}
                          {todo._calKind === "due" && (
                            <button
                              type="button"
                              className="icon-button mini remove-due-btn"
                              onClick={() => unscheduleTodo(todo.id)}
                              title="Retirer la date d'échéance"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {selectedTodos.length === 0 && selectedExtEvents.length === 0 && (
                <p className="calendar-day-empty">Rien de planifié pour cette date.</p>
              )}
            </div>

            {unscheduledTodos.length > 0 && (
              <div className="calendar-unscheduled-box">
                <div className="unscheduled-head">
                  <div className="unscheduled-head-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                    <strong>Tâches à planifier ({unscheduledTodos.length})</strong>
                  </div>
                  <small className="muted">Triées par projet · Planifier pour le {selectedDay.split("-").reverse().join("/")}</small>
                </div>
                <div className="unscheduled-grouped-list">
                  {groupedUnscheduledTodos.map((group) => (
                    <div key={group.id} className="unscheduled-project-group">
                      <div className="unscheduled-group-bar">
                        <span className="cal-chip-dot" style={{ backgroundColor: group.color }} />
                        <span>{group.name}</span>
                        <span className="cal-chip-count">{group.items.length}</span>
                      </div>
                      <div className="unscheduled-group-items">
                        {group.items.slice(0, 4).map((todo) => (
                          <div key={todo.id} className="unscheduled-item">
                            <span className="todo-text" title={todo.text}>{todo.text}</span>
                            {todo.shared && (
                              <span className="todo-shared-chip" title={todo.ownerName ? `Partagé par ${todo.ownerName}` : "Tâche partagée"}>👥</span>
                            )}
                            <button
                              type="button"
                              className="ghost mini schedule-here-btn"
                              disabled={schedulingId === todo.id}
                              onClick={() => scheduleTodo(todo.id, selectedDay)}
                            >
                              {schedulingId === todo.id ? "…" : "📅 Planifier"}
                            </button>
                          </div>
                        ))}
                        {group.items.length > 4 && (
                          <small className="muted more-unscheduled">
                            +{group.items.length - 4} autre(s) dans {group.name}
                          </small>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CalendarView({ projects = [], onView }) {
  const cached = cachedView("todos");
  const [todos, setTodos] = useState(() => (Array.isArray(cached) ? cached : cached?.todos) || []);
  const [folders, setFolders] = useState(() => (Array.isArray(cached) ? [] : cached?.folders) || []);

  const load = useCallback(async () => {
    try {
      const result = await api("/api/todos");
      if (result) {
        setTodos(result.todos || []);
        setFolders(result.folders || []);
        storeView("todos", result);
      }
    } catch {}
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("noyau:todos-refresh", load);
    return () => window.removeEventListener("noyau:todos-refresh", load);
  }, [load]);

  const scheduledCount = todos.filter((t) => t.dueDate && t.status !== "done" && !t.completed).length;
  const unscheduledCount = todos.filter((t) => !t.dueDate && t.status !== "done" && !t.completed).length;
  const doneCount = todos.filter((t) => t.status === "done" || t.completed).length;

  return (
    <div className="page calendar-page">
      <div className="calendar-view-hero-card">
        <div className="calendar-hero-content">
          <div className="calendar-hero-badge">
            <span className="cal-hero-dot" />
            <span>Agenda & Échéances</span>
          </div>
          <h1>Calendrier</h1>
          <p className="calendar-hero-desc">
            Planification des tâches triées par projet, synchronisation flux iCal et widgets.
          </p>
          <div className="calendar-hero-stats">
            <span className="cal-hero-stat-pill">
              <strong>{scheduledCount}</strong> planifiée{scheduledCount > 1 ? "s" : ""}
            </span>
            <span className="cal-hero-stat-pill warning">
              <strong>{unscheduledCount}</strong> sans date
            </span>
            <span className="cal-hero-stat-pill success">
              <strong>{doneCount}</strong> terminée{doneCount > 1 ? "s" : ""}
            </span>
            <span className="cal-hero-stat-pill muted">
              <strong>{projects.length}</strong> projet{projects.length > 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <div className="calendar-hero-actions">
          <button type="button" className="ghost cal-hero-todo-btn" onClick={() => onView?.("todos")}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
            <span>Tableau des tâches</span>
          </button>
        </div>
      </div>

      <TodoCalendar
        todos={todos}
        folders={folders}
        projects={projects}
        onTodoClick={() => onView?.("todos")}
      />
    </div>
  );
}

function getTodoAssignee(todo) {
  if (!todo) return "main";
  if (todo.assignee === "all" || todo.assignee === "both" || (todo.shared && !todo.assignee)) return "all";
  if (todo.assignee === "aurora" || todo.assignee === "aurora") return "aurora";
  if (todo.assignee === "main" || todo.assignee === "me") return "main";
  if (todo.ownerProfileId === "aurora" || (todo.ownerName && /aurora/i.test(todo.ownerName))) return "aurora";
  return "main";
}

function TodosView({ projects = [], onView }) {
  const cached = cachedView("todos");
  const [todos, setTodos] = useState(() => (Array.isArray(cached) ? cached : cached?.todos) || []);
  const [folders, setFolders] = useState(() => (Array.isArray(cached) ? [] : cached?.folders) || []);
  const [storage, setStorage] = useState("Obsidian · NAS");
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState(() => {
    try {
      return localStorage.getItem("noyau-todo-last-assignee") || "main";
    } catch {
      return "main";
    }
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [datePanel, setDatePanel] = useState(null);
  const [openComments, setOpenComments] = useState({});
  const [newComment, setNewComment] = useState({});
  const [filterTab, setFilterTab] = useState("all");
  const [viewMode, setViewMode] = useState(() => { try { return localStorage.getItem(profileCacheKey("todo-view-mode")) || "board"; } catch { return "board"; } });
  const [sortMode, setSortMode] = useState(() => { try { return localStorage.getItem(profileCacheKey("todo-sort-mode")) || "activity"; } catch { return "activity"; } });
  const [rawContent, setRawContent] = useState("");
  const [rawOriginal, setRawOriginal] = useState("");
  const [rawLoading, setRawLoading] = useState(false);
  const [rawSaving, setRawSaving] = useState(false);
  const [rawCopied, setRawCopied] = useState(false);
  const [rawError, setRawError] = useState("");
  const [addingInColumn, setAddingInColumn] = useState(null);
  const [columnText, setColumnText] = useState("");
  const [openFolder, setOpenFolder] = useState(() => { try { return localStorage.getItem(profileCacheKey("todo-folder")) || null; } catch { return null; } });
  const [subFolderFilter, setSubFolderFilter] = useState(() => {
    try {
      const savedFolder = localStorage.getItem(profileCacheKey("todo-folder"));
      if (savedFolder) {
        return localStorage.getItem(profileCacheKey(`todo-subfolder-${savedFolder}`)) || "all";
      }
      return "all";
    } catch {
      return "all";
    }
  });
  const [showCalendar, setShowCalendar] = useState(false);
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
  const [folderToDelete, setFolderToDelete] = useState(null);
  const [folderModal, setFolderModal] = useState(null);
  const [dragging, setDragging] = useState("");
  const dragRef = React.useRef(null);
  const rowRefs = React.useRef(new Map());
  const seenRef = React.useRef(new Set());
  // Ids supprimes localement: une reponse partie avant la suppression ne doit pas les ressusciter.
  const deletedRef = React.useRef(new Map());
  const mutationRef = React.useRef(0);

  const apply = useCallback((result) => {
    if (!result) return;
    const now = Date.now();
    for (const [id, at] of deletedRef.current) if (now - at > 5 * 60_000) deletedRef.current.delete(id);
    // Une reponse partie avant le marquage ne doit pas rallumer une pastille deja lue.
    const nextTodos = (result.todos || [])
      .filter((todo) => !deletedRef.current.has(todo.id))
      .map((todo) => (seenRef.current.has(todo.id) ? { ...todo, unread: 0 } : todo));
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
      const mutation = mutationRef.current;
      const result = await api("/api/todos");
      // Un rafraichissement parti avant une action renverrait l'etat d'avant: on l'ignore.
      if (mutation !== mutationRef.current) return;
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

  useEffect(() => {
    function handleDocumentClick(event) {
      const openMenus = document.querySelectorAll(".todo-card-menu[open], .todo-column-menu[open]");
      openMenus.forEach((menu) => {
        if (!menu.contains(event.target)) {
          menu.removeAttribute("open");
        }
      });
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        document.querySelectorAll(".todo-card-menu[open], .todo-column-menu[open]").forEach((m) => m.removeAttribute("open"));
      }
    }
    document.addEventListener("click", handleDocumentClick, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleDocumentClick, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  async function run(key, task) {
    mutationRef.current += 1;
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

  const handleAssigneeChange = (val) => {
    setAssignee(val);
    try {
      localStorage.setItem("noyau-todo-last-assignee", val);
    } catch {}
  };

  async function add(event) {
    event.preventDefault();
    if (!text.trim()) return;
    const effectiveFolderId = subFolderFilter && subFolderFilter !== "all"
      ? subFolderFilter
      : (!openFolder || openFolder === "all" || openFolder === ROOT_FOLDER ? null : openFolder);
    const targetProjectId = active?.folder?.projectId || null;
    const isBoth = assignee === "all" || assignee === "both";
    await run("new", async () => {
      const result = await api("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          text,
          folderId: effectiveFolderId,
          projectId: targetProjectId,
          priority: "medium",
          assignee,
          shared: isBoth,
        }),
      });
      if (result?.todo?.id) seenRef.current.add(result.todo.id);
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
    const effectiveFolderId = subFolderFilter && subFolderFilter !== "all"
      ? subFolderFilter
      : (!openFolder || openFolder === "all" || openFolder === ROOT_FOLDER ? null : openFolder);
    const targetProjectId = active?.folder?.projectId || null;
    const isBoth = assignee === "all" || assignee === "both";
    await run("new", async () => {
      const result = await api("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          text: raw,
          folderId: effectiveFolderId,
          projectId: targetProjectId,
          priority: "medium",
          assignee,
          shared: isBoth,
        }),
      });
      if (result?.todo?.id) seenRef.current.add(result.todo.id);
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
      seenRef.current.add(todo.id);
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
    mutationRef.current += 1;
    deletedRef.current.set(todo.id, Date.now());
    setTodos((prev) => prev.filter((item) => item.id !== todo.id));
    try {
      apply(await api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: "DELETE" }));
      setError("");
    } catch (reason) {
      if (/introuvable/i.test(reason.message)) return;
      deletedRef.current.delete(todo.id);
      setError(reason.message);
      load();
    }
  }

  const statusOf = (todo) => todo.status || (todo.completed ? "done" : "todo");
  // Vue tableau: la derniere activite remonte en tete de colonne.
  const byActivity = (a, b) => String(b.activityAt || "").localeCompare(String(a.activityAt || ""));

  const PRIORITY_ORDER = { high: 1, medium: 2, low: 3 };
  const byPriority = (a, b) => {
    const pA = PRIORITY_ORDER[a.priority] || 4;
    const pB = PRIORITY_ORDER[b.priority] || 4;
    if (pA !== pB) return pA - pB;
    return byActivity(a, b);
  };
  const byDueDate = (a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return byActivity(a, b);
  };
  const sortTodos = useCallback((list) => {
    if (sortMode === "priority") return [...list].sort(byPriority);
    if (sortMode === "dueDate") return [...list].sort(byDueDate);
    return [...list].sort(byActivity);
  }, [sortMode]);

  function switchSortMode(mode) {
    setSortMode(mode);
    try { localStorage.setItem(profileCacheKey("todo-sort-mode"), mode); } catch {}
  }

  function cyclePriority(todo) {
    const next = todo.priority === "high" ? "medium" : todo.priority === "medium" ? "low" : "high";
    update(todo, { priority: next });
  }

  const loadRaw = useCallback(async () => {
    setRawLoading(true);
    setRawError("");
    try {
      const res = await api("/api/todos/raw");
      setRawContent(res.raw || "");
      setRawOriginal(res.raw || "");
    } catch (err) {
      setRawError(err.message);
    } finally {
      setRawLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode === "raw") loadRaw();
  }, [viewMode, loadRaw]);

  async function saveRaw() {
    setRawSaving(true);
    setRawError("");
    try {
      const res = await api("/api/todos/raw", {
        method: "PUT",
        body: JSON.stringify({ raw: rawContent }),
      });
      setRawOriginal(rawContent);
      apply(res);
    } catch (err) {
      setRawError(err.message);
    } finally {
      setRawSaving(false);
    }
  }

  async function copyRaw() {
    await writeClipboard(rawContent);
    setRawCopied(true);
    setTimeout(() => setRawCopied(false), 2000);
  }

  function renderViewSwitcher() {
    return (
      <div className="todo-view-switcher">
        <button
          type="button"
          className={viewMode === "board" ? "active" : ""}
          onClick={() => switchViewMode("board")}
          title="Vue Tableau Trello (Kanban)"
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
        <button
          type="button"
          className={viewMode === "raw" ? "active" : ""}
          onClick={() => switchViewMode("raw")}
          title="Vue Markdown brut (édition et copie)"
        >
          <span className="view-icon">📝</span> .MD
        </button>
      </div>
    );
  }

  function renderSortSwitcher() {
    return (
      <div className="todo-sort-switcher">
        <button
          type="button"
          className={`todo-sort-btn ${sortMode === "priority" ? "active" : ""}`}
          onClick={() => switchSortMode(sortMode === "priority" ? "activity" : "priority")}
          title="Trier par priorité (🔴 Haute, 🟡 Moyenne, 🟢 Basse)"
        >
          ⚡ Priorité
        </button>
        <button
          type="button"
          className={`todo-sort-btn ${sortMode === "activity" ? "active" : ""}`}
          onClick={() => switchSortMode("activity")}
          title="Trier par récents / activité"
        >
          🕒 Récents
        </button>
      </div>
    );
  }

  function renderRawView() {
    return (
      <div className="todo-raw-wrap">
        <div className="todo-raw-toolbar">
          <div className="todo-raw-info">
            <span className="todo-raw-tag">MARKDOWN BRUT</span>
            <small className="muted">{rawContent ? rawContent.split(/\r?\n/).length : 0} lignes · {rawContent.length} car.</small>
            {rawContent !== rawOriginal && <b className="todo-raw-dirty">● Modifié non enregistré</b>}
          </div>
          <div className="todo-raw-actions">
            <button
              type="button"
              className="ghost"
              onClick={loadRaw}
              disabled={rawLoading || rawSaving}
              title="Recharger le fichier depuis le serveur"
            >
              {rawLoading ? "…" : "🔄 Recharger"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={copyRaw}
              disabled={!rawContent}
              title="Copier tout le Markdown"
            >
              {rawCopied ? "✓ Copié !" : "📋 Copier"}
            </button>
            <button
              type="button"
              className="primary"
              onClick={saveRaw}
              disabled={rawSaving || rawContent === rawOriginal}
              title="Enregistrer les modifications dans le fichier Markdown"
            >
              {rawSaving ? "Enregistrement…" : "💾 Enregistrer"}
            </button>
          </div>
        </div>
        {rawError && <p className="finance-error todo-error">{rawError}</p>}
        <textarea
          className="todo-raw-textarea"
          value={rawContent}
          onChange={(e) => setRawContent(e.target.value)}
          placeholder="Chargement du contenu Markdown brut…"
          spellCheck={false}
        />
      </div>
    );
  }

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
  // Arborescence des dossiers avec sous-dossiers indentés pour les menus déroulants
  const hierarchicalFolders = useMemo(() => {
    const rootFolders = folders.filter((f) => !f.parentId && f.id !== ROOT_FOLDER);
    const result = [];
    for (const parent of rootFolders) {
      result.push(parent);
      const children = folders.filter((f) => f.parentId === parent.id);
      result.push(...children);
    }
    const handled = new Set(result.map((f) => f.id));
    for (const f of folders) {
      if (!handled.has(f.id) && f.id !== ROOT_FOLDER) result.push(f);
    }
    const root = folders.find((f) => f.id === ROOT_FOLDER);
    if (root) result.push(root);
    return result;
  }, [folders]);

  // Une tache dont la zone a disparu retombe visuellement dans « A faire ».
  const inColumn = useCallback(
    (list, columnId) => sortTodos(
      list.filter((todo) => statusOf(todo) === columnId || (columnId === "todo" && !knownStatus.has(statusOf(todo))))
    ),
    [knownStatus, sortTodos],
  );

  async function addColumn() {
    const name = window.prompt("Nom de la nouvelle zone (ex: Idée, Backlog, En cours…) ?");
    if (!name?.trim()) return;
    await run("column", () => api("/api/todos/columns", { method: "POST", body: JSON.stringify({ name }) }));
  }

  async function renameColumn(column, name) {
    setRenamingColumn(null);
    if (!name?.trim() || name.trim() === column.name) return;
    await run(`column:${column.id}`, () => api(`/api/todos/columns/${encodeURIComponent(column.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }));
  }

  async function toggleColumnEnabled(column) {
    const next = column.enabled === false;
    await run(`column:${column.id}`, () => api(`/api/todos/columns/${encodeURIComponent(column.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: next }) }));
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
  function selectFolder(id, subId = null) {
    setOpenFolder(id);
    let targetSub = subId;
    if (targetSub === null) {
      try {
        targetSub = (id && localStorage.getItem(profileCacheKey(`todo-subfolder-${id}`))) || "all";
      } catch {
        targetSub = "all";
      }
    }
    setSubFolderFilter(targetSub);
    setDatePanel(null);
    setFilterTab("all");
    setAddingInColumn(null);
    setColumnText("");
    try {
      if (id) {
        localStorage.setItem(profileCacheKey("todo-folder"), id);
        localStorage.setItem(profileCacheKey(`todo-subfolder-${id}`), targetSub);
      } else {
        localStorage.removeItem(profileCacheKey("todo-folder"));
      }
    } catch { /* stockage optionnel */ }
  }

  function changeSubFolderFilter(subId) {
    setSubFolderFilter(subId);
    try {
      if (openFolder) {
        localStorage.setItem(profileCacheKey(`todo-subfolder-${openFolder}`), subId);
      }
    } catch { /* stockage optionnel */ }
  }

  function switchViewMode(mode) {
    setViewMode(mode);
    try {
      localStorage.setItem(profileCacheKey("todo-view-mode"), mode);
    } catch { /* stockage optionnel */ }
  }

  function createFolder() {
    setFolderModal({ parentFolder: null });
  }

  function createSubFolder(parentFolder) {
    setFolderModal({ parentFolder });
  }

  async function handleFolderCreated(folderData) {
    await run("folder", () => api("/api/todos/folders", {
      method: "POST",
      body: JSON.stringify(folderData),
    }));
  }

  async function renameFolder(folder) {
    const name = window.prompt("Nouveau nom du dossier ?", folder.name);
    if (!name?.trim() || name === folder.name) return;
    await run(folder.id, () => api(`/api/todos/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }));
  }

  async function removeFolder(folder) {
    setFolderToDelete(null);
    if (openFolder === folder.id) selectFolder(null);
    await run(folder.id, () => api(`/api/todos/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }));
  }

  // Les projets ouvrent la liste, les dossiers libres suivent, le hors-dossier ferme la marche.
  const sections = useMemo(() => {
    const rank = (folder) => folder.projectId ? 0 : folder.id === ROOT_FOLDER ? 2 : 1;
    const rootFolders = folders.filter((folder) => !folder.parentId);
    return [...rootFolders]
      .sort((a, b) => rank(a) - rank(b))
      .map((folder) => {
        const subFolderIds = new Set();
        const collectDescendants = (parentId) => {
          for (const f of folders) {
            if (f.parentId === parentId && !subFolderIds.has(f.id)) {
              subFolderIds.add(f.id);
              collectDescendants(f.id);
            }
          }
        };
        collectDescendants(folder.id);
        const subFolders = folders.filter((f) => subFolderIds.has(f.id));
        const folderIds = new Set([folder.id, ...subFolderIds]);
        const items = todos.filter((todo) =>
          folderIds.has(todo.folderId || ROOT_FOLDER) ||
          (folder.projectId && todo.projectId === folder.projectId)
        );
        return { folder, subFolders, items };
      })
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
    const activeColumns = columns.filter((item) => item.enabled !== false);
    const columnIndex = columns.findIndex((item) => item.id === currentColumn);
    const column = columns[columnIndex] || columns[0];
    const activeIndex = activeColumns.findIndex((item) => item.id === currentColumn);
    const previousColumn = activeIndex > 0 ? activeColumns[activeIndex - 1] : null;
    const nextColumn = activeIndex >= 0 && activeIndex < activeColumns.length - 1 ? activeColumns[activeIndex + 1] : null;
    const nextCycleColumn = activeColumns.length > 0
      ? (activeColumns[(activeIndex + 1) % activeColumns.length] || activeColumns[0])
      : column;
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
        <button
          type="button"
          className="todo-card-quick-delete"
          onClick={(e) => {
            e.stopPropagation();
            removeTodo(todo);
          }}
          disabled={busy === `del:${todo.id}`}
          title="Supprimer la tâche"
          aria-label="Supprimer la tâche"
        >
          🗑
        </button>
        <div
          className="todo-card-top"
          onClick={() => { if (overflows || expanded) setExpandedCards((prev) => ({ ...prev, [todo.id]: !prev[todo.id] })); }}
        >
          <button
            type="button"
            className={`todo-tri-box status-${column?.kind || "custom"}`}
            onClick={(event) => { event.stopPropagation(); update(todo, { status: nextCycleColumn.id }); }}
            disabled={busy === todo.id}
            title={`${column?.name || "Zone"} — cliquer pour : ${nextCycleColumn?.name || "Suivant"}`}
          >
            {isDone && <span className="todo-tri-icon done-check">✓</span>}
            {isReview && <span className="todo-tri-icon review-bar" />}
            {!isDone && !isReview && column?.kind === "custom" && <span className="todo-tri-icon custom-dot">○</span>}
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
            <select
              className={`todo-priority-select prio-${todo.priority || "medium"}`}
              value={todo.priority || "medium"}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                update(todo, { priority: e.target.value });
              }}
              disabled={busy === todo.id}
              title="Sélectionner la priorité"
              aria-label="Priorité de la tâche"
            >
              <option value="high">🔴 Haute</option>
              <option value="medium">🟡 Moyenne</option>
              <option value="low">🟢 Basse</option>
            </select>
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
            <select
              className={`todo-assignee-select todo-card-assignee assignee-${getTodoAssignee(todo)}`}
              value={getTodoAssignee(todo)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                const nextVal = e.target.value;
                const isBoth = nextVal === "all" || nextVal === "both";
                update(todo, {
                  assignee: nextVal,
                  shared: isBoth,
                });
              }}
              disabled={busy === todo.id}
              title={`Attribuée à : ${getTodoAssignee(todo) === "aurora" ? "Aurora" : getTodoAssignee(todo) === "main" ? "Moi" : "Tout le monde"} — cliquer pour changer`}
              aria-label="Attribution de la tâche"
            >
              <option value="aurora">🌸 Aurora</option>
              <option value="main">👤 Moi</option>
              <option value="all">👥 Tout le monde</option>
            </select>
          </div>

          <div className="todo-card-shift-actions">
            <button
              className={`todo-date-pill ${overdue ? "overdue" : ""} ${todo.dueDate ? "has-date" : "empty"} ${datePanel === todo.id ? "active" : ""}`}
              onClick={() => setDatePanel((c) => (c === todo.id ? null : todo.id))}
              disabled={busy === todo.id}
              title={todo.dueDate ? `Date limite : ${todo.dueDate}` : "Ajouter une date limite"}
            >
              {todo.dueDate ? todo.dueDate.slice(5).split("-").reverse().join("/") : "📅"}
            </button>
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
                {(overflows || expanded) && (
                  <button onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setExpandedCards((prev) => ({ ...prev, [todo.id]: !prev[todo.id] })); }}>
                    {expanded ? "Replier le texte" : "Déplier le texte"}
                  </button>
                )}
                <button onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setDatePanel((c) => (c === todo.id ? null : todo.id)); }}>
                  {todo.dueDate ? "Modifier la date" : "Ajouter une date"}
                </button>
                <label className="todo-card-menu-move">
                  <span>Attribuée à</span>
                  <select
                    value={getTodoAssignee(todo)}
                    onChange={(event) => {
                      const nextVal = event.target.value;
                      event.target.closest("details")?.removeAttribute("open");
                      update(todo, {
                        assignee: nextVal,
                        shared: nextVal === "all" || nextVal === "both",
                      });
                    }}
                    disabled={busy === todo.id}
                    aria-label="Changer l'attribution"
                  >
                    <option value="aurora">🌸 Aurora</option>
                    <option value="main">👤 Moi</option>
                    <option value="all">👥 Tout le monde</option>
                  </select>
                </label>
                <label className="todo-card-menu-move">
                  <span>Priorité</span>
                  <select
                    value={todo.priority || ""}
                    onChange={(event) => {
                      const next = event.target.value || null;
                      event.target.closest("details")?.removeAttribute("open");
                      update(todo, { priority: next });
                    }}
                    disabled={busy === todo.id}
                    aria-label="Priorité de la tâche"
                  >
                    <option value="">Normale</option>
                    <option value="high">🔴 Haute</option>
                    <option value="medium">🟡 Moyenne</option>
                    <option value="low">🟢 Basse</option>
                  </select>
                </label>
                <label className="todo-card-menu-move">
                  <span>Zone</span>
                  <select
                    value={statusOf(todo)}
                    onChange={(event) => {
                      const next = event.target.value;
                      event.target.closest("details")?.removeAttribute("open");
                      update(todo, { status: next });
                    }}
                    disabled={busy === todo.id}
                    aria-label="Déplacer vers une autre zone"
                  >
                    {columns.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="todo-card-menu-move">
                  <span>Déplacer vers</span>
                  <select
                    value={todo.folderId || ROOT_FOLDER}
                    onChange={(event) => {
                      const next = event.target.value;
                      event.target.closest("details")?.removeAttribute("open");
                      update(todo, { folderId: next });
                    }}
                    disabled={busy === todo.id}
                    aria-label="Déplacer la tâche vers un autre projet ou dossier"
                  >
                    {hierarchicalFolders.map((item) => <option value={item.id} key={item.id}>{item.parentId ? `  ↳ ${item.name}` : item.name}</option>)}
                  </select>
                </label>
                <button
                  className="danger"
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    removeTodo(todo);
                  }}
                  disabled={busy === `del:${todo.id}`}
                >
                  Supprimer la tâche
                </button>
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
              {todo.comments && todo.comments.map((comment) => {
                const isAgent = isCommentByAgent(comment);
                const authorText = comment.author
                  ? (isAgent ? (comment.author.startsWith("IA ·") ? comment.author : `IA · ${comment.author}`) : comment.author)
                  : (isAgent ? "IA" : "Vous");
                return (
                  <div className={`todo-comment-item ${isAgent ? "comment-agent" : "comment-user"}`} key={comment.id}>
                    <div className="todo-comment-meta">
                      <span className={`todo-comment-avatar ${isAgent ? "agent" : "user"}`}>
                        {isAgent ? "🤖" : "👤"}
                      </span>
                      <strong className={`todo-comment-author ${isAgent ? "agent" : "user"}`}>
                        {authorText}
                      </strong>
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
                );
              })}
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
    const currentColumn = columns.find((c) => c.id === status);
    const isCustom = !isDone && !isReview && status !== "todo";
    const overdue = todo.dueDate && todo.dueDate < localIsoDate() && !isDone;
    const commentsCount = todo.comments?.length || 0;
    const commentsOpen = !!openComments[todo.id];

    function cycleStatus() {
      const activeCols = columns.filter((c) => c.enabled !== false);
      if (activeCols.length === 0) return;
      const colIndex = activeCols.findIndex((c) => c.id === status);
      const nextCol = colIndex >= 0 ? activeCols[(colIndex + 1) % activeCols.length] : activeCols[0];
      update(todo, { status: nextCol.id });
    }

    return (
      <React.Fragment key={todo.id}>
        <article
          className={`todo-item ${isDone ? "completed" : ""} ${isReview ? "in-review" : ""} ${dragging === todo.id ? "dragging" : ""}`}
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
              title={currentColumn ? `${currentColumn.name} (cliquer pour changer de zone)` : "Changer d'état"}
              aria-label={`Changer état de ${todo.text}`}
            >
              {isDone && <span className="todo-tri-icon done-check">✓</span>}
              {isReview && <span className="todo-tri-icon review-bar" />}
              {isCustom && <span className="todo-tri-icon custom-dot">○</span>}
            </button>
            <div className="todo-text-group">
              <TodoInlineText
                text={todo.text}
                onSave={(newText) => update(todo, { text: newText })}
                disabled={busy === todo.id}
              />
              <small className={overdue ? "overdue" : isReview ? "status-review-label" : isCustom ? "status-custom-label" : ""}>
                {isDone ? completedLabel(todo.completedAt) || "Terminée" : isReview ? "◐ À vérifier / tester" : isCustom ? `💡 ${currentColumn?.name || "Zone"}` : todoDueLabel(todo.dueDate)}
              </small>
            </div>
          </div>
          <div className="todo-actions">
            <select
              className={`todo-priority-select prio-${todo.priority || "medium"}`}
              value={todo.priority || "medium"}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                update(todo, { priority: e.target.value });
              }}
              disabled={busy === todo.id}
              title="Sélectionner la priorité"
              aria-label="Priorité de la tâche"
            >
              <option value="high">🔴 Haute</option>
              <option value="medium">🟡 Moyenne</option>
              <option value="low">🟢 Basse</option>
            </select>
            <select
              className={`todo-assignee-select todo-card-assignee assignee-${getTodoAssignee(todo)}`}
              value={getTodoAssignee(todo)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                const nextVal = e.target.value;
                const isBoth = nextVal === "all" || nextVal === "both";
                update(todo, {
                  assignee: nextVal,
                  shared: isBoth,
                });
              }}
              disabled={busy === todo.id}
              title={`Attribuée à : ${getTodoAssignee(todo) === "aurora" ? "Aurora" : getTodoAssignee(todo) === "main" ? "Moi" : "Tout le monde"} — cliquer pour changer`}
              aria-label="Attribution de la tâche"
            >
              <option value="aurora">🌸 Aurora</option>
              <option value="main">👤 Moi</option>
              <option value="all">👥 Tout le monde</option>
            </select>
            <select
              value={status}
              onChange={(event) => update(todo, { status: event.target.value })}
              disabled={busy === todo.id}
              title="Changer de zone"
              aria-label="Zone de la tâche"
              className="todo-zone-select"
            >
              {columns.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}
            </select>
            <button
              className={`todo-date-trigger ${todo.dueDate ? "dated" : ""} ${overdue ? "overdue" : ""} ${datePanel === todo.id ? "active" : ""}`}
              onClick={() => setDatePanel((current) => current === todo.id ? null : todo.id)}
              disabled={busy === todo.id}
              aria-label="Modifier date limite"
              title={todo.dueDate ? `Date limite : ${todo.dueDate}` : "Ajouter une date limite"}
            >
              <span aria-hidden="true">📅</span>{todo.dueDate ? todo.dueDate.slice(5).split("-").reverse().join("/") : "Date"}
            </button>
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
            <select value={todo.folderId || ROOT_FOLDER} onChange={(event) => update(todo, { folderId: event.target.value })} disabled={busy === todo.id} aria-label="Dossier">{hierarchicalFolders.map((item) => <option value={item.id} key={item.id}>{item.parentId ? `  ↳ ${item.name}` : item.name}</option>)}</select>
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
              {todo.comments && todo.comments.map((comment) => {
                const isAgent = isCommentByAgent(comment);
                const authorText = comment.author
                  ? (isAgent ? (comment.author.startsWith("IA ·") ? comment.author : `IA · ${comment.author}`) : comment.author)
                  : (isAgent ? "IA" : "Vous");
                return (
                  <div className={`todo-comment-item ${isAgent ? "comment-agent" : "comment-user"}`} key={comment.id}>
                    <div className="todo-comment-meta">
                      <span className={`todo-comment-avatar ${isAgent ? "agent" : "user"}`}>
                        {isAgent ? "🤖" : "👤"}
                      </span>
                      <strong className={`todo-comment-author ${isAgent ? "agent" : "user"}`}>
                        {authorText}
                      </strong>
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
                );
              })}
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
  const activeSection = sections.find((section) => section.folder.id === openFolder);
  const active = openFolder === "all"
    ? { folder: { id: "all", name: "Toutes les tâches" }, subFolders: [], items: todos, rawItems: todos }
    : activeSection
      ? {
          folder: activeSection.folder,
          subFolders: activeSection.subFolders || [],
          items: subFolderFilter === "all"
            ? activeSection.items
            : activeSection.items.filter((todo) => todo.folderId === subFolderFilter),
          rawItems: activeSection.items,
        }
      : null;

  if (!active) {
    return (
      <div className="page todos-page">
        {showCalendar && (
          <TodoCalendar
            todos={todos}
            folders={folders}
            projects={projects}
            onSelectDate={() => {}}
            onTodoClick={(todo) => {
              if (todo.folderId) selectFolder(todo.folderId);
            }}
          />
        )}
        {folderModal && (
          <FolderCreateModal
            parentFolder={folderModal.parentFolder}
            onClose={() => setFolderModal(null)}
            onCreated={handleFolderCreated}
          />
        )}
      {folderToDelete && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setFolderToDelete(null)}>
          <section className="modal todo-delete-modal">
            <div className="modal-head">
              <div><p className="eyebrow">SUPPRIMER UNE LISTE</p><h2>{folderToDelete.name}</h2></div>
              <button className="icon-button" onClick={() => setFolderToDelete(null)} aria-label="Fermer">×</button>
            </div>
            <p className="todo-delete-modal__body">
              {folderToDelete.count
                ? `${folderToDelete.count} tâche${folderToDelete.count > 1 ? "s" : ""} de cette liste ${folderToDelete.count > 1 ? "repartent" : "repart"} dans « Sans dossier ». Rien n'est perdu.`
                : "Cette liste est vide."}
              {folderToDelete.projectId ? " La liste est rattachée à un projet : elle réapparaîtra tant que le projet existe." : ""}
            </p>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setFolderToDelete(null)}>Annuler</button>
              <button type="button" className="danger-action" onClick={() => removeFolder(folderToDelete)} disabled={busy === folderToDelete.id}>
                {busy === folderToDelete.id ? "…" : "Supprimer la liste"}
              </button>
            </div>
          </section>
        </div>
      )}
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
            {renderViewSwitcher()}
            {renderSortSwitcher()}
            <button
              type="button"
              className={`ghost ${showCalendar ? "active" : ""}`}
              onClick={() => setShowCalendar(!showCalendar)}
              title="Afficher/masquer le calendrier"
            >
              📅 {showCalendar ? "Masquer agenda" : "Agenda"}
            </button>
            <button
              type="button"
              className={`todo-correction-toggle ${correction ? "active" : ""}`}
              onClick={toggleCorrection}
              title={correction ? "Correction automatique active" : "Correction automatique désactivée"}
            >
              {correction ? "✨ Correction" : "Correction off"}
            </button>
            <button className="ghost" onClick={createFolder} disabled={busy === "folder"}>+ Dossier</button>
          </div>
        </section>
        {error && <p className="finance-error todo-error">{error}</p>}
        {viewMode === "raw" ? (
          renderRawView()
        ) : (
          <section className="todo-folder-grid">
          <button className="panel todo-folder-card all-tasks" onClick={() => selectFolder("all")}>
            <span className="todo-folder-name">📁 Toutes les tâches{globalUnread > 0 && <b className="todo-unread-badge" title={`${globalUnread} changement${globalUnread > 1 ? "s" : ""} non lu${globalUnread > 1 ? "s" : ""}`}>{globalUnread}</b>}</span>
            <span className="todo-folder-meta">
              {openCount} à faire{reviewCount > 0 ? ` · ${reviewCount} à vérifier` : ""}{doneCount > 0 ? ` · ${doneCount} terminée${doneCount > 1 ? "s" : ""}` : ""}
            </span>
          </button>
          {sections.map(({ folder, subFolders, items }) => {
            const folderTodos = items.filter((todo) => (todo.status || (todo.completed ? "done" : "todo")) === "todo");
            const folderReviews = items.filter((todo) => todo.status === "review");
            const folderDone = items.filter((todo) => todo.status === "done" || todo.completed);
            const late = folderTodos.filter((todo) => todo.dueDate && todo.dueDate < localIsoDate()).length;
            const folderUnread = items.reduce((total, todo) => total + (todo.unread || 0), 0);
            return (
              <div className="panel todo-folder-card" key={folder.id} role="button" tabIndex={0} onClick={() => selectFolder(folder.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectFolder(folder.id); } }}>
                {folder.id !== ROOT_FOLDER && folder.ownerProfileId === undefined && (
                  <button
                    type="button"
                    className="todo-folder-delete"
                    onClick={(event) => { event.stopPropagation(); setFolderToDelete({ ...folder, count: items.length }); }}
                    disabled={busy === folder.id}
                    title={`Supprimer la liste « ${folder.name} »`}
                    aria-label={`Supprimer la liste ${folder.name}`}
                  >🗑</button>
                )}
                <span className="todo-folder-name">
                  {folder.projectId && projects.find((p) => p.id === folder.projectId)?.logoUrl && (
                    <img src={projects.find((p) => p.id === folder.projectId).logoUrl} alt="" className="todo-card-project-logo" />
                  )}
                  {folder.name || "Dossier"}{folderUnread > 0 && <b className="todo-unread-badge" title={`${folderUnread} changement${folderUnread > 1 ? "s" : ""} non lu${folderUnread > 1 ? "s" : ""}`}>{folderUnread}</b>}
                </span>
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
                {folder.projectId && (
                  <div className="todo-folder-subpills" onClick={(e) => e.stopPropagation()}>
                    {subFolders.map((sub) => {
                      const count = countOpenTodos(items.filter((t) => t.folderId === sub.id));
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          className="todo-folder-subpill"
                          onClick={() => selectFolder(folder.id, sub.id)}
                          title={`Ouvrir le sous-dossier ${sub.name}`}
                        >
                          {/^\p{Extended_Pictographic}/u.test(sub.name) ? "" : "📂 "}{sub.name} ({count})
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="todo-folder-subpill add"
                      onClick={() => createSubFolder(folder)}
                      title={`Ajouter un sous-dossier dans ${folder.name}`}
                    >
                      + Sous-dossier
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {!sections.length && !error && <p className="finance-empty">Aucune tâche. Liste Obsidian vide.</p>}
        </section>
      )}
    </div>
  );
}

  const { folder, items } = active;
  const boardUnread = items.reduce((total, todo) => total + (todo.unread || 0), 0);
  const todoItems = inColumn(items, "todo");
  const reviewItems = items.filter((todo) => statusOf(todo) === "review");
  const doneItems = items.filter((todo) => statusOf(todo) === "done" || todo.completed);

  const sortedItems = sortTodos(items);
  const displayedItems = filterTab === "all" ? sortedItems : inColumn(items, filterTab);

  const openList = displayedItems.filter((t) => statusOf(t) !== "done");
  const doneList = displayedItems.filter((t) => statusOf(t) === "done");

  return (
    <div className="page todos-page">
      {showCalendar && (
        <TodoCalendar
          todos={items}
          folders={folders}
          projects={projects}
          onSelectDate={() => {}}
        />
      )}
      {folderModal && (
        <FolderCreateModal
          parentFolder={folderModal.parentFolder}
          onClose={() => setFolderModal(null)}
          onCreated={handleFolderCreated}
        />
      )}
      {folderToDelete && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setFolderToDelete(null)}>
          <section className="modal todo-delete-modal">
            <div className="modal-head">
              <div><p className="eyebrow">SUPPRIMER UNE LISTE</p><h2>{folderToDelete.name}</h2></div>
              <button className="icon-button" onClick={() => setFolderToDelete(null)} aria-label="Fermer">×</button>
            </div>
            <p className="todo-delete-modal__body">
              {folderToDelete.count
                ? `${folderToDelete.count} tâche${folderToDelete.count > 1 ? "s" : ""} de cette liste ${folderToDelete.count > 1 ? "repartent" : "repart"} dans « Sans dossier ». Rien n'est perdu.`
                : "Cette liste est vide."}
              {folderToDelete.projectId ? " La liste est rattachée à un projet : elle réapparaîtra tant que le projet existe." : ""}
            </p>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setFolderToDelete(null)}>Annuler</button>
              <button type="button" className="danger-action" onClick={() => removeFolder(folderToDelete)} disabled={busy === folderToDelete.id}>
                {busy === folderToDelete.id ? "…" : "Supprimer la liste"}
              </button>
            </div>
          </section>
        </div>
      )}
      <section className="hero-row todos-hero">
        <div>
          <button className="todo-back" onClick={() => selectFolder(null)}>‹ Tous les dossiers</button>
          <div className="todo-header-title-row">
            {projects.find((p) => p.id === folder.projectId)?.logoUrl && (
              <img
                src={projects.find((p) => p.id === folder.projectId).logoUrl}
                alt=""
                className="todo-header-project-logo"
              />
            )}
            <h1>{folder.name}</h1>
          </div>
          <p className="muted">
            {todoItems.length} à faire
            {reviewItems.length ? ` · ${reviewItems.length} à vérifier` : ""}
            {doneItems.length ? ` · ${doneItems.length} terminée${doneItems.length > 1 ? "s" : ""}` : ""}
          </p>
        </div>
        <div className="todo-hero-right">
          {renderViewSwitcher()}
          {renderSortSwitcher()}
          <button
            type="button"
            className={`ghost ${showCalendar ? "active" : ""}`}
            onClick={() => setShowCalendar(!showCalendar)}
            title="Afficher/masquer le calendrier"
          >
            📅 {showCalendar ? "Masquer agenda" : "Agenda"}
          </button>
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
              <button onClick={() => setFolderToDelete(folder)} disabled={busy === folder.id} aria-label={`Supprimer ${folder.name}`}>Supprimer</button>
            </div>
          )}
        </div>
      </section>

      {(active.folder.projectId || (active.subFolders && active.subFolders.length > 0)) && active.folder.id !== "all" && (
        <div className="todo-subfolder-bar">
          <button
            type="button"
            className={`todo-subfolder-tab ${subFolderFilter === "all" ? "active" : ""}`}
            onClick={() => changeSubFolderFilter("all")}
          >
            📁 Tout {active.folder.name} ({countOpenTodos(active.rawItems || active.items)})
          </button>
          {active.subFolders.map((sub) => {
            const count = countOpenTodos((active.rawItems || active.items).filter((t) => t.folderId === sub.id));
            return (
              <div key={sub.id} className={`todo-subfolder-tab-group ${subFolderFilter === sub.id ? "active" : ""}`}>
                <button
                  type="button"
                  className="todo-subfolder-tab"
                  onClick={() => changeSubFolderFilter(sub.id)}
                >
                  {/^\p{Extended_Pictographic}/u.test(sub.name) ? "" : "📂 "}{sub.name} ({count})
                </button>
                <button
                  type="button"
                  className="todo-subfolder-edit-btn"
                  onClick={(e) => { e.stopPropagation(); renameFolder(sub); }}
                  title={`Renommer ${sub.name}`}
                >✎</button>
                <button
                  type="button"
                  className="todo-subfolder-del-btn"
                  onClick={(e) => { e.stopPropagation(); setFolderToDelete({ ...sub, count }); }}
                  title={`Supprimer ${sub.name}`}
                >×</button>
              </div>
            );
          })}
          <button
            type="button"
            className="todo-subfolder-add-btn"
            onClick={() => createSubFolder(active.folder)}
            disabled={busy === "folder"}
            title={`Créer un sous-dossier dans ${active.folder.name}`}
          >
            ＋ Sous-dossier
          </button>
        </div>
      )}

      <form className="panel todo-add" onSubmit={add}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Ajouter dans ${subFolderFilter && subFolderFilter !== "all" ? (active.subFolders?.find((s) => s.id === subFolderFilter)?.name || folder.name) : folder.name}…`}
          maxLength="300"
        />
        <select
          className={`todo-assignee-select todo-add-assignee assignee-${assignee}`}
          value={assignee}
          onChange={(e) => handleAssigneeChange(e.target.value)}
          title="Attribuer à Aurora, Moi, ou tout le monde (enregistré par défaut)"
          aria-label="Attribution de la tâche"
        >
          <option value="aurora">🌸 Aurora</option>
          <option value="main">👤 Moi</option>
          <option value="all">👥 Tout le monde</option>
        </select>
        <button className="primary" disabled={busy === "new" || !text.trim()}>{busy === "new" ? "…" : "Ajouter"}</button>
      </form>

      {error && <p className="finance-error todo-error">{error}</p>}

      {viewMode === "raw" ? (
        renderRawView()
      ) : viewMode === "board" ? (
        <div className="todo-board-wrap">
          <div className="todo-board-toolbar">
            <small>
              {columns.length} zone{columns.length > 1 ? "s" : ""} · {countOpenTodos(items)} tâche{countOpenTodos(items) > 1 ? "s" : ""} en cours
              {boardUnread > 0 && <b className="todo-unread-inline"> · {boardUnread} non lu{boardUnread > 1 ? "s" : ""}</b>}
            </small>
            {boardUnread > 0 && <button className="todo-mark-seen-btn" onClick={() => markSeen(items.filter((todo) => todo.unread).map((todo) => todo.id))} title="Marquer toutes les nouveautés comme lues">Tout lu</button>}
            <button className="todo-add-column-btn" onClick={addColumn} disabled={busy === "column"} title="Ajouter une zone" aria-label="Ajouter une zone">＋ Zone</button>
          </div>
          <div className="todo-board">
            {columns.map((column, index) => {
              const columnItems = inColumn(items, column.id);
              const renaming = renamingColumn === column.id;
              const collapsed = !!collapsedColumns[column.id];
              const isColDisabled = column.enabled === false;
              if (collapsed) {
                return (
                  <button
                    key={column.id}
                    className={`todo-board-column collapsed column-${column.kind} ${isColDisabled ? "disabled-zone" : ""}`}
                    onClick={() => toggleColumn(column)}
                    onDragOver={handleBoardDragOver}
                    onDrop={(e) => handleBoardDrop(e, column.id)}
                    title={`Déplier ${column.name}${isColDisabled ? " (Désactivée)" : ""}`}
                  >
                    <span className="todo-column-count">{columnItems.length}</span>
                    <span className="todo-collapsed-title">{column.name}</span>
                    {isColDisabled && <span className="todo-column-disabled-badge">OFF</span>}
                    <span className="todo-collapsed-chevron">›</span>
                  </button>
                );
              }
              return (
                <div
                  className={`todo-board-column column-${column.kind} ${column.kind === "done" ? "muted" : ""} ${isColDisabled ? "disabled-zone" : ""}`}
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
                      {isColDisabled && <span className="todo-column-disabled-badge">Désactivée</span>}
                      <span className="todo-column-count">{columnItems.length}</span>
                    </div>
                    <div className="todo-column-tools">
                      <button
                        type="button"
                        className="todo-column-btn"
                        onClick={() => setRenamingColumn(column.id)}
                        title="Renommer la zone"
                        aria-label={`Renommer la zone ${column.name}`}
                      >✎</button>
                      {column.id !== "todo" && column.id !== "done" && (
                        <button
                          type="button"
                          className={`todo-column-toggle ${isColDisabled ? "off" : "on"}`}
                          onClick={() => toggleColumnEnabled(column)}
                          title={isColDisabled ? "Zone désactivée — cliquer pour activer" : "Zone active — cliquer pour désactiver"}
                          aria-label={isColDisabled ? `Activer la zone ${column.name}` : `Désactiver la zone ${column.name}`}
                        >
                          {isColDisabled ? "OFF" : "ON"}
                        </button>
                      )}
                      {column.kind !== "done" && (
                        <button className="todo-column-add-btn" onClick={() => setAddingInColumn((c) => (c === column.id ? null : column.id))} title={`Ajouter une tâche dans ${column.name}`}>+</button>
                      )}
                      <details className="todo-column-menu">
                        <summary title="Options de la zone">⋯</summary>
                        <div className="todo-column-menu-panel">
                          <button onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); setRenamingColumn(column.id); }}>Renommer</button>
                          {column.id !== "todo" && column.id !== "done" && (
                            <button onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); toggleColumnEnabled(column); }}>
                              {isColDisabled ? "Activer la zone" : "Désactiver la zone"}
                            </button>
                          )}
                          <button onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); shiftColumn(column, -1); }} disabled={index === 0}>Déplacer à gauche</button>
                          <button onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); shiftColumn(column, 1); }} disabled={index === columns.length - 1}>Déplacer à droite</button>
                          {column.kind === "custom" && <button className="danger" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); removeColumn(column); }}>Supprimer la zone</button>}
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
            <button className={filterTab === "all" ? "active" : ""} onClick={() => setFilterTab("all")}>Toutes ({countOpenTodos(items)})</button>
            {columns.map((col) => {
              const count = inColumn(items, col.id).length;
              return (
                <button
                  key={col.id}
                  className={filterTab === col.id ? "active" : ""}
                  onClick={() => setFilterTab(col.id)}
                >
                  {col.kind === "custom" ? `💡 ${col.name}` : col.name} ({count})
                </button>
              );
            })}
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

function getPasswordFeedback(pwd) {
  if (!pwd) return null;
  const clean = String(pwd).trim();
  if (!clean) return null;
  if (clean.length < 8) return { level: "weak", label: `${clean.length}/8 car. min` };
  if (/^(.)\1+$/.test(clean)) return { level: "weak", label: "Caractère répété" };
  const common = ["12345678", "password", "azertyuiop", "qwertyuiop", "admin123", "noyau123"];
  if (common.includes(clean.toLowerCase())) return { level: "weak", label: "Trop simple à deviner" };
  const hasLetters = /[a-zA-Z]/.test(clean);
  const hasDigitsOrSymbols = /[\d\W_]/.test(clean);
  if (clean.length < 12 && (!hasLetters || !hasDigitsOrSymbols)) {
    return { level: "weak", label: "Ajouter chiffres ou symboles" };
  }
  if (clean.length >= 12 && hasLetters && hasDigitsOrSymbols) {
    return { level: "strong", label: "Fort (robuste)" };
  }
  return { level: "medium", label: "Correct" };
}

function ProfilesSettings({ profiles, profileId, onSwitch, onChanged }) {
  const active = profiles.find((item) => item.id === profileId);
  const [name, setName] = useState(active?.name || "");
  const [theme, setTheme] = useState(active?.theme || "noyau");
  const [todoFile, setTodoFile] = useState(active?.todoFile || "");
  const [todoMountUri, setTodoMountUri] = useState(active?.todoMountUri || "");
  const [password, setPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [newTheme, setNewTheme] = useState("moving-castle");
  const [newProfilePassword, setNewProfilePassword] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pwdFeedback = getPasswordFeedback(password);
  const newPwdFeedback = getPasswordFeedback(newProfilePassword);

  useEffect(() => {
    setName(active?.name || "");
    setTheme(active?.theme || "noyau");
    setTodoFile(active?.todoFile || "");
    setTodoMountUri(active?.todoMountUri || "");
    setPassword("");
    setMsg("");
    setError("");
  }, [active]);

  async function run(task) {
    setBusy(true);
    setError("");
    setMsg("");
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
    const payload = { name, theme, todoFile, todoMountUri: todoMountUri || null };
    if (password.trim()) payload.password = password.trim();
    const result = await api(`/api/profiles/${encodeURIComponent(profileId)}`, { method: "PATCH", body: JSON.stringify(payload) });
    applyTheme(result.profile.theme);
    setPassword("");
    setMsg("Réglages enregistrés.");
  });

  const clearPassword = () => run(async () => {
    await api(`/api/profiles/${encodeURIComponent(profileId)}/password`, { method: "POST", body: JSON.stringify({ password: "" }) });
    setPassword("");
    setMsg("Mot de passe personnalisé supprimé (clé master active).");
  });

  const create = () => run(async () => {
    await api("/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        name: newName,
        theme: newTheme,
        password: newProfilePassword.trim() || undefined,
      }),
    });
    setNewName("");
    setNewProfilePassword("");
    setMsg("Profil créé.");
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
              <small>{THEMES[item.theme]?.label || item.theme}{item.primary ? " · principal" : ""}{item.hasPassword ? " · mot de passe actif" : ""}</small>
              <em>{item.id === profileId ? "Profil actif" : "Basculer"}</em>
            </button>
          ))}
        </div>
        {error && <p className="form-error">{error}</p>}
        {msg && <p className="form-success">{msg}</p>}
      </section>
      <details className="panel foldable settings-fold">
        <summary className="panel-head"><div><h3>Réglages de {activeName}</h3><p>Nom, thème, mot de passe, fichier Todo</p></div><i>›</i></summary>
        <div className="profile-form">
          <label htmlFor="profile-name">Nom du profil</label>
          <input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} />
          <label htmlFor="profile-theme">Thème</label>
          <select id="profile-theme" value={theme} onChange={(event) => setTheme(event.target.value)}>{Object.entries(THEMES).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select>
          <label htmlFor="profile-password">
            Mot de passe de connexion
            <small className="profile-pwd-status">
              {active?.hasPassword ? "✓ Mot de passe configuré" : "Clé master (aucun mot de passe dédié)"}
            </small>
          </label>
          <div className="profile-password-row">
            <input
              id="profile-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={active?.hasPassword ? "Nouveau mot de passe (ou laisser vide)" : "Définir un mot de passe (8 car. min)"}
              autoComplete="new-password"
            />
            {active?.hasPassword && (
              <button type="button" className="ghost danger" onClick={clearPassword} disabled={busy} title="Revenir à la clé d'accès master">
                Effacer
              </button>
            )}
          </div>
          {pwdFeedback && (
            <div className="profile-pwd-strength">
              <div className={`profile-pwd-meter ${pwdFeedback.level}`}>
                <span></span><span></span><span></span>
              </div>
              <span className={`profile-pwd-strength-label ${pwdFeedback.level}`}>{pwdFeedback.label}</span>
            </div>
          )}
          <label htmlFor="profile-todo">Fichier Todo Obsidian</label>
          <input id="profile-todo" value={todoFile} onChange={(event) => setTodoFile(event.target.value)} placeholder="/chemin/absolu/TO DO.md" />
          <label htmlFor="profile-mount">Montage SMB (optionnel)</label>
          <input id="profile-mount" value={todoMountUri} onChange={(event) => setTodoMountUri(event.target.value)} placeholder="smb://nas/partage" />
          <div className="modal-actions"><button className="primary" onClick={save} disabled={busy}>{busy ? "Application…" : "Enregistrer"}</button></div>
        </div>
      </details>
      <details className="panel foldable settings-fold">
        <summary className="panel-head"><div><h3>Nouveau profil</h3><p>Son propre espace, son thème et son mot de passe</p></div><i>›</i></summary>
        <div className="profile-form">
          <label htmlFor="profile-new">Prénom</label>
          <input id="profile-new" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Prénom" />
          <label htmlFor="profile-new-theme">Thème</label>
          <select id="profile-new-theme" value={newTheme} onChange={(event) => setNewTheme(event.target.value)}>{Object.entries(THEMES).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select>
          <label htmlFor="profile-new-pwd">Mot de passe (optionnel)</label>
          <input
            id="profile-new-pwd"
            type="password"
            value={newProfilePassword}
            onChange={(event) => setNewProfilePassword(event.target.value)}
            placeholder="Optionnel (8 car. min)"
            autoComplete="new-password"
          />
          {newPwdFeedback && (
            <div className="profile-pwd-strength">
              <div className={`profile-pwd-meter ${newPwdFeedback.level}`}>
                <span></span><span></span><span></span>
              </div>
              <span className={`profile-pwd-strength-label ${newPwdFeedback.level}`}>{newPwdFeedback.label}</span>
            </div>
          )}
          <div className="modal-actions"><button className="ghost" onClick={create} disabled={busy || !newName.trim()}>Créer le profil</button></div>
        </div>
      </details>
    </>
  );
}

function ClearHistoryModal({ profile, onClose, onCleared }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e?.preventDefault();
    if (!password) {
      setError("Mot de passe requis.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/sessions/clear-history", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      if (onCleared) onCleared(result);
      onClose();
    } catch (err) {
      setError(err.message || "Erreur lors de la suppression.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal">
        <div className="modal-head">
          <div>
            <p className="eyebrow">CONFIDENTIALITÉ & SÉCURITÉ</p>
            <h2>Purger les historiques</h2>
          </div>
          <button className="icon-button" onClick={onClose} type="button">×</button>
        </div>
        <form onSubmit={submit}>
          <p className="todo-delete-modal__body">
            Efface le scrollback tmux et réinitialise les conversations pour tous les agents et terminaux CLI du profil <strong>{profile?.name || "actif"}</strong> ainsi que les agents partagés.
          </p>
          <label htmlFor="clear-history-pwd">Mot de passe de confirmation ({profile?.name || "Profil"})</label>
          <input
            id="clear-history-pwd"
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Entre ton mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>Annuler</button>
            <button type="submit" className="danger-action" disabled={busy || !password}>
              {busy ? "Purge en cours…" : "Purger les historiques"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function SettingsView({ permission, onNotifications, onRefresh, onView, profiles, profileId, onSwitchProfile, onProfilesChanged, voice, onVoice, muted, onMuted }) {
  const [refreshing, setRefreshing] = useState(false);
  const [versionInfo, setVersionInfo] = useState(null);
  const [osk, setOsk] = useState(oskMode);
  const [confirmMode, setConfirmMode] = useState(() => {
    try { return localStorage.getItem(CONFIRM_KEY) || "on"; } catch { return "on"; }
  });
  const [power, setPower] = useState(null);
  const [powerBusy, setPowerBusy] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearStatus, setClearStatus] = useState("");

  useEffect(() => {
    api("/api/system/power").then(setPower).catch(() => {});
  }, []);

  async function toggleSleep() {
    setPowerBusy(true);
    try {
      if (power?.sleeping) {
        await api("/api/system/power/wake", { method: "POST" });
      } else {
        await api("/api/system/power/sleep", { method: "POST" });
      }
      setPower(await api("/api/system/power"));
    } catch (error) {
      window.alert(error.message);
    } finally {
      setPowerBusy(false);
    }
  }

  async function updatePowerSchedule(changes) {
    try {
      const result = await api("/api/system/power/schedule", { method: "PATCH", body: JSON.stringify(changes) });
      setPower((prev) => (prev ? { ...prev, schedule: result.schedule } : prev));
    } catch (error) {
      window.alert(error.message);
    }
  }

  const activeProfile = profiles.find((item) => item.id === profileId) || profiles[0];
  const quotaNotify = activeProfile?.quotaResetNotify || { codex: true, claude: true, antigravity: false };

  async function toggleQuotaReset(providerKey) {
    const current = quotaNotify;
    const next = { ...current, [providerKey]: !current[providerKey] };
    try {
      await api(`/api/profiles/${encodeURIComponent(profileId || activeProfile?.id || "main")}`, {
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
        <article className="setting-select-row">
          <span className="setting-symbol">🌙</span>
          <div>
            <strong>Mode basse consommation & veille</strong>
            <small>
              {power?.sleeping
                ? `En veille depuis ${new Date(power.sleepingSince).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ${power.pausedContainers.length} conteneur${power.pausedContainers.length > 1 ? "s" : ""} Docker gelé${power.pausedContainers.length > 1 ? "s" : ""}`
                : power?.canSleep
                  ? `Normal · Aucun agent au travail · Prêt pour la veille (${power?.runningContainersCount || 0} conteneurs Docker)`
                  : `Actif · ${power?.workingAgents?.length} agent(s) en train de travailler`}
            </small>
          </div>
          <button
            className={`ghost ${power?.sleeping ? "active" : ""}`}
            onClick={toggleSleep}
            disabled={powerBusy || (!power?.sleeping && !power?.canSleep)}
          >
            {powerBusy ? "Action en cours…" : power?.sleeping ? "⚡ Sortir de veille" : "🌙 Mettre en veille"}
          </button>
        </article>
        <article className="setting-select-row">
          <span className="setting-symbol">⏰</span>
          <div>
            <strong>Veille nocturne automatique</strong>
            <small>
              Met en pause les conteneurs Docker entre {power?.schedule?.start || "00:00"} et {power?.schedule?.end || "07:30"} (si aucun agent ne travaille)
            </small>
          </div>
          <button
            className={`setting-toggle ${power?.schedule?.enabled ? "on" : ""}`}
            onClick={() => updatePowerSchedule({ enabled: !power?.schedule?.enabled })}
            aria-pressed={Boolean(power?.schedule?.enabled)}
          >
            {power?.schedule?.enabled ? "Activée" : "Désactivée"}
          </button>
        </article>
        <article><span className="setting-symbol update-symbol"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.2M20 5v6h-6" /></svg></span><div><strong>Mise à jour interface</strong><small>{versionInfo ? `Version ${versionInfo.version} · build ${versionInfo.build}` : "Lecture version…"}</small></div><button className="ghost" onClick={refreshApp} disabled={refreshing}>{refreshing ? "Actualisation…" : "Recharger dernière version"}</button></article>
        <article className="setting-select-row">
          <span className="setting-symbol">📱</span>
          <div>
            <strong>Application mobile (APK & PWA)</strong>
            <small>Installer l'app mobile sur votre téléphone pour le mode hors-ligne et WireGuard.</small>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <a href="/api/mobile/noyau.apk" download="noyau.apk" className="button ghost">
              🤖 Télécharger APK
            </a>
            <button className="primary" onClick={() => window.dispatchEvent(new CustomEvent("noyau:open-install"))}>
              📲 Installer l’app
            </button>
          </div>
        </article>
        <article><span className="setting-symbol">⌁</span><div><strong>Connexions bancaires</strong><small>Enable Banking: application ID, URL de retour, clé privée, banques liées.</small></div><button className="ghost" onClick={() => onView("finance-banking")}>Ouvrir réglages</button></article>
        <article className="setting-select-row"><span className="setting-symbol">✓</span><div><strong>Confirmations</strong><small>{confirmMode === "off" ? "Redémarrage et changement de fournisseur immédiats" : "Demandées avant redémarrage et changement de fournisseur"} · suppressions toujours confirmées</small></div><select className="setting-select" value={confirmMode} onChange={(event) => chooseConfirm(event.target.value)} aria-label="Confirmations"><option value="on">Demander</option><option value="off">Sans confirmation</option></select></article>
        <article className="setting-select-row"><span className="setting-symbol">🎙</span><div><strong>Mode micro</strong><small>{voice?.installed === false ? "Moteurs vocaux absents · lancer scripts/voice-install.sh" : voice?.error ? voice.error : voice?.listening ? "À l'écoute · dis « Noyau, ouvre l'agent … »" : "Éteint · rien n'est capté"}</small></div><button className={`setting-toggle ${voice?.listening ? "on" : ""}`} onClick={() => onVoice(!voice?.listening)} disabled={voice?.installed === false} aria-pressed={Boolean(voice?.listening)}>{voice?.listening ? "Activé" : "Éteint"}</button></article>
        <article className="setting-select-row"><span className="setting-symbol">🔔</span><div><strong>Sons de notification</strong><small>{muted ? "Coupés" : "Bip quand un agent attend une réponse ou rend la main"}</small></div><button className={`setting-toggle ${muted ? "" : "on"}`} onClick={() => onMuted(!muted)} aria-pressed={!muted}>{muted ? "Coupés" : "Activés"}</button></article>
        <article className="setting-select-row"><span className="setting-symbol">⌨</span><div><strong>Clavier virtuel</strong><small>Réglage propre à cet appareil · {osk === "auto" ? (wantsOnScreenKeyboard() ? "ouvert au toucher ici" : "désactivé ici (clavier physique ou PC)") : osk === "always" ? "toujours ouvert au toucher" : "jamais ouvert"}</small></div><select className="setting-select" value={osk} onChange={(event) => chooseOsk(event.target.value)} aria-label="Clavier virtuel"><option value="auto">Automatique</option><option value="always">Toujours</option><option value="never">Jamais</option></select></article>
        <article>
          <span className="setting-symbol">🗑</span>
          <div>
            <strong>Historique des agents et CLI</strong>
            <small>Efface le scrollback tmux et réinitialise les conversations ({activeProfile?.name || "profil actif"} et partagés).</small>
            {clearStatus && <small className="setting-ok" style={{ display: "block", marginTop: "4px" }}>{clearStatus}</small>}
          </div>
          <button className="ghost danger-action" onClick={() => setClearModalOpen(true)}>
            Effacer l'historique
          </button>
        </article>
        <article><span className="setting-symbol">⌁</span><div><strong>Connexion privée</strong><small>{window.isSecureContext ? "HTTPS actif · notifications compatibles" : "Ouvre version HTTPS via VPN"}</small></div><b className={window.isSecureContext ? "setting-ok" : "setting-warn"}>{window.isSecureContext ? "ACTIF" : "REQUIS"}</b></article>
      </section>
      {profiles.length > 0 && <ProfilesSettings key={profileId} profiles={profiles} profileId={profileId} onSwitch={onSwitchProfile} onChanged={onProfilesChanged} />}
      {clearModalOpen && (
        <ClearHistoryModal
          profile={activeProfile}
          onClose={() => setClearModalOpen(false)}
          onCleared={(res) => {
            setClearStatus(res.message || "Historiques effacés.");
            if (onRefresh) onRefresh();
          }}
        />
      )}
    </div>
  );
}

function VsCodeModal({ session, onClose }) {
  const cwd = session.cwd || "/home/user/projects";
  const hostname = window.location.hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  const [sshTarget, setSshTarget] = useState(() => {
    return localStorage.getItem("noyau-vscode-ssh-target") || `user@${hostname}`;
  });
  const [directSsh, setDirectSsh] = useState(() => {
    return localStorage.getItem("noyau-vscode-direct-ssh") === "true";
  });
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState(sshTarget);
  const [copied, setCopied] = useState(false);
  const [showKeySetup, setShowKeySetup] = useState(false);
  const [pubKey, setPubKey] = useState("");
  const [keyStatus, setKeyStatus] = useState(null);
  const [addingKey, setAddingKey] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState("");

  const saveSettings = (target, direct) => {
    setSshTarget(target);
    setDirectSsh(direct);
    localStorage.setItem("noyau-vscode-ssh-target", target);
    localStorage.setItem("noyau-vscode-direct-ssh", String(direct));
  };

  const handleCommitTarget = () => {
    const trimmed = targetDraft.trim() || `user@${hostname}`;
    saveSettings(trimmed, directSsh);
    setTargetDraft(trimmed);
    setEditingTarget(false);
  };

  const cleanCwd = cwd.startsWith("/") ? cwd : `/${cwd}`;
  const folderName = cleanCwd.split("/").filter(Boolean).pop() || cleanCwd;
  const remoteUri = `vscode://vscode-remote/ssh-remote+${sshTarget}${cleanCwd}`;
  const localUri = `vscode://file${cleanCwd}`;
  const cliCommand = `code --remote ssh-remote+${sshTarget} "${cleanCwd}"`;

  const openRemote = () => {
    saveSettings(sshTarget, directSsh);
    window.location.href = remoteUri;
    onClose();
  };

  const openLocal = () => {
    window.location.href = localUri;
    onClose();
  };

  const copyCommand = (cmd, id) => {
    navigator.clipboard?.writeText(cmd);
    setCopiedCmd(id);
    setTimeout(() => setCopiedCmd(""), 2200);
  };

  const handlePasteKey = async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (text && text.trim()) {
        setPubKey(text.trim());
      }
    } catch {}
  };

  const copyCli = () => {
    navigator.clipboard?.writeText(cliCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddKey = async () => {
    if (!pubKey.trim()) return;
    setAddingKey(true);
    setKeyStatus(null);
    try {
      const res = await api("/api/system/ssh-key", {
        method: "POST",
        body: JSON.stringify({ publicKey: pubKey.trim() }),
      });
      if (res.ok) {
        setKeyStatus({
          success: true,
          message: `✓ Clé SSH autorisée (${res.added} nouvelle${res.added > 1 ? "s" : ""}, ${res.total} au total)`,
        });
        setPubKey("");
      }
    } catch (err) {
      setKeyStatus({ success: false, message: err.message });
    } finally {
      setAddingKey(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal vscode-modal" role="dialog" aria-labelledby="vscode-modal-heading">
        {/* Header */}
        <div className="vscode-modal-header">
          <div className="vscode-header-left">
            <span className="vscode-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="#007acc">
                <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/>
              </svg>
            </span>
            <div>
              <h2 id="vscode-modal-heading" className="vscode-title">VS Code Remote</h2>
              <span className="vscode-subtitle">Éditeur distant via SSH</span>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">×</button>
        </div>

        <div className="vscode-modal-body">
          {/* Summary Target & Folder Card */}
          <div className="vscode-summary-card">
            <div className="vscode-summary-row">
              <span className="vscode-summary-label">📁 Dossier</span>
              <span className="vscode-summary-pill" title={cleanCwd}>
                <strong>{folderName}</strong>
                <span className="vscode-path-hint">{cleanCwd}</span>
              </span>
            </div>

            <div className="vscode-summary-row">
              <span className="vscode-summary-label">🖥️ Cible SSH</span>
              {editingTarget ? (
                <div className="vscode-inline-edit">
                  <input
                    type="text"
                    value={targetDraft}
                    onChange={(e) => setTargetDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCommitTarget();
                      if (e.key === "Escape") {
                        setTargetDraft(sshTarget);
                        setEditingTarget(false);
                      }
                    }}
                    autoFocus
                    placeholder="user@noyau.lan"
                  />
                  <button type="button" className="primary mini" onClick={handleCommitTarget}>OK</button>
                  <button type="button" className="ghost mini" onClick={() => { setTargetDraft(sshTarget); setEditingTarget(false); }}>✕</button>
                </div>
              ) : (
                <div className="vscode-target-pill" onClick={() => setEditingTarget(true)} title="Cliquer pour modifier l'adresse SSH">
                  <code>{sshTarget}</code>
                  <span className="vscode-edit-icon" aria-label="Modifier">✎</span>
                </div>
              )}
            </div>
          </div>

          {/* Hero Action */}
          <button type="button" className="vscode-hero-btn" onClick={openRemote}>
            <span className="vscode-hero-main">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M5 3l14 9-14 9V3z"/>
              </svg>
              Ouvrir dans VS Code
            </span>
            <span className="vscode-hero-sub">ssh-remote+{sshTarget}</span>
          </button>

          {/* Quick Utility Actions */}
          <div className="vscode-secondary-actions">
            <button
              type="button"
              className="ghost mini vscode-action-pill"
              onClick={copyCli}
              title={cliCommand}
            >
              {copied ? "✓ Commande copiée !" : "📋 Copier commande CLI"}
            </button>

            {isLocal && (
              <button
                type="button"
                className="ghost mini vscode-action-pill"
                onClick={openLocal}
                title="Ouvrir sans tunnel SSH (accès local direct)"
              >
                💻 Ouvrir en local
              </button>
            )}
          </div>

          {/* SSH Key Setup Accordion */}
          <div className="vscode-accordion-wrapper">
            <button
              type="button"
              className={`vscode-accordion-trigger ${showKeySetup ? "open" : ""}`}
              onClick={() => setShowKeySetup(!showKeySetup)}
            >
              <span className="vscode-trigger-icon">🔑</span>
              <span className="vscode-trigger-text">
                {showKeySetup ? "Masquer la configuration de clé SSH" : "Première connexion ou refus de clé (PermissionDenied) ?"}
              </span>
              <span className="vscode-chevron">{showKeySetup ? "▲" : "▼"}</span>
            </button>

            {showKeySetup && (
              <div className="vscode-key-setup-body">
                <p className="vscode-setup-help">
                  Pour que VS Code se connecte sans mot de passe, autorisez la clé publique de votre PC :
                </p>

                <div className="vscode-key-helpers">
                  <div className="vscode-helper-row">
                    <span className="vscode-helper-label">1. Créer une clé :</span>
                    <button
                      type="button"
                      className="ghost mini vscode-chip-btn"
                      onClick={() => copyCommand('ssh-keygen -t ed25519 -C "pc-fixe"', "gen")}
                      title="Copier la commande pour générer une clé ed25519"
                    >
                      {copiedCmd === "gen" ? "✓ Copié !" : "✨ ssh-keygen -t ed25519"}
                    </button>
                  </div>

                  <div className="vscode-helper-row">
                    <span className="vscode-helper-label">2. Copier la clé :</span>
                    <div className="vscode-helper-chips">
                      <button
                        type="button"
                        className="ghost mini vscode-chip-btn"
                        onClick={() => copyCommand("cat ~/.ssh/id_ed25519.pub", "cat-linux")}
                        title="Afficher la clé sur Linux / macOS"
                      >
                        {copiedCmd === "cat-linux" ? "✓ Copié !" : "🐧 Linux/Mac (cat)"}
                      </button>
                      <button
                        type="button"
                        className="ghost mini vscode-chip-btn"
                        onClick={() => copyCommand("Get-Content ~\\.ssh\\id_ed25519.pub | Set-Clipboard", "cat-win")}
                        title="Copier la clé directement dans le presse-papier Windows"
                      >
                        {copiedCmd === "cat-win" ? "✓ Copié !" : "🪟 Windows (clip)"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Paste Textarea */}
                <div className="vscode-key-input-box">
                  <div className="vscode-input-header">
                    <span>3. Collez votre clé publique :</span>
                    <button
                      type="button"
                      className="ghost mini vscode-paste-chip"
                      onClick={handlePasteKey}
                      title="Coller depuis le presse-papier"
                    >
                      📋 Coller
                    </button>
                  </div>
                  <textarea
                    className="vscode-key-textarea"
                    rows={2}
                    placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... ou ssh-rsa AAAAB3NzaC1..."
                    value={pubKey}
                    onChange={(e) => setPubKey(e.target.value)}
                  />
                  <div className="vscode-key-submit-bar">
                    <button
                      type="button"
                      className="primary mini"
                      disabled={addingKey || !pubKey.trim()}
                      onClick={handleAddKey}
                    >
                      {addingKey ? "Autorisation…" : "🔐 Autoriser la clé sur le laptop"}
                    </button>
                    {keyStatus && (
                      <span className={`vscode-status-badge ${keyStatus.success ? "success" : "error"}`}>
                        {keyStatus.message}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick Direct Open Option */}
          <label className="vscode-direct-checkbox">
            <input
              type="checkbox"
              checked={directSsh}
              onChange={(e) => saveSettings(sshTarget, e.target.checked)}
            />
            <span>Toujours ouvrir en 1 clic sans cette confirmation</span>
          </label>
        </div>
      </section>
    </div>,
    document.body
  );
}

function CreateFileModal({ session, onClose, onSend }) {
  const [files, setFiles] = useState([
    { id: "1", name: "", content: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addFile = () => {
    setFiles((prev) => [...prev, { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: "", content: "" }]);
  };

  const removeFile = (id) => {
    if (files.length <= 1) return;
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const updateFile = (id, field, value) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)));
  };

  const handlePasteClipboard = async (id) => {
    try {
      if (!navigator.clipboard?.readText) return;
      const text = await navigator.clipboard.readText();
      if (text) updateFile(id, "content", text);
    } catch {}
  };

  const handleSaveAndSend = async () => {
    const validFiles = files.filter((f) => f.content.trim().length > 0);
    if (!validFiles.length) {
      setError("Veuillez saisir du contenu pour au moins un fichier.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = validFiles.map((f, i) => ({
        name: f.name.trim() || `fichier-${i + 1}.txt`,
        content: f.content,
      }));
      const res = await api("/api/uploads/raw-files", {
        method: "POST",
        body: JSON.stringify({ sessionId: session.id, files: payload }),
      });
      if (res.files && res.files.length) {
        onSend(res.files);
        onClose();
      } else {
        throw new Error("Erreur lors de la création des fichiers.");
      }
    } catch (err) {
      setError(err.message || "Erreur de création");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal create-file-modal" role="dialog" aria-modal="true" aria-labelledby="create-file-title">
        <div className="create-file-header">
          <div className="create-file-header-left">
            <span className="create-file-glyph">📝</span>
            <div>
              <h2 id="create-file-title" className="create-file-title">Créer un ou plusieurs fichiers</h2>
              <span className="create-file-subtitle">Évite de polluer le prompt avec des tokens, configs ou longs textes</span>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">×</button>
        </div>

        {error && <div className="create-file-error">{error}</div>}

        <div className="create-file-list">
          {files.map((file, idx) => (
            <div className="create-file-card" key={file.id}>
              <div className="create-file-card-head">
                <span className="create-file-num">#{idx + 1}</span>
                <input
                  type="text"
                  className="create-file-name-input"
                  placeholder="nom-fichier.txt (ex: token.env, api-key.json, prompt.md)"
                  value={file.name}
                  onChange={(e) => updateFile(file.id, "name", e.target.value)}
                />
                <button
                  type="button"
                  className="ghost mini create-file-paste-btn"
                  onClick={() => handlePasteClipboard(file.id)}
                  title="Coller le presse-papiers ici"
                >
                  📋 Coller
                </button>
                {files.length > 1 && (
                  <button
                    type="button"
                    className="danger-link mini"
                    onClick={() => removeFile(file.id)}
                    title="Supprimer ce fichier"
                  >
                    🗑
                  </button>
                )}
              </div>
              <textarea
                className="create-file-content-input"
                placeholder="Colle ou saisis le contenu de ton fichier ici (tokens, API keys, code, texte volumineux)…"
                value={file.content}
                onChange={(e) => updateFile(file.id, "content", e.target.value)}
                rows={6}
                spellCheck="false"
              />
              <div className="create-file-char-count">
                {file.content.length} caractère{file.content.length > 1 ? "s" : ""}
                {file.content.length > 0 ? ` · ~${(file.content.length / 1024).toFixed(1)} Ko` : ""}
              </div>
            </div>
          ))}
        </div>

        <div className="create-file-footer">
          <button type="button" className="ghost create-file-add-btn" onClick={addFile}>
            ＋ Ajouter un autre fichier
          </button>
          <div className="create-file-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={saving}>
              Annuler
            </button>
            <button type="button" className="primary" onClick={handleSaveAndSend} disabled={saving}>
              {saving ? "Création…" : `Créer & insérer dans le prompt (${files.filter((f) => f.content.trim()).length || 1})`}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}

function TerminalView({ session, onBack, onKilled, onMigrated, onRefresh, onEdit, quotas, assistants, voice, onVoice, onInteract }) {
  const terminalNode = React.useRef(null);
  const terminalRef = React.useRef(null);
  const socketRef = React.useRef(null);
  const keyboardRef = React.useRef(null);
  const touchRef = React.useRef(null);
  const momentumRafRef = React.useRef(null);
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
  const [vscodeModal, setVscodeModal] = useState(false);
  const [createFileModal, setCreateFileModal] = useState(false);
  const todoLinkRef = React.useRef(null);
  const [copiedLink, setCopiedLink] = useState(null);
  const snapshotRef = React.useRef(null);

  const handleInsertRawFiles = (createdFiles) => {
    if (!createdFiles?.length || socketRef.current?.readyState !== WebSocket.OPEN) return;
    const pathsStr = createdFiles.map((f) => (f.path.includes(" ") ? `"${f.path}"` : f.path)).join(" ") + " ";
    socketRef.current.send(JSON.stringify({ type: "input", data: pathsStr }));
    focusKeyboard();
  };

  const openVsCode = (e) => {
    const cwd = session.cwd;
    if (!cwd) {
      window.alert("Répertoire de travail inconnu pour cet agent.");
      return;
    }
    const hostname = window.location.hostname;
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const directSsh = localStorage.getItem("noyau-vscode-direct-ssh") === "true";
    const sshTarget = localStorage.getItem("noyau-vscode-ssh-target") || `user@${hostname}`;

    if (e?.shiftKey || (!isLocal && !directSsh)) {
      setVscodeModal(true);
      return;
    }

    const cleanCwd = cwd.startsWith("/") ? cwd : `/${cwd}`;
    if (isLocal) {
      window.location.href = `vscode://file${cleanCwd}`;
    } else {
      window.location.href = `vscode://vscode-remote/ssh-remote+${sshTarget}${cleanCwd}`;
    }
  };
  const [oskEnabled, setOskEnabled] = useState(wantsOnScreenKeyboard);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [migrating, setMigrating] = useState(session.migrationState === "summarizing");
  const [descOpen, setDescOpen] = useState(false);

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
    const isTouchDevice = TOUCH_MODE || coarsePointer;
    // Sans clavier virtuel, l'agent recoit les touches directement: pas de champ de capture cache.
    const touchTerminal = isTouchDevice && oskEnabled;
    // Capture au niveau du document seulement la ou un clavier systeme peut surgir:
    // sur un poste souris-clavier, xterm garde sa saisie native, plus fiable.
    const captureMode = isTouchDevice && !oskEnabled;
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: touchTerminal || captureMode,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      scrollback: isTouchDevice ? 0 : 5000,
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
    const keyDisposable = terminal.onKey(({ domEvent }) => {
      if (domEvent && ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(domEvent.key)) return;
      onInteract?.();
    });
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
    const scrollQueue = { up: 0, down: 0 };
    let scrollFlushTimer = null;

    const flushScroll = () => {
      scrollFlushTimer = null;
      if (socketRef.current?.readyState !== WebSocket.OPEN) return;
      if (scrollQueue.up > 0) {
        socketRef.current.send(JSON.stringify({ type: "scroll", direction: "up", count: scrollQueue.up }));
        scrollQueue.up = 0;
      } else if (scrollQueue.down > 0) {
        socketRef.current.send(JSON.stringify({ type: "scroll", direction: "down", count: scrollQueue.down }));
        scrollQueue.down = 0;
      }
    };

    const queueScroll = (direction, count) => {
      if (count <= 0) return;
      if (direction === "up") {
        scrollQueue.up += count;
        scrollQueue.down = 0;
      } else {
        scrollQueue.down += count;
        scrollQueue.up = 0;
      }
      if (!scrollFlushTimer) {
        scrollFlushTimer = setTimeout(flushScroll, 16);
      }
    };

    const stopMomentum = () => {
      if (momentumRafRef.current) {
        cancelAnimationFrame(momentumRafRef.current);
        momentumRafRef.current = null;
      }
    };

    const getCellHeight = () => {
      try {
        const h = terminal._core?._renderService?.dimensions?.actualCellHeight;
        if (h && h > 8 && h < 50) return h;
      } catch {}
      return 18;
    };

    const beginTouchScroll = (x, y, pointerId = null) => {
      stopMomentum();
      terminal.clearSelection();
      touchRef.current = {
        startX: x,
        startY: y,
        lastY: y,
        lastTime: performance.now(),
        velocity: 0,
        remainderY: 0,
        pointerId,
        moved: false,
        scrolling: false,
      };
    };

    const continueTouchScroll = (x, y) => {
      const touch = touchRef.current;
      if (!touch) return;
      const now = performance.now();
      const dt = Math.max(1, now - touch.lastTime);
      const dy = y - touch.lastY;

      const currentV = dy / dt;
      touch.velocity = touch.velocity * 0.3 + currentV * 0.7;
      touch.lastTime = now;
      touch.lastY = y;

      const deltaX = x - touch.startX;
      const deltaY = y - touch.startY;
      if (!touch.moved && Math.hypot(deltaX, deltaY) > 6) {
        touch.moved = true;
        touch.scrolling = Math.abs(deltaY) > Math.abs(deltaX);
      }

      if (touch.scrolling) {
        touch.remainderY += dy;
        const cellH = getCellHeight();
        if (Math.abs(touch.remainderY) >= cellH) {
          const lines = Math.trunc(touch.remainderY / cellH);
          touch.remainderY -= lines * cellH;
          if (lines !== 0) {
            queueScroll(lines > 0 ? "up" : "down", Math.min(25, Math.abs(lines)));
          }
        }
      }
    };

    const finishTouchScroll = (y) => {
      const touch = touchRef.current;
      if (!touch) return;
      if (touch.scrolling) {
        if (typeof y === "number") continueTouchScroll(touch.startX, y);
        let vel = touch.velocity;
        if (Math.abs(vel) > 0.2) {
          let remainder = touch.remainderY;
          const cellH = getCellHeight();
          let lastFrame = performance.now();
          const step = (now) => {
            const frameDt = Math.min(32, Math.max(8, now - lastFrame));
            lastFrame = now;
            vel *= Math.pow(0.92, frameDt / 16);
            if (Math.abs(vel) < 0.04) {
              momentumRafRef.current = null;
              return;
            }
            remainder += vel * frameDt;
            if (Math.abs(remainder) >= cellH) {
              const lines = Math.trunc(remainder / cellH);
              remainder -= lines * cellH;
              if (lines !== 0) {
                queueScroll(lines > 0 ? "up" : "down", Math.min(12, Math.abs(lines)));
              }
            }
            momentumRafRef.current = requestAnimationFrame(step);
          };
          momentumRafRef.current = requestAnimationFrame(step);
        }
      } else if (!touch.moved) {
        focusKeyboard();
      }
      touchRef.current = null;
    };

    const cancelTouchScroll = () => {
      stopMomentum();
      touchRef.current = null;
    };

    const stopPointerEvent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const pointerStart = (event) => {
      if (event.pointerType !== "touch") return;
      terminalNode.current.setPointerCapture?.(event.pointerId);
      beginTouchScroll(event.clientX, event.clientY, event.pointerId);
    };
    const pointerMove = (event) => {
      if (touchRef.current?.pointerId !== event.pointerId) return;
      if (touchRef.current?.scrolling) stopPointerEvent(event);
      continueTouchScroll(event.clientX, event.clientY);
    };
    const pointerEnd = (event) => {
      if (touchRef.current?.pointerId !== event.pointerId) return;
      terminalNode.current.releasePointerCapture?.(event.pointerId);
      if (touchRef.current?.scrolling) stopPointerEvent(event);
      finishTouchScroll(event.clientY);
    };
    const pointerCancel = (event) => {
      if (touchRef.current?.pointerId !== event.pointerId) return;
      cancelTouchScroll();
    };

    const touchStart = (event) => {
      if (touchRef.current?.pointerId != null) return;
      if (!event.touches[0]) return;
      beginTouchScroll(event.touches[0].clientX, event.touches[0].clientY);
    };
    const touchMove = (event) => {
      if (!touchRef.current || touchRef.current.pointerId != null || !event.touches[0]) return;
      continueTouchScroll(event.touches[0].clientX, event.touches[0].clientY);
      if (touchRef.current?.scrolling) stopPointerEvent(event);
    };
    const touchEnd = (event) => {
      if (!touchRef.current || touchRef.current.pointerId != null) return;
      if (touchRef.current.scrolling) stopPointerEvent(event);
      finishTouchScroll(event.changedTouches[0]?.clientY);
    };

    if ("PointerEvent" in window) {
      terminalNode.current.addEventListener("pointerdown", pointerStart, true);
      terminalNode.current.addEventListener("pointermove", pointerMove, true);
      terminalNode.current.addEventListener("pointerup", pointerEnd, true);
      terminalNode.current.addEventListener("pointercancel", pointerCancel, true);
    }
    terminalNode.current.addEventListener("touchstart", touchStart, { capture: true, passive: true });
    terminalNode.current.addEventListener("touchmove", touchMove, { capture: true, passive: false });
    terminalNode.current.addEventListener("touchend", touchEnd, { capture: true, passive: false });
    terminalNode.current.addEventListener("touchcancel", cancelTouchScroll, { capture: true, passive: true });
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
    const inTerminal = (node) => node instanceof HTMLElement && (node.closest(".terminal-frame, .terminal-controls, .terminal-page") || !node.closest(".modal, .modal-backdrop"));
    const pasteFile = (event) => {
      if (editableTarget(event.target) && !inTerminal(event.target)) return false;
      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find((it) => it.type && it.type.startsWith("image/"));
      const imageFile = imageItem ? imageItem.getAsFile() : null;
      const file = imageFile
        || Array.from(event.clipboardData?.files || []).find((f) => f.type && f.type.startsWith("image/"))
        || Array.from(event.clipboardData?.files || [])[0]
        || items.filter((it) => it.kind === "file").map((it) => it.getAsFile()).find(Boolean);
      if (!file) return false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
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
    window.addEventListener("paste", capturePaste, true);
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
      clearTimeout(scrollFlushTimer);
      stopMomentum();
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
      window.removeEventListener("paste", capturePaste, true);
      terminalNode.current?.removeEventListener("dragover", allowDrop);
      terminalNode.current?.removeEventListener("drop", dropFile);
      inputDisposable.dispose();
      keyDisposable.dispose();
      socket?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [session.id, session.name, oskEnabled]);

  function send(data) {
    onInteract?.();
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "input", data }));
  }

  function sendSpecial(key) {
    onInteract?.();
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
    if (file.size > 500 * 1024 * 1024) {
      window.alert("Fichier trop volumineux. La taille maximale autorisée est de 500 Mo.");
      return;
    }
    onInteract?.();
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("sessionId", session.id);
      const uploaded = await api("/api/uploads/file", { method: "POST", body: form });
      if (socketRef.current?.readyState !== WebSocket.OPEN) throw new Error("Terminal déconnecté. Réessaie après reconnexion.");
      const insertedPath = uploaded.path.includes(" ") ? `"${uploaded.path}" ` : `${uploaded.path} `;
      socketRef.current.send(JSON.stringify(submit
        ? { type: "submit", data: `${uploaded.image ? "Image" : "Fichier"} joint à examiner : ${uploaded.path}` }
        : { type: "input", data: insertedPath }));
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
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((it) => it.type && it.type.startsWith("image/"));
    const imageFile = imageItem ? imageItem.getAsFile() : null;
    const file = imageFile
      || Array.from(event.clipboardData?.files || []).find((f) => f.type && f.type.startsWith("image/"))
      || Array.from(event.clipboardData?.files || [])[0];
    if (file) {
      event.preventDefault();
      sendFile(file, { submit: false });
      event.currentTarget.value = "";
      return;
    }
    const data = event.clipboardData?.getData("text");
    if (!data) return;
    event.preventDefault();
    sendKeyboardData(data);
    event.currentTarget.value = "";
  }

  async function pasteImageOnly() {
    try {
      if (!window.isSecureContext || !navigator.clipboard?.read) {
        window.alert("Presse-papiers inaccessible. Utilise Ctrl+V / Cmd+V pour coller.");
        return;
      }
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1]?.replace("jpeg", "jpg") || "png";
          const nowStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          const file = new File([blob], `capture-${nowStr}.${ext}`, { type: imageType });
          await sendFile(file, { submit: false });
          return;
        }
      }
      window.alert("Aucune image trouvée dans le presse-papiers. Fais une capture d'écran ou copie une image d'abord.");
    } catch {
      window.alert("Impossible d'accéder au presse-papiers (vérifie les permissions ou utilise Ctrl+V).");
    }
  }

  async function pasteClipboard() {
    try {
      if (!window.isSecureContext) throw new Error("insecure");

      // 1. Si le presse-papiers contient une image, la coller comme fichier
      if (navigator.clipboard?.read) {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imageType = item.types.find((t) => t.startsWith("image/"));
            if (imageType) {
              const blob = await item.getType(imageType);
              const ext = imageType.split("/")[1]?.replace("jpeg", "jpg") || "png";
              const nowStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
              const file = new File([blob], `capture-${nowStr}.${ext}`, { type: imageType });
              await sendFile(file, { submit: false });
              return;
            }
          }
        } catch {}
      }

      // 2. Sinon coller le texte
      if (!navigator.clipboard?.readText) throw new Error("insecure");
      const data = await navigator.clipboard.readText();
      if (!data) throw new Error("Presse-papiers vide.");
      sendKeyboardData(data);
    } catch (error) {
      if (error.message === "Presse-papiers vide.") return window.alert(error.message);
      // Sans contexte sécurisé, la lecture du presse-papiers est interdite: saisie manuelle.
      const manual = window.prompt("Colle ici le texte à envoyer à l'agent (Cmd+V) :", "");
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

  // Dictee vocale: le texte entendu arrive tel quel dans la conversation visee, sans etre valide.
  useEffect(() => {
    const dictate = (event) => {
      const detail = typeof event.detail === "string" ? { text: event.detail, sessionId: null } : event.detail;
      if (!detail?.text) return;
      if (detail.sessionId && detail.sessionId !== session.id) return;
      sendKeyboardData(`${String(detail.text)} `);
    };
    window.addEventListener("noyau:dictate", dictate);
    return () => window.removeEventListener("noyau:dictate", dictate);
  }, [session.id]);

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
        <div className="terminal-identity">
          <strong>
            <i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} />
            <span>{session.name}</span>
            {session.assistant === "codex" && <span className="codex-efficiency-badge" title="Contexte compact, recherches ciblées, raisonnement faible">Caveman · compact</span>}
            <span
              className="agent-desc-btn"
              title={session.description ? `Description : ${session.description}` : "Voir la description de l'agent"}
              onClick={() => setDescOpen((v) => !v)}
              role="button"
              tabIndex={0}
              aria-label="Description de l'agent"
            >
              ℹ
            </span>
            {session.managed && session.canEdit !== false && onEdit && (
              <button
                type="button"
                className="agent-settings-btn"
                title="Réglages de l'agent"
                onClick={onEdit}
                aria-label={`Réglages de ${session.name}`}
              >
                ⚙
              </button>
            )}
          </strong>
          {descOpen && (
            <>
              <div className="agent-desc-backdrop" onClick={() => setDescOpen(false)} />
              <div className="agent-desc-popover terminal-desc-popover" onClick={(e) => e.stopPropagation()}>
                <div className="agent-desc-popover-head">
                  <strong>{session.name}</strong>
                  <button type="button" onClick={() => setDescOpen(false)} aria-label="Fermer">×</button>
                </div>
                <p>{session.description || "Aucune description renseignée pour cet agent."}</p>
              </div>
            </>
          )}
          <small>{session.agentStatus?.label || "Disponible"} · {connected ? "Connecté" : "Déconnecté"} · {session.cwd}</small>
        </div>
        <div className="terminal-actions">
          <ContextControl session={session} onRefresh={onRefresh} />
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
      {vscodeModal && <VsCodeModal session={session} onClose={() => setVscodeModal(false)} />}
      {createFileModal && <CreateFileModal session={session} onClose={() => setCreateFileModal(false)} onSend={handleInsertRawFiles} />}
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
          <button
            type="button"
            className="vscode-key"
            {...tapKey(openVsCode)}
            aria-label="Ouvrir le projet dans VS Code"
            title={`Ouvrir dans VS Code (${session.cwd || "projet"}) · Shift+clic pour options SSH`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/>
            </svg>
          </button>
          <button
            className={`dictate-key ${voice?.dictation === session.id ? "selected" : ""}`}
            {...tapKey(async () => {
              const enabled = voice?.dictation !== session.id;
              if (enabled) onInteract?.();
              try {
                // La dictee doit ecouter le micro de ce navigateur, meme a distance.
                let micError = null;
                if (enabled && !voiceCapture.active) await voiceCapture.start().catch((error) => { micError = error; });
                const state = await api("/api/voice/dictation", { method: "POST", body: JSON.stringify({ sessionId: session.id, enabled }) });
                onVoice?.(state);
                if (enabled && !state.listening) window.alert(state.error || micError?.message || "Micro indisponible.");
                else if (micError) window.alert(`Micro de ce navigateur refusé (${micError.message}): Noyau écoute le micro du PC hôte.`);
                if (!enabled && !state.listening) voiceCapture.stop();
              } catch (error) {
                window.alert(error.message);
              }
            })}
            aria-pressed={voice?.dictation === session.id}
            aria-label="Dicter au lieu de taper"
            title={voice?.dictation === session.id ? "Dictée active: ce que tu dis s'écrit ici" : "Dicter: parler au lieu d'écrire, sans dire « Noyau »"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>
          </button>
          <button className="keyboard-key" {...tapKey(() => { setOskEnabled(true); focusKeyboard(true); })} aria-label="Afficher le clavier">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M9.5 13.5h6.5" /></svg>
          </button>
          <label className={`upload-key ${uploading ? "disabled" : ""}`} aria-label="Joindre photo ou fichier" title="Téléverser un fichier depuis l'appareil">
            <input type="file" onChange={attachFile} disabled={uploading} />
            <span>{uploading ? "…" : "＋"}</span>
          </label>
          <button
            type="button"
            className="create-file-key"
            {...tapKey(() => setCreateFileModal(true))}
            aria-label="Créer fichier texte direct"
            title="Créer un ou plusieurs fichiers texte (tokens API, snippets, config) et insérer les chemins"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </button>
          <button
            type="button"
            className={`paste-image-key ${uploading ? "disabled" : ""}`}
            {...tapKey(pasteImageOnly)}
            aria-label="Coller image du presse-papiers"
            title="Coller directement une image ou capture d'écran du presse-papiers"
            disabled={uploading}
          >
            {uploading ? "…" : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            )}
          </button>
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
  const [description, setDescription] = useState("");
  const [suggesting, setSuggesting] = useState(false);
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
      const result = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          assistant,
          name,
          description: description.trim() || undefined,
          cwd: cwd.trim() || undefined,
          yolo,
          projectLogo,
          projectId: projectId || null,
          favorite,
        }),
      });
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
          <div className="form-row-between">
            <label htmlFor="description">Description <small className="label-optional">(rôle et utilité)</small></label>
            <button
              type="button"
              className="suggest-link"
              onClick={async () => {
                setSuggesting(true);
                try {
                  const q = new URLSearchParams({ name, assistant, cwd, projectId });
                  const res = await api(`/api/sessions/suggest-description?${q}`);
                  if (res.description) setDescription(res.description);
                } catch {} finally {
                  setSuggesting(false);
                }
              }}
              disabled={suggesting}
            >
              {suggesting ? "Génération…" : "✨ Suggérer"}
            </button>
          </div>
          <textarea
            id="description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="À quoi sert cet agent ? Ex. Scraping web, tests mocks, refonte frontend..."
          />
          <label htmlFor="project">Projet</label>
          <select id="project" value={projectId} onChange={(event) => {
            const nextProj = event.target.value;
            setProjectId(nextProj);
            if (nextProj) setProjectLogo(true);
          }}><option value="">Sans projet</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
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
  const [description, setDescription] = useState(session.description || "");
  const [suggesting, setSuggesting] = useState(false);
  const [assistant, setAssistant] = useState(session.assistant);
  const [yolo, setYolo] = useState(Boolean(session.yolo));
  const [projectLogo, setProjectLogo] = useState(session.projectId ? session.projectLogo !== false : Boolean(session.projectLogo));
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
      const result = await api(`/api/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          description: description.trim(),
          assistant,
          yolo,
          projectLogo,
          projectId: projectId || null,
          favorite,
          shared,
          todoTracking,
        }),
      });
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
          <div className="form-row-between">
            <label htmlFor="edit-description">Description <small className="label-optional">(rôle et utilité)</small></label>
            <button
              type="button"
              className="suggest-link"
              onClick={async () => {
                setSuggesting(true);
                try {
                  const q = new URLSearchParams({ name, assistant, cwd: session.cwd || "", projectId });
                  const res = await api(`/api/sessions/suggest-description?${q}`);
                  if (res.description) setDescription(res.description);
                } catch {} finally {
                  setSuggesting(false);
                }
              }}
              disabled={suggesting}
            >
              {suggesting ? "Génération…" : "✨ Suggérer"}
            </button>
          </div>
          <textarea
            id="edit-description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="À quoi sert cet agent ?"
          />
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
          <select id="edit-project" value={projectId} onChange={(event) => {
            const nextProj = event.target.value;
            setProjectId(nextProj);
            if (nextProj) setProjectLogo(true);
          }}><option value="">Sans projet</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
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
  const [logoPath, setLogoPath] = useState(project?.logoPath || null);
  const [showPicker, setShowPicker] = useState(false);
  const [images, setImages] = useState([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchImages = useCallback(async (offset = 0, reset = false, search = "") => {
    if (!project?.id) return;
    setImagesLoading(true);
    try {
      const q = new URLSearchParams({ offset: String(offset), limit: "30" });
      if (search) q.set("search", search);
      const res = await api(`/api/projects/${project.id}/images?${q}`);
      setImages((prev) => (reset ? res.images : [...prev, ...res.images]));
      setHasMore(Boolean(res.hasMore));
    } catch {
      // Ignorer erreur de listage images
    } finally {
      setImagesLoading(false);
    }
  }, [project?.id]);

  useEffect(() => {
    if (showPicker && project?.id && images.length === 0 && !imagesLoading) {
      fetchImages(0, true, searchQuery);
    }
  }, [showPicker, project?.id, images.length, imagesLoading, fetchImages, searchQuery]);

  function handleLogoSearch(event) {
    const val = event.target.value;
    setSearchQuery(val);
    fetchImages(0, true, val);
  }

  function handleGridScroll(event) {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 60 && hasMore && !imagesLoading) {
      fetchImages(images.length, false, searchQuery);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api(project ? `/api/projects/${project.id}` : "/api/projects", {
        method: project ? "PATCH" : "POST",
        body: JSON.stringify({ name, rootPath: null, shared, todoTracking, logoPath }),
      });
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
          <label htmlFor="project-name">Nom</label>
          <input id="project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex. Noyau" autoFocus />

          {project && (
            <div className="project-logo-picker-section">
              <label>Logo du projet</label>
              <div className="project-logo-preview-row">
                <div className="project-logo-preview-box">
                  {logoPath ? (
                    <img
                      src={`/api/projects/${project.id}/image-file?path=${encodeURIComponent(logoPath)}`}
                      alt="Logo sélectionné"
                    />
                  ) : (
                    <img
                      src={project.logoUrl}
                      alt="Logo projet"
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                    />
                  )}
                </div>
                <div className="project-logo-details">
                  <strong>{logoPath ? "Logo personnalisé sélectionné" : "Logo automatique"}</strong>
                  <small>{logoPath ? logoPath.split("/").pop() : "Détecté dans les dossiers ou agents du projet"}</small>
                </div>
                <div className="project-logo-actions">
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => setShowPicker((prev) => !prev)}
                  >
                    {showPicker ? "Fermer" : "Changer…"}
                  </button>
                  {logoPath && (
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => setLogoPath(null)}
                      title="Revenir au logo détecté automatiquement"
                    >
                      Auto
                    </button>
                  )}
                </div>
              </div>

              {showPicker && (
                <div className="project-logo-browser">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={handleLogoSearch}
                    placeholder="Filtrer les images du projet…"
                    className="project-logo-search-input"
                  />
                  <div className="project-logo-grid" onScroll={handleGridScroll}>
                    {images.map((img) => {
                      const isSelected = logoPath === img.path;
                      return (
                        <button
                          key={img.path}
                          type="button"
                          className={`project-logo-thumb-btn ${isSelected ? "selected" : ""}`}
                          onClick={() => setLogoPath(img.path)}
                          title={`${img.relativePath} (${img.name})`}
                        >
                          <img
                            src={`/api/projects/${project.id}/image-file?path=${encodeURIComponent(img.path)}`}
                            alt={img.name}
                            loading="lazy"
                          />
                          <span className="project-logo-thumb-label">{img.name}</span>
                          {isSelected && <span className="project-logo-thumb-check">✓</span>}
                        </button>
                      );
                    })}
                    {imagesLoading && (
                      <div className="project-logo-loading-more">Chargement des images…</div>
                    )}
                    {!imagesLoading && images.length === 0 && (
                      <div className="project-logo-empty-hint">Aucune image trouvée dans le projet.</div>
                    )}
                  </div>
                  {hasMore && !imagesLoading && (
                    <p className="form-hint" style={{ marginTop: "6px", marginBottom: "0" }}>
                      Défilez vers le bas pour charger davantage d'images.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <label className="checkbox-option"><input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} /><span><strong>Partager le projet</strong><small>Visible par les autres profils, avec ses agents, todos et modules</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={todoTracking} onChange={(event) => setTodoTracking(event.target.checked)} /><span><strong>Reporting évolutions / bugs</strong><small>Les demandes adressées aux agents du projet créent ou commentent un to-do</small></span></label>
          <p className="form-hint">Agents peuvent utiliser dossiers différents. Changer le logo met à jour l'icône du projet et de ses agents.</p>
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


// Micro du navigateur: le poste qui pilote envoie son son a Noyau, qui transcrit chez lui.
// Sans cela, piloter depuis un autre ordinateur ecouterait le micro de la machine hote.
const voiceCapture = (() => {
  let socket = null;
  let context = null;
  let stream = null;
  let processor = null;
  let source = null;
  let mute = null;

  function release() {
    try { processor?.disconnect(); } catch { /* deja detache */ }
    try { source?.disconnect(); } catch { /* deja detache */ }
    try { mute?.disconnect(); } catch { /* deja detache */ }
    for (const track of stream?.getTracks() || []) track.stop();
    try { context?.close(); } catch { /* deja ferme */ }
    socket = null; context = null; stream = null; processor = null; source = null; mute = null;
  }

  return {
    get active() { return socket?.readyState === WebSocket.OPEN; },
    async start() {
      if (this.active) return true;
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) throw new Error("Micro du navigateur indisponible ici.");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      await context.resume();
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/voice`);
      socket.binaryType = "arraybuffer";
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("Liaison micro refusée.")), { once: true });
      });
      socket.addEventListener("close", () => release());
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      // Le navigateur peut refuser 16 kHz: on reechantillonne alors nous-memes.
      const ratio = context.sampleRate / 16000;
      processor.onaudioprocess = (event) => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const length = Math.floor(input.length / ratio);
        const pcm = new Int16Array(length);
        for (let index = 0; index < length; index += 1) {
          const sample = Math.max(-1, Math.min(1, input[Math.floor(index * ratio)]));
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        socket.send(pcm.buffer);
      };
      // Un gain nul garde le traitement vivant sans renvoyer la voix dans les haut-parleurs.
      mute = context.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      return true;
    },
    stop() {
      try { socket?.close(); } catch { /* deja ferme */ }
      release();
    },
  };
})();

// Une action vocale se raconte en une ligne: on doit la reconnaitre du coin de l'oeil.
function describeVoiceAction(action) {
  if (action.action === "open-agent") return `Ouvre l'agent ${action.name || ""}`.trim();
  if (action.action === "open-project") return `Ouvre le projet ${action.name || ""}`.trim();
  if (action.action === "view") return `Ouvre ${action.view}`;
  if (action.action === "send-agent") return `À ${action.name}: « ${action.text} »`;
  if (action.action === "interrupt") return action.name ? `Arrête ${action.name}` : "Arrête la tâche en cours";
  if (action.action === "optimize") return `${action.mode === "clear" ? "Repart propre" : "Compacte"} ${action.name}`;
  if (action.action === "restart") return `Relance ${action.name}`;
  if (action.action === "dictate") return `Dicté: « ${action.text} »`;
  if (action.action === "mute") return "Coupe le son";
  if (action.action === "unmute") return "Remet le son";
  if (action.action === "stop-listening") return "Arrête d'écouter";
  if (action.action === "unknown") return `Pas compris: « ${action.target || ""} »`;
  return action.action;
}

// Superposition micro: ce que Noyau entend, ce qu'il en fait, et de quoi couper court sans changer d'ecran.
function VoiceOverlay({ voice, feed, sessions, onVoice, onOpenAgent }) {
  const [folded, setFolded] = useState(false);
  const [busy, setBusy] = useState("");
  if (!voice?.listening) return null;
  const target = sessions.find((session) => session.id === voice.dictation) || null;
  const working = sessions.filter((session) => session.agentStatus?.state === "working");
  const heard = feed.partial || voice.lastHeard?.text || "";

  async function interrupt(id) {
    setBusy(id);
    try {
      await api(`/api/sessions/${id}/interrupt`, { method: "POST" });
    } catch (error) {
      window.alert(error.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <aside className={`voice-overlay ${folded ? "folded" : ""}`}>
      <header>
        <i className={`voice-overlay-dot ${feed.partial ? "live" : ""}`} aria-hidden="true" />
        <strong>{target ? `Dictée → ${target.name}` : "Micro actif"}</strong>
        <button className="voice-overlay-fold" onClick={() => setFolded((value) => !value)} aria-label={folded ? "Déplier" : "Replier"}>{folded ? "▴" : "▾"}</button>
        <button className="voice-overlay-off" onClick={() => onVoice(false)}>Couper</button>
      </header>
      {!folded && (
        <div className="voice-overlay-body">
          <p className={`voice-overlay-heard ${feed.partial ? "live" : ""}`}>{heard ? `« ${heard} »` : "En écoute…"}</p>
          {feed.events.length > 0 && (
            <ul className="voice-overlay-events">
              {feed.events.map((event) => <li key={event.key}>{event.label}</li>)}
            </ul>
          )}
          {working.map((session) => (
            <div key={session.id} className="voice-overlay-task">
              <button className="voice-overlay-agent" onClick={() => onOpenAgent(session.id)}>
                <strong>{session.name}</strong><small>travaille en ce moment</small>
              </button>
              <button className="voice-overlay-stop" disabled={busy === session.id} onClick={() => interrupt(session.id)}>{busy === session.id ? "…" : "Arrêter"}</button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function MobileInstallPopup() {
  const [visible, setVisible] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showIosTip, setShowIosTip] = useState(false);
  const isApple = typeof navigator !== "undefined" && /iPhone|iPad|iPod/i.test(navigator.userAgent);

  useEffect(() => {
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (isStandalone) return;

    const dismissed = sessionStorage.getItem("noyau-mobile-banner-dismissed");
    const isMobile = window.innerWidth <= 840 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || TOUCH_MODE;
    if (isMobile && !dismissed) {
      setVisible(true);
    }

    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      if (!dismissed) setVisible(true);
    };
    const openHandler = () => setVisible(true);
    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("noyau:open-install", openHandler);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("noyau:open-install", openHandler);
    };
  }, []);

  const dismiss = () => {
    setVisible(false);
    sessionStorage.setItem("noyau-mobile-banner-dismissed", "1");
  };

  const handleInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const res = await deferredPrompt.userChoice;
      if (res.outcome === "accepted") setVisible(false);
      setDeferredPrompt(null);
    } else if (isApple) {
      setShowIosTip(true);
    } else {
      window.location.href = "/api/mobile/noyau.apk";
    }
  };

  if (!visible) return null;

  return (
    <aside className="mobile-install-banner" role="banner">
      <div className="mobile-install-banner-inner">
        <span className="mobile-install-glyph">📱</span>
        <div className="mobile-install-info">
          <strong>Installer l'application Noyau</strong>
          <small>Mode hors-ligne, tunnel WireGuard direct et accès instantané.</small>
        </div>
        <div className="mobile-install-actions">
          <button type="button" className="primary mini" onClick={handleInstall}>
            {isApple ? "📲 Installer" : "📲 Installer App"}
          </button>
          {!isApple && (
            <a href="/api/mobile/noyau.apk" download="noyau.apk" className="button ghost mini">
              🤖 APK Android
            </a>
          )}
          <button type="button" className="icon-button mini close-install" onClick={dismiss} aria-label="Fermer">
            ✕
          </button>
        </div>
      </div>
      {showIosTip && (
        <div className="ios-install-hint">
          <span>Sur Safari iOS : appuyez sur Partager <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> puis sur <strong>« Sur l'écran d'accueil » ➕</strong></span>
          <button type="button" className="ghost mini" onClick={() => setShowIosTip(false)}>Compris</button>
        </div>
      )}
    </aside>
  );
}

function App() {
  const [auth, setAuth] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [modules, setModules] = useState([]);
  const [moduleProposals, setModuleProposals] = useState([]);
  const [quotas, setQuotas] = useState({ codex: null, claude: null });
  const [assistants, setAssistants] = useState(null);
  // Le flux vocal vit hors du rendu: il lui faut l'agent regarde a l'instant, pas celui du montage.
  const activeIdRef = React.useRef(null);
  const [activeId, setActiveId] = useState(() => new URLSearchParams(location.search).get("session"));
  activeIdRef.current = activeId;
  const [view, setView] = useState(() => ["projects", "calendar", "todos", "finances", "finance-transactions", "finance-agent", "finance-modules", "finance-banking", "settings"].includes(new URLSearchParams(location.search).get("view")) ? new URLSearchParams(location.search).get("view") : "dashboard");
  const [modal, setModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [projectModalId, setProjectModalId] = useState(null);
  const [menu, setMenu] = useState(false);
  const [bootOffline, setBootOffline] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [bootAttempts, setBootAttempts] = useState(0);
  const [bootNonce, setBootNonce] = useState(0);
  const [bootPercent, setBootPercent] = useState(8);
  const [bootStep, setBootStep] = useState("Démarrage…");
  const [bootDetail, setBootDetail] = useState("");
  const [permission, setPermission] = useState(!window.isSecureContext ? "insecure" : (typeof Notification === "undefined" ? "denied" : Notification.permission));
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState(() => activeProfileId());
  const [todoUnread, setTodoUnread] = useState(0);
  const [power, setPower] = useState(null);
  const [powerBusy, setPowerBusy] = useState(false);
  const [switchTarget, setSwitchTarget] = useState(null);
  const [agentSortMode, setAgentSortMode] = useState(() => {
    try { return localStorage.getItem(profileCacheKey("agents-sort-mode")) || "recent"; } catch { return "recent"; }
  });
  const [lastInteractedMap, setLastInteractedMap] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(profileCacheKey("agents-last-interacted")))
        || JSON.parse(localStorage.getItem(profileCacheKey("agents-last-opened")))
        || {};
    } catch {
      return {};
    }
  });

  const registerAgentInteraction = useCallback((id) => {
    if (!id) return;
    const now = Date.now();
    setLastInteractedMap((prev) => {
      if (now - (prev[id] || 0) < 3000) return prev;
      const next = { ...prev, [id]: now };
      try { localStorage.setItem(profileCacheKey("agents-last-interacted"), JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (event) => {
      if (event.detail?.id) registerAgentInteraction(event.detail.id);
    };
    window.addEventListener("noyau:agent-interact", handler);
    return () => window.removeEventListener("noyau:agent-interact", handler);
  }, [registerAgentInteraction]);

  const openAgentSession = useCallback((id) => {
    setActiveId(id || null);
  }, []);

  const changeAgentSortMode = useCallback((next) => {
    setAgentSortMode(next);
    try { localStorage.setItem(profileCacheKey("agents-sort-mode"), next); } catch {}
  }, []);

  const cycleAgentSort = useCallback(() => {
    const MODES = ["recent", "alpha", "project"];
    setAgentSortMode((current) => {
      const idx = MODES.indexOf(current);
      const next = MODES[(idx + 1) % MODES.length];
      try { localStorage.setItem(profileCacheKey("agents-sort-mode"), next); } catch {}
      return next;
    });
  }, []);
  const syncPower = useCallback(() => api("/api/system/power").then(setPower).catch(() => {}), []);
  useEffect(() => {
    syncPower();
    const timer = setInterval(syncPower, 20_000);
    return () => clearInterval(timer);
  }, [syncPower]);

  const togglePower = async () => {
    try {
      setPowerBusy(true);
      if (power?.sleeping) await api("/api/system/power/wake", { method: "POST" });
      else await api("/api/system/power/sleep", { method: "POST" });
      await syncPower();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setPowerBusy(false);
    }
  };

  const [voice, setVoice] = useState({ enabled: false, listening: false, installed: false });
  const [voiceFeed, setVoiceFeed] = useState({ partial: "", events: [] });
  const [muted, setMuted] = useState(soundMuted);
  const agentStatesRef = React.useRef(new Map());

  // Le micro parle a l'interface par un flux d'evenements: la vue suit la voix sans interrogation en boucle.
  useEffect(() => {
    if (!auth) return undefined;
    let source = null;
    try {
      source = new EventSource("/api/voice/events");
    } catch {
      return undefined;
    }
    source.onmessage = (event) => {
      let payload = null;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === "hello" || payload.type === "state") { setVoice((current) => ({ ...current, ...payload.state })); return; }
      if (payload.type === "partial") { setVoiceFeed((current) => ({ ...current, partial: payload.partial?.text || "" })); return; }
      if (payload.type !== "action") return;
      const action = payload.action;
      setVoiceFeed((current) => ({ partial: "", events: [{ key: `${Date.now()}-${current.events.length}`, label: describeVoiceAction(action) }, ...current.events].slice(0, 5) }));
      sounds.voiceHeard();
      if (action.action === "open-agent") { setActiveId(action.id); setView("dashboard"); }
      else if (action.action === "open-project") setView("projects");
      else if (action.action === "view") { setActiveId(null); setView(action.view); }
      else if (action.action === "mute") { setSoundMuted(true); setMuted(true); }
      else if (action.action === "unmute") { setSoundMuted(false); setMuted(false); }
      else if (action.action === "stop-listening") setVoice((current) => ({ ...current, enabled: false, listening: false }));
      // « annule sa tâche » sans nom d'agent: c'est celui qu'on regarde qu'on veut couper.
      else if (action.action === "interrupt" && !action.id && activeIdRef.current) api(`/api/sessions/${activeIdRef.current}/interrupt`, { method: "POST" }).catch(() => {});
      else if (action.action === "send-agent") {
        if (action.id) registerAgentInteraction(action.id);
        setTimeout(() => refresh(), 1200);
      }
      else if (action.action === "dictate") {
        const targetId = action.sessionId || voice.dictation || activeIdRef.current;
        if (targetId) registerAgentInteraction(targetId);
        if (action.text) {
          window.dispatchEvent(new CustomEvent("noyau:dictate", { detail: { text: action.text, sessionId: action.sessionId || null } }));
        }
      }
    };
    source.onerror = () => { /* le navigateur reconnecte tout seul */ };
    return () => source.close();
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    api("/api/voice").then(setVoice).catch(() => {});
  }, [auth]);


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

  async function toggleVoice(next) {
    try {
      if (!next) {
        voiceCapture.stop();
        setVoice(await api("/api/voice/stop", { method: "POST" }));
        return;
      }
      // Micro du navigateur d'abord: c'est celui de la personne qui parle, pas celui du serveur.
      try {
        await voiceCapture.start();
        setVoice((current) => ({ ...current, enabled: true, listening: true, source: "browser" }));
      } catch {
        setVoice(await api("/api/voice/start", { method: "POST" }));
      }
    } catch (error) {
      window.alert(error.message);
    }
  }

  function toggleMuted(next) {
    setSoundMuted(next);
    setMuted(next);
    if (!next) sounds.agentDone();
  }

  const refresh = useCallback(async () => {
    try {
      const [{ sessions: nextSessions, quotas: nextQuotas, assistants: nextAssistants }, { projects: nextProjects }, nextModules] = await Promise.all([api("/api/sessions"), api("/api/projects"), api("/api/modules")]);
      // Un agent qui passe en attente ou qui rend la main se signale a l'oreille.
      for (const session of nextSessions) {
        const previous = agentStatesRef.current.get(session.id);
        const current = session.agentStatus?.state || "available";
        if (previous && previous !== current) {
          if (current === "waiting") sounds.agentWaiting();
          else if (previous === "working" && current === "available") sounds.agentDone();
        }
        agentStatesRef.current.set(session.id, current);
      }
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
        const session = await api("/api/auth/session", { signal: controller.signal });
        if (disposed) return;
        clearInterval(creepTimer);
        advance(80, "Session validée…");
        setBootOffline(false);
        setBootDetail("");
        if (session?.profile?.id) {
          setProfileId(session.profile.id);
          try { localStorage.setItem(PROFILE_KEY, session.profile.id); } catch { /* ignore */ }
          applyTheme(session.profile.theme);
          applyInstallIdentity(session.profile);
        }
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

  // Détection de l'activité humaine pour maintenir éveillé ou réveiller le serveur
  useEffect(() => {
    let lastSent = 0;
    const reportActivity = (event) => {
      // Ignorer les clics sur les contrôles de mise en veille pour ne pas auto-réveiller immédiatement
      if (event?.target?.closest(".system-power__toggle, .power-sleeping-banner, .power-wake-btn, .setting-toggle")) return;
      if (power?.sleeping) return;
      const now = Date.now();
      if (now - lastSent < 30_000) return;
      lastSent = now;
      api("/api/system/activity", { method: "POST" })
        .then(() => {
          if (power?.sleeping) syncPower();
        })
        .catch(() => {});
    };
    window.addEventListener("pointerdown", reportActivity, { passive: true });
    window.addEventListener("keydown", reportActivity, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", reportActivity);
      window.removeEventListener("keydown", reportActivity);
    };
  }, [power?.sleeping, syncPower]);

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
    const resolvedTheme = (current && current.toLowerCase().includes("aurora")) || active?.name?.toLowerCase().includes("aurora")
      ? "moving-castle"
      : (active?.theme || "noyau");
    applyTheme(resolvedTheme);
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
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) await reg.update();
        }
      } catch {}
    }
    check();
    timer = setInterval(check, 10000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    document.addEventListener("fullscreenchange", check);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      document.removeEventListener("fullscreenchange", check);
    };
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
      if (event.data?.type === "NOYAU_UPDATE" && event.data.version) {
        const known = localStorage.getItem(VERSION_KEY);
        if (known && known !== event.data.version) {
          localStorage.setItem(VERSION_KEY, event.data.version);
          purgeClient().then(() => {
            window.location.reload();
          });
        }
      }
    };
    const onControllerChange = () => {
      window.location.reload();
    };
    // Le controle de version gere seul le rechargement pour eviter les boucles a l'activation du worker.
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.addEventListener("message", receiveUpdate);
    navigator.serviceWorker.register("/sw.js").then((registration) => registration.update()).catch(() => {});
    consumePending();
    const wake = () => document.visibilityState === "visible" && consumePending();
    document.addEventListener("visibilitychange", wake);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
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
  const orderedSessions = useMemo(() => sortAgents(sessions, agentSortMode, lastInteractedMap), [sessions, agentSortMode, lastInteractedMap]);
  const tryReconnect = useCallback(async () => {
    try {
      const res = await api("/api/auth/session");
      if (res?.authenticated) {
        setOfflineMode(false);
        await flushOfflineQueue();
        await refresh();
        window.dispatchEvent(new Event("noyau:todos-refresh"));
      } else {
        window.alert("Session expirée. Veuillez vous reconnecter.");
      }
    } catch {
      window.alert("Connexion impossible : serveur / VPN toujours injoignable.");
    }
  }, [refresh]);

  useEffect(() => {
    const handleOnline = () => tryReconnect();
    window.addEventListener("online", handleOnline);
    const interval = setInterval(() => {
      if (offlineMode) {
        api("/api/auth/session")
          .then((res) => {
            if (res?.authenticated) {
              setOfflineMode(false);
              flushOfflineQueue();
              refresh();
              window.dispatchEvent(new Event("noyau:todos-refresh"));
            }
          })
          .catch(() => {});
      }
    }, 8_000);
    return () => {
      window.removeEventListener("online", handleOnline);
      clearInterval(interval);
    };
  }, [offlineMode, refresh, tryReconnect]);

  useEffect(() => {
    if (offlineMode && !["calendar", "todos", "settings"].includes(view)) {
      setView("calendar");
    }
  }, [offlineMode, view]);

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
        onEnterOffline={() => {
          setBootOffline(false);
          setAuth(true);
          setOfflineMode(true);
          setView("calendar");
        }}
      />
    );
  }
  if (!auth) return <Login onLogin={() => setAuth(true)} />;

  async function logout() {
    await api("/api/logout", { method: "POST" });
    setAuth(false);
  }

  function requestSwitchProfile(id) {
    if (!id || id === profileId) return;
    const target = profiles.find((item) => item.id === id);
    if (!target) return;
    setSwitchTarget(target);
  }

  async function confirmSwitchProfile(target, password) {
    const res = await api("/api/auth/switch", {
      method: "POST",
      body: JSON.stringify({ profileId: target.id, password }),
    });
    setSwitchTarget(null);
    await applyProfileSwitch(res.profile.id);
  }

  async function applyProfileSwitch(id) {
    if (!id) return;
    const nextProfile = profiles.find((item) => item.id === id);
    if (!nextProfile) return;
    try { localStorage.setItem(PROFILE_KEY, id); } catch { /* stockage optionnel */ }
    setProfileId(id);
    setAgentSortMode(() => {
      try { return localStorage.getItem(`${id}:agents-sort-mode`) || "recent"; } catch { return "recent"; }
    });
    setLastInteractedMap(() => {
      try {
        return JSON.parse(localStorage.getItem(`${id}:agents-last-interacted`))
          || JSON.parse(localStorage.getItem(`${id}:agents-last-opened`))
          || {};
      } catch {
        return {};
      }
    });
    const resolvedTheme = (id && id.toLowerCase().includes("aurora")) || nextProfile.name?.toLowerCase().includes("aurora")
      ? "moving-castle"
      : (nextProfile.theme || "noyau");
    applyTheme(resolvedTheme);
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
  const runModuleAction = (id, actionId, body = {}) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}${body.stop ? "/stop" : ""}`, { method: "POST", body: JSON.stringify(body) });
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
    <div className={`app-shell ${TOUCH_MODE ? "touch-shell" : ""} ${offlineMode ? "offline-mode" : ""}`}>
      <MobileInstallPopup />
      {TOUCH_MODE && !offlineMode && <TouchSystemBar sessions={orderedSessions} onHome={() => { setActiveId(null); setView("dashboard"); }} onNew={() => setModal(true)} />}
      {!offlineMode && <Sidebar sessions={orderedSessions} projects={projects} activeId={activeId} view={view} onOpen={openAgentSession} onView={setView} onNew={() => setModal(true)} onLogout={logout} open={menu} onClose={() => setMenu(false)} profiles={profiles} profileId={profileId} onSwitchProfile={requestSwitchProfile} todoUnread={todoUnread} sortMode={agentSortMode} onCycleSort={cycleAgentSort} lastInteractedMap={lastInteractedMap} />}
      {menu && !offlineMode && <button className="menu-backdrop" onClick={() => setMenu(false)} aria-label="Fermer menu" />}
      <main className="content">
        {offlineMode && (
          <aside className="offline-top-banner" role="status">
            <div className="offline-top-banner-content">
              <div className="offline-banner-head">
                <span className="offline-status-text">
                  <span className="offline-pulse-dot" />
                  <strong>Mode hors-ligne</strong>
                </span>
                <div className="offline-top-banner-actions">
                  <button
                    type="button"
                    className="ghost mini offline-btn"
                    onClick={() => {
                      const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && !window.MSStream;
                      if (isApple) {
                        window.alert("Sur iOS, active WireGuard depuis ton écran d'accueil ou configure « Sur demande » dans WireGuard.");
                      } else {
                        try {
                          window.location.href = "intent://#Intent;package=com.wireguard.android;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end";
                        } catch {
                          try { window.location.href = "wireguard://"; } catch {}
                        }
                      }
                    }}
                  >
                    🛡️ WireGuard
                  </button>
                  <button type="button" className="primary mini offline-btn" onClick={tryReconnect}>🔄 Reconnecter</button>
                </div>
              </div>
              <div className="offline-top-banner-tabs">
                <button
                  type="button"
                  className={`offline-tab-btn ${view === "calendar" ? "active" : ""}`}
                  onClick={() => setView("calendar")}
                >
                  📅 Calendrier
                </button>
                <button
                  type="button"
                  className={`offline-tab-btn ${view === "todos" ? "active" : ""}`}
                  onClick={() => setView("todos")}
                >
                  📋 Tâches
                </button>
              </div>
            </div>
          </aside>
        )}
        {power?.sleeping && (
          <aside className="power-sleeping-banner" role="alert">
            <span>🌙 <strong>Mode basse consommation actif</strong> ({power.pausedContainers?.length || 0} conteneurs Docker gelés pour rafraîchir le PC)</span>
            <button onClick={togglePower} className="power-wake-btn">⚡ Sortir de veille</button>
          </aside>
        )}
        <ViewBoundary viewKey={`${view}:${activeId || ""}`}>
        {!active ? (
          <>
            {view === "dashboard" && <><Header title="Accueil" subtitle="Vue générale" onMenu={() => setMenu(true)} onAction={() => setModal(true)} /><Dashboard sessions={orderedSessions} projects={projects} quotas={quotas} onSessionsChanged={refresh} onRefreshQuotas={refreshQuotas} onOpen={openAgentSession} onNew={() => setModal(true)} onEdit={setEditingId} onFavorite={toggleFavorite} onArchive={archiveAgent} voice={voice} onVoice={toggleVoice} muted={muted} onMuted={toggleMuted} onProjects={() => setView("projects")} onFinances={() => setView("finances")} power={power} onTogglePower={togglePower} powerBusy={powerBusy} sortMode={agentSortMode} onSetSortMode={changeAgentSortMode} profileId={profileId} lastInteractedMap={lastInteractedMap} /></>}
            {view === "projects" && <><Header title="Projets" subtitle="Agents et modules" onMenu={() => setMenu(true)} actionLabel="Nouveau projet" onAction={() => setProjectModalId("new")} /><ProjectsView projects={projects} sessions={orderedSessions} modules={modules} moduleProposals={moduleProposals} onOpenAgent={openAgentSession} onNew={() => setProjectModalId("new")} onEdit={setProjectModalId} onDelete={deleteProject} onInstallModule={installModule} onModuleToggle={toggleModule} onModuleAction={runModuleAction} onModuleSchedule={saveModuleSchedule} onModuleBuild={buildModule} onModuleBuildRefresh={refreshModuleBuilds} onOpenTodos={() => setView("todos")} onReorder={reorderProjects} onRefresh={refresh} profileId={profileId} /></>}
            {view === "calendar" && <>{!offlineMode && <Header title="Calendrier" subtitle="Agenda et échéances" onMenu={() => setMenu(true)} />}<CalendarView projects={projects} onView={setView} /></>}
            {view === "todos" && <>{!offlineMode && <Header title="Todo" subtitle="Obsidian · NAS" onMenu={() => setMenu(true)} />}<TodosView projects={projects} onView={setView} /></>}
            {view === "finances" && <><Header title="Budget" subtitle="Dépenses et épargne" onMenu={() => setMenu(true)} /><FinanceView onView={setView} /></>}
            {view === "finance-transactions" && <><Header title="Budget · Opérations" subtitle="Saisie et historique" onMenu={() => setMenu(true)} /><FinanceTransactionsView onView={setView} /></>}
            {view === "finance-agent" && <><Header title="Budget · Agent" subtitle="Charges et prévisions" onMenu={() => setMenu(true)} /><FinanceAgentView onView={setView} /></>}
            {view === "finance-modules" && <><Header title="Budget · Modules" subtitle="Actifs et règles" onMenu={() => setMenu(true)} /><FinanceModulesView onView={setView} /></>}
            {view === "finance-banking" && <><Header title="Budget · Banques" subtitle="Connexions et synchronisation" onMenu={() => setMenu(true)} /><FinanceBankingView onView={setView} /></>}
            {view === "settings" && <><Header title="Réglages" subtitle="Application" onMenu={() => setMenu(true)} /><SettingsView voice={voice} onVoice={toggleVoice} muted={muted} onMuted={toggleMuted} permission={permission} onNotifications={enableNotifications} onRefresh={reloadLatest} onView={setView} profiles={profiles} profileId={profileId} onSwitchProfile={requestSwitchProfile} onProfilesChanged={refreshProfiles} /></>}
          </>
        ) : (
          <TerminalView session={active} quotas={quotas} assistants={assistants} voice={voice} onVoice={(next) => setVoice((current) => ({ ...current, ...next }))} onBack={() => setActiveId(null)} onKilled={() => { setActiveId(null); refresh(); }} onMigrated={(id) => { registerAgentInteraction(id); openAgentSession(id); refresh(); }} onRefresh={refresh} onEdit={() => setEditingId(active.id)} onInteract={() => registerAgentInteraction(active.id)} />
        )}
        </ViewBoundary>
      </main>
      {modal && <NewSessionModal projects={projects} sessions={orderedSessions} assistants={assistants} onClose={() => setModal(false)} onCreated={(session) => { setModal(false); registerAgentInteraction(session.id); openAgentSession(session.id); refresh(); }} />}
      {editingSession && <EditSessionModal session={editingSession} projects={projects} onClose={() => setEditingId(null)} onSaved={(next, meta) => { setEditingId(null); if (meta?.switched && next?.id) { if (activeId === editingSession.id) openAgentSession(next.id); } refresh(); }} />}
      {switchTarget && <SwitchProfileModal target={switchTarget} onClose={() => setSwitchTarget(null)} onConfirm={(password) => confirmSwitchProfile(switchTarget, password)} />}
      <VoiceOverlay voice={voice} feed={voiceFeed} sessions={orderedSessions} onVoice={toggleVoice} onOpenAgent={(id) => { openAgentSession(id); setMenu(false); }} />
      {projectModalId && <ProjectModal project={editingProject} onClose={() => setProjectModalId(null)} onSaved={() => { setProjectModalId(null); refresh(); }} />}
    </div>
  );
}

window.__noyauMounted = true;
createRoot(document.getElementById("root")).render(<App />);
