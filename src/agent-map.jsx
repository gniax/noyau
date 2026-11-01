import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY } from "d3-force";
import "./agent-map.css";
import { tr, LOCALE } from "./i18n.js";

const REFRESH_MS = 30_000;
const EXCHANGES_REFRESH_MS = 5_000;
const PACKET_MS = 1_700;
const STORAGE_KEY = "noyau.map";
const TYPES = [
  { id: "agent", label: tr("Agents"), tone: "agent" },
  { id: "service", label: tr("Services"), tone: "service", includes: ["service"] },
  { id: "timer", label: tr("Timers · cron"), tone: "timer", includes: ["timer", "cron"] },
  { id: "module", label: tr("Modules"), tone: "module" },
  { id: "api", label: "APIs", tone: "api" },
];
const STATUS_LABELS = { ok: "OK", run: tr("En cours"), err: tr("Erreur"), stop: tr("Arrêté"), unknown: tr("Inconnu") };
const TYPE_LABELS = { founder: tr("Fondateur"), agent: tr("Agent"), service: tr("Service"), timer: tr("Timer systemd"), cron: tr("Tâche cron"), module: tr("Module Noyau"), api: tr("API externe"), script: tr("Script") };
const ZONE_LABELS = { diffusion: tr("Diffusion · social"), prod: tr("Production"), infra: tr("Infra · ce PC"), external: "APIs externes" };
const ASSISTANT_LABELS = { claude: tr("Claude"), codex: tr("Codex"), antigravity: tr("Antigravity"), "claude-design": tr("Claude Design") };
const LINK_LABELS = { message: "messages", founder: "demandes", created: tr("a créé"), calls: "appelle", triggers: tr("déclenche"), controls: "pilote", declares: tr("héberge") };
const PRIORITY = { founder: 0, agent: 1, module: 2, service: 3, timer: 4, cron: 4, api: 5, script: 5 };

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* stockage indisponible */ }
}

function typeGroup(type) {
  if (type === "cron") return "timer";
  if (type === "script") return "service";
  return type;
}

function nodeRadius(node) {
  if (node.type === "founder") return 19;
  const boost = Math.sqrt(Math.max(0, node.activity || 0));
  if (node.type === "agent") return 10 + Math.min(13, boost * 2);
  if (node.type === "module") return 11 + Math.min(5, boost);
  if (node.type === "api") return 7 + Math.min(6, boost * 1.2);
  return 7 + Math.min(7, boost * 1.3);
}

function initials(label) {
  const words = String(label || "?").replace(/^Atlas\s*·\s*/i, "").split(/[\s·\-_]+/).filter(Boolean);
  return ((words[0]?.[0] || "?") + (words[1]?.[0] || words[0]?.[1] || "")).toUpperCase();
}

function shortLabel(label, max = 26) {
  const clean = String(label || "").replace(/^Atlas\s*·\s*/, "");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Bulles en texte brut: le markdown des réponses d'agents est aplati.
function plainText(value) {
  return String(value || "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1");
}

function duration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 5_400_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function dayTime(value) {
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? timeOf(value) : `${date.toLocaleDateString(LOCALE, { weekday: "short", day: "numeric" })} ${timeOf(value)}`;
}

function timeOf(value) {
  if (!value) return "—";
  const date = new Date(value);
  return date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}

function dayOf(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return tr("Aujourd'hui");
  if (date.toDateString() === yesterday.toDateString()) return tr("Hier");
  return date.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "short" });
}

function relative(value) {
  if (!value) return "—";
  const diff = Date.parse(value) - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : abs < 172_800_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.round(abs / 86_400_000), "j"];
  if (abs < 60_000) return diff > 0 ? tr("dans un instant") : tr("à l'instant");
  return diff > 0 ? tr("dans {0} {1}", unit[0], unit[1]) : tr("il y a {0} {1}", unit[0], unit[1]);
}

function zoneAnchors(width, height) {
  const sx = width / 2;
  const sy = height / 2;
  return {
    diffusion: [-0.66 * sx, 0.06 * sy],
    prod: [0.58 * sx, -0.5 * sy],
    infra: [0.6 * sx, 0.52 * sy],
  };
}

// Disposition: fondateur au centre, agents en anneau, zones en secteurs, APIs en orbite extérieure.
function computeLayout(nodes, links, width, height, previous) {
  const anchors = zoneAnchors(width, height);
  const unit = Math.min(width, height) / 2;
  const simNodes = nodes.map((node) => {
    const old = previous.get(node.id);
    const anchor = anchors[node.zone];
    // Graine stable par id: même carte d'un chargement à l'autre.
    let seed = [...node.id].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);
    const jitter = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 4294967296 - 0.5) * 40;
    };
    return {
      ...node,
      r: nodeRadius(node),
      x: old?.x ?? (anchor ? anchor[0] + jitter() : jitter()),
      y: old?.y ?? (anchor ? anchor[1] + jitter() : jitter()),
      ...(node.type === "founder" ? { fx: 0, fy: 0 } : {}),
    };
  });
  const ids = new Set(simNodes.map((node) => node.id));
  const simLinks = links.filter((link) => ids.has(link.source) && ids.has(link.target)).map((link) => ({ ...link }));
  const outer = Math.min(width * 0.47, unit * 1.25);
  const simulation = forceSimulation(simNodes)
    .force("link", forceLink(simLinks).id((node) => node.id).distance((link) => 34 + link.source.r + link.target.r).strength((link) => (link.kind === "founder" ? 0.04 : link.kind === "created" ? 0.08 : 0.22)))
    .force("charge", forceManyBody().strength((node) => -60 - node.r * 9).distanceMax(unit * 1.4))
    .force("agents", forceRadial(unit * 0.42, 0, 0).strength((node) => (node.type === "agent" ? 0.5 : 0)))
    .force("external", forceRadial(outer, 0, 0).strength((node) => (node.zone === "external" ? 0.35 : 0)))
    .force("zoneX", forceX((node) => anchors[node.zone]?.[0] || 0).strength((node) => (anchors[node.zone] ? 0.16 : 0)))
    .force("zoneY", forceY((node) => anchors[node.zone]?.[1] || 0).strength((node) => (anchors[node.zone] ? 0.16 : 0)))
    .force("collide", forceCollide((node) => node.r + 15).strength(0.9).iterations(2))
    .stop();
  const ticks = previous.size ? 160 : 360;
  for (let index = 0; index < ticks; index += 1) simulation.tick();
  const halfW = width / 2 - 24;
  const halfH = height / 2 - 24;
  const positions = new Map();
  for (const node of simNodes) {
    positions.set(node.id, { x: Math.max(-halfW, Math.min(halfW, node.x)), y: Math.max(-halfH, Math.min(halfH, node.y)), r: node.r });
  }
  return positions;
}

// Étiquettes sans chevauchement: placement glouton par priorité, sinon visible au survol seulement.
function placeLabels(nodes, positions, scale, pinned) {
  const boxes = [];
  const placed = new Map();
  const charWidth = 6.1 / scale;
  const lineHeight = 13 / scale;
  const overlaps = (box) => boxes.some((other) => box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1);
  for (const node of nodes) {
    const position = positions.get(node.id);
    if (position) boxes.push({ x1: position.x - position.r, x2: position.x + position.r, y1: position.y - position.r, y2: position.y + position.r });
  }
  const ordered = [...nodes].sort((a, b) => (pinned.has(b.id) - pinned.has(a.id)) || (PRIORITY[a.type] - PRIORITY[b.type]) || ((b.activity || 0) - (a.activity || 0)));
  for (const node of ordered) {
    const position = positions.get(node.id);
    if (!position) continue;
    const text = shortLabel(tr(node.label));
    const width = text.length * charWidth + 6 / scale;
    const gap = position.r + 4 / scale;
    const candidates = [
      { x: position.x, y: position.y + gap + lineHeight * 0.8, anchor: "middle", box: { x1: position.x - width / 2, x2: position.x + width / 2, y1: position.y + gap, y2: position.y + gap + lineHeight } },
      { x: position.x, y: position.y - gap - lineHeight * 0.25, anchor: "middle", box: { x1: position.x - width / 2, x2: position.x + width / 2, y1: position.y - gap - lineHeight, y2: position.y - gap } },
      { x: position.x + gap, y: position.y + lineHeight * 0.32, anchor: "start", box: { x1: position.x + gap, x2: position.x + gap + width, y1: position.y - lineHeight / 2, y2: position.y + lineHeight / 2 } },
      { x: position.x - gap, y: position.y + lineHeight * 0.32, anchor: "end", box: { x1: position.x - gap - width, x2: position.x - gap, y1: position.y - lineHeight / 2, y2: position.y + lineHeight / 2 } },
    ];
    const choice = candidates.find((candidate) => !overlaps(candidate.box)) || (pinned.has(node.id) ? candidates[0] : null);
    if (!choice) continue;
    boxes.push(choice.box);
    placed.set(node.id, { ...choice, text });
  }
  return placed;
}

const PANEL_WIDTH = 340;
const STATUS_ORDER = { err: 0, run: 1, unknown: 2, stop: 3, ok: 4 };
const GROUPS = [["agent", tr("Agents")], ["service", tr("Services")], ["timer", tr("Timers · cron")], ["module", tr("Modules")], ["api", tr("APIs et services externes")]];

function matchesFilter(node, filter) {
  if (!filter) return true;
  if (filter === "paid") return Boolean(node.paid);
  if (filter === "archived") return Boolean(node.archived);
  if (node.type === "founder") return false;
  return typeGroup(node.type) === filter && (filter !== "agent" || !node.archived);
}

function nodeSubline(node) {
  const meta = node.meta || {};
  if (node.type === "timer" || node.type === "cron") return [meta.scheduleText || meta.schedule, meta.nextRun ? tr("prochain {0}", dayTime(meta.nextRun)) : null].filter(Boolean).join(" · ");
  if (node.type === "api") return [tr(meta.costLabel || ""), meta.lifecycle && meta.lifecycle !== "actif" ? meta.lifecycle : null, meta.manage].filter(Boolean).join(" · ");
  if (node.type === "agent") return [ASSISTANT_LABELS[meta.assistant] || meta.assistant, node.foreign ? tr("projet {0}", node.foreign) : meta.state === "working" ? tr("travaille") : meta.state === "paused" ? tr("en pause") : meta.state === "archived" ? tr("archivé") : tr("disponible")].filter(Boolean).join(" · ");
  if (node.type === "module") return [meta.environment === "production" ? tr("Production") : tr("Développement"), meta.host].filter(Boolean).join(" · ");
  return [meta.scheduleText, meta.host || (meta.script ? meta.script : null)].filter(Boolean).join(" · ");
}

function ListPanel({ nodes, filter, onClearFilter, onPick, onCollapse }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("status");
  const [closed, setClosed] = useState(() => new Set());
  const text = query.trim().toLocaleLowerCase(LOCALE);
  const items = nodes
    .filter((node) => matchesFilter(node, filter))
    .filter((node) => !text || `${tr(node.label)} ${nodeSubline(node)}`.toLocaleLowerCase(LOCALE).includes(text))
    .sort((a, b) => (sort === "status" ? (STATUS_ORDER[a.status] ?? 5) - (STATUS_ORDER[b.status] ?? 5) : 0) || a.label.localeCompare(b.label, "fr"));
  const title = filter === "paid" ? tr("Payants") : filter === "archived" ? tr("Archivés") : filter ? TYPES.find((type) => type.id === filter)?.label : tr("Tous les nœuds");
  const groups = filter ? [[null, title, items]] : GROUPS.map(([id, label]) => [id, label, items.filter((node) => typeGroup(node.type) === id)]).filter(([, , list]) => list.length);
  const toggle = (id) => setClosed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <aside className="amap-panel amap-list" aria-label={tr("Liste des nœuds")}>
      <div className="amap-list-head">
        <div className="amap-list-title"><b>{title}</b><small>{items.length}</small>{filter && <button className="amap-chip-clear" onClick={onClearFilter}>{tr("tout afficher")}</button>}<button className="amap-close" onClick={onCollapse} aria-label={tr("Replier le panneau")}>›</button></div>
        <div className="amap-list-tools">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("Filtrer la liste…")} aria-label={tr("Filtrer la liste")} />
          <div className="amap-seg">{[["status", tr("Statut")], ["name", tr("Nom")]].map(([id, label]) => <button key={id} className={sort === id ? "on" : ""} onClick={() => setSort(id)}>{label}</button>)}</div>
        </div>
      </div>
      <div className="amap-list-body">
        {groups.map(([id, label, list]) => (
          <section key={label}>
            {!filter && <button className="amap-group" onClick={() => toggle(id)} aria-expanded={!closed.has(id)}><span>{closed.has(id) ? "›" : "⌄"}</span>{label}<small>{list.length}</small></button>}
            {!closed.has(id) && list.map((node) => (
              <button key={node.id} className={`amap-item ${node.status}`} onClick={() => onPick(node.id)}>
                <i className={`amap-dot ${node.status}`} />
                <span><b>{tr(node.label)}</b><small>{nodeSubline(node) || TYPE_LABELS[node.type]}</small></span>
                {node.paid && <em className="amap-dot paid">$</em>}
              </button>
            ))}
          </section>
        ))}
        {!items.length && <p className="amap-muted amap-list-empty">{tr("Aucun nœud.")}</p>}
      </div>
    </aside>
  );
}

function linkPath(source, target, kind) {
  if (kind !== "message") return `M${source.x},${source.y}L${target.x},${target.y}`;
  // Courbe légère: A→B et B→A restent distincts.
  const mx = (source.x + target.x) / 2;
  const my = (source.y + target.y) / 2;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(26, length * 0.12);
  return `M${source.x},${source.y}Q${mx - (dy / length) * bend},${my + (dx / length) * bend} ${target.x},${target.y}`;
}

function linkTone(link) {
  if (link.kind === "message" || link.kind === "founder" || link.kind === "created") return "agent";
  if (link.kind === "calls") return "service";
  return "timer";
}

function NodeShape({ node, r }) {
  const status = <circle className={`amap-status ${node.status}`} cx={r * 0.74} cy={-r * 0.74} r={3.8} />;
  if (node.type === "founder") {
    return (
      <>
        <circle className="amap-founder-orbit" r={r + 8} />
        <circle className="amap-founder" r={r} />
        <text className="amap-glyph founder" dy="0.35em">★</text>
      </>
    );
  }
  if (node.type === "agent") {
    return (
      <>
        <circle className="amap-agent-ring" r={r} />
        <circle className="amap-agent-core" r={Math.max(4, r - 4.5)} />
        <text className="amap-glyph" dy="0.35em" style={{ fontSize: Math.max(8, Math.min(12, r * 0.62)) }}>{initials(node.label)}</text>
        {node.foreign ? null : status}
      </>
    );
  }
  if (node.type === "module") {
    const points = Array.from({ length: 6 }, (_, index) => {
      const angle = (Math.PI / 3) * index + Math.PI / 6;
      return `${(r * 1.08 * Math.cos(angle)).toFixed(1)},${(r * 1.08 * Math.sin(angle)).toFixed(1)}`;
    }).join(" ");
    return (
      <>
        <polygon className="amap-module" points={points} style={node.accent ? { "--node-accent": node.accent } : undefined} />
        <text className="amap-glyph module" dy="0.35em" style={node.accent ? { fill: node.accent } : undefined}>{String(node.glyph || initials(node.label)).slice(0, 2)}</text>
        {status}
      </>
    );
  }
  if (node.type === "service") {
    return (
      <>
        <rect className={`amap-service ${node.role === "bot" ? "bot" : ""}`} x={-r} y={-r} width={r * 2} height={r * 2} rx={node.role === "bot" ? r : 4} />
        {node.role === "bot" ? <text className="amap-glyph service" dy="0.35em">⚡</text> : <rect className="amap-service-core" x={-r / 2.4} y={-r / 2.4} width={r / 1.2} height={r / 1.2} rx={1.5} />}
        {status}
      </>
    );
  }
  if (node.type === "timer" || node.type === "cron") {
    return (
      <>
        <circle className={`amap-timer ${node.type}`} r={r} />
        <path className="amap-timer-hands" d={`M0,0V${-r * 0.58}M0,0H${r * 0.44}`} />
        {status}
      </>
    );
  }
  return (
    <>
      <circle className="amap-api" r={r} />
      <circle className="amap-api-core" r={2.4} />
    </>
  );
}

function useSize(ref) {
  const [size, setSize] = useState({ width: 900, height: 620 });
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const update = () => {
      const rect = ref.current.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) setSize((current) => (Math.abs(current.width - rect.width) > 8 || Math.abs(current.height - rect.height) > 8 ? { width: Math.round(rect.width), height: Math.round(rect.height) } : current));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function ChatBubbles({ events, nodeLabel }) {
  const scroller = useRef(null);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [events]);
  if (!events.length) return <div className="amap-chat-empty">{tr("Aucun échange sur la période.")}</div>;
  let lastDay = null;
  return (
    <div className="amap-chat" ref={scroller}>
      {events.map((event, index) => {
        const day = dayOf(event.at);
        const header = day !== lastDay ? <div className="amap-day" key={`d${index}`}>{day}</div> : null;
        lastDay = day;
        const author = event.direction === "in" ? (event.kind === "founder" ? tr("Fondateur") : shortLabel(event.from, 34)) : event.kind === "sent" ? `${shortLabel(nodeLabel, 20)} → ${shortLabel(event.to, 24)}` : shortLabel(nodeLabel, 34);
        return (
          <React.Fragment key={`${event.at}${index}`}>
            {header}
            <div className={`amap-bubble ${event.direction} ${event.kind}`}>
              <small>{author} · {timeOf(event.at)}</small>
              <p>{plainText(event.text)}</p>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// Flux live des messages entre agents: lecture pure, on peut ouvrir l'agent pour intervenir.
function ExchangesPanel({ activeProject, projectName, span, api, onCollapse, onOpenAgent, onFresh, onHoverNode, onItems, onScope, agentFilter = null, onClearAgent, initialScope = "project" }) {
  const [scope, setScope] = useState(initialScope);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => onScope?.(scope), [scope, onScope]);
  const known = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());
  const target = scope === "all" || !activeProject ? "all" : activeProject;
  useEffect(() => {
    let active = true;
    known.current = null;
    setItems(null);
    const load = async () => {
      if (document.hidden) return;
      try {
        const result = await api(`/api/map/exchanges?project=${encodeURIComponent(target)}&window=${span}`);
        if (!active) return;
        const list = result.exchanges || [];
        if (known.current) {
          const added = list.filter((item) => !known.current.has(item.id));
          if (added.length) {
            onFresh?.(added);
            setFresh(new Set(added.map((item) => item.id)));
          }
        }
        known.current = new Set(list.map((item) => item.id));
        setItems(list);
        onItems?.(list);
        setError(null);
      } catch (failure) {
        if (active) setError(failure.message);
      }
    };
    void load();
    const timer = setInterval(load, EXCHANGES_REFRESH_MS);
    return () => { active = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, target, span]);
  const text = query.trim().toLocaleLowerCase(LOCALE);
  const shown = (items || []).filter((item) => !agentFilter || item.from === agentFilter || item.to === agentFilter).filter((item) => !text || `${item.from} ${item.to} ${item.text} ${item.reply || ""}`.toLocaleLowerCase(LOCALE).includes(text)).slice().reverse();
  const toggle = (id) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <aside className="amap-panel amap-exchanges" aria-label={tr("Échanges entre agents")}>
      <div className="amap-list-head">
        <div className="amap-list-title">
          <i className="amap-live-dot" aria-hidden="true" />
          <b>{tr("Échanges")}</b>
          {items && <small>{shown.length}</small>}
          {onCollapse && <button className="amap-close" onClick={onCollapse} aria-label={tr("Réduire")}>›</button>}
        </div>
        <div className="amap-list-tools">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("Filtrer par agent ou contenu…")} aria-label={tr("Filtrer les échanges")} />
        </div>
        <div className="amap-seg amap-exchange-scope" role="group" aria-label={tr("Portée")}>
          <button className={scope === "project" && activeProject ? "on" : ""} disabled={!activeProject} onClick={() => setScope("project")} title={projectName}>{tr("Ce projet")}</button>
          <button className={scope === "all" || !activeProject ? "on" : ""} onClick={() => setScope("all")}>{tr("Tous les projets")}</button>
        </div>
        {agentFilter && <button type="button" className="amap-exchange-agent-filter" onClick={onClearAgent}>{shortLabel(agentFilter, 30)}<b aria-hidden="true">×</b></button>}
      </div>
      <div className="amap-exchange-list">
        {error && <div className="amap-chat-empty">{error}</div>}
        {!error && !items && <div className="amap-chat-empty">{tr("Chargement…")}</div>}
        {!error && items && !shown.length && <div className="amap-chat-empty">{tr("Aucun échange sur la période.")}</div>}
        {shown.map((item) => {
          const expanded = open.has(item.id);
          return (
            <article key={item.id} className={`amap-exchange ${item.kind === "subagent" ? "subagent" : ""} ${fresh.has(item.id) ? "fresh" : ""}`} onPointerEnter={() => item.toId && onHoverNode?.(`agent:${item.toId}`)} onPointerLeave={() => onHoverNode?.(null)}>
              <header>
                <span className="amap-exchange-route"><b>{shortLabel(item.from, 22)}</b><i aria-hidden="true">→</i><b>{shortLabel(item.to, 22)}</b>{item.kind === "subagent" && <em>{item.running ? tr("sous-agent en cours") : tr("sous-agent")}</em>}</span>
                <time title={dayTime(item.at)}>{timeOf(item.at)}</time>
              </header>
              <button type="button" className={`amap-exchange-text ${expanded ? "open" : ""}`} onClick={() => toggle(item.id)} aria-expanded={expanded}>{plainText(item.text)}</button>
              {expanded && item.reply && <div className="amap-exchange-reply"><small>{tr("Réponse de {0}", shortLabel(item.to, 26))}</small><p>{plainText(item.reply)}</p></div>}
              <footer>
                {!expanded && item.reply && <span className="amap-exchange-answered">{tr("Répondu")}</span>}
                {item.toId && !item.toArchived && <button type="button" onClick={() => onOpenAgent?.(item.toId)}>{tr("Ouvrir {0}", shortLabel(item.to, 22))}</button>}
                {item.kind === "subagent" && item.fromId && <button type="button" onClick={() => onOpenAgent?.(item.fromId)}>{tr("Ouvrir {0}", shortLabel(item.from, 22))}</button>}
              </footer>
            </article>
          );
        })}
      </div>
    </aside>
  );
}

const ROOM_RECENT_MS = 15 * 60_000;
const ROOM_BUBBLES = 5;

// Places agents around the room, busiest towards the centre; two rings beyond a dozen.
function roomSeats(names, width, height) {
  const seats = new Map();
  const cx = width / 2;
  const cy = height / 2 + 14;
  const outer = names.length > 12 ? names.slice(0, Math.ceil(names.length * 0.62)) : names;
  const inner = names.length > 12 ? names.slice(outer.length) : [];
  const ring = (list, rx, ry, offset) => list.forEach((name, index) => {
    const angle = offset + (index / list.length) * Math.PI * 2;
    seats.set(name, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  });
  ring(outer, Math.max(100, width * 0.4), Math.max(90, height * 0.36), -Math.PI / 2);
  ring(inner, Math.max(60, width * 0.2), Math.max(50, height * 0.17), -Math.PI / 3);
  return seats;
}

function AgentFigure({ name, seat, logo, status, active, speaking, count, foreign, onPick, onHover }) {
  const [failed, setFailed] = useState(false);
  return (
    <button type="button" className={`amap-room-agent ${status || "idle"} ${active ? "on" : ""} ${speaking ? "speaking" : ""}`} style={{ left: seat.x, top: seat.y }} onClick={() => onPick(name)} onPointerEnter={() => onHover(name)} onPointerLeave={() => onHover(null)} aria-label={tr("Voir les échanges de {0}", name)} aria-pressed={active}>
      <span className="amap-room-figure" aria-hidden="true">
        <span className="amap-room-head">{logo && !failed ? <img src={logo} alt="" onError={() => setFailed(true)} /> : <b>{initials(name)}</b>}<i /></span>
        <span className="amap-room-body" />
      </span>
      <strong>{shortLabel(name, 18)}</strong>
      <small>{foreign || (count ? tr(count > 1 ? "{0} messages" : "{0} message", count) : "")}</small>
    </button>
  );
}

function ExchangeRoom({ items, sessions, projects, scopeProject, selected, onSelect, packets }) {
  const stage = useRef(null);
  const size = useSize(stage);
  const [hover, setHover] = useState(null);
  const byName = useMemo(() => new Map(sessions.map((session) => [session.name, session])), [sessions]);
  const humans = (items || []).filter((item) => item.kind !== "subagent");
  const names = useMemo(() => {
    const counts = new Map();
    for (const item of humans) for (const name of [item.from, item.to]) counts.set(name, (counts.get(name) || 0) + 1);
    for (const session of sessions) if (scopeProject ? session.projectId === scopeProject : false) { if (!counts.has(session.name) && session.assistant !== "shell") counts.set(session.name, 0); }
    return counts;
  }, [items, sessions, scopeProject]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stable seats: alphabetical, so nobody jumps when a new message arrives.
  const order = useMemo(() => [...names.keys()].sort((a, b) => a.localeCompare(b, "fr")).slice(0, 26), [names]);
  const seats = useMemo(() => roomSeats(order, size.width, size.height), [order, size.width, size.height]);
  const pairs = useMemo(() => {
    const map = new Map();
    for (const item of humans) {
      if (!seats.has(item.from) || !seats.has(item.to) || item.from === item.to) continue;
      const key = [item.from, item.to].sort().join("|");
      const pair = map.get(key) || { key, a: item.from, b: item.to, count: 0, lastAt: 0 };
      pair.count += 1;
      pair.lastAt = Math.max(pair.lastAt, Date.parse(item.at));
      map.set(key, pair);
    }
    return [...map.values()];
  }, [items, seats]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = Date.now();
  const bubbles = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const item of [...humans].reverse()) {
      if (seen.has(item.from) || !seats.has(item.from)) continue;
      seen.add(item.from);
      list.push(item);
      if (list.length >= ROOM_BUBBLES) break;
    }
    return list;
  }, [items, seats]); // eslint-disable-line react-hooks/exhaustive-deps
  const focus = hover || selected;
  const running = (items || []).filter((item) => item.kind === "subagent" && item.running && seats.has(item.from));
  const projectName = (session) => (session?.projectId && session.projectId !== scopeProject ? projects.find((project) => project.id === session.projectId)?.name || null : null);
  return (
    <div className="amap-room" ref={stage}>
      <div className="amap-room-floor" aria-hidden="true" />
      <svg className="amap-room-links" width={size.width} height={size.height} aria-hidden="true">
        {pairs.map((pair) => {
          const a = seats.get(pair.a);
          const b = seats.get(pair.b);
          const live = now - pair.lastAt < ROOM_RECENT_MS;
          const dim = focus && pair.a !== focus && pair.b !== focus;
          return <line key={pair.key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`${live ? "live" : ""} ${dim ? "dim" : ""}`} style={{ strokeWidth: 0.8 + Math.log2(1 + pair.count) * 0.8 }} />;
        })}
        {packets.map((packet) => {
          const a = seats.get(packet.from);
          const b = seats.get(packet.to);
          return a && b ? <circle key={packet.key} className="amap-packet" r={4}><animateMotion dur={`${PACKET_MS - 200}ms`} fill="freeze" path={`M${a.x},${a.y}L${b.x},${b.y}`} /></circle> : null;
        })}
      </svg>
      {order.map((name) => {
        const session = byName.get(name);
        const seat = seats.get(name);
        return seat ? <AgentFigure key={name} name={name} seat={seat} logo={session?.logoUrl} status={session ? (session.agentStatus?.subagents ? "working" : session.agentStatus?.state) : "gone"} active={selected === name} speaking={bubbles.some((item) => item.from === name && now - Date.parse(item.at) < ROOM_RECENT_MS)} count={names.get(name)} foreign={projectName(session)} onPick={(value) => onSelect(selected === value ? null : value)} onHover={setHover} /> : null;
      })}
      {bubbles.map((item) => {
        const seat = seats.get(item.from);
        const dim = focus && item.from !== focus && item.to !== focus;
        const fresh = now - Date.parse(item.at) < ROOM_RECENT_MS;
        const flip = seat.x > size.width - 170;
        const below = seat.y < 130;
        return <button type="button" key={item.id} className={`amap-room-bubble ${fresh ? "fresh" : ""} ${dim ? "dim" : ""} ${flip ? "flip" : ""} ${below ? "below" : ""}`} style={{ left: seat.x, top: seat.y }} onClick={() => onSelect(item.from)}>
          <small>{tr("à {0}", shortLabel(item.to, 18))} · {timeOf(item.at)}</small>
          <span>{plainText(item.text).slice(0, 90)}</span>
        </button>;
      })}
      {running.map((item, index) => {
        const seat = seats.get(item.from);
        return <span key={item.id} className="amap-room-sub" style={{ left: seat.x + 30 + index * 8, top: seat.y + 8 }} title={tr("Sous-agent en cours : {0}", item.to)} aria-label={tr("Sous-agent en cours : {0}", item.to)} />;
      })}
      {!order.length && <div className="amap-loading">{items ? tr("Aucun échange sur la période.") : tr("Chargement…")}</div>}
    </div>
  );
}

const COST_OPTIONS = [["", "— (carte / scan)"], ["free", tr("Gratuit")], ["subscription", tr("Payant · abonnement")], ["usage", tr("Payant · à l'usage")], ["commission", tr("Commission par transaction")], ["unknown", tr("À confirmer")]];
const LIFECYCLE_OPTIONS = ["", "actif", tr("en pause"), "sandbox", tr("obsolète ?"), tr("non utilisé"), "secours", tr("plus détecté")];

// Correction du fondateur: prime sur la carte, le scan et les fiches rédigées; jamais écrasée par un scan.
function FixForm({ projectId, node, api, onDone }) {
  const meta = node.meta || {};
  const [what, setWhat] = useState(meta.what || "");
  const [cost, setCost] = useState("");
  const [costNote, setCostNote] = useState(meta.costNote || "");
  const [lifecycle, setLifecycle] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const fields = { costNote };
      if (what.trim() !== String(meta.what || "").trim()) fields.what = what;
      if (cost) fields.cost = cost;
      if (lifecycle) fields.lifecycle = lifecycle;
      await api("/api/map/override", { method: "POST", body: JSON.stringify({ project: projectId, node: node.id, fields }) });
      onDone(true);
    } catch (error) {
      setFailure(error.message);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    try {
      await api("/api/map/override", { method: "POST", body: JSON.stringify({ project: projectId, node: node.id, fields: { what: "", cost: null, costNote: "", lifecycle: null } }) });
      onDone(true);
    } catch (error) {
      setFailure(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="amap-fix" onSubmit={save}>
      <label>{tr("Description")}<textarea value={what} onChange={(event) => setWhat(event.target.value)} rows={3} /></label>
      <div className="amap-fix-row">
        <label>{tr("Coût")}<select value={cost} onChange={(event) => setCost(event.target.value)}>{COST_OPTIONS.map(([id, label]) => <option key={id} value={id}>{id ? label : `${label}${meta.costLabel ? ` : ${meta.costLabel}` : ""}`}</option>)}</select></label>
        <label>{tr("Statut")}<select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>{LIFECYCLE_OPTIONS.map((id) => <option key={id} value={id}>{id || `— (${meta.lifecycle || "auto"})`}</option>)}</select></label>
      </div>
      <label>{tr("Note coût / plan")}<input value={costNote} onChange={(event) => setCostNote(event.target.value)} placeholder={tr("ex. plan gratuit confirmé")} /></label>
      {failure && <small className="amap-fix-error">{failure}</small>}
      <div className="amap-fix-actions">
        <button type="submit" className="primary" disabled={busy}>{tr("Enregistrer")}</button>
        <button type="button" onClick={() => onDone(false)} disabled={busy}>{tr("Annuler")}</button>
        {meta.corrected && <button type="button" className="ghost" onClick={reset} disabled={busy}>{tr("Retirer ma correction")}</button>}
      </div>
    </form>
  );
}

function ScanDialog({ projectId, projectName, api, onClose, onApplied }) {
  const [status, setStatus] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setStatus(await api(`/api/map/scan?project=${encodeURIComponent(projectId)}`));
      setFailure(null);
    } catch (error) {
      setFailure(error.message);
    }
  }, [api, projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!status?.running) return undefined;
    const timer = setTimeout(load, 2000);
    return () => clearTimeout(timer);
  }, [status, load]);
  const start = async () => {
    setBusy(true);
    try {
      setStatus(await api("/api/map/scan", { method: "POST", body: JSON.stringify({ project: projectId }) }));
    } catch (error) {
      setFailure(error.message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      setStatus(await api("/api/map/scan/apply", { method: "POST", body: JSON.stringify({ project: projectId }) }));
      onApplied();
    } catch (error) {
      setFailure(error.message);
    } finally {
      setBusy(false);
    }
  };
  const result = status?.result;
  const scanning = status?.running && status.phase === "scan";
  const groups = result ? [["added", tr("Nouveaux"), result.added], ["changed", tr("Modifiés"), result.changed], ["gone", tr("Plus détectés"), result.gone]] : [];
  return (
    <div className="amap-dialog-backdrop" onClick={onClose}>
      <section className="amap-dialog" role="dialog" aria-label={tr("Explorer le projet")} onClick={(event) => event.stopPropagation()}>
        <header>
          <div><b>{tr("Explorer ·")}{" "}{projectName}</b><small>{tr("Clés .env (noms seulement), hôtes d'API, SDK, services systemd, crons. Aucune valeur de secret lue ni affichée.")}</small></div>
          <button className="amap-close" onClick={onClose} aria-label={tr("Fermer")}>×</button>
        </header>
        {failure && <div className="amap-error">{failure}</div>}
        {!status ? <p className="amap-muted">{tr("Chargement…")}</p> : scanning ? (
          <div className="amap-scan-progress"><i /><span>{tr("Scan en cours…")}{" "}{status.progress}</span></div>
        ) : result ? (
          <>
            <div className="amap-diff-kpis">
              {groups.map(([id, label, items]) => <div key={id} className={`amap-diff-kpi ${id}`}><b>{items.length}</b><small>{label}</small></div>)}
              <div className="amap-diff-kpi"><b>{result.total}</b><small>{tr("Nœuds détectés")}</small></div>
            </div>
            <p className="amap-muted">{tr("Scan du")}{" "}{dayTime(result.scannedAt)} · {result.stats?.files || 0}{" "}{tr("fichiers de code,")}{" "}{result.stats?.envFiles || 0}{" "}{tr("fichiers .env (noms),")}{" "}{result.dirs?.join(", ")}</p>
            <div className="amap-diff-body">
              {groups.filter(([, , items]) => items.length).map(([id, label, items]) => (
                <section key={id}>
                  <h4>{label}{id === "gone" && <small>{" "}{tr("· seront grisés, pas supprimés")}</small>}</h4>
                  <ul>{items.map((item) => <li key={item.id} className={id}><i className={`tone-${typeGroup(item.type || "api")}`} />{tr(item.label)}<small>{TYPE_LABELS[item.type] || item.type || ""}</small></li>)}</ul>
                </section>
              ))}
            </div>
            {status.running && <div className="amap-scan-progress"><i /><span>{tr("Rédaction des fiches…")}{" "}{status.progress}</span></div>}
          </>
        ) : (
          <p className="amap-muted">{status.appliedAt ? tr("Carte à jour (dernier scan appliqué le {0}).", dayTime(status.appliedAt)) : tr("Aucun scan encore pour ce projet.")}{" "}{tr("Un scan automatique tourne chaque nuit ; ses changements attendent ici.")}</p>
        )}
        <footer>
          <button onClick={start} disabled={busy || status?.running}>{result || status?.appliedAt ? tr("Relancer le scan") : tr("Lancer le scan")}</button>
          {result && <button className="primary" onClick={apply} disabled={busy || scanning}>{tr("Appliquer")}</button>}
        </footer>
      </section>
    </div>
  );
}

function DetailPanel({ projectId, span, node, graph, onBack, onCollapse, onOpenAgent, onChanged, api }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState(null);
  const [fixing, setFixing] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await api(`/api/map/node?project=${encodeURIComponent(projectId)}&window=${span}&node=${encodeURIComponent(node.id)}`);
      setDetail(result);
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  }, [api, projectId, span, node.id]);
  useEffect(() => {
    setDetail(null);
    setNotice(null);
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  const current = detail?.node || node;
  const meta = current.meta || {};
  const send = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const result = await api(`/api/map/agents/${encodeURIComponent(current.sessionId)}/message`, { method: "POST", body: JSON.stringify({ message: text }) });
      setDraft("");
      setNotice(result?.held ? tr("Envoyé dès que la saisie en cours est libre.") : tr("Message envoyé."));
      setTimeout(load, 4000);
    } catch (failure) {
      setNotice(failure.message);
    } finally {
      setSending(false);
    }
  };
  const rows = [];
  if (current.type === "agent") {
    rows.push([tr("Assistant"), ASSISTANT_LABELS[meta.assistant] || meta.assistant || "—"]);
    rows.push([tr("État"), current.foreign ? `Projet ${current.foreign}` : meta.state === "working" ? tr("Travail en cours") : meta.state === "waiting" ? tr("Attend une réponse") : meta.state === "paused" ? tr("En pause (arrêté)") : meta.state === "archived" ? tr("Archivé") : tr("Disponible")]);
    if (meta.createdAt) rows.push([tr("Créé"), `${new Date(meta.createdAt).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit" })} ${timeOf(meta.createdAt)}`]);
    if (meta.archivedAt) rows.push([tr("Archivé"), relative(meta.archivedAt)]);
    rows.push([tr("Dernière réponse"), relative(meta.lastReplyAt)]);
    rows.push([tr("Échanges"), `${meta.inbound || 0} entrants · ${meta.outbound || 0} sortants`]);
    if (meta.costNote) rows.push([tr("Coût"), `Payant · ${meta.costNote}`]);
    if (meta.manage) rows.push([tr("Où le gérer"), meta.manage]);
  } else {
    if (meta.host) rows.push([tr("Où"), `${meta.host}${meta.user ? ` · compte ${meta.user}` : ""}`]);
    if (meta.owner) rows.push([tr("Propriétaire"), meta.owner]);
    if (meta.environment) rows.push([tr("Environnement"), meta.environment === "production" ? tr("Production") : tr("Développement")]);
    if (meta.maintenance) rows.push([tr("Maintenance"), meta.maintenance]);
    if (meta.reachable === false) rows.push([tr("Tunnel"), "injoignable"]);
    if (meta.statusSource) rows.push([tr("Statut via"), meta.statusSource]);
    if (current.shared) rows.push([tr("Portée"), tr("Partagé entre projets")]);
  }
  const outgoing = graph.links.filter((link) => link.source === current.id && ["calls", "triggers"].includes(link.kind)).map((link) => graph.label(link.target));
  const contains = graph.links.filter((link) => link.source === current.id && ["declares", "controls"].includes(link.kind)).map((link) => graph.label(link.target));
  const incoming = graph.links.filter((link) => link.target === current.id && !["founder", "message", "created", "declares", "controls"].includes(link.kind)).map((link) => graph.label(link.source));
  const usedIn = [...new Set([...(meta.usedIn || []), ...(current.type === "api" ? incoming : [])])];
  const costText = meta.costLabel || (meta.paidVia?.length ? tr("Payant (via les APIs appelées)") : current.type === "api" ? tr("À confirmer") : tr("Pas de coût propre"));
  const ran = meta.lastRun ? `${timeOf(meta.lastRun)} · ${relative(meta.lastRun)}${meta.durationMs != null ? tr(" · durée {0}", duration(meta.durationMs)) : ""}` : null;
  const result = meta.result ? (meta.result === "success" ? tr("succès") : `${meta.result}${meta.exitStatus && meta.exitStatus !== "0" ? ` (code ${meta.exitStatus})` : ""}`) : null;
  return (
    <aside className="amap-panel" aria-label={tr("Détail {0}", current.label)}>
      <div className="amap-panel-head">
        <div className="amap-kind">{TYPE_LABELS[current.role === "bot" ? "service" : current.type] || current.type}{current.role === "bot" ? " · bot" : ""}{meta.assistant ? ` · ${ASSISTANT_LABELS[meta.assistant] || meta.assistant}` : ""}</div>
        <div className="amap-panel-actions"><button className="amap-back" onClick={onBack}>{tr("← liste")}</button><button className="amap-close" onClick={onCollapse} aria-label={tr("Replier le panneau")}>›</button></div>
        <h3>{current.label} <span className={`amap-pill ${current.status}`}>● {STATUS_LABELS[current.status] || current.status}</span></h3>
        {current.type === "agent" && meta.what && <p className="amap-desc">{meta.what}</p>}
        {current.type === "agent" && <dl className="amap-meta">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>}
        {current.type === "agent" && current.sessionId && !current.archived && !current.foreign && <div className="amap-actions"><button onClick={() => onOpenAgent?.(current.sessionId)}>{tr("Ouvrir le terminal")}</button></div>}
      </div>
      {error && <div className="amap-error">{error}</div>}
      {current.type === "agent" ? (
        <>
          {detail ? <ChatBubbles events={detail.chat || []} nodeLabel={current.label} /> : <div className="amap-chat-empty">{tr("Chargement…")}</div>}
          {meta.canMessage && (
            <form className="amap-compose" onSubmit={send}>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={tr("Écrire à {0}…", shortLabel(current.label, 30))} rows={1} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) send(event); }} />
              <button type="submit" disabled={!draft.trim() || sending} aria-label={tr("Envoyer")}>↑</button>
              {notice && <small>{notice}</small>}
            </form>
          )}
        </>
      ) : (
        <div className="amap-sheet">
          <section>
            <h4>{tr("À quoi ça sert")}{meta.verify && <b className="amap-verify">{tr("à vérifier")}</b>}{!fixing && <button className="amap-fix-btn" onClick={() => setFixing(true)}>corriger</button>}</h4>
            {fixing ? <FixForm projectId={projectId} node={current} api={api} onDone={(saved) => { setFixing(false); if (saved) { void load(); onChanged?.(); } }} /> : (
              <>
                {meta.what ? <p className="amap-what">{meta.what}</p> : <p className="amap-muted">{tr("Pas encore de description : lance « Explorer » ou corrige-la ici.")}</p>}
                {meta.whatSource && <small className={`amap-source ${meta.corrected ? "fixed" : ""}`}>{tr("source :")}{" "}{meta.whatSource}</small>}
                {meta.note && <p className="amap-note">« {meta.note} »</p>}
              </>
            )}
          </section>
          <section className="amap-facts">
            <div className="amap-fact"><span>{tr("Où c'est utilisé")}</span>{usedIn.length ? <div className="amap-tags">{usedIn.map((item) => <i key={item}>{item}</i>)}</div> : <b className="amap-muted">—</b>}</div>
            <div className="amap-fact"><span>{tr("Clés .env")}</span>{meta.keys?.length ? <ul className="amap-keys">{meta.keys.map((item) => <li key={item}><code>{item.split(" — ")[0]}</code>{item.includes(" — ") && <small>{item.split(" — ").slice(1).join(" — ")}</small>}</li>)}</ul> : <b className="amap-muted">{tr("aucune déclarée")}</b>}</div>
            <div className="amap-fact"><span>{tr("Coût")}</span><b className={`amap-cost ${meta.cost || "none"}`}>{costText}</b>{meta.costNote && <small>{meta.costNote}</small>}{meta.paidVia?.length > 0 && <small>via {meta.paidVia.join(", ")}</small>}</div>
            {meta.quota && <div className="amap-fact"><span>{tr("Quota / limite")}</span><b>{meta.quota}</b></div>}
            <div className="amap-fact"><span>{tr("Statut")}</span><b className={`amap-life ${String(meta.lifecycle || "").replace(/\W+/g, "")}`}>{meta.lifecycle || STATUS_LABELS[current.status]}</b></div>
            {meta.manage && <div className="amap-fact"><span>{tr("Où le gérer")}</span><b>{meta.manage}</b></div>}
            {meta.detected && <div className="amap-fact"><span>{tr("Détecté par le scan")}</span><b className="amap-muted">{[meta.detected.hosts?.length ? meta.detected.hosts.join(", ") : null, meta.detected.sdks?.length ? `paquets ${meta.detected.sdks.join(", ")}` : null, `${meta.detected.files} fichier(s)`].filter(Boolean).join(" · ")}</b></div>}
          </section>
          {(meta.scheduleText || meta.nextRun || meta.schedule) && (
            <section>
              <h4>{tr("Quand")}</h4>
              <p className="amap-what">{meta.scheduleText || meta.schedule}</p>
              {meta.nextRun && <p className="amap-line"><span>{tr("Prochain passage")}</span><b>{dayTime(meta.nextRun)} · {relative(meta.nextRun)}</b></p>}
            </section>
          )}
          {(meta.produces?.length > 0 || meta.dependsOn?.length > 0 || outgoing.length > 0 || incoming.length > 0 || contains.length > 0) && (
            <section>
              <h4>{tr("Produit · dépend de")}</h4>
              {meta.produces?.length > 0 && <div className="amap-tags"><span>{tr("Produit")}</span>{meta.produces.map((item) => <i key={item}>{item}</i>)}</div>}
              {meta.dependsOn?.length > 0 && <div className="amap-tags"><span>{tr("Dépend de")}</span>{meta.dependsOn.map((item) => <i key={item}>{item}</i>)}</div>}
              {outgoing.length > 0 && <div className="amap-tags"><span>{tr("Appelle")}</span>{[...new Set(outgoing)].map((item) => <i className="link" key={item}>{item}</i>)}</div>}
              {contains.length > 0 && <div className="amap-tags"><span>{tr("Pilote")}</span>{[...new Set(contains)].map((item) => <i className="link" key={item}>{item}</i>)}</div>}
              {incoming.length > 0 && <div className="amap-tags"><span>{tr("Appelé par")}</span>{[...new Set(incoming)].map((item) => <i className="link" key={item}>{item}</i>)}</div>}
            </section>
          )}
          {(ran || result || meta.unit) && (
            <section>
              <h4>{tr("Dernier passage")}</h4>
              {ran ? <p className="amap-line"><span>{tr("Lancé")}</span><b>{ran}</b></p> : <p className="amap-muted">{tr("Pas encore lancé sur la période.")}</p>}
              {result && <p className="amap-line"><span>{tr("Résultat")}</span><b className={meta.result === "success" ? "ok" : "err"}>{result}</b></p>}
              {detail?.logs?.length > 0 && <div className="amap-log">{detail.logs.map((item, index) => <div key={index}><time>{item.at ? timeOf(item.at) : ""}</time><span>{item.text}</span></div>)}</div>}
            </section>
          )}
          {!meta.unit && current.type === "cron" && meta.host && (
            <section>
              <h4>{tr("Dernier passage")}</h4>
              <p className="amap-muted">{tr("Pas de journal lisible depuis ce PC : le statut vient de la santé globale des crons prod (HealthMonitorCron).")}</p>
            </section>
          )}
          {meta.unit && (
            <section>
              <h4>{tr("Erreurs récentes")}</h4>
              {!detail ? <p className="amap-muted">{tr("Chargement…")}</p> : detail.errors?.length ? detail.errors.map((item, index) => <div className="amap-error-line" key={index}><time>{item.at ? timeOf(item.at) : ""}</time><span>{item.text}</span></div>) : <p className="amap-muted">{tr("Aucune erreur sur la période.")}</p>}
            </section>
          )}
          {(meta.command || meta.script || meta.unit) && (
            <section>
              <h4>{tr("Commande")}</h4>
              {meta.command && <code className="amap-code">{meta.command}</code>}
              {meta.script && <p className="amap-line"><span>{tr("Script")}</span><b>{meta.scriptPath || meta.script}</b></p>}
              {meta.unit && <p className="amap-line"><span>{tr("Unité")}</span><b>{meta.unit}{meta.service && meta.service !== meta.unit ? ` → ${meta.service}` : ""}{meta.scope === "system" ? tr(" · système") : ""}</b></p>}
              {meta.workingDirectory && <p className="amap-line"><span>{tr("Dossier")}</span><b>{meta.workingDirectory}</b></p>}
            </section>
          )}
          {rows.length > 0 && (
            <section>
              <h4>{tr("Contexte")}</h4>
              <dl className="amap-meta">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
            </section>
          )}
          {detail?.comments?.length > 0 && (
            <section>
              <h4>{tr("Notes de l'unité systemd")}</h4>
              <ul className="amap-notes">{detail.comments.map((item) => <li key={item}>{item}</li>)}</ul>
            </section>
          )}
          {detail?.header?.length > 0 && (
            <section>
              <h4>{tr("En-tête du script")}{" "}<small>{tr("(peut dater)")}</small></h4>
              <ul className="amap-notes">{detail.header.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

export default function AgentMapView({ projects = [], projectId: requestedProject = null, onProjectChange, api, onOpenAgent, sessions = [], initialMode = "map" }) {
  const prefs = useMemo(readPrefs, []);
  const projectList = useMemo(() => projects.filter((project) => project?.id), [projects]);
  const [projectId, setProjectId] = useState(requestedProject || prefs.projectId || null);
  useEffect(() => {
    if (requestedProject) setProjectId(requestedProject);
  }, [requestedProject]);
  const [span, setSpan] = useState(prefs.window === "7d" ? "7d" : "24h");
  const [filter, setFilter] = useState(null);
  const [panelOpen, setPanelOpen] = useState(prefs.panelOpen !== false);
  const [mode, setMode] = useState(initialMode);
  useEffect(() => setMode(initialMode), [initialMode]);
  const [roomItems, setRoomItems] = useState(null);
  const [roomAgent, setRoomAgent] = useState(null);
  const [roomPackets, setRoomPackets] = useState([]);
  const [roomScope, setRoomScope] = useState("project");
  const room = mode === "room";
  const [packets, setPackets] = useState([]);
  const [exploring, setExploring] = useState(false);
  const [search, setSearch] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [labelScale, setLabelScale] = useState(1);
  const stage = useRef(null);
  const size = useSize(stage);
  const positionsRef = useRef(new Map());
  const drag = useRef(null);

  const activeProject = projectList.find((project) => project.id === projectId) ? projectId : projectList[0]?.id || null;
  useEffect(() => writePrefs({ projectId: activeProject, window: span, panelOpen }), [activeProject, span, panelOpen]);

  const load = useCallback(async () => {
    if (!activeProject) return;
    try {
      const result = await api(`/api/map?project=${encodeURIComponent(activeProject)}&window=${span}`);
      setData(result);
      setError(null);
    } catch (failure) {
      setError(failure.message);
    }
  }, [api, activeProject, span]);
  useEffect(() => {
    setData((current) => (current?.project?.id === activeProject ? current : null));
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, activeProject]);
  useEffect(() => {
    positionsRef.current = new Map();
    setSelectedId(null);
    setView({ x: 0, y: 0, k: 1 });
  }, [activeProject]);

  const visible = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    const nodes = data.nodes.filter((node) => node.type === "founder" || filter === "archived" || !node.archived);
    const ids = new Set(nodes.map((node) => node.id));
    const links = data.links.filter((link) => ids.has(link.source) && ids.has(link.target));
    // Nœuds isolés par les filtres (ex. API sans service visible) masqués.
    const linked = new Set(links.flatMap((link) => [link.source, link.target]));
    const kept = nodes.filter((node) => node.type !== "api" || linked.has(node.id));
    return { nodes: kept, links };
  }, [data, filter]);

  const layoutKey = `${visible.nodes.map((node) => node.id).join("|")}::${visible.links.length}::${size.width}x${size.height}`;
  const positions = useMemo(() => {
    if (!visible.nodes.length) return new Map();
    const next = computeLayout(visible.nodes, visible.links, size.width, size.height, positionsRef.current);
    positionsRef.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    const timer = setTimeout(() => setLabelScale(view.k), 140);
    return () => clearTimeout(timer);
  }, [view.k]);

  const query = search.trim().toLocaleLowerCase(LOCALE);
  const matches = useMemo(() => (query ? new Set(visible.nodes.filter((node) => node.label.toLocaleLowerCase(LOCALE).includes(query)).map((node) => node.id)) : null), [visible.nodes, query]);
  const focusId = hoverId || selectedId;
  const neighbours = useMemo(() => {
    if (!focusId) return null;
    const set = new Set([focusId]);
    for (const link of visible.links) {
      if (link.source === focusId) set.add(link.target);
      if (link.target === focusId) set.add(link.source);
    }
    return set;
  }, [focusId, visible.links]);
  const filtered = useMemo(() => (filter ? visible.nodes.filter((node) => matchesFilter(node, filter)) : []), [visible.nodes, filter]);
  const pinned = useMemo(() => new Set([selectedId, hoverId, ...(matches ? [...matches] : []), ...(filtered.length <= 60 ? filtered.map((node) => node.id) : [])].filter(Boolean)), [selectedId, hoverId, matches, filtered]);
  const labels = useMemo(() => placeLabels(visible.nodes, positions, labelScale, pinned), [visible.nodes, positions, labelScale, pinned]);

  const selected = data?.nodes.find((node) => node.id === selectedId) || null;
  const graph = useMemo(() => {
    const labels = new Map((data?.nodes || []).map((node) => [node.id, node.label]));
    return { links: data?.links || [], label: (id) => labels.get(id) || id };
  }, [data]);
  const hovered = hoverId ? visible.nodes.find((node) => node.id === hoverId) : null;
  const desktop = size.width > 900;
  // Panneau en surimpression à droite (desktop): le graphe glisse à gauche au lieu d'être recalculé.
  const shift = panelOpen && desktop ? -PANEL_WIDTH / 2 : 0;
  const pickFilter = (id) => {
    setFilter((current) => (current === id ? null : id));
    setSelectedId(null);
    setPanelOpen(true);
  };
  // Clic dans la liste: la carte centre et zoome sur le nœud, puis la fiche s'ouvre dans le même panneau.
  const focusNode = (id) => {
    setSelectedId(id);
    setPanelOpen(true);
    const position = positions.get(id);
    if (position) setView((current) => {
      const k = Math.max(current.k, 1.6);
      return { k, x: -position.x * k, y: -position.y * k + (desktop ? 0 : -size.height * 0.25) };
    });
  };

  // Un message arrivé traverse son lien une fois; le lien lui-même n'apparaît qu'après relecture de la carte.
  const onFreshExchanges = useCallback((added) => {
    void load();
    const next = added.filter((item) => item.fromId).map((item) => ({ key: item.id, source: `agent:${item.fromId}`, target: `agent:${item.toId}` }));
    const flying = added.map((item) => ({ key: item.id, from: item.from, to: item.to }));
    setRoomPackets((current) => [...current, ...flying].slice(-12));
    setTimeout(() => setRoomPackets((current) => current.filter((packet) => !flying.includes(packet))), PACKET_MS);
    if (!next.length) return;
    setPackets((current) => [...current, ...next].slice(-12));
    setTimeout(() => setPackets((current) => current.filter((packet) => !next.includes(packet))), PACKET_MS);
  }, [load]);

  const onWheel = (event) => {
    const rect = stage.current.getBoundingClientRect();
    const px = event.clientX - rect.left - rect.width / 2 - shift;
    const py = event.clientY - rect.top - rect.height / 2;
    setView((current) => {
      const k = Math.max(0.45, Math.min(3.2, current.k * Math.exp(-event.deltaY * 0.0015)));
      const ratio = k / current.k;
      return { k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  };
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const block = (event) => event.preventDefault();
    element.addEventListener("wheel", block, { passive: false });
    return () => element.removeEventListener("wheel", block);
  }, []);
  const onPointerDown = (event) => {
    if (event.target.closest?.(".amap-node")) return;
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
    setView({ ...drag.current.view, x: drag.current.view.x + dx, y: drag.current.view.y + dy });
  };
  const onPointerUp = () => {
    if (drag.current && !drag.current.moved) setSelectedId(null);
    drag.current = null;
  };

  const anchors = zoneAnchors(size.width, size.height);
  const zonesPresent = new Set(visible.nodes.map((node) => node.zone));
  const kpis = data?.kpis;
  const now = Date.now();

  return (
    <section className={`amap ${room ? "room-mode has-panel" : panelOpen ? "has-panel" : "panel-collapsed"}`}>
      {exploring && activeProject && <ScanDialog projectId={activeProject} projectName={data?.project?.name || ""} api={api} onClose={() => { setExploring(false); void load(); }} onApplied={load} />}
      <div className="amap-toolbar">
        <div className="amap-chips amap-projects" role="tablist" aria-label={tr("Projet")}>
          {projectList.map((project) => (
            <button key={project.id} className={`amap-chip ${project.id === activeProject ? "on" : ""}`} onClick={() => { setProjectId(project.id); onProjectChange?.(project.id); }}>{project.name}</button>
          ))}
        </div>
        {!room && <div className="amap-chips amap-types" aria-label={tr("Types de nœuds")}>
          {TYPES.map((type) => (
            <button key={type.id} className={`amap-chip ${filter === type.id ? "on" : ""}`} onClick={() => pickFilter(type.id)} aria-pressed={filter === type.id}><i className={`tone-${type.tone}`} />{type.label}{data ? <small>{data.nodes.filter((node) => matchesFilter(node, type.id)).length}</small> : null}</button>
          ))}
          <button className={`amap-chip paid ${filter === "paid" ? "on" : ""}`} onClick={() => pickFilter("paid")} aria-pressed={filter === "paid"} title={tr("Ce qui coûte de l'argent")}><b>$</b>{tr("Payants")}{data ? <small>{data.nodes.filter((node) => matchesFilter(node, "paid")).length}</small> : null}</button>
          <button className={`amap-chip ${filter === "archived" ? "on" : ""}`} onClick={() => pickFilter("archived")} aria-pressed={filter === "archived"}><i className="tone-archived" />{tr("Archivés")}{data ? <small>{data.nodes.filter((node) => node.archived).length}</small> : null}</button>
        </div>}
        <div className="amap-seg amap-mode" role="group" aria-label={tr("Affichage")}>
          <button className={!room ? "on" : ""} onClick={() => setMode("map")}>{tr("Carte")}</button>
          <button className={room ? "on" : ""} onClick={() => { setMode("room"); setSelectedId(null); }}><i className="amap-live-dot" aria-hidden="true" />{tr("Échanges")}</button>
        </div>
        {!room && <>
        <button className={`amap-explore ${data?.scan?.running ? "running" : ""}`} onClick={() => setExploring(true)} title={tr("Scanner le projet : clés .env (noms), APIs, SDK, services, crons")}>{tr("Explorer")}{data?.scan?.pending > 0 && <b>{data.scan.pending}</b>}</button>
        <input className="amap-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tr("Rechercher un nœud…")} aria-label={tr("Rechercher un nœud")} />
        </>}
        <div className="amap-seg" role="group" aria-label={tr("Fenêtre de temps")}>
          {["24h", "7d"].map((value) => <button key={value} className={span === value ? "on" : ""} onClick={() => setSpan(value)}>{value === "24h" ? "24 h" : tr("7 j")}</button>)}
        </div>
      </div>
      <div className="amap-body">
        {room && <ExchangeRoom items={roomItems} sessions={sessions} projects={projectList} scopeProject={roomScope === "all" ? null : activeProject} selected={roomAgent} onSelect={setRoomAgent} packets={roomPackets} />}
        <div className="amap-stage" hidden={room} ref={stage} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          {kpis && (
            <div className="amap-kpis">
              <div className="amap-kpi"><small>{tr("Agents actifs")}</small><b>{kpis.agents}</b><em className="run">{kpis.working ? `● ${kpis.working} en cours` : tr("au repos")}</em></div>
              <div className="amap-kpi"><small>{tr("Services · timers")}</small><b>{kpis.services}</b><em className={kpis.errors ? "err" : "ok"}>● {kpis.errors ? tr(kpis.errors > 1 ? "{0} erreurs" : "{0} erreur", kpis.errors) : tr("tout OK")}</em></div>
              <div className="amap-kpi"><small>{tr("Prochain run")}</small><b>{kpis.nextRun ? timeOf(kpis.nextRun.at) : "—"}</b><em>{kpis.nextRun ? shortLabel(kpis.nextRun.label, 18) : ""}</em></div>
              <div className="amap-kpi"><small>{tr("Messages")}{" "}{span === "7d" ? tr("7 j") : "24 h"}</small><b>{kpis.messages}</b><em>{visible.links.filter((link) => link.live).length}{" "}{tr("liens actifs")}</em></div>
            </div>
          )}
          <svg className="amap-svg" width={size.width} height={size.height} role="img" aria-label={tr("Carte des agents et services")}>
            <g className="amap-world" style={{ transform: `translate(${size.width / 2 + view.x + shift}px,${size.height / 2 + view.y}px) scale(${view.k})` }}>
              <g className="amap-orbits">
                <circle r={Math.min(size.width, size.height) * 0.21} />
                <circle r={Math.min(size.width * 0.47, Math.min(size.width, size.height) * 0.62)} />
              </g>
              {Object.entries(anchors).filter(([zone]) => zonesPresent.has(zone)).map(([zone, [x, y]]) => (
                <g key={zone} className={`amap-zone ${zone}`} transform={`translate(${x},${y})`}>
                  <circle r={Math.min(size.width, size.height) * 0.26} />
                  <text y={-Math.min(size.width, size.height) * 0.26 - 8}>{ZONE_LABELS[zone]}</text>
                </g>
              ))}
              <g className="amap-links">
                {visible.links.map((link) => {
                  const source = positions.get(link.source);
                  const target = positions.get(link.target);
                  if (!source || !target) return null;
                  const dim = neighbours && !(neighbours.has(link.source) && neighbours.has(link.target) && (link.source === focusId || link.target === focusId));
                  const width = 0.8 + Math.log2(1 + link.count) * 0.9;
                  const d = linkPath(source, target, link.kind);
                  return (
                    <g key={link.id} className={`amap-link tone-${linkTone(link)} ${link.kind} ${dim ? "dim" : ""} ${link.live ? "live" : ""}`}>
                      <path d={d} style={{ strokeWidth: width }} />
                      {link.live && <path className="amap-flow" d={d} style={{ strokeWidth: Math.max(1.2, width * 0.55) }} />}
                    </g>
                  );
                })}
              </g>
              <g className="amap-packets">
                {packets.map((packet) => {
                  const source = positions.get(packet.source);
                  const target = positions.get(packet.target);
                  if (!source || !target) return null;
                  return <circle key={packet.key} className="amap-packet" r={3.4}><animateMotion dur={`${PACKET_MS - 200}ms`} fill="freeze" path={linkPath(source, target, "message")} /></circle>;
                })}
              </g>
              <g className="amap-nodes">
                {visible.nodes.map((node) => {
                  const position = positions.get(node.id);
                  if (!position) return null;
                  const dim = (neighbours && !neighbours.has(node.id)) || (matches && !matches.has(node.id)) || (filter && !matchesFilter(node, filter) && node.type !== "founder");
                  const label = labels.get(node.id);
                  return (
                    <g
                      key={node.id}
                      className={`amap-node type-${node.type} ${node.status} ${node.archived ? "archived" : ""} ${node.paused ? "paused" : ""} ${node.gone ? "gone" : ""} ${dim ? "dim" : ""} ${selectedId === node.id ? "selected" : ""}`}
                      transform={`translate(${position.x},${position.y})`}
                      onPointerEnter={() => setHoverId(node.id)}
                      onPointerLeave={() => setHoverId((current) => (current === node.id ? null : current))}
                      onClick={(event) => { event.stopPropagation(); setSelectedId(node.id); setPanelOpen(true); }}
                      tabIndex={0}
                      role="button"
                      aria-label={`${TYPE_LABELS[node.type] || node.type} ${tr(node.label)}, ${STATUS_LABELS[node.status] || node.status}`}
                      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(node.id); } }}
                    >
                      {(node.status === "run" || node.status === "err") && <circle className={`amap-pulse ${node.status}`} r={position.r} />}
                      {selectedId === node.id && <circle className="amap-selection" r={position.r + 8} />}
                      <circle className="amap-hit" r={position.r + 6} />
                      <NodeShape node={node} r={position.r} />
                      {node.paid && <g className="amap-paid" transform={`translate(${-position.r * 0.78},${position.r * 0.72})`}><circle r={5.4} /><text dy="0.35em">$</text></g>}
                      {label && <text className="amap-label" x={label.x - position.x} y={label.y - position.y} textAnchor={label.anchor} style={{ fontSize: 11 / labelScale }}>{label.text}</text>}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
          {hovered && positions.get(hovered.id) && (() => {
            const position = positions.get(hovered.id);
            const left = size.width / 2 + view.x + shift + position.x * view.k + position.r * view.k + 12;
            const top = size.height / 2 + view.y + position.y * view.k - 18;
            const meta = hovered.meta || {};
            const detail = hovered.type === "agent"
              ? `${meta.inbound || 0} entrants · ${meta.outbound || 0} sortants${meta.lastMessageAt ? ` · ${relative(meta.lastMessageAt)}` : ""}`
              : meta.nextRun ? `prochain ${timeOf(meta.nextRun)}` : meta.lastRun ? tr("dernier run {0}", relative(meta.lastRun)) : meta.schedule || meta.host || "";
            return (
              <div className="amap-tip" style={{ left: Math.min(left, size.width - 230), top: Math.max(8, top) }}>
                <b>{hovered.label}</b> · {TYPE_LABELS[hovered.type] || hovered.type}
                <span className={`amap-tip-status ${hovered.status}`}>● {STATUS_LABELS[hovered.status]}{detail ? ` · ${detail}` : ""}</span>
              </div>
            );
          })()}
          <div className="amap-legend">
            {Object.entries(STATUS_LABELS).filter(([key]) => key !== "unknown").map(([key, value]) => <span key={key}><i className={`amap-dot ${key}`} />{value}</span>)}
            <span><i className="amap-dot paid">$</i>{tr("payant")}</span>
            <span className="amap-legend-note">{tr("lien animé = échange < 1 h · épaisseur = volume")}</span>
          </div>
          <div className="amap-zoom">
            <button onClick={() => setView((current) => ({ ...current, k: Math.min(3.2, current.k * 1.25) }))} aria-label={tr("Zoom avant")}>+</button>
            <button onClick={() => setView((current) => ({ ...current, k: Math.max(0.45, current.k / 1.25) }))} aria-label={tr("Zoom arrière")}>−</button>
            <button onClick={() => setView({ x: 0, y: 0, k: 1 })} aria-label={tr("Recentrer")}>⌖</button>
          </div>
          {!data && !error && <div className="amap-loading">{tr("Lecture des agents, services et messages…")}</div>}
          {error && <div className="amap-loading error">{error}</div>}
          {data && <div className="amap-updated">maj {timeOf(data.generatedAt)}{now - Date.parse(data.generatedAt) > REFRESH_MS * 3 ? tr(" · données anciennes") : ""}</div>}
        </div>
        {room
          ? <ExchangesPanel key={activeProject || "all"} activeProject={activeProject} projectName={data?.project?.name || ""} span={span} api={api} onOpenAgent={onOpenAgent} onFresh={onFreshExchanges} onItems={setRoomItems} onScope={setRoomScope} agentFilter={roomAgent} onClearAgent={() => setRoomAgent(null)} />
          : panelOpen ? (
          selected
            ? <DetailPanel key={selected.id} projectId={activeProject} span={span} node={selected} graph={graph} api={api} onBack={() => setSelectedId(null)} onCollapse={() => setPanelOpen(false)} onOpenAgent={onOpenAgent} onChanged={load} />
            : <ListPanel nodes={(data?.nodes || []).filter((node) => node.type !== "founder" && (filter === "archived" || !node.archived))} filter={filter} onClearFilter={() => setFilter(null)} onPick={focusNode} onCollapse={() => setPanelOpen(false)} />
        ) : (
          <button className="amap-panel-tab" onClick={() => setPanelOpen(true)} aria-label={tr("Afficher la liste")}><span>‹</span><b>{tr("Liste")}{data ? ` · ${filter ? data.nodes.filter((node) => matchesFilter(node, filter)).length : data.nodes.length - 1}` : ""}</b></button>
        )}
      </div>
    </section>
  );
}

export { computeLayout, placeLabels, initials, shortLabel };
