import React, { useEffect, useState } from "react";
import { AppIcon } from "./app-icon.jsx";
import { tr, LOCALE } from "./i18n.js";

const LEVELS = ["eco", "normal", "max"];
const LEVEL_LABELS = { eco: () => tr("Économe"), normal: () => tr("Normal"), max: () => tr("Maximum") };
const PROVIDERS = [["claude", "Claude"], ["codex", "Codex"]];
const CHECKS = [[0, () => tr("Désactivé")], [60, () => tr("Toutes les heures")], [360, () => tr("Toutes les 6 h")], [1440, () => tr("Une fois par jour")]];

const formatTokens = (value) => {
  const tokens = Number(value) || 0;
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(1)} G`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)} M`;
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)} k`;
  return String(tokens);
};
const formatTime = (at) => new Date(at).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function modelLabel(assistant, level) {
  if (assistant === "codex") return { eco: tr("effort bas"), normal: tr("effort moyen"), max: tr("effort élevé") }[level];
  return { eco: "Haiku", normal: "Sonnet", max: "Opus" }[level];
}

function stateOf(autonomy) {
  if (autonomy.keepAliveExhausted) return { tone: "bad", label: tr("Relance abandonnée") };
  if (autonomy.paused) return { tone: "off", label: tr("En pause") };
  if (autonomy.held?.reason === "quota") return { tone: "warn", label: tr("Limite atteinte, incident en attente") };
  if (autonomy.held?.reason === "hourly") return { tone: "warn", label: tr("Plafond de réveils atteint, incident en attente") };
  if (autonomy.held?.reason === "busy") return { tone: "warn", label: tr("Agent occupé, incident en attente") };
  if (autonomy.activeIncidents) return { tone: "bad", label: tr(autonomy.activeIncidents > 1 ? "{0} incidents ouverts" : "{0} incident ouvert", autonomy.activeIncidents) };
  if (!autonomy.watching.projects && !autonomy.watching.units) return { tone: "warn", label: tr("Rien à surveiller") };
  return { tone: "ok", label: tr("Surveille") };
}

const REASONS = {
  "no-quota": () => tr("quota hebdo non relevé"),
  "stale-quota": () => tr("relevé de quota trop ancien"),
  "window-young": () => tr("semaine à peine commencée"),
  "low-usage": () => tr("trop peu de consommation cette semaine"),
  "no-tokens": () => tr("aucun token mesuré cette semaine"),
};

function EstimateLine({ estimate, assistant }) {
  if (!estimate || estimate.status === "pending") return <span className="autonomy-estimate muted">{tr("Estimation en cours de calcul…")}</span>;
  const measured = estimate.measured || {};
  const hours = Math.floor(measured.hours || 0);
  const detail = tr("{0} tokens mesurés sur {1} h, {2} réponses.", formatTokens(measured.tokens), hours, measured.messages || 0);
  if (estimate.status === "insufficient") {
    const need = estimate.reason === "observation" ? tr("{0} h d’observation sur {1}", hours, estimate.policy?.minObservedHours) : tr("{0} réponses sur {1}", measured.messages || 0, estimate.policy?.minMessages);
    return <span className="autonomy-estimate muted" title={detail}>{tr("Estimation : données insuffisantes ({0})", need)}</span>;
  }
  const explanation = [
    detail,
    tr("Projection : taux observé × 7 jours × marge de prudence ×{0}, soit {1} tokens par semaine.", estimate.margin, formatTokens(estimate.projectedTokens)),
    tr("Rendement calculé sur la consommation réelle de cette semaine et le % hebdo du fournisseur, en retenant la lecture la plus défavorable du cache."),
    tr("La marge est un choix de prudence, pas une mesure. L’autre IA suppose la même charge de travail."),
  ].join("\n");
  return <span className="autonomy-estimate" title={explanation}>
    <span className="autonomy-estimate-label">{tr("Estimation hebdo")}</span>
    {PROVIDERS.map(([id, name]) => {
      const value = estimate.providers?.[id];
      const reason = value?.reason ? REASONS[value.reason]?.() || value.reason : null;
      return <span key={id} className={`autonomy-estimate-chip${id === assistant ? " current" : ""}${value?.percent > 100 ? " over" : ""}`} title={reason || undefined}>
        {name} {value?.percent === null || value?.percent === undefined ? tr("données insuffisantes") : `~${value.percent} %`}
      </span>;
    })}
  </span>;
}

function WatchPanel({ autonomy, api, onPatch, disabled, sessionProjectId }) {
  const [projects, setProjects] = useState(null);
  const [unit, setUnit] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api("/api/projects").then((result) => { if (active) setProjects(result.projects || []); }).catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [api]);
  const watch = autonomy.watch || { projectIds: [], units: [] };
  const save = (next) => onPatch({ watch: { ...watch, ...next } }).catch((reason) => setError(reason.message));
  const others = (projects || []).filter((project) => project.id !== sessionProjectId);
  function addUnit(event) {
    event.preventDefault();
    const name = unit.trim();
    if (!name) return;
    if (!/^[\w@.\\-]+\.(service|timer)$/.test(name)) { setError(tr("Nom attendu : exemple.service ou exemple.timer")); return; }
    setError("");
    setUnit("");
    save({ units: [...new Set([...watch.units, name])] });
  }
  return <div className="autonomy-watch">
    <p>{sessionProjectId ? tr("Modules, services, timers et crons du projet sont surveillés. Tu peux en rattacher d’autres.") : tr("Hors projet, seul ce qui est rattaché ici est surveillé.")}</p>
    {others.length > 0 && <div className="autonomy-watch-projects" role="group" aria-label={tr("Projets surveillés")}>
      {others.map((project) => {
        const on = watch.projectIds.includes(project.id);
        return <label key={project.id} className={on ? "on" : ""}><input type="checkbox" checked={on} disabled={disabled} onChange={() => save({ projectIds: on ? watch.projectIds.filter((id) => id !== project.id) : [...watch.projectIds, project.id] })}/>{project.name}</label>;
      })}
    </div>}
    <form className="autonomy-watch-unit" onSubmit={addUnit}>
      <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={tr("Unité systemd, ex. sauvegarde.service")} aria-label={tr("Unité systemd à surveiller")} disabled={disabled} spellCheck="false" autoCapitalize="off"/>
      <button type="submit" disabled={disabled || !unit.trim()} title={tr("Rattacher cette unité")} aria-label={tr("Rattacher cette unité")}><AppIcon name="plus" size={14}/></button>
    </form>
    {watch.units.length > 0 && <ul className="autonomy-watch-units">
      {watch.units.map((name) => <li key={name}><code>{name}</code><button type="button" disabled={disabled} onClick={() => save({ units: watch.units.filter((item) => item !== name) })} title={tr("Retirer {0}", name)} aria-label={tr("Retirer {0}", name)}><AppIcon name="close" size={12}/></button></li>)}
    </ul>}
    {error && <p className="autonomy-error" role="alert">{error}</p>}
    <label className="autonomy-check-select">
      <span>{tr("Contrôle périodique (consomme des tokens sans incident)")}</span>
      <select value={autonomy.checkMinutes} disabled={disabled} onChange={(event) => onPatch({ checkMinutes: Number(event.target.value) }).catch((reason) => setError(reason.message))}>
        {!CHECKS.some(([value]) => value === autonomy.checkMinutes) && <option value={autonomy.checkMinutes}>{tr("Toutes les {0} min", autonomy.checkMinutes)}</option>}
        {CHECKS.map(([value, label]) => <option value={value} key={value}>{label()}</option>)}
      </select>
    </label>
  </div>;
}

export function AutonomyBanner({ session, autonomy, api, onChange }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shownLevel = level ?? autonomy.level;
  const disabled = session.canEdit === false;
  const state = stateOf(autonomy);

  async function patch(body) {
    const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/autonomy`, { method: "PATCH", body: JSON.stringify(body) });
    onChange(result.autonomy);
    return result;
  }
  async function commitLevel(next) {
    setLevel(null);
    if (next === autonomy.level) return;
    setError("");
    try { await patch({ level: next }); } catch (reason) { setError(reason.message); }
  }
  async function togglePause() {
    setBusy(true);
    setError("");
    try { await patch({ paused: !autonomy.paused }); } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }
  const last = autonomy.lastIncident;
  return <section className={`autonomy-banner tone-${state.tone}`} aria-label={tr("Agent autonome")}>
    <div className="autonomy-row">
      <span className="autonomy-state" role="status"><i aria-hidden="true"/>{state.label}</span>
      <label className="autonomy-level" title={tr("Modèle ou effort de l’agent. Le changement relance l’agent sur la même conversation, une fois son tour terminé.")}>
        <span className="autonomy-level-name">{tr("Intelligence")}</span>
        <input type="range" min="0" max="2" step="1" value={LEVELS.indexOf(shownLevel)} disabled={disabled}
          aria-valuetext={LEVEL_LABELS[shownLevel]()}
          aria-label={tr("Niveau d’intelligence")}
          onChange={(event) => setLevel(LEVELS[Number(event.target.value)])}
          onPointerUp={(event) => commitLevel(LEVELS[Number(event.currentTarget.value)])}
          onKeyUp={(event) => commitLevel(LEVELS[Number(event.currentTarget.value)])}/>
        <b>{LEVEL_LABELS[shownLevel]()}</b><small>{modelLabel(autonomy.assistant, shownLevel)}</small>
      </label>
      {autonomy.levelPending && !level && <span className="autonomy-pending">{tr("Appliqué à la fin du tour")}</span>}
      <span className="autonomy-actions">
        <button type="button" className={autonomy.paused ? "resume" : ""} onClick={togglePause} disabled={busy || disabled} title={autonomy.paused ? tr("Reprendre la surveillance et les réveils") : tr("Plus aucun réveil automatique. Le tour en cours se termine, le bouton Arrêter l’interrompt.")}>
          <AppIcon name={autonomy.paused ? "play" : "pause"} size={14}/><span>{autonomy.paused ? tr("Reprendre") : tr("Pause")}</span>
        </button>
        <button type="button" className="autonomy-more" aria-expanded={open} onClick={() => setOpen((value) => !value)} title={tr("Surveillance")} aria-label={tr("Surveillance")}><AppIcon name="settings" size={14}/></button>
      </span>
    </div>
    <div className="autonomy-row autonomy-details">
      <EstimateLine estimate={autonomy.estimate} assistant={autonomy.assistant}/>
      {last
        ? <span className="autonomy-last" title={last.title}>{tr("Dernier incident")} · {last.resolved ? tr("résolu") : tr("en cours")} · {formatTime(last.at)}{last.count > 1 ? ` · +${last.count - 1}` : ""}</span>
        : autonomy.firstActive ? <span className="autonomy-last" title={autonomy.firstActive}>{autonomy.firstActive}</span>
        : <span className="autonomy-last muted">{tr("Aucun incident traité")}</span>}
    </div>
    {(error || autonomy.lastError) && <p className="autonomy-error" role="alert">{error || autonomy.lastError}</p>}
    {open && <WatchPanel autonomy={autonomy} api={api} onPatch={patch} disabled={disabled} sessionProjectId={session.projectId || null}/>}
  </section>;
}
