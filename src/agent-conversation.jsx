import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./agent-conversation.css";
import { AppIcon } from "./app-icon.jsx";
import {
  ProjectFilePreviewModal,
  detectProjectFiles,
  getFileIcon,
  getFileCategory,
  getFileBadgeClass,
  formatFileBytes,
  downloadProjectFile
} from "./project-file-preview.jsx";
import { reformulateRequest, fallbackRecap, findMatchingTodo } from "./request-reformulate.js";
import { tr, LOCALE } from "./i18n.js";

export { reformulateRequest, fallbackRecap, findMatchingTodo };

export function AgentConversation({ session, connected, api, onSubmit, onForceSubmit, onStop, onRestart, onTerminal, agents = [], restarting, onTagTodo, onCreateNote, onDictation, insertRequest, onInsertConsumed, draftStore, held = 0, queued = 0 }) {
  const [messages, setMessages] = useState([]); const [pendingMessages, setPendingMessages] = useState([]); const [available, setAvailable] = useState(null);
  const [error, setError] = useState(""); const [activity, setActivity] = useState(""); const [draft, setDraft] = useState(""); const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState([]); const [queue, setQueue] = useState([]); const [agentPicker, setAgentPicker] = useState(false); const [agentQuery, setAgentQuery] = useState("");
  const input = useRef(null); const sendTouch = useRef(null); const scroll = useRef(null); const bottomAnchor = useRef(null); const stick = useRef(true); const drainingRef = useRef(false);
  const timelineListRef = useRef(null); const timelineStick = useRef(true);
  const currentSession = useRef(session.id); currentSession.current = session.id;
  const savedDrafts = useRef(new Map()); const lastInsert = useRef(null); const store = draftStore || savedDrafts.current;

  const [projectFiles, setProjectFiles] = useState([]);
  const [previewingFile, setPreviewingFile] = useState(null);
  const projectId = session.projectId || session.project?.id || "";

  const [forcedIds, setForcedIds] = useState(new Set());
  const [expandedId, setExpandedId] = useState(null);
  const [recaps, setRecaps] = useState({});
  const [showRawText, setShowRawText] = useState({});
  const [timelineOpen, setTimelineOpen] = useState(() => (typeof window !== "undefined" ? window.innerWidth > 900 : true));
  const [todos, setTodos] = useState([]);

  const loadRecap = useCallback(async (item) => {
    if (!item?.id || !item?.text) return;
    if (recaps[item.id]?.ai) return;

    const instantBullets = item.bullets || fallbackRecap(item.text, item.todo);
    setRecaps((prev) => ({
      ...prev,
      [item.id]: prev[item.id] || { bullets: instantBullets },
    }));

    try {
      const res = await api("/api/agent/recap-prompt", {
        method: "POST",
        body: JSON.stringify({ text: item.text }),
      });
      if (res?.bullets?.length) {
        setRecaps((prev) => ({
          ...prev,
          [item.id]: { bullets: res.bullets, ai: true },
        }));
      }
    } catch {
      // Ignorer : le récap instantané reste affiché
    }
  }, [api, recaps]);

  const loadTodos = useCallback(async () => {
    try {
      const res = await api("/api/todos");
      setTodos(res?.todos || []);
    } catch {
      // Ignorer
    }
  }, [api]);

  useEffect(() => {
    loadTodos();
    const onTodosChanged = () => loadTodos();
    window.addEventListener("noyau:todos", onTodosChanged);
    return () => window.removeEventListener("noyau:todos", onTodosChanged);
  }, [loadTodos]);

  const openTodoInView = useCallback((todo) => {
    if (!todo) return;
    try {
      sessionStorage.setItem("noyau-target-todo", JSON.stringify({
        id: todo.id,
        ref: todo.ref,
        status: todo.status,
        folderId: todo.folderId || null,
      }));
    } catch {}
    window.dispatchEvent(
      new CustomEvent("noyau:navigate-todo", {
        detail: {
          id: todo.id,
          ref: todo.ref,
          status: todo.status,
          folderId: todo.folderId || null,
        },
      })
    );
  }, []);

  const toggleTodo = useCallback(async (todo) => {
    if (!todo?.id) return;
    const nextStatus = todo.status === "done" ? "todo" : "done";
    try {
      await api(`/api/todos/${encodeURIComponent(todo.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, status: nextStatus } : t)));
      window.dispatchEvent(new Event("noyau:todos"));
    } catch (err) {
      window.alert(err.message || tr("Erreur mise à jour tâche"));
    }
  }, [api]);

  function handleForceSend(msg) {
    if (!msg?.id || forcedIds.has(msg.id)) return;
    setForcedIds((prev) => new Set([...prev, msg.id]));
    onForceSubmit?.(msg.text);
  }

  const scrollToMessage = useCallback((id) => {
    if (!scroll.current || !id) return;
    stick.current = false;
    const allArticles = scroll.current.querySelectorAll("article[data-chat-id]");
    let target = null;
    for (const art of allArticles) {
      if (art.getAttribute("data-chat-id") === String(id)) {
        target = art;
        break;
      }
    }
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("highlight-targeted");
      void target.offsetWidth;
      target.classList.add("highlight-targeted");
      setTimeout(() => {
        target.classList.remove("highlight-targeted");
      }, 1000);
    }
  }, []);



  const loadProjectFiles = useCallback(async () => {
    try {
      // Agent sans projet: ses fichiers partagés atterrissent dans un projet voisin, on cherche partout.
      const ids = projectId ? [projectId] : ((await api("/api/projects")).projects || []).map((project) => project.id);
      const lists = await Promise.all(ids.map((id) => api(`/api/projects/${encodeURIComponent(id)}/files`).then((res) => (res.files || []).map((file) => ({ ...file, projectId: id })), () => [])));
      setProjectFiles(lists.flat());
    } catch {
      // Ignorer
    }
  }, [projectId, api]);

  useEffect(() => {
    loadProjectFiles();
    const onFilesChanged = () => loadProjectFiles();
    window.addEventListener("noyau:files", onFilesChanged);
    return () => window.removeEventListener("noyau:files", onFilesChanged);
  }, [loadProjectFiles]);

  useEffect(() => {
    if (messages.length > 0) {
      loadProjectFiles();
    }
  }, [messages.length, loadProjectFiles]);

  function updateDraft(value) { setDraft(value); store.set(session.id, { ...(store.get(session.id) || {}), draft: value }); }
  function updateAttachments(value) { setAttachments((old) => { const next = typeof value === "function" ? value(old) : value; store.set(session.id, { ...(store.get(session.id) || {}), attachments: next }); return next; }); }
  function updateQueue(value) { setQueue((old) => { const next = typeof value === "function" ? value(old) : value; store.set(session.id, { ...(store.get(session.id) || {}), queue: next }); return next; }); }

  function scrollToBottom(smooth = false) {
    stick.current = true;
    if (scroll.current) {
      if (smooth && typeof scroll.current.scrollTo === "function") {
        scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
      } else {
        scroll.current.scrollTop = scroll.current.scrollHeight;
      }
    }
    if (bottomAnchor.current?.scrollIntoView) {
      try {
        bottomAnchor.current.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
      } catch {}
    }
  }

  function registerPendingPrompt(text) {
    const existingCount = messages.filter((m) => m.direction === "in" && m.text?.trim() === text.trim()).length;
    const newMsg = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      direction: "in",
      from: tr("Vous"),
      text,
      at: new Date().toISOString(),
      pending: true,
      createdAt: Date.now(),
      existingCount,
    };
    setPendingMessages((old) => [...old, newMsg]);
    scrollToBottom(false);
    requestAnimationFrame(() => {
      scrollToBottom(false);
      setTimeout(() => scrollToBottom(false), 50);
      setTimeout(() => scrollToBottom(false), 220);
    });
  }

  useEffect(() => {
    const saved = store.get(session.id);
    setDraft(saved?.draft || "");
    setAttachments(saved?.attachments || []);
    setQueue(saved?.queue || []);
    setMessages([]);
    setPendingMessages([]);
    setAvailable(null);
    setError("");
    setActivity("");
    setAgentPicker(false);
    setAgentQuery("");
    stick.current = true;
  }, [session.id, store]);

  useEffect(() => {
    if (!insertRequest || insertRequest.sessionId !== session.id || lastInsert.current === insertRequest.id) return;
    lastInsert.current = insertRequest.id;
    setDraft((old) => { const next = `${old}${old && !/\s$/.test(old) ? " " : ""}${insertRequest.text}`; store.set(session.id, { ...(store.get(session.id) || {}), draft: next }); return next; });
    input.current?.focus();
    onInsertConsumed?.();
  }, [insertRequest, session.id, store, onInsertConsumed]);

  useEffect(() => {
    let alive = true; let pending = false;
    async function refresh() {
      if (pending) return; pending = true;
      try {
        const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/conversation`);
        if (alive) {
          const serverList = result.messages || [];
          setMessages(serverList);
          setAvailable(result.available);
          setActivity(result.activity || "");
          setError("");
          setPendingMessages((prev) => {
            if (!prev.length) return prev;
            const now = Date.now();
            return prev.filter((p) => {
              if (now - p.createdAt > 45000) return false;
              const currentCount = serverList.filter(
                (m) => m.direction === "in" && m.text?.trim() === p.text?.trim()
              ).length;
              return currentCount <= (p.existingCount || 0);
            });
          });
        }
      } catch (reason) { if (alive) setError(reason.message); }
      finally { pending = false; }
    }
    refresh(); const timer = setInterval(refresh, 3500); return () => { alive = false; clearInterval(timer); };
  }, [session.id, api]);

  const displayMessages = useMemo(() => {
    return [...messages, ...pendingMessages].map((m, idx) => ({
      ...m,
      stableId: m.id || `msg-${m.direction || "u"}-${idx}-${String(m.at ?? "").replace(/[^a-zA-Z0-9]/g, "_")}`,
    }));
  }, [messages, pendingMessages]);

  useEffect(() => {
    if (stick.current) {
      scrollToBottom();
    }
  }, [displayMessages.length, session.agentStatus?.state, queue.length, activity]);

  const scrollTimelineToBottom = useCallback(() => {
    if (timelineListRef.current) {
      timelineListRef.current.scrollTop = timelineListRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    timelineStick.current = true;
    const raf = requestAnimationFrame(() => {
      scrollTimelineToBottom();
      setTimeout(scrollTimelineToBottom, 80);
    });
    return () => cancelAnimationFrame(raf);
  }, [session.id, scrollTimelineToBottom]);

  useEffect(() => {
    if (timelineStick.current) {
      const raf = requestAnimationFrame(scrollTimelineToBottom);
      return () => cancelAnimationFrame(raf);
    }
  }, [displayMessages.length, timelineOpen, scrollTimelineToBottom]);

  // Dépilement automatique dès que l'agent redevient disponible
  useEffect(() => {
    if (session.agentStatus?.state !== "working" && connected && queue.length > 0 && !drainingRef.current) {
      drainingRef.current = true;
      const nextItem = queue[0];
      updateQueue((old) => old.slice(1));
      onSubmit(nextItem.text);
      registerPendingPrompt(nextItem.text);
      const timer = setTimeout(() => { drainingRef.current = false; }, 900);
      return () => clearTimeout(timer);
    }
  }, [session.agentStatus?.state, connected, queue.length, onSubmit, messages]);

  async function addFiles(files) {
    if (!files.length || uploading) return; const uploadSession = session.id; setUploading(true); setError("");
    try {
      for (const file of files) {
        if (file.size > 500 * 1024 * 1024) throw new Error(tr("Fichier trop volumineux (maximum 500 Mo)."));
        const form = new FormData(); form.append("file", file); form.append("sessionId", session.id);
        const result = await api("/api/uploads/file", { method: "POST", body: form });
        if (currentSession.current !== uploadSession) break;
        updateAttachments((old) => [...old, { name: file.name, path: result.path }]);
      }
    } catch (reason) { setError(reason.message); } finally { setUploading(false); }
  }

  function editQueueItem(index) {
    const item = queue[index];
    if (!item) return;
    updateQueue((old) => old.filter((_, i) => i !== index));
    updateDraft(item.text);
    input.current?.focus();
  }

  function cancelQueueItem(index) {
    updateQueue((old) => old.filter((_, i) => i !== index));
  }

  function sendQueueItemNow(index) {
    const item = queue[index];
    if (!item) return;
    updateQueue((old) => old.filter((_, i) => i !== index));
    onSubmit(item.text);
    registerPendingPrompt(item.text);
  }

  function enqueueDraft() {
    const attachmentText = attachments.map((file) => tr("Fichier joint : {0}", file.path)).join("\n");
    const text = [draft.trim(), attachmentText].filter(Boolean).join("\n\n");
    if (!text || text.length > 16384) return;
    updateQueue((old) => [...old, { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }]);
    updateDraft("");
    updateAttachments([]);
    input.current?.blur();
    stick.current = true;
  }

  function send(event) {
    event?.preventDefault?.();
    const attachmentText = attachments.map((file) => tr("Fichier joint : {0}", file.path)).join("\n");
    const text = [draft.trim(), attachmentText].filter(Boolean).join("\n\n");
    if (!text || text.length > 16384 || !connected || uploading) return;
    input.current?.blur();
    onSubmit(text);
    registerPendingPrompt(text);
    updateDraft("");
    updateAttachments([]);
  }

  const QUOTA_PATTERN = /usage limit|limite d'utilisation|rate limit|individual quota reached|resource_exhausted|quota (atteint|reached|exceeded|depasse|dépassé)|try again (at|in)|upgrade (to pro|your subscription)|plan limit|out of credits/i;
  const lastAssistantMsg = messages.slice().reverse().find((m) => m.direction === "out");
  const quotaExhausted = Boolean(session.quotaExhausted || session.agentStatus?.state === "exhausted" || (activity && QUOTA_PATTERN.test(activity)) || (lastAssistantMsg && QUOTA_PATTERN.test(lastAssistantMsg.text)));

  // Détection du dernier message utilisateur envoyé pour lequel l'agent travaille actuellement
  const lastUserMsgIndex = displayMessages.map((m) => m.direction).lastIndexOf("in");
  const isWorkingOnLastMsg = session.agentStatus?.state === "working" && lastUserMsgIndex !== -1 && lastUserMsgIndex > displayMessages.map((m) => m.direction).lastIndexOf("out");

  const timelineItems = useMemo(() => {
    const userMsgs = displayMessages.filter((m) => m.direction === "in" && !m.kind?.includes("agent"));
    const last10 = userMsgs.slice(-10);

    return last10.map((uMsg, idx) => {
      const uIdx = displayMessages.indexOf(uMsg);
      const isLastUserMsg = uIdx === lastUserMsgIndex;
      const following = displayMessages.slice(uIdx + 1);
      const nextUIdx = following.findIndex((m) => m.direction === "in");
      const relatedOut = (nextUIdx === -1 ? following : following.slice(0, nextUIdx)).filter((m) => m.direction === "out");
      const lastRelatedOut = relatedOut[relatedOut.length - 1];

      let status = "done";
      let statusLabel = tr("Demande traitée");

      if (uMsg.pending || (isLastUserMsg && session.agentStatus?.state === "working")) {
        status = "working";
        statusLabel = tr("En cours de traitement");
      } else if (isLastUserMsg && session.agentStatus?.state === "waiting") {
        status = "question";
        statusLabel = tr("En attente de réponse");
      } else if (lastRelatedOut && /\?\s*$/.test(lastRelatedOut.text?.trim() || "") && isLastUserMsg) {
        status = "question";
        statusLabel = tr("Question posée par l'agent");
      } else if (!relatedOut.length && !uMsg.pending) {
        status = isLastUserMsg ? "working" : "done";
        statusLabel = isLastUserMsg ? tr("En attente de prise en charge") : tr("Envoyé");
      }

      const matchedTodo = findMatchingTodo(uMsg.text, todos, projectId);

      return {
        id: uMsg.stableId,
        text: uMsg.text,
        title: reformulateRequest(uMsg.text, matchedTodo),
        bullets: fallbackRecap(uMsg.text, matchedTodo),
        at: uMsg.at,
        status,
        statusLabel,
        todo: matchedTodo,
      };
    });
  }, [displayMessages, lastUserMsgIndex, session.agentStatus?.state, todos, projectId]);

  return <section className="agent-conversation" aria-label={tr("Conversation avec {0}", session.name)}>
    <div className="agent-chat-layout">
      <div className="agent-chat-feed" ref={scroll} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
        {available && displayMessages.length > 0 && <div className="agent-chat-history-note">{tr("Historique récent · les messages plus anciens peuvent manquer")}</div>}
        {available !== null && displayMessages.length === 0 && <div className="agent-chat-empty"><b>{tr("Conversation avec")}{" "}{session.name}</b><p>{tr("Envoie un message pour commencer.")}</p></div>}
        {displayMessages.map((message, index) => {
          const isCurrentExecutingPrompt = isWorkingOnLastMsg && index === lastUserMsgIndex;
          const mentionedFiles = message.direction === "out" ? detectProjectFiles(message.text, projectFiles) : [];
          return <article data-chat-id={message.stableId} className={`agent-chat-message ${message.direction === "in" ? "user" : "assistant"}${message.pending ? " pending" : ""}`} key={message.stableId}>
            <div className="agent-chat-meta">
              <span className={`agent-chat-avatar ${message.direction === "in" ? "user" : "assistant"}`} aria-hidden="true">{message.direction === "in" ? (message.from ? message.from.slice(0, 1).toUpperCase() : "V") : <AppIcon name="chat" size={13}/>}</span>
              <strong>{message.direction === "in" ? message.from || tr("Vous") : session.name}</strong>
              <span className="agent-chat-role">{message.direction === "in" ? (message.kind === "agent" ? tr("Agent") : tr("Vous")) : tr("Assistant")}</span>
              {message.pending ? (
                <span className="agent-chat-pending-wrap">
                  <small className="agent-chat-pending-tag">{" "}{tr("· Envoi en cours…")}</small>
                  <button
                    type="button"
                    className="agent-chat-send-now-btn"
                    onClick={() => handleForceSend(message)}
                    disabled={forcedIds.has(message.id)}
                    title={tr("Forcer l'envoi immédiat à l'agent sans délai")}
                    aria-label={tr("Forcer l'envoi immédiat")}
                  >
                    <AppIcon name="arrowUp" size={11} />
                    <span>{forcedIds.has(message.id) ? tr("Envoyé") : tr("Send now")}</span>
                  </button>
                </span>
              ) : (message.at ? ` · ${new Date(message.at).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "")}
            </div>
            <div className="agent-chat-bubble">
              {message.direction === "out" ? (
                <div className="agent-chat-markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{
                      a: ({ node, ...props }) => {
                        const href = props.href || "";
                        const text = typeof props.children === "string" ? props.children : "";
                        const matchingFile = projectFiles.find((f) => {
                          if (!f?.name) return false;
                          const lowerName = f.name.toLowerCase();
                          return (
                            href.toLowerCase().endsWith(lowerName) ||
                            href.toLowerCase().includes(`/files/${lowerName}`) ||
                            text.toLowerCase().trim() === lowerName
                          );
                        });
                        if (matchingFile) {
                          return (
                            <a
                              {...props}
                              href={props.href || "#"}
                              className="agent-chat-inline-file-link"
                              onClick={(e) => {
                                e.preventDefault();
                                setPreviewingFile(matchingFile);
                              }}
                              title={tr("Aperçu direct de {0}", matchingFile.name)}
                            >
                              <AppIcon name="eye" size={12} />
                              {props.children}
                            </a>
                          );
                        }
                        return <a {...props} target="_blank" rel="noopener noreferrer" />;
                      }
                    }}
                  >
                    {message.text}
                  </ReactMarkdown>
                </div>
              ) : message.text}
              {message.truncated && <small>{" "}{tr("· Texte tronqué")}</small>}
              {mentionedFiles.length > 0 && (
                <div className="agent-chat-shared-files" aria-label={tr("Fichiers partagés mentionnés")}>
                  <div className="agent-chat-shared-files-head">
                    <AppIcon name="folder" size={13} />
                    <span>{mentionedFiles.length === 1 ? tr("Fichier partagé disponible") : tr("Fichiers partagés disponibles")}</span>
                  </div>
                  <div className="agent-chat-shared-files-list">
                    {mentionedFiles.map((f) => {
                      const cat = getFileCategory(f.extension);
                      const token = typeof localStorage !== "undefined" ? (localStorage.getItem("noyau:token") || localStorage.getItem("token")) : "";
                      const profileId = typeof localStorage !== "undefined" ? localStorage.getItem("noyau:profile") : "";
                      const thumbUrl = cat === "image" ? `/api/projects/${encodeURIComponent(f.projectId || projectId)}/files/${encodeURIComponent(f.name)}?inline=1${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}${token ? `&token=${encodeURIComponent(token)}` : ""}` : null;
                      return (
                        <div
                          key={f.name}
                          className="agent-chat-file-card"
                          onClick={() => setPreviewingFile(f)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setPreviewingFile(f);
                            }
                          }}
                        >
                          {thumbUrl ? (
                            <div className="agent-chat-file-thumb">
                              <img src={thumbUrl} alt={f.name} loading="lazy" />
                            </div>
                          ) : (
                            <div className={`agent-chat-file-badge ${getFileBadgeClass(f.extension)}`}>
                              {getFileIcon(f.extension)}
                            </div>
                          )}
                          <div className="agent-chat-file-details">
                            <span className="agent-chat-file-name" title={f.name}>{f.name}</span>
                            <span className="agent-chat-file-size">{formatFileBytes(f.size)}</span>
                          </div>
                          <div className="agent-chat-file-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="agent-chat-file-btn primary"
                              title={tr("Aperçu direct")}
                              aria-label={tr("Aperçu direct de {0}", f.name)}
                              onClick={() => setPreviewingFile(f)}
                            >
                              <AppIcon name="eye" size={14} />
                              <span>{tr("Voir")}</span>
                            </button>
                            <button
                              type="button"
                              className="agent-chat-file-btn"
                              title={tr("Télécharger")}
                              aria-label={tr("Télécharger {0}", f.name)}
                              onClick={() => downloadProjectFile(f.projectId || projectId, f.name)}
                            >
                              <AppIcon name="download" size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="agent-chat-message-actions">
              {isCurrentExecutingPrompt && onStop && <button type="button" className="agent-chat-msg-cancel" aria-label={tr("Annuler la réponse")} title={tr("Arrêter la réponse de l’agent")} onClick={onStop}><AppIcon name="stop" size={15}/> <span>{tr("Annuler")}</span></button>}
              {message.direction === "in" && message.kind !== "agent" && !message.truncated && !isCurrentExecutingPrompt && !message.pending && <button type="button" aria-label={tr("Réutiliser le message")} title={tr("Réutiliser dans un nouveau message")} onClick={() => { updateDraft(message.text); input.current?.focus(); }}><AppIcon name="edit" size={15}/></button>}
              {message.direction === "out" && typeof speechSynthesis !== "undefined" && <button type="button" onClick={() => { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(message.text); u.lang = LOCALE; speechSynthesis.speak(u); }} aria-label={tr("Lire la réponse")} title={tr("Lire la réponse")}><AppIcon name="volume" size={15}/></button>}
            </div>
          </article>;
        })}
        {quotaExhausted && <div className="agent-chat-quota-alert" role="alert"><span className="agent-chat-quota-icon"><AppIcon name="lock" size={18}/></span><div className="agent-chat-quota-text"><strong>{tr("Limite de quota atteinte")}</strong><p>{tr("L’agent a atteint son plafond d’utilisation (")}{session.assistant}{tr("). Vous pouvez basculer de moteur ou attendre la réinitialisation.")}</p></div></div>}
        {session.agentStatus?.state === "working" && <div className="agent-chat-progress working"><span className="agent-chat-pulse working" /> {session.name} travaille <button type="button" aria-label={tr("Voir activité en direct")} title={tr("Voir activité en direct")} onClick={onTerminal}><AppIcon name="terminal" size={16}/></button><button type="button" aria-label={tr("Arrêter la réponse")} title={tr("Arrêter la réponse")} onClick={onStop}><AppIcon name="stop" size={16}/></button></div>}
        {session.agentStatus?.state === "working" && activity && <pre className="agent-chat-live" aria-label={tr("Activité en direct")}>{activity}</pre>}
        {session.agentStatus?.state === "waiting" && <div className="agent-chat-progress waiting"><span className="agent-chat-pulse waiting" /> {session.name}{" "}{tr("attend une réponse")}</div>}
        <div ref={bottomAnchor} className="agent-chat-anchor" aria-hidden="true" />
      </div>

      {timelineOpen && (
        <div
          className="agent-chat-timeline-backdrop"
          onClick={() => setTimelineOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside className={`agent-chat-timeline-sidebar ${timelineOpen ? "open" : "collapsed"}`} aria-label={tr("Sommaire des 10 dernières demandes")}>
        <header className="agent-chat-timeline-head">
          <button
            type="button"
            className="agent-chat-timeline-toggle-btn"
            onClick={() => setTimelineOpen((v) => !v)}
            title={timelineOpen ? tr("Masquer le sommaire") : tr("Afficher le sommaire des demandes")}
            aria-label={tr("Basculer sommaire")}
          >
            {timelineOpen ? (
              <>
                <AppIcon name="task" size={13} />
                <strong>{tr("Demandes (")}{timelineItems.length})</strong>
                <span className="agent-chat-timeline-collapse-icon">›</span>
              </>
            ) : (
              <>
                <span className="agent-chat-timeline-open-arrow">‹</span>
                <span className="agent-chat-timeline-badge">{timelineItems.length}</span>
              </>
            )}
          </button>
        </header>
        {timelineOpen && (
          <div
            className="agent-chat-timeline-list"
            ref={timelineListRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              timelineStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            }}
          >
            {timelineItems.map((item) => {
              const isExpanded = expandedId === item.id;
              return (
                <div
                  key={item.id}
                  className={`agent-chat-timeline-item ${item.status}`}
                  onClick={() => {
                    scrollToMessage(item.id);
                    if (typeof window !== "undefined" && window.innerWidth <= 900) {
                      setTimelineOpen(false);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      scrollToMessage(item.id);
                      if (typeof window !== "undefined" && window.innerWidth <= 900) {
                        setTimelineOpen(false);
                      }
                    }
                  }}
                  title={item.text}
                >
                  <div className="agent-chat-timeline-top">
                    <span className={`agent-chat-timeline-status-dot ${item.status}`} title={item.statusLabel}>
                      {item.status === "working" && <span className="agent-chat-timeline-spin" />}
                      {item.status === "question" && "?"}
                      {item.status === "done" && "✓"}
                    </span>
                    <span className="agent-chat-timeline-text" title={item.text}>{item.title}</span>
                    <button
                      type="button"
                      className="agent-chat-timeline-read-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = expandedId === item.id ? null : item.id;
                        setExpandedId(next);
                        if (next) loadRecap(item);
                      }}
                      title={isExpanded ? tr("Masquer le récapitulatif") : tr("Lire le récapitulatif IA")}
                      aria-label={tr("Récapitulatif de la demande")}
                    >
                      {isExpanded ? tr("Masquer") : tr("Récap")}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="agent-chat-timeline-full-prompt" onClick={(e) => e.stopPropagation()}>
                      <div className="agent-chat-timeline-recap-head">
                        <span className="agent-chat-timeline-recap-title">{tr("✨ Récapitulatif IA")}</span>
                        <button
                          type="button"
                          className="agent-chat-timeline-raw-toggle"
                          onClick={() => setShowRawText((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                          title={tr("Basculer entre récapitulatif structuré et message brut")}
                        >
                          {showRawText[item.id] ? tr("Voir récap") : tr("Texte brut")}
                        </button>
                      </div>
                      {showRawText[item.id] ? (
                        <div className="agent-chat-timeline-raw-text">{item.text}</div>
                      ) : (
                        <ul className="agent-chat-timeline-recap-list">
                          {(recaps[item.id]?.bullets || item.bullets || fallbackRecap(item.text, item.todo)).map((bullet, bIdx) => (
                            <li key={bIdx} className="agent-chat-timeline-recap-bullet">
                              <span className="recap-dash">›</span>
                              <span className="recap-body">{bullet}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {item.todo ? (
                    <div className="agent-chat-timeline-todo-card" onClick={(e) => e.stopPropagation()}>
                      <div className="agent-chat-timeline-todo-head">
                        <span className="agent-chat-timeline-todo-ref">{item.todo.ref}</span>
                        <span className={`agent-chat-timeline-todo-status ${item.todo.status}`}>
                          {item.todo.status === "done" ? "✓ Fait" : item.todo.status === "review" ? tr("⏳ À tester") : tr("○ À faire")}
                        </span>
                        <button
                          type="button"
                          className="agent-chat-timeline-todo-btn"
                          onClick={() => openTodoInView(item.todo)}
                          title={tr("Voir dans la fenêtre Todo")}
                          aria-label={tr("Voir dans la fenêtre Todo")}
                        >
                          {tr("Voir todo ↗")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    onTagTodo && (
                      <div className="agent-chat-timeline-no-todo" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="agent-chat-timeline-tag-btn"
                          onClick={() => onTagTodo(item.text)}
                          title={tr("Lier ou créer une tâche todo")}
                        >
                          {tr("+ Todo")}
                        </button>
                      </div>
                    )
                  )}
                </div>
              );
            })}
            {timelineItems.length === 0 && (
              <div className="agent-chat-timeline-empty">{tr("Aucune demande récente.")}</div>
            )}
          </div>
        )}
      </aside>
    </div>
    <div className="agent-chat-bottom">
      {held > 0 && <div className="agent-chat-held-notice"><AppIcon name="chat" size={14}/> {held} {tr(held > 1 ? "messages" : "message")}{" "}{tr("inter-agent en attente")}</div>}
      {queued > 0 && <div className="agent-chat-held-notice"><AppIcon name="refresh" size={14}/> {queued} {tr(queued > 1 ? "messages" : "message")}{" "}{tr("en attente de transmission")}</div>}
      {queue.length > 0 && (
        <section className="agent-chat-queue-section" aria-label={tr("Messages en file d'attente")}>
          <header className="agent-chat-queue-head">
            <span className="agent-chat-queue-badge">{queue.length}</span>
            <strong>{queue.length === 1 ? tr("1 message en file d’attente") : tr("{0} messages en file d’attente", queue.length)}</strong>
            <small>{session.agentStatus?.state === "working" ? tr("Partira automatiquement dès que {0} sera disponible", session.name) : tr("Prêt à partir")}</small>
          </header>
          <div className="agent-chat-queue-items">
            {queue.map((item, index) => (
              <article className="agent-chat-queue-card" key={item.id || index}>
                <div className="agent-chat-queue-meta">
                  <span className="agent-chat-queue-idx">#{index + 1}</span>
                  <span className="agent-chat-queue-tag">{tr("En attente")}</span>
                </div>
                <p className="agent-chat-queue-content">{item.text}</p>
                <div className="agent-chat-queue-actions">
                  <button type="button" onClick={() => editQueueItem(index)} aria-label={tr("Modifier ce message")} title={tr("Modifier")}>
                    <AppIcon name="edit" size={14}/>
                    <span>{tr("Modifier")}</span>
                  </button>
                  <button type="button" onClick={() => sendQueueItemNow(index)} aria-label={tr("Envoyer maintenant")} title={tr("Forcer l’envoi")}>
                    <AppIcon name="arrowUp" size={14}/>
                    <span>{tr("Envoyer")}</span>
                  </button>
                  <button type="button" className="agent-chat-queue-cancel" onClick={() => cancelQueueItem(index)} aria-label={tr("Annuler ce message")} title={tr("Annuler")}>
                    <AppIcon name="trash" size={14}/>
                    <span>{tr("Annuler")}</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {error && <p className="agent-chat-error" role="status">{error}</p>}
      {attachments.length > 0 && <div className="agent-chat-attachments">{attachments.map((file, i) => <span key={`${file.path}-${i}`}><AppIcon name="paperclip" size={14}/> {file.name} <button type="button" aria-label={`Retirer ${file.name}`} onClick={() => updateAttachments((old) => old.filter((_, n) => n !== i))}>×</button></span>)}</div>}
      {agentPicker && <div className="agent-tag-panel" role="dialog" aria-label={tr("Mentionner un agent")}><header><strong>{tr("Mentionner un agent")}</strong><button type="button" aria-label={tr("Fermer")} onClick={() => setAgentPicker(false)}>×</button></header><input aria-label={tr("Rechercher un agent à mentionner")} placeholder={tr("Rechercher un agent…")} value={agentQuery} onChange={(event) => setAgentQuery(event.target.value)}/><small>{tr("Ajoute une référence au message, sans contacter l’agent automatiquement.")}</small><div className="agent-tag-list">{agents.filter((item) => item.id !== session.id && `${item.name} ${item.project?.name || ""}`.toLocaleLowerCase("fr").includes(agentQuery.trim().toLocaleLowerCase("fr"))).slice(0, 30).map((item) => <button key={item.id} type="button" onClick={() => { const reference = `@${item.name} (agent Noyau : ${item.agentId || item.id})`; updateDraft(`${draft}${draft && !/\s$/.test(draft) ? " " : ""}${reference} `); setAgentPicker(false); setAgentQuery(""); input.current?.focus(); }}><strong>{item.name}</strong><small>{item.project?.name || tr("Sans projet")}</small></button>)}</div></div>}
      <form className="agent-chat-compose" onSubmit={send} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); }}>
        <textarea
          ref={input}
          value={draft}
          onChange={(e) => updateDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing) {
              e.preventDefault();
              send(e);
            }
          }}
          onPaste={(e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } }}
          placeholder={tr("Écrire à {0}…", session.name)}
          aria-label={tr("Message à l’agent")}
          rows={2}
          maxLength={16384}
        />
        <div className="agent-chat-actions">
          <label className="agent-chat-attach" title={tr("Joindre des fichiers")} aria-label={tr("Joindre des fichiers")}><input type="file" multiple disabled={uploading} onChange={(e) => { addFiles([...e.target.files]); e.target.value = ""; }} /><span>{uploading ? "…" : <AppIcon name="paperclip" size={18}/>}</span></label>
          {onTagTodo && <button type="button" className="agent-chat-tool" aria-label={tr("Taguer une tâche")} title={tr("Taguer une tâche")} onClick={onTagTodo}><AppIcon name="task" size={18}/></button>}
          {onCreateNote && <button type="button" className="agent-chat-tool" aria-label={tr("Créer une note")} title={tr("Créer une note")} onClick={onCreateNote}><AppIcon name="file" size={18}/></button>}
          {agents.length > 1 && <button type="button" className="agent-chat-tool" aria-label={tr("Mentionner un agent")} title={tr("Mentionner un agent")} onClick={() => setAgentPicker((open) => !open)}><AppIcon name="tag" size={18}/></button>}
          {onDictation && <button type="button" className="agent-chat-tool" aria-label={tr("Dicter un message")} title={tr("Dicter un message")} onClick={onDictation}><AppIcon name="microphone" size={18}/></button>}
          {(draft.trim() || attachments.length > 0) && <button type="button" className="agent-chat-tool" aria-label={tr("Mettre en file d'attente")} title={tr("Mettre en file d'attente pour plus tard")} onClick={enqueueDraft}><AppIcon name="more" size={18}/></button>}
          <button className="agent-chat-send" type="submit" aria-label={tr("Envoyer")} title={tr("Envoyer")} onPointerDown={(event) => { event.preventDefault(); }} onTouchStart={(event) => { const touch = event.changedTouches[0]; sendTouch.current = touch ? { x: touch.clientX, y: touch.clientY } : null; }} onTouchCancel={() => { sendTouch.current = null; }} onTouchEnd={(event) => { const start = sendTouch.current; const touch = event.changedTouches[0]; sendTouch.current = null; if (!start || !touch || Math.abs(touch.clientX - start.x) > 12 || Math.abs(touch.clientY - start.y) > 12 || event.currentTarget.disabled) return; event.preventDefault(); send(); }} disabled={!connected || uploading || (!draft.trim() && !attachments.length)}><AppIcon name="arrowUp" size={19}/></button>
        </div>
      </form><small>{connected ? tr("Entrée pour envoyer · Shift+Entrée pour aller à la ligne") : tr("Connexion interrompue : message conservé ici.")}</small>
    </div>
    {previewingFile && (
      <ProjectFilePreviewModal
        file={previewingFile}
        files={projectFiles.filter((f) => (f.projectId || projectId) === (previewingFile.projectId || projectId))}
        project={previewingFile.projectId || projectId}
        onClose={() => setPreviewingFile(null)}
        onSelectFile={(f) => setPreviewingFile(f)}
        onDownload={(filename) => downloadProjectFile(previewingFile.projectId || projectId, filename)}
      />
    )}
  </section>;
}
