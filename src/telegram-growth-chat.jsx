import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./telegram-growth-chat.css";
import { tr } from "./i18n.js";

const STATE_LABELS = {
  active: tr("Actif"),
  running: tr("En cours"),
  stopping: tr("Arrêt en cours"),
  success: tr("Terminé"),
  error: tr("Erreur"),
  stopped: tr("Arrêté"),
};

const STATUS_LABELS = {
  sent: tr("Envoyé"),
  failed: tr("Échec d'envoi"),
  pending: tr("En attente"),
  received: tr("Reçu"),
  skipped: tr("Ignoré"),
  unknown: tr("Statut inconnu"),
};

const STATUS_ICONS = { sent: "✓", failed: "!", pending: "…", received: "↓", skipped: "–", unknown: "?" };
const AVATAR_TONES = ["green", "blue", "violet", "orange"];
const BOTTOM_THRESHOLD = 48;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function newMessageCount(previousIds, nextIds) {
  const previous = new Set(previousIds);
  return nextIds.filter((id) => !previous.has(id)).length;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return tr("Aujourd'hui");
  if (dayKey(date) === dayKey(yesterday)) return tr("Hier");
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeLabel(date) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fullLabel(date) {
  return date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "medium" });
}

function initials(name) {
  const words = String(name || "").replace(/^@/, "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

function toneFor(name) {
  let hash = 0;
  for (const char of String(name || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function normalizeDirection(direction) {
  return direction === "outgoing" || direction === "system" ? direction : "incoming";
}

function normalizeStatus(status) {
  return STATUS_LABELS[status] ? status : "unknown";
}

// Builds render rows: day separators + messages flagged as continuation of previous bubble group.
function buildRows(messages) {
  const rows = [];
  let lastDay = null;
  let prev = null;
  messages.forEach((message, index) => {
    const date = parseDate(message?.timestamp);
    const direction = normalizeDirection(message?.direction);
    if (date && dayKey(date) !== lastDay) {
      lastDay = dayKey(date);
      rows.push({ type: "day", key: `day-${lastDay}`, date });
      prev = null;
    }
    const sender = message?.sender || (direction === "outgoing" ? tr("Vous") : tr("Inconnu"));
    const chat = message?.chat || "";
    const continued = Boolean(
      prev && direction !== "system" && prev.direction === direction && prev.sender === sender && prev.chat === chat
      && (!date || !prev.date || Math.abs(date - prev.date) < GROUP_WINDOW_MS),
    );
    const row = {
      type: "message",
      key: message?.id != null ? `msg-${message.id}` : `msg-idx-${index}`,
      text: message?.text == null ? "" : String(message.text),
      sender,
      chat,
      date,
      direction,
      status: normalizeStatus(message?.status),
      continued,
    };
    rows.push(row);
    prev = row;
  });
  return rows;
}

function TelegramMark() {
  return (
    <svg className="tgc-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21.4 4.2 2.9 11.3c-1.1.4-1.1 1.1-.2 1.4l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.5-1.5Zm-3.3 3.4-8.6 7.8-.3 3.6-1.6-5 9.9-6.3c.5-.3.9-.1.6-.1Z" />
    </svg>
  );
}

function Timestamp({ date }) {
  if (!date) return <span className="tgc-time">{tr("Heure inconnue")}</span>;
  return <time className="tgc-time" dateTime={date.toISOString()} title={fullLabel(date)}>{timeLabel(date)}</time>;
}

function MessageRow({ row }) {
  if (row.direction === "system") {
    return (
      <li className="tgc-system">
        <span className="tgc-system-text">{row.text || tr("Événement système")}</span>
        <Timestamp date={row.date} />
      </li>
    );
  }
  const outgoing = row.direction === "outgoing";
  return (
    <li className={`tgc-row tgc-${row.direction}${row.continued ? " tgc-continued" : ""}`}>
      {row.continued ? (
        <span className="tgc-avatar-spacer" aria-hidden="true" />
      ) : (
        <span className={`tgc-avatar tgc-tone-${toneFor(row.sender)}`} aria-hidden="true">{initials(row.sender)}</span>
      )}
      <article className={`tgc-bubble tgc-status-${row.status}`} aria-label={tr("Message de {0}{1}", row.sender, row.chat ? ` · ${row.chat}` : "")}>
        {!row.continued && (
          <header className="tgc-meta">
            <strong className="tgc-sender">{row.sender}</strong>
            {row.chat && (
              <span className="tgc-chat">
                <span className="tgc-sr">{outgoing ? "vers" : "dans"} </span>
                <span aria-hidden="true">{outgoing ? "→ " : "# "}</span>
                {row.chat}
              </span>
            )}
          </header>
        )}
        <p className="tgc-text">{row.text || <em className="tgc-empty-text">{tr("Message sans texte")}</em>}</p>
        <footer className="tgc-foot">
          <Timestamp date={row.date} />
          <span className="tgc-status">
            <span className="tgc-status-icon" aria-hidden="true">{STATUS_ICONS[row.status]}</span>
            {STATUS_LABELS[row.status]}
          </span>
        </footer>
      </article>
    </li>
  );
}

function dayFromKey(key) {
  const [year, month, day] = String(key || "").split("-").map(Number);
  return year ? new Date(year, month - 1, day) : null;
}

// Une journee affichee du plus recent au plus ancien; le flux vivant = dernier jour, les autres jours sont charges a la demande.
export default function TelegramGrowthChat({ title = tr("Telegram Growth"), messages = [], day = null, prevDay = null, nextDay = null, latestDay = null, onDay = null, state, phase, current, nextAt }) {
  const live = Array.isArray(messages) ? messages : [];
  const [page, setPage] = useState(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [dayError, setDayError] = useState("");
  const view = page || { messages: live, day, prevDay, nextDay };
  const list = Array.isArray(view.messages) ? view.messages : [];
  const rows = useMemo(() => buildRows([...list].reverse()).filter((row) => row.type === "message"), [list]);
  const logRef = useRef(null);
  const atTopRef = useRef(true);
  const seenRef = useRef(null);
  const [unseen, setUnseen] = useState(0);

  async function goDay(target) {
    if (!target || !onDay || loadingDay) return;
    setDayError("");
    // Retour au jour vivant: on reprend le flux rafraichi plutot qu'une copie figee.
    if (target === day) { setPage(null); return; }
    setLoadingDay(true);
    try {
      const next = await onDay(target);
      setPage(next?.day === (latestDay || day) ? null : next);
      seenRef.current = null;
      setUnseen(0);
      if (logRef.current) logRef.current.scrollTop = 0;
    } catch (error) {
      setDayError(error?.message || tr("Chargement impossible"));
    } finally {
      setLoadingDay(false);
    }
  }

  const scrollToTop = useCallback((smooth) => {
    const el = logRef.current;
    if (!el) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: 0, behavior: smooth && !reduced ? "smooth" : "auto" });
    atTopRef.current = true;
    setUnseen(0);
  }, []);

  const onScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atTop = el.scrollTop <= BOTTOM_THRESHOLD;
    atTopRef.current = atTop;
    if (atTop) setUnseen(0);
  }, []);

  useLayoutEffect(() => {
    const ids = rows.map((row) => row.key);
    const previous = seenRef.current;
    seenRef.current = ids;
    if (page) return;
    const added = newMessageCount(previous || [], ids);
    if (atTopRef.current || previous === null) scrollToTop(false);
    else if (added) setUnseen((value) => value + added);
  }, [rows, page, scrollToTop]);

  const stateKey = STATE_LABELS[state] ? state : "idle";
  const next = parseDate(nextAt);
  const details = [phase, current].filter((value) => value != null && String(value).trim() !== "");
  const shownDay = dayFromKey(view.day);

  return (
    <section className="tgc" aria-label={`Messagerie ${title}`}>
      <header className="tgc-head">
        <span className="tgc-logo"><TelegramMark /></span>
        <div className="tgc-title">
          <h3>{title}</h3>
          <p>
            {details.length ? details.map(String).join(" · ") : tr("Historique des messages · Lecture seule")}
            {next && (
              <>
                {" · "}{tr("Prochaine action")}{" "}<time dateTime={next.toISOString()} title={fullLabel(next)}>{timeLabel(next)}</time>
              </>
            )}
          </p>
        </div>
        <span className={`tgc-badge tgc-badge-${stateKey}`} role="status">
          <span className="tgc-dot" aria-hidden="true" />
          {STATE_LABELS[state] || tr("Inactif")}
        </span>
      </header>

      {onDay && shownDay && (
        <nav className="tgc-daynav" aria-label={tr("Changer de jour")}>
          <button type="button" onClick={() => goDay(view.prevDay)} disabled={!view.prevDay || loadingDay} aria-label={tr("Jour précédent")} title={tr("Jour précédent")}>←</button>
          <span>{loadingDay ? tr("Chargement…") : dayLabel(shownDay)}{page && <small>{" "}{tr("· historique")}</small>}</span>
          <button type="button" onClick={() => goDay(view.nextDay)} disabled={!view.nextDay || loadingDay} aria-label={tr("Jour suivant")} title={tr("Jour suivant")}>→</button>
        </nav>
      )}
      {dayError && <p className="tgc-day-error" role="alert">{dayError}</p>}

      <div className="tgc-body">
        {rows.length === 0 ? (
          <p className="tgc-empty">{tr("Aucun message disponible")}</p>
        ) : (
          <ol
            ref={logRef}
            className="tgc-log"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label={tr("Historique des messages {0}", title)}
            tabIndex={0}
            onScroll={onScroll}
          >
            {rows.map((row) => <MessageRow key={row.key} row={row} />)}
          </ol>
        )}
        {unseen > 0 && (
          <button type="button" className="tgc-jump" onClick={() => scrollToTop(true)}>
            <span aria-hidden="true">↑</span> {unseen} nouveau{unseen > 1 ? "x" : ""} {tr(unseen > 1 ? "messages" : "message")}
          </button>
        )}
      </div>
    </section>
  );
}
