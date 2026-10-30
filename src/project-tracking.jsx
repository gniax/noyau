import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./project-tracking.css";

const COLUMNS = [
  { id: "waiting", label: "Décision fondateur" },
  { id: "inProgress", label: "En cours" },
  { id: "planned", label: "Prévu" },
  { id: "done", label: "Fait" },
];
const REFRESH_MS = 60_000;

function ago(value) {
  if (!value) return "jamais";
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function shortDate(value) {
  if (!value) return "";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function reportKind(report) {
  if (report.url) return "lien";
  const ext = report.file.split(".").pop().toLowerCase();
  return ext === "htm" ? "html" : ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? "image" : ext;
}

// Decision Go / Non: une note optionnelle part avec la notification a l'agent proprietaire.
function DecisionButtons({ projectId, boardId, item, api, onDone }) {
  const [busy, setBusy] = useState("");
  async function decide(decision) {
    const label = decision === "go" ? "GO" : "NON";
    const note = window.prompt(`${label} pour « ${item.title} ».\nNote pour l'agent (facultatif) :`, "");
    if (note === null) return;
    setBusy(decision);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/tracking/${encodeURIComponent(boardId)}/items/${encodeURIComponent(item.id)}/decision`, { method: "POST", body: JSON.stringify({ decision, note }) });
      onDone?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <span className="tracking-decide">
      <button type="button" className="go" disabled={Boolean(busy)} onClick={() => decide("go")}>{busy === "go" ? "…" : "Go"}</button>
      <button type="button" className="no" disabled={Boolean(busy)} onClick={() => decide("no")}>{busy === "no" ? "…" : "Non"}</button>
    </span>
  );
}

function ItemCard({ item, projectId, boardId, api, onChanged }) {
  const [open, setOpen] = useState(false);
  return (
    <article className={`tracking-item ${item.column}`}>
      <button type="button" className="tracking-item-head" onClick={() => setOpen((value) => !value)} aria-expanded={open} disabled={!item.detail}>
        <strong>{item.title}</strong>
        <small>
          {item.date && <time>{shortDate(item.date)}</time>}
          {item.decision && <b className={`tracking-verdict ${item.decision.value}`}>{item.decision.value === "go" ? "Go" : "Non"} · {shortDate(item.decision.at)}</b>}
          <span className="tracking-id">#{item.id}</span>
        </small>
      </button>
      {item.detail && <p className={open ? "open" : ""}>{item.detail}</p>}
      {item.decision?.note && <p className="tracking-note">Note : {item.decision.note}</p>}
      {(item.link || item.column === "waiting") && (
        <footer>
          {item.link && <a href={item.link} target="_blank" rel="noreferrer">Ouvrir ↗</a>}
          {item.column === "waiting" && <DecisionButtons projectId={projectId} boardId={boardId} item={item} api={api} onDone={onChanged} />}
        </footer>
      )}
    </article>
  );
}

function ReportViewer({ report, src, onClose }) {
  const kind = reportKind(report);
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop tracking-report-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="tracking-report-viewer" role="dialog" aria-modal="true" aria-label={report.title}>
        <header><strong>{report.title}</strong><a href={src} target="_blank" rel="noreferrer">Nouvel onglet ↗</a><button type="button" onClick={onClose} aria-label="Fermer">×</button></header>
        {kind === "image" ? <img src={src} alt={report.title} /> : <iframe title={report.title} src={src} sandbox={kind === "html" ? "" : undefined} />}
      </section>
    </div>,
    document.body,
  );
}

function BoardModal({ projectId, boardId, api, onClose, onOpenAgent, onChanged }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null);
  const [mobileColumn, setMobileColumn] = useState("waiting");
  const base = `/api/projects/${encodeURIComponent(projectId)}/tracking/${encodeURIComponent(boardId)}`;
  const load = useCallback(() => api(base).then((next) => { setBoard(next); setError(""); }).catch((reason) => setError(reason.message)), [api, base]);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !viewing) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);
  const changed = () => { load(); onChanged?.(); };
  const items = board?.items || [];
  const reports = [...(board?.reports || [])].sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
  const fileUrl = (report) => report.url || `${base}/files/${encodeURIComponent(report.file)}`;
  return createPortal(
    <div className="modal-backdrop tracking-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="tracking-modal" role="dialog" aria-modal="true" aria-label={board?.title || "Suivi"}>
        <header className="tracking-modal-head">
          <div>
            <h3>{board?.title || boardId}</h3>
            <small>
              {board?.agentName && (board.agentId && onOpenAgent ? <button type="button" className="tracking-agent" onClick={() => { onClose(); onOpenAgent(board.agentId); }}>{board.agentName} ›</button> : <span>{board.agentName}</span>)}
              <span>mis à jour {ago(board?.updatedAt)}</span>
            </small>
          </div>
          <button type="button" className="tracking-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="tracking-modal-body">
          {error && <p className="tracking-empty">{error}</p>}
          {!board && !error && <p className="tracking-empty">Chargement…</p>}
          {board?.objective && <p className="tracking-objective">{board.objective}</p>}
          {board?.kpis.length > 0 && (
            <div className="tracking-kpis">
              {board.kpis.map((kpi) => <div key={kpi.label} title={kpi.note || undefined}><small>{kpi.label}</small><strong>{kpi.value}</strong>{kpi.note && <em>{kpi.note}</em>}</div>)}
            </div>
          )}
          {board && (
            <>
              <nav className="tracking-tabs" aria-label="Colonnes">
                {COLUMNS.map((column) => {
                  const count = items.filter((item) => item.column === column.id).length;
                  return <button type="button" key={column.id} className={`${mobileColumn === column.id ? "active" : ""} ${column.id}`} onClick={() => setMobileColumn(column.id)}>{column.label}<b>{count}</b></button>;
                })}
              </nav>
              <div className="tracking-columns">
                {COLUMNS.map((column) => {
                  const list = items.filter((item) => item.column === column.id)
                    .sort((a, b) => (column.id === "done" ? Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0) : String(a.date || "9").localeCompare(String(b.date || "9"))));
                  return (
                    <section key={column.id} className={`tracking-column ${column.id} ${mobileColumn === column.id ? "mobile-active" : ""}`}>
                      <h4>{column.label}<b>{list.length}</b></h4>
                      {list.map((item) => <ItemCard key={item.id} item={item} projectId={projectId} boardId={boardId} api={api} onChanged={changed} />)}
                      {!list.length && <p className="tracking-empty">Rien ici.</p>}
                    </section>
                  );
                })}
              </div>
              <section className="tracking-reports">
                <h4>Rapports<b>{reports.length}</b></h4>
                {reports.map((report) => {
                  const kind = reportKind(report);
                  return report.url
                    ? <a key={report.id} className="tracking-report" href={report.url} target="_blank" rel="noreferrer"><span className="kind">{kind}</span><strong>{report.title}</strong><time>{shortDate(report.date)}</time><b>↗</b></a>
                    : <button key={report.id} type="button" className="tracking-report" onClick={() => setViewing(report)}><span className="kind">{kind}</span><strong>{report.title}</strong><time>{shortDate(report.date)}</time><b>›</b></button>;
                })}
                {!reports.length && <p className="tracking-empty">Aucun rapport.</p>}
              </section>
            </>
          )}
        </div>
      </section>
      {viewing && <ReportViewer report={viewing} src={fileUrl(viewing)} onClose={() => setViewing(null)} />}
    </div>,
    document.body,
  );
}

function readOpen(key) {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

export default function ProjectTracking({ project, api, onOpenAgent, storageKey, publications = null }) {
  const [data, setData] = useState(null);
  // Repliee par defaut; l'etat ouvert/ferme est memorise par profil et par projet.
  const [open, setOpen] = useState(() => (storageKey ? readOpen(storageKey) : false));
  const toggle = (event) => {
    const next = event.currentTarget.open;
    setOpen(next);
    try { if (storageKey) localStorage.setItem(storageKey, next ? "1" : "0"); } catch {}
  };
  const [error, setError] = useState("");
  const [openBoard, setOpenBoard] = useState(null);
  const load = useCallback(() => api(`/api/projects/${encodeURIComponent(project.id)}/tracking`)
    .then((next) => { setData(next); setError(""); })
    .catch((reason) => setError(reason.message)), [api, project.id]);
  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  const boards = data?.boards || [];
  const waiting = data?.waiting || [];
  if (!boards.length && !publications && !error) return null;
  const parts = [boards.length ? `${boards.length} tableau${boards.length > 1 ? "x" : ""}` : null, publications ? "publications" : null].filter(Boolean).join(" · ");
  return (
    <details className="project-modules project-tracking" open={open} onToggle={toggle}>
      <summary>
        <span>Planification</span>
        <small>{waiting.length > 0 && <em className="tracking-pending">{waiting.length} décision{waiting.length > 1 ? "s" : ""} à prendre</em>}{parts}</small>
        <b>›</b>
      </summary>
      <div className="tracking-body">
        {error && <p className="tracking-empty">{error}</p>}
        {waiting.length > 0 && (
          <section className="tracking-waiting">
            <h4>Décisions en attente<b>{waiting.length}</b></h4>
            {waiting.map((item) => (
              <article key={`${item.boardId}-${item.id}`} className="tracking-waiting-item">
                <div>
                  <button type="button" className="tracking-waiting-board" onClick={() => setOpenBoard(item.boardId)}>{item.boardTitle}{item.agentName ? ` · ${item.agentName}` : ""}</button>
                  <strong>{item.title}</strong>
                  {item.detail && <p title="Afficher tout" onClick={(event) => event.currentTarget.classList.toggle("open")}>{item.detail}</p>}
                  {item.link && <a href={item.link} target="_blank" rel="noreferrer">Ouvrir ↗</a>}
                </div>
                <DecisionButtons projectId={project.id} boardId={item.boardId} item={item} api={api} onDone={load} />
              </article>
            ))}
          </section>
        )}
        <section className="tracking-boards">
          {publications}
          {boards.map((board) => (
            <button type="button" key={board.id} className="tracking-board" onClick={() => setOpenBoard(board.id)}>
              <span className="tracking-board-title"><strong>{board.title}</strong><small>{board.agentName ? `${board.agentName} · ` : ""}{ago(board.updatedAt)}</small></span>
              <span className="tracking-counts">
                {COLUMNS.map((column) => <i key={column.id} className={`${column.id} ${board.counts[column.id] ? "" : "zero"}`} title={column.label}>{board.counts[column.id]}</i>)}
              </span>
              <b>›</b>
            </button>
          ))}
          {boards.length > 0 && <p className="tracking-legend">{COLUMNS.map((column) => <span key={column.id} className={column.id}>{column.label}</span>)}</p>}
        </section>
      </div>
      {openBoard && <BoardModal projectId={project.id} boardId={openBoard} api={api} onOpenAgent={onOpenAgent} onChanged={load} onClose={() => setOpenBoard(null)} />}
    </details>
  );
}
