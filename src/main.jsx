import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const assistantMeta = {
  codex: { label: "Codex", glyph: "C", color: "green" },
  claude: { label: "Claude", glyph: "A", color: "orange" },
  shell: { label: "Terminal", glyph: ">_", color: "blue" },
};

function applicationServerKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function api(path, options = {}) {
  const multipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: { ...(multipart ? {} : { "Content-Type": "application/json" }), ...options.headers },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Erreur ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

const VERSION_KEY = "noyau:version";

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
  location.replace(`/?reset=${Date.now()}`);
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

function Sidebar({ sessions, activeId, view, onOpen, onView, onNew, onLogout, open, onClose }) {
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand"><Mark /><span>Noyau</span><button className="icon-button close-menu" onClick={onClose} aria-label="Fermer">×</button></div>
      <nav className="main-nav">
        <button className={!activeId && view === "dashboard" ? "active" : ""} onClick={() => { onOpen(null); onView("dashboard"); onClose(); }}><span>⌂</span>Accueil</button>
        <button className={!activeId && view === "projects" ? "active" : ""} onClick={() => { onOpen(null); onView("projects"); onClose(); }}><span>◫</span>Projets</button>
        <button><span>↗</span>Veille <em>Bientôt</em></button>
        <button className={!activeId && view === "finances" ? "active" : ""} onClick={() => { onOpen(null); onView("finances"); onClose(); }}><span>€</span>Dépenses</button>
        <button className={!activeId && view === "finance-transactions" ? "active" : ""} onClick={() => { onOpen(null); onView("finance-transactions"); onClose(); }}><span>±</span>Opérations</button>
        <button className={!activeId && view === "finance-agent" ? "active" : ""} onClick={() => { onOpen(null); onView("finance-agent"); onClose(); }}><span>◇</span>Agent finances</button>
        <button className={!activeId && view === "settings" ? "active" : ""} onClick={() => { onOpen(null); onView("settings"); onClose(); }}><span className="nav-settings-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h10m4 0h2M4 17h2m4 0h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg></span>Réglages</button>
      </nav>
      <div className="sidebar-title"><span>AGENTS</span><button onClick={onNew} aria-label="Nouvelle session">+</button></div>
      <div className="session-list">
        {sessions.map((session) => (
          <button className={activeId === session.id ? "active" : ""} onClick={() => { onOpen(session.id); onClose(); }} key={session.id}>
            <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small />
            <span><strong>{session.favorite && <b className="favorite-star">★</b>}{session.name}</strong><small>{session.project?.name || assistantMeta[session.assistant]?.label || "Terminal"} · {session.agentStatus?.label || "Disponible"}</small></span>
            <i className={`live-dot ${session.agentStatus?.state || "available"}`} title={session.agentStatus?.label || "Disponible"} />
          </button>
        ))}
        {!sessions.length && <p className="empty-small">Aucune session active.</p>}
      </div>
      <button className="profile" onClick={onLogout}><span>G</span><strong>Session locale<small>Se déconnecter</small></strong><i>···</i></button>
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

function DashboardAgentCard({ session, onOpen, onEdit, onFavorite }) {
  return (
    <article className="agent-card">
      <button className="agent-card-open" onClick={() => onOpen(session.id)}>
        <AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} />
        <span className="agent-info"><strong>{session.name}</strong><small>{session.project?.name || "Sans projet"} · {session.cwd || session.id}</small><em><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {session.agentStatus?.label || "Disponible"} · {session.usage?.contextPercent ?? "—"}% contexte · <RelativeTime date={session.activityAt} /></em></span>
        <span className="open-arrow">›</span>
      </button>
      {session.managed && <div className="agent-card-actions"><button className={`agent-card-favorite ${session.favorite ? "active" : ""}`} onClick={() => onFavorite(session)} aria-label={`${session.favorite ? "Retirer" : "Ajouter"} favori`}>★</button><button className="agent-card-edit" onClick={() => onEdit(session.id)} aria-label={`Éditer ${session.name}`}>Éditer</button></div>}
    </article>
  );
}

function Dashboard({ sessions, projects, quotas, onOpen, onNew, onEdit, onFavorite, onProjects, onFinances }) {
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
  const codexPeriod = quotas.codex?.windowMinutes ? (quotas.codex.windowMinutes >= 10_080 ? "7 j" : `${Math.round(quotas.codex.windowMinutes / 60)} h`) : "";
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
    if (!navigator.geolocation) return;
    let disposed = false;
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const nextWeather = await api(`/api/weather?latitude=${encodeURIComponent(coords.latitude)}&longitude=${encodeURIComponent(coords.longitude)}`);
        if (disposed) return;
        setWeather(nextWeather);
        try { localStorage.setItem("noyau-weather", JSON.stringify(nextWeather)); } catch { /* cache optional */ }
      } catch { /* weather optional */ }
    }, () => {}, { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 5000 });
    return () => { disposed = true; };
  }, []);
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(now).toLocaleUpperCase("fr-FR");
  const greeting = now.getHours() < 12 ? "Bonjour" : now.getHours() < 18 ? "Bon après-midi" : "Bonsoir";
  return (
    <div className="page dashboard">
      <section className="hero-row">
        <div><p className="eyebrow">{weekday} · CENTRE DE CONTRÔLE</p><div className="hero-title"><h1>{greeting}.</h1>{weather && <span className={`weather-inline ${weather.isDay ? "day" : "night"}`} title={`Ressenti ${Math.round(weather.apparentTemperature)}°C`}><i /><b>{Math.round(weather.temperature)}°</b><span>{weatherLabel(weather.code)}</span><small>Open-Meteo</small></span>}</div><p className="muted">{sessions.length ? `${sessions.length} agent${sessions.length > 1 ? "s" : ""} actif${sessions.length > 1 ? "s" : ""} sur ce PC.` : "PC prêt. Lance premier agent."}</p></div>
        <div className="system-state"><i /><span><strong>Système opérationnel</strong><small>Connexion locale chiffrable via VPN</small></span></div>
      </section>

      <section className="metrics">
        <article className="active-agents-metric"><span className="metric-symbol green">◎</span><div><small>AGENTS ACTIFS</small><div className="active-agents-data"><strong className="active-total">{sessions.length}</strong><div className="agent-breakdown"><span><b>{codexCount}</b><em>Codex</em></span><span><b>{claudeCount}</b><em>Claude</em></span><span><b>{shellCount}</b><em>Terminal</em></span></div></div><p>{linkedProjects} projet{linkedProjects > 1 ? "s" : ""} lié{linkedProjects > 1 ? "s" : ""} · {favoriteCount} favori{favoriteCount > 1 ? "s" : ""}</p></div></article>
        <article className="quota-metric"><span className="metric-symbol blue">↗</span><div><small>QUOTAS IA</small><div className="quota-providers"><div className="quota-codex"><span>CODEX {codexPeriod}</span><div className="quota-current"><strong>{Number.isFinite(quotas.codex?.remainingPercent) ? `${quotas.codex.remainingPercent}%` : "—"}</strong><em>{formatReset(quotas.codex?.resetsAt)}</em></div>{Number.isFinite(quotas.codex?.remainingPercent) && <progress max="100" value={quotas.codex.remainingPercent} aria-label={`Quota Codex restant ${quotas.codex.remainingPercent}%`} />}</div><div className="quota-claude"><span>CLAUDE</span>{claudeWindows.length ? <div className="quota-dials">{claudeWindows.map((item) => <div className="quota-dial" key={item.label}><div className="quota-ring" style={{ "--quota": Math.max(0, Math.min(100, item.remainingPercent || 0)) }}><strong>{item.remainingPercent}%</strong></div><span>{item.label}</span><em title={formatReset(item.resetsAt)}>{formatReset(item.resetsAt).replace("Reset ", "")}</em></div>)}</div> : <div className="quota-empty"><strong>{quotas.claude?.status === "loggedOut" ? "Déconnecté" : "—"}</strong><em>{quotas.claude?.status === "loggedOut" ? "Reconnecte Claude" : "Reset inconnu"}</em></div>}</div></div></div></article>
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
        <article className="panel"><span>NOUVEAU</span><h3>Dépenses & budgets</h3><p>Capacité épargne, enveloppes et alertes mensuelles.</p><button onClick={onFinances}>Ouvrir</button></article>
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
    try {
      await onAction(module.id, action.id);
    } finally {
      setBusy(false);
    }
  }
  const latestRun = module.actions.find((action) => action.run?.state === "running")?.run || module.actions.find((action) => action.run)?.run;
  return (
    <article className="project-module" style={{ "--module-accent": module.accent }}>
      <header><span className="module-glyph">{module.glyph}</span><div><strong>{module.name}</strong><small>{module.description}</small></div><button className={`module-toggle ${module.enabled ? "enabled" : ""}`} onClick={toggle} disabled={busy} role="switch" aria-checked={module.enabled}><i /><span>{module.enabled ? "Actif" : "Arrêté"}</span></button></header>
      <div className="module-schedules">{module.schedules.map((schedule) => <ModuleSchedule key={schedule.id} moduleId={module.id} schedule={schedule} onSave={onSchedule} />)}</div>
      <div className="module-actions">{module.actions.map((action) => <button key={action.id} className={action.tone} onClick={() => actionRun(action)} disabled={busy || action.run?.state === "running"}>{action.run?.state === "running" ? "Exécution…" : action.label}</button>)}</div>
      {latestRun && latestRun.state !== "running" && <small className={`module-run ${latestRun.state}`}>{latestRun.state === "success" ? "Dernière action terminée" : `Erreur: ${latestRun.output || "échec"}`}</small>}
    </article>
  );
}

function ProjectsView({ projects, sessions, modules, moduleProposals, onOpenAgent, onNew, onEdit, onDelete, onInstallModule, onModuleToggle, onModuleAction, onModuleSchedule }) {
  return (
    <div className="page projects-page">
      <section className="hero-row"><div><p className="eyebrow">ORGANISATION</p><h1>Projets.</h1><p className="muted">Regroupe agents liés au même travail, sans imposer dossier.</p></div></section>
      <div className="projects-grid">
        {projects.map((project) => {
          const agents = sessions.filter((session) => session.projectId === project.id);
          const projectModules = modules.filter((module) => module.projectId === project.id);
          const proposals = moduleProposals.filter((module) => module.projectId === project.id);
          return (
            <article className="panel project-card" key={project.id}>
              <header><ProjectIcon project={project} /><span><strong>{project.name}</strong><small>{project.rootPath || "Dossiers propres aux agents"}</small></span><div><button onClick={() => onEdit(project.id)}>Éditer</button><button className="project-delete" onClick={() => onDelete(project)}>×</button></div></header>
              <p>{agents.length} agent{agents.length > 1 ? "s" : ""} actif{agents.length > 1 ? "s" : ""}</p>
              <div className="project-agents">
                {agents.map((session) => <button key={session.id} onClick={() => onOpenAgent(session.id)}><AgentIcon assistant={session.assistant} logoUrl={session.logoUrl} small /><span><strong>{session.favorite && <i className="favorite-star">★</i>}{session.name}</strong><small><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {assistantMeta[session.assistant]?.label} · {session.agentStatus?.label || "Disponible"}</small></span><b>›</b></button>)}
                {!agents.length && <span className="project-empty">Aucun agent rattaché.</span>}
              </div>
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
        <summary>Configuration Enable Banking <b>›</b></summary>
        <form onSubmit={saveConfig}>
          <p>Crée application gratuite, ajoute URL retour exacte, puis charge clé privée RSA PEM. Clé reste serveur; jamais renvoyée navigateur.</p>
          <label><span>Application ID</span><input value={config.appId} onChange={(event) => setConfig({ ...config, appId: event.target.value })} required autoComplete="off" placeholder="ID application" /></label>
          <label className="wide"><span>URL retour à enregistrer</span><input value={config.redirectUrl} onChange={(event) => setConfig({ ...config, redirectUrl: event.target.value })} required inputMode="url" /></label>
          <label className="wide bank-key-file"><span>Clé privée RSA (.pem)</span><input type="file" accept=".pem,.key,text/plain" onChange={readKey} required={!status?.keyStored} /><small>{config.privateKey ? "Clé chargée, prête à enregistrer" : status?.keyStored ? "Clé déjà stockée; laisse vide pour conserver" : "Clé requise"}</small></label>
          <a className="ghost bank-account-link" href="https://enablebanking.com/sign-in/" target="_blank" rel="noreferrer">Ouvrir Enable Banking</a>
          <button className="primary" disabled={busy === "config"}>{busy === "config" ? "Vérification…" : "Enregistrer et vérifier"}</button>
        </form>
      </details>
      {status?.configured && <div className="bank-toolbar"><small>{status.connections.length} banque{status.connections.length > 1 ? "s" : ""} liée{status.connections.length > 1 ? "s" : ""}</small>{status.connections.length > 0 && <button className="ghost" onClick={() => sync()} disabled={Boolean(busy)}>{busy === "sync" ? "Synchronisation…" : "Tout synchroniser"}</button>}</div>}
      <div className="bank-list">{banks.map((bank) => {
        const connection = status?.connections.find(({ bankId }) => bankId === bank.id);
        const options = institutions[bank.id] || [];
        return <article key={bank.id}><i>{bank.name[0]}</i><span><strong>{bank.name}</strong><small>{connection ? `${connection.accountCount} compte · synchro ${connection.lastSyncAt ? new Date(connection.lastSyncAt).toLocaleDateString("fr-FR") : "jamais"}` : bank.access}</small></span>{options.length > 1 && !connection && <select value={selected[bank.id] || ""} onChange={(event) => setSelected({ ...selected, [bank.id]: event.target.value })}>{options.map((option) => <option key={option.name}>{option.name}</option>)}</select>}{connection ? <div className="bank-actions"><button onClick={() => sync(bank.id)} disabled={Boolean(busy)}>Synchroniser</button><button onClick={() => disconnect(bank.id)} disabled={Boolean(busy)}>Délier</button></div> : <button onClick={() => connect(bank.id)} disabled={Boolean(busy) || !options.length}>{busy === bank.id ? "Ouverture…" : options.length ? "Lier cette banque" : "Indisponible"}</button>}</article>;
      })}</div>
    </section>
  );
}

function FinanceView({ onTransactions }) {
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const payload = await api(`/api/finance?month=${encodeURIComponent(month)}`);
      setData(payload);
      setSettings({
        ...payload.settings,
        monthlyIncome: String(payload.settings.monthlyIncome || ""),
        savingsGoal: String(payload.settings.savingsGoal || ""),
        currentSavings: String(payload.settings.currentSavings || ""),
        safetyBuffer: String(payload.settings.safetyBuffer || ""),
        budgets: Object.fromEntries(Object.entries(payload.settings.budgets).map(([id, value]) => [id, String(value || "")])),
      });
    } catch (reason) {
      setError(reason.message);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  function shiftMonth(offset) {
    const [year, value] = month.split("-").map(Number);
    const next = new Date(Date.UTC(year, value - 1 + offset, 1));
    setMonth(next.toISOString().slice(0, 7));
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
          monthlyIncome: Number(settings.monthlyIncome || 0),
          savingsGoal: Number(settings.savingsGoal || 0),
          currentSavings: Number(settings.currentSavings || 0),
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
        const suggestion = summary.categoryPlans[category.id]?.suggestedBudget || 0;
        return [category.id, String(suggestion || current.budgets[category.id] || "")];
      })),
    }));
  }

  const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  if (!data || !settings) return <div className="page finance-page"><section className="hero-row"><div><p className="eyebrow">ARGENT</p><h1>Finances.</h1><p className="muted">{error || "Chargement données locales…"}</p></div></section></div>;
  const { summary } = data;
  const confidenceLabel = { low: "provisoire", medium: "correcte", high: "solide" }[summary.dataConfidence] || "provisoire";
  return (
    <div className="page finance-page">
      <section className="hero-row finance-hero">
        <div><p className="eyebrow">ARGENT · DONNÉES LOCALES</p><h1>Dépenses.</h1><p className="muted">Objectif: épargner sans perdre vue du reste à vivre.</p></div>
        <div className="finance-hero-actions"><button className="ghost" onClick={onTransactions}>Opérations</button><div className="month-switch"><button onClick={() => shiftMonth(-1)} aria-label="Mois précédent">‹</button><strong>{monthName}</strong><button onClick={() => shiftMonth(1)} aria-label="Mois suivant">›</button></div></div>
      </section>

      {error && <p className="finance-error">{error}</p>}

      <section className="finance-metrics">
        <article className={summary.safeToSpend > 0 ? "positive safe-metric" : "negative safe-metric"}><small>ENCORE DÉPENSABLE</small><strong>{euro(summary.safeToSpend)}</strong><span>Sans toucher charges, réserve, épargne</span></article>
        <article><small>RYTHME MAX</small><strong>{euro(summary.dailyAllowance)}</strong><span>Par jour · {summary.daysRemaining} jour{summary.daysRemaining > 1 ? "s" : ""}</span></article>
        <article><small>CHARGES À VENIR</small><strong>{euro(summary.futureEssentialExpenses)}</strong><span>Essentiels estimés restants</span></article>
        <article className="positive"><small>ÉPARGNE PROTÉGÉE</small><strong>{euro(summary.protectedSavings)}</strong><span>{summary.protectedSavings < Number(settings.savingsGoal || 0) ? "Objectif réduit car irréaliste" : "Soutenable selon données"}</span></article>
      </section>

      <section className="panel spending-plan">
        <div className="panel-head"><div><h3>Calcul réaliste</h3><p>Chaque euro protégé avant dépenses libres</p></div><span className={`confidence ${summary.dataConfidence}`}>FIABILITÉ {confidenceLabel.toUpperCase()}</span></div>
        <div className="spending-plan-body">
          <div className="money-equation">
            <span><small>Revenus du mois</small><b>{euro(summary.income)}</b></span>
            <span><small>Déjà dépensé</small><b>− {euro(summary.expenses)}</b></span>
            <span><small>Charges essentielles restantes</small><b>− {euro(summary.futureEssentialExpenses)}</b></span>
            <span><small>Réserve imprévus {summary.safetyBufferAutomatic ? "auto" : "fixe"}</small><b>− {euro(summary.safetyBuffer)}</b></span>
            <span><small>Épargne soutenable protégée</small><b>− {euro(summary.protectedSavings)}</b></span>
            {summary.flexibleBudgetApplied && <span><small>Plafond budgets libres</small><b>{euro(summary.flexibleBudgetRemaining)}</b></span>}
          </div>
          <div className="month-forecast">
            <small>PROJECTION FIN DE MOIS</small><strong>{euro(summary.projectedExpenses)}</strong><span>dépenses probables</span>
            <div><b className={summary.projectedSavings >= 0 ? "positive" : "negative"}>{summary.projectedSavings >= 0 ? "+" : "−"}{euro(Math.abs(summary.projectedSavings))}</b><small>{summary.projectedSavings >= 0 ? "marge avant imprévus" : "déficit projeté"}</small></div>
            <p>{summary.historyMonths} mois historique · {summary.transactionCount} opérations ce mois</p>
          </div>
        </div>
      </section>

      <section className="finance-layout">
        <section className="panel finance-budgets">
          <div className="panel-head"><div><h3>Budgets du mois</h3><p>Réel, prévision, limite</p></div><div className="budget-head-actions"><span>{euro(summary.budgetTotal)}</span><button className="ghost" onClick={useRealisticBudgets}>Préremplir réaliste</button></div></div>
          <div className="budget-list">
            {data.categories.map((category) => {
              const spent = summary.spentByCategory[category.id] || 0;
              const budget = Number(settings.budgets[category.id] || 0);
              const plan = summary.categoryPlans[category.id];
              const limit = budget || plan.suggestedBudget;
              const ratio = limit ? Math.round((spent / limit) * 100) : 0;
              return <div className="budget-row" key={category.id}><span><strong>{category.label}{plan.essential && <em>essentiel</em>}</strong><small>{euro(spent)} réel · {euro(plan.projected)} prévu · {limit ? `${euro(limit)} limite` : "à définir"}</small></span><div><i style={{ width: `${Math.min(100, ratio)}%` }} className={ratio >= 100 ? "over" : ratio >= 80 ? "near" : ""} /></div><b>{limit ? `${ratio}%` : "—"}</b></div>;
            })}
          </div>
        </section>

        <section className="panel finance-insights">
          <div className="panel-head"><div><h3>Alertes & leviers</h3><p>Repères automatiques, pas conseil financier</p></div></div>
          <div className="insight-list">
            {summary.warnings.map((warning) => <article className={warning.tone} key={warning.id}><i /><span><strong>{warning.title}</strong><small>{warning.detail}</small></span></article>)}
            {summary.recommendations.map((recommendation, index) => <article className="tip" key={recommendation}><i>{index + 1}</i><span><strong>Optimisation</strong><small>{recommendation}</small></span></article>)}
            {!summary.warnings.length && !summary.recommendations.length && <p className="finance-empty">Ajoute revenus, budgets et dépenses pour générer analyse.</p>}
          </div>
        </section>
      </section>

      <section className="finance-forms">
        <form className="panel finance-settings" onSubmit={saveSettings}>
          <div className="panel-head"><div><h3>Plan mensuel</h3><p>Base calcul épargne</p></div><button className="primary" disabled={saving}>{saving ? "…" : "Enregistrer"}</button></div>
          <div className="finance-form-grid">
            <label><span>Revenu net mensuel</span><input type="number" min="0" step="0.01" value={settings.monthlyIncome} onChange={(event) => setSettings({ ...settings, monthlyIncome: event.target.value })} placeholder="0 €" /></label>
            <label><span>Objectif épargne / mois</span><input type="number" min="0" step="0.01" value={settings.savingsGoal} onChange={(event) => setSettings({ ...settings, savingsGoal: event.target.value })} placeholder="0 €" /></label>
            <label><span>Réserve imprévus (0 = auto)</span><input type="number" min="0" step="0.01" value={settings.safetyBuffer} onChange={(event) => setSettings({ ...settings, safetyBuffer: event.target.value })} placeholder="Auto" /></label>
            <label><span>Épargne actuelle</span><input type="number" min="0" step="0.01" value={settings.currentSavings} onChange={(event) => setSettings({ ...settings, currentSavings: event.target.value })} placeholder="0 €" /></label>
            <label><span>Fonds sécurité</span><select value={settings.emergencyMonths} onChange={(event) => setSettings({ ...settings, emergencyMonths: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6, 9, 12].map((value) => <option key={value} value={value}>{value} mois</option>)}</select></label>
          </div>
          <div className="budget-inputs">{data.categories.map((category) => <label key={category.id}><span>{category.label}</span><input type="number" min="0" step="0.01" value={settings.budgets[category.id]} onChange={(event) => setSettings({ ...settings, budgets: { ...settings.budgets, [category.id]: event.target.value } })} placeholder="Budget €" /></label>)}</div>
        </form>
      </section>
      <BankingPanel banks={data.banking.banks} month={month} onSynced={load} />
    </div>
  );
}

function FinanceTransactionsView() {
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState(null);
  const [transaction, setTransaction] = useState({ kind: "expense", amount: "", description: "", category: "food", date: today, account: "" });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setError("");
      setData(await api(`/api/finance?month=${encodeURIComponent(month)}`));
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
  const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
  return (
    <div className="page finance-page finance-operations-page">
      <section className="hero-row finance-hero"><div><p className="eyebrow">HISTORIQUE LOCAL</p><h1>Opérations.</h1><p className="muted">Saisie manuelle et imports bancaires.</p></div><div className="month-switch"><button onClick={() => shiftMonth(-1)}>‹</button><strong>{monthName}</strong><button onClick={() => shiftMonth(1)}>›</button></div></section>
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
          <div className="panel-head"><div><h3>Historique</h3><p>{data?.transactions.length || 0} opération{data?.transactions.length > 1 ? "s" : ""}</p></div></div>
          <div className="transaction-list">
            {(data?.transactions || []).map((item) => <article key={item.id}><span className={`transaction-kind ${item.kind}`}>{item.kind === "income" ? "+" : "−"}</span><span><strong>{item.description}</strong><small>{item.date.split("-").reverse().join("/")} · {item.account} · {data.categories.find(({ id }) => id === item.category)?.label || "Revenu"}</small></span><b className={item.amount >= 0 ? "income" : "expense"}>{item.amount >= 0 ? "+" : "−"}{euro(Math.abs(item.amount))}</b><button onClick={() => removeTransaction(item.id)} aria-label={`Supprimer ${item.description}`}>×</button></article>)}
            {data && !data.transactions.length && <p className="finance-empty">Aucune opération ce mois.</p>}
          </div>
        </section>
      </section>
    </div>
  );
}

function FinanceAgentView() {
  const month = new Date().toISOString().slice(0, 7);
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
      <section className="hero-row"><div><p className="eyebrow">PRÉVISIONS</p><h1>Agent finances.</h1><p className="muted">Transforme phrases en charges datées; calcul reste dépensable automatiquement.</p></div></section>
      {error && <p className="finance-error">{error}</p>}
      <section className="finance-agent-layout">
        <section className="panel finance-chat">
          <div className="panel-head"><div><h3>Discussion</h3><p>Actions locales, sans envoyer données bancaires à IA externe</p></div><span className="ready">DISPONIBLE</span></div>
          <div className="finance-chat-messages">
            {!messages.length && <article className="assistant"><strong>Agent finances</strong><p>Dis-moi une charge mensuelle, changement futur, ou demande reste dépensable.</p></article>}
            {messages.map((item) => <article className={item.role} key={item.id}><strong>{item.role === "user" ? "Toi" : "Agent finances"}</strong><p>{item.content}</p></article>)}
          </div>
          <div className="finance-prompts"><button onClick={(event) => send(event, "Chaque mois je paye 950 euros de loyer")}>Ajouter loyer</button><button onClick={(event) => send(event, "Combien je peux encore dépenser ce mois ?")}>Reste dépensable</button><button onClick={(event) => send(event, "Liste mes charges mensuelles")}>Lister charges</button></div>
          <form className="finance-chat-input" onSubmit={send}><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Chaque mois je paye…" maxLength="1000" enterKeyHint="send" /><button className="primary" disabled={sending || !message.trim()}>{sending ? "…" : "Envoyer"}</button></form>
        </section>
        <section className="panel recurring-panel">
          <div className="panel-head"><div><h3>Charges prévues</h3><p>{recurring.filter(({ endDate }) => !endDate).length} active{recurring.filter(({ endDate }) => !endDate).length > 1 ? "s" : ""}</p></div></div>
          <div className="recurring-list">{recurring.map((rule) => <article className={rule.endDate ? "ended" : ""} key={rule.id}><span><strong>{rule.description}</strong><small>Le {rule.dayOfMonth} · depuis {rule.startDate.split("-").reverse().join("/")}{rule.endDate ? ` · fin ${rule.endDate.split("-").reverse().join("/")}` : ""}</small></span><b>{euro(rule.amount)}</b>{!rule.endDate && <button onClick={() => removeRule(rule.id)} aria-label={`Supprimer ${rule.description}`}>×</button>}</article>)}{!recurring.length && <p className="finance-empty">Aucune charge. Écris première règle dans discussion.</p>}</div>
        </section>
      </section>
    </div>
  );
}

function SettingsView({ permission, onNotifications, onRefresh }) {
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
        <article><span className="setting-symbol">⌁</span><div><strong>Connexion privée</strong><small>{window.isSecureContext ? "HTTPS actif · notifications compatibles" : "Ouvre version HTTPS via VPN"}</small></div><b className={window.isSecureContext ? "setting-ok" : "setting-warn"}>{window.isSecureContext ? "ACTIF" : "REQUIS"}</b></article>
      </section>
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
  const [connected, setConnected] = useState(false);
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
    let frame = null;
    let lastHeight = 0;
    const updateHeight = () => {
      const height = Math.floor(viewport?.height || window.innerHeight);
      if (Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => document.documentElement.style.setProperty("--terminal-height", `${height}px`));
    };
    updateHeight();
    viewport?.addEventListener("resize", updateHeight);
    window.addEventListener("resize", updateHeight);
    return () => {
      viewport?.removeEventListener("resize", updateHeight);
      window.removeEventListener("resize", updateHeight);
      cancelAnimationFrame(frame);
      document.documentElement.style.removeProperty("--terminal-height");
      document.documentElement.classList.remove("terminal-open");
      document.body.classList.remove("terminal-open");
    };
  }, []);

  useEffect(() => {
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: coarsePointer,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      scrollback: 5000,
      theme: { background: "#080b0a", foreground: "#d9e0dc", cursor: "#b8ff5e", selectionBackground: "#31551f88" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalNode.current);
    terminalRef.current = terminal;
    const xtermViewport = terminalNode.current.querySelector(".xterm-viewport");
    if (coarsePointer) {
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
    let disposed = false;

    const resize = () => {
      try {
        fit.fit();
        if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      } catch { /* terminal disposed */ }
    };
    const observer = new ResizeObserver(resize);
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
    const touchStart = (event) => {
      if (!coarsePointer) return;
      const touch = event.touches[0];
      if (touch) touchRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        scrollTop: xtermViewport?.scrollTop || 0,
        lastScrollDelta: 0,
        moved: false,
        scrolling: false,
      };
    };
    const touchMove = (event) => {
      if (!coarsePointer || !touchRef.current || !event.touches[0]) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - touchRef.current.x;
      const deltaY = touch.clientY - touchRef.current.y;
      if (!touchRef.current.moved && Math.hypot(deltaX, deltaY) > 8) {
        touchRef.current.moved = true;
        touchRef.current.scrolling = Math.abs(deltaY) > Math.abs(deltaX);
      }
      if (touchRef.current.scrolling && xtermViewport) {
        event.preventDefault();
        event.stopPropagation();
        if (xtermViewport.scrollHeight > xtermViewport.clientHeight + 1) {
          xtermViewport.scrollTop = touchRef.current.scrollTop - deltaY;
        } else {
          const pendingDelta = deltaY - touchRef.current.lastScrollDelta;
          if (Math.abs(pendingDelta) >= 24 && socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              type: "scroll",
              direction: pendingDelta > 0 ? "up" : "down",
              count: Math.min(12, Math.max(1, Math.floor(Math.abs(pendingDelta) / 12))),
            }));
            touchRef.current.lastScrollDelta = deltaY;
          }
        }
      }
    };
    const touchEnd = (event) => {
      if (!coarsePointer) return;
      if (touchRef.current && !touchRef.current.moved) {
        event.preventDefault();
        event.stopPropagation();
        focusKeyboard();
      }
      touchRef.current = null;
    };
    const touchCancel = () => { touchRef.current = null; };
    terminalNode.current.addEventListener("touchstart", touchStart, { capture: true, passive: true });
    terminalNode.current.addEventListener("touchmove", touchMove, { capture: true, passive: false });
    terminalNode.current.addEventListener("touchend", touchEnd, { capture: true, passive: false });
    terminalNode.current.addEventListener("touchcancel", touchCancel, { capture: true, passive: true });
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
      socket = new WebSocket(`${protocol}//${location.host}/ws/terminal/${session.id}`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        snapBottomRef.current = true;
        setConnected(true);
        resize();
        if (!coarsePointer) terminal.focus();
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
      terminalNode.current?.removeEventListener("touchstart", touchStart, true);
      terminalNode.current?.removeEventListener("touchmove", touchMove, true);
      terminalNode.current?.removeEventListener("touchend", touchEnd, true);
      terminalNode.current?.removeEventListener("touchcancel", touchCancel, true);
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
    if (window.matchMedia("(pointer: coarse)").matches) {
      const input = keyboardRef.current;
      window.scrollTo(0, 0);
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

  async function kill() {
    if (!window.confirm(`Arrêter définitivement session « ${session.name} » ?`)) return;
    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
    onKilled();
  }

  async function migrate() {
    const target = session.assistant === "codex" ? "claude" : "codex";
    setMigrating(true);
    try {
      await api(`/api/sessions/${session.id}/migrate`, { method: "POST", body: JSON.stringify({ target }) });
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
        <div><strong>{session.name}</strong><small><i className={`agent-state-dot ${session.agentStatus?.state || "available"}`} /> {session.agentStatus?.label || "Disponible"} · {connected ? "Connecté" : "Déconnecté"} · {session.cwd}</small></div>
        <div className="terminal-actions">
          <span className="usage-pill" title="Contexte restant">{session.usage?.estimated ? "~" : ""}{formatTokens(session.usage?.remainingTokens)} · {session.usage?.contextPercent ?? "—"}%</span>
          {["codex", "claude"].includes(session.assistant) && <button className="migrate-link" onClick={migrate} disabled={migrating}>{migrating ? "Récap…" : `→ ${session.assistant === "codex" ? "Claude" : "Codex"}`}</button>}
          {session.managed && <button className="danger-link" onClick={kill} aria-label="Arrêter agent" title="Arrêter">⏻</button>}
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
          onFocus={() => setKeyboardActive(true)}
          onBlur={() => setKeyboardActive(false)}
          aria-label="Clavier terminal"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck="false"
          enterKeyHint="enter"
          autoFocus={new URLSearchParams(location.search).get("reply") === "1"}
        />
        <div className="key-row">
          <label className={`upload-key ${uploading ? "disabled" : ""}`} aria-label="Joindre photo ou fichier">
            <input type="file" onChange={attachFile} disabled={uploading} />
            <span>{uploading ? "…" : "＋"}</span>
          </label>
          <button className="copy-key" onClick={copyTerminal}>Copier</button>
          <button className="paste-key" onClick={pasteClipboard}>Coller</button>
          <button className={ctrl ? "selected" : ""} onClick={() => toggleModifier("ctrl")}>Ctrl</button>
          <button className={alt ? "selected" : ""} onClick={() => toggleModifier("alt")}>Alt</button>
          <button onClick={() => pressSpecial("Escape")}>Esc</button>
          <button onClick={() => pressSpecial("Tab")}>Tab</button>
          <button onClick={() => pressSpecial("ArrowLeft")}>←</button>
          <button onClick={() => pressSpecial("ArrowUp")}>↑</button>
          <button onClick={() => pressSpecial("ArrowDown")}>↓</button>
          <button onClick={() => pressSpecial("ArrowRight")}>→</button>
          <button className="enter-key" onClick={() => pressSpecial("Enter")}>Entrée</button>
        </div>
      </div>
    </div>
  );
}

function NewSessionModal({ projects, onClose, onCreated }) {
  const [assistant, setAssistant] = useState("codex");
  const [name, setName] = useState("");
  const [yolo, setYolo] = useState(false);
  const [projectLogo, setProjectLogo] = useState(true);
  const [projectId, setProjectId] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api("/api/sessions", { method: "POST", body: JSON.stringify({ assistant, name, yolo, projectLogo, projectId: projectId || null, favorite }) });
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
          <p className="form-hint">Dossier de travail automatique. Projet sert au classement, sans dossier racine requis.</p>
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
  const [yolo, setYolo] = useState(Boolean(session.yolo));
  const [projectLogo, setProjectLogo] = useState(Boolean(session.projectLogo));
  const [projectId, setProjectId] = useState(session.projectId || "");
  const [favorite, setFavorite] = useState(Boolean(session.favorite));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api(`/api/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ name, yolo, projectLogo, projectId: projectId || null, favorite }) });
      onSaved(result.session);
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
          <label htmlFor="edit-project">Projet</label>
          <select id="edit-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Sans projet</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select>
          {session.assistant !== "shell" && <label className="checkbox-option"><input type="checkbox" checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span><strong>Sans confirmation</strong><small>{session.assistant === "codex" ? "Codex --yolo" : "Claude --dangerously-skip-permissions"}</small></span></label>}
          <label className="checkbox-option"><input type="checkbox" checked={projectLogo} onChange={(event) => setProjectLogo(event.target.checked)} /><span><strong>Logo projet auto</strong><small>Remplace icône agent si logo trouvé</small></span></label>
          <label className="checkbox-option"><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} /><span><strong>Agent favori</strong><small>Affiché avant autres agents</small></span></label>
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api(project ? `/api/projects/${project.id}` : "/api/projects", { method: project ? "PATCH" : "POST", body: JSON.stringify({ name, rootPath: null }) });
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
          <p className="form-hint">Agents peuvent utiliser dossiers différents. Logo repris depuis premier agent rattaché.</p>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions"><button type="button" className="ghost" onClick={onClose}>Annuler</button><button className="primary" disabled={loading}>{loading ? "Enregistrement…" : "Enregistrer"}</button></div>
        </form>
      </section>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [modules, setModules] = useState([]);
  const [moduleProposals, setModuleProposals] = useState([]);
  const [quotas, setQuotas] = useState({ codex: null, claude: null });
  const [activeId, setActiveId] = useState(() => new URLSearchParams(location.search).get("session"));
  const [view, setView] = useState(() => ["projects", "finances", "finance-transactions", "finance-agent", "settings"].includes(new URLSearchParams(location.search).get("view")) ? new URLSearchParams(location.search).get("view") : "dashboard");
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
          location.replace(`/?v=${encodeURIComponent(version)}`);
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
    const receiveUpdate = (event) => event.data?.type === "NOYAU_UPDATE" && refresh();
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
    location.replace(`/?view=settings&v=${encodeURIComponent(version)}&refresh=${Date.now()}`);
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
      await api(path, options);
      await refresh();
    } catch (error) {
      window.alert(error.message);
    }
  }

  const installModule = (id) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/install`, { method: "POST" });
  const toggleModule = (id, enabled) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/toggle`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  const runModuleAction = (id, actionId) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`, { method: "POST" });
  const saveModuleSchedule = (id, scheduleId, time) => moduleRequest(`/api/modules/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: JSON.stringify({ time }) });

  return (
    <div className="app-shell">
      <Sidebar sessions={orderedSessions} activeId={activeId} view={view} onOpen={setActiveId} onView={setView} onNew={() => setModal(true)} onLogout={logout} open={menu} onClose={() => setMenu(false)} />
      {menu && <button className="menu-backdrop" onClick={() => setMenu(false)} aria-label="Fermer menu" />}
      <main className="content">
        {!active ? (
          <>
            {view === "dashboard" && <><Header title="Accueil" subtitle="Vue générale" onMenu={() => setMenu(true)} onAction={() => setModal(true)} /><Dashboard sessions={orderedSessions} projects={projects} quotas={quotas} onOpen={setActiveId} onNew={() => setModal(true)} onEdit={setEditingId} onFavorite={toggleFavorite} onProjects={() => setView("projects")} onFinances={() => setView("finances")} /></>}
            {view === "projects" && <><Header title="Projets" subtitle="Agents et modules" onMenu={() => setMenu(true)} actionLabel="Nouveau projet" onAction={() => setProjectModalId("new")} /><ProjectsView projects={projects} sessions={orderedSessions} modules={modules} moduleProposals={moduleProposals} onOpenAgent={setActiveId} onNew={() => setProjectModalId("new")} onEdit={setProjectModalId} onDelete={deleteProject} onInstallModule={installModule} onModuleToggle={toggleModule} onModuleAction={runModuleAction} onModuleSchedule={saveModuleSchedule} /></>}
            {view === "finances" && <><Header title="Dépenses" subtitle="Budgets et épargne" onMenu={() => setMenu(true)} /><FinanceView onTransactions={() => setView("finance-transactions")} /></>}
            {view === "finance-transactions" && <><Header title="Opérations" subtitle="Saisie et historique" onMenu={() => setMenu(true)} /><FinanceTransactionsView /></>}
            {view === "finance-agent" && <><Header title="Agent finances" subtitle="Charges et prévisions" onMenu={() => setMenu(true)} /><FinanceAgentView /></>}
            {view === "settings" && <><Header title="Réglages" subtitle="Application" onMenu={() => setMenu(true)} /><SettingsView permission={permission} onNotifications={enableNotifications} onRefresh={reloadLatest} /></>}
          </>
        ) : (
          <TerminalView session={active} onBack={() => setActiveId(null)} onKilled={() => { setActiveId(null); refresh(); }} onMigrated={(id) => { setActiveId(id); refresh(); }} onRefresh={refresh} />
        )}
      </main>
      {modal && <NewSessionModal projects={projects} onClose={() => setModal(false)} onCreated={(session) => { setModal(false); setActiveId(session.id); refresh(); }} />}
      {editingSession && <EditSessionModal session={editingSession} projects={projects} onClose={() => setEditingId(null)} onSaved={() => { setEditingId(null); refresh(); }} />}
      {projectModalId && <ProjectModal project={editingProject} onClose={() => setProjectModalId(null)} onSaved={() => { setProjectModalId(null); refresh(); }} />}
    </div>
  );
}

window.__noyauMounted = true;
createRoot(document.getElementById("root")).render(<App />);
