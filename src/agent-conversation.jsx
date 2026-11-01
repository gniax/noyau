import { buildConversationTimeline, conversationQuestions, obviouslyAnsweredIds } from "../shared/conversation-timeline.js";
import { oneLine, splitInterAgent } from "../shared/inter-agent-thread.js";
import { FileTypeIcon } from "./file-type-icon.jsx";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./agent-conversation.css";
import { AppIcon } from "./app-icon.jsx";
import { AutonomyBanner } from "./autonomy-banner.jsx";
import {
  ProjectFilePreviewModal,
  detectProjectFiles,
  getFileCategory,
  getFileBadgeClass,
  formatFileBytes,
  downloadProjectFile
} from "./project-file-preview.jsx";
import { reformulateRequest, fallbackRecap, findMatchingTodo } from "./request-reformulate.js";
import { tr, LOCALE } from "./i18n.js";
import { conversationQuotaExhausted } from "./conversation-quota.js";
import { delegateMessage, parseDelegate } from "../shared/delegate.js";

export { reformulateRequest, fallbackRecap, findMatchingTodo };

const RECAP_STORE = "noyau-recaps-v2";
const RECAP_STORE_MAX = 300;
const recapKey = (text) => { let hash = 5381; for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) | 0; return `${text.length}:${hash}`; };
function readRecapStore() { try { return JSON.parse(localStorage.getItem(RECAP_STORE)) || {}; } catch { return {}; } }
function recalledRecap(text) { return readRecapStore()[recapKey(text)] || null; }
function rememberRecap(text, { title, bullets }) {
  try {
    const entries = Object.entries(readRecapStore()).slice(-(RECAP_STORE_MAX - 1));
    localStorage.setItem(RECAP_STORE, JSON.stringify(Object.fromEntries([...entries, [recapKey(text), { title, bullets }]])));
  } catch { /* Private mode or full storage: the server cache still answers. */ }
}
function agentReplyTitle(text, questions = []) {
  if (questions.length) return questions[0];
  const line = String(text || "").split("\n").map((part) => part.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "").trim()).find(Boolean) || "";
  return line.length > 110 ? `${line.slice(0, 107)}…` : line;
}

// A request whose task is finished must stop spinning, even while the agent moves on to other work.
const todoClosed = (todo) => ["done", "review"].includes(todo?.status);

// The server answers { pending: true } while the LLM works, so no browser connection stays held.
async function pollAi(api, url, body, isActive = () => true) {
  for (let delay = 2000; delay <= 16000; delay *= 1.3) {
    const result = await api(url, { method: "POST", body: JSON.stringify(body) });
    if (!result?.pending) return result;
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    if (!isActive()) return null;
  }
  return null;
}

const ASSISTANT_NAMES = { codex: "Codex", claude: "Claude", "claude-design": "Claude Design", antigravity: "Antigravity" };
const assistantName = (id) => ASSISTANT_NAMES[id] || id || "";

// Keeps restarts and provider switches at their place in the conversation.
function mergeContextEvents(messages, events) {
  if (!events.length) return messages;
  const time = (value) => (typeof value === "number" ? value : Date.parse(value) || 0);
  const merged = [...messages];
  for (const event of events) {
    const index = merged.findIndex((message) => time(message.at) > time(event.at));
    merged.splice(index < 0 ? merged.length : index, 0, { contextEvent: event, stableId: `context-${event.kind}-${event.at}`, at: event.at });
  }
  return merged;
}

// Back on a conversation already read, its messages show at once while the refresh runs.
const conversationMemory = new Map();
function rememberConversation(id, value) {
  conversationMemory.delete(id);
  conversationMemory.set(id, value);
  if (conversationMemory.size > 30) conversationMemory.delete(conversationMemory.keys().next().value);
}

export function AgentConversation({ session, connected, api, onSubmit, onForceSubmit, onStop, onRestart, onTerminal, agents = [], restarting, onTagTodo, onCreateNote, onDictation, insertRequest, onInsertConsumed, draftStore, held = 0, queued = 0 }) {
  const [quota, setQuota] = useState(null);
  const [autonomy, setAutonomy] = useState(null);
  const [answeredQuestionIds, setAnsweredQuestionIds] = useState([]);
  const [dismissedWait, setDismissedWait] = useState(false);
  const [messages, setMessages] = useState(() => conversationMemory.get(session.id)?.messages || []); const [pendingMessages, setPendingMessages] = useState([]); const [available, setAvailable] = useState(null);
  const [error, setError] = useState(""); const [submitError, setSubmitError] = useState(""); const [activity, setActivity] = useState(""); const [draft, setDraft] = useState(""); const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState([]); const [queue, setQueue] = useState([]); const [queueTick, setQueueTick] = useState(0); const [agentPicker, setAgentPicker] = useState(false); const [agentQuery, setAgentQuery] = useState("");
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
  const autoRecaps = useRef(new Map());
  const [showRawText, setShowRawText] = useState({});
  const [timelineOpen, setTimelineOpen] = useState(() => (typeof window !== "undefined" ? window.innerWidth > 900 : true));
  const [todos, setTodos] = useState([]);

  const loadRecap = useCallback(async (item) => {
    if (!item?.id || !item?.text) return;
    if (recaps[item.id]?.ai) return;

    const instantBullets = item.bullets || fallbackRecap(item.text, item.todo);
    setRecaps((prev) => ({
      ...prev,
      [item.id]: { bullets: prev[item.id]?.bullets || instantBullets, loading: true, ai: false },
    }));

    try {
      const res = await pollAi(api, "/api/agent/recap-prompt", { text: item.text, kind: item.role === "assistant" ? "reply" : "request" });
      if (res?.bullets?.length) {
        if (res.ai) rememberRecap(item.text, res);
        setRecaps((prev) => ({
          ...prev,
          [item.id]: { title: res.title, bullets: res.bullets, ai: res.ai === true, loading: false },
        }));
      }
    } catch {
      setRecaps((prev) => ({ ...prev, [item.id]: { bullets: prev[item.id]?.bullets || instantBullets, ai: false, loading: false } }));
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

  function registerPendingPrompt(rawText) {
    const text = parseDelegate(rawText).text;
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
    setMessages(conversationMemory.get(session.id)?.messages || []);
    setAnsweredQuestionIds([]);
    setQuota(null);
    setAutonomy(null);
    setPendingMessages([]);
    setAvailable(conversationMemory.get(session.id)?.available ?? null);
    setError("");
    setSubmitError("");
    setActivity("");
    setAgentPicker(false);
    setAgentQuery("");
    stick.current = true;
  }, [session.id, store]);

  useEffect(() => {
    const failed = (event) => { const detail = event.detail || {}; if (detail.sessionId !== session.id) return; if (detail.text) { setDraft((old) => { const next = old ? `${detail.text}\n\n${old}` : detail.text; store.set(session.id, { ...(store.get(session.id) || {}), draft: next }); return next; }); setPendingMessages((old) => old.filter((item) => item.text !== detail.text)); } setSubmitError(tr("Envoi au terminal échoué. Vérifiez le terminal avant de renvoyer.")); };
    window.addEventListener("noyau:submit-failed", failed); return () => window.removeEventListener("noyau:submit-failed", failed);
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
          rememberConversation(session.id, { messages: serverList, available: result.available });
          setAvailable(result.available);
          setActivity(result.activity || "");
          setQuota(result.quota || null);
          setAutonomy(result.autonomy || null);
          setSubagents(Array.isArray(result.subagents) ? result.subagents : []);
          setContextEvents(Array.isArray(result.contextEvents) ? result.contextEvents : []);
          setContextTransition(result.contextTransition || null);
          if (result.contextTransition) setLocalTransition(null);
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

  useEffect(() => { setDismissedWait(false); }, [session.id, session.agentStatus?.state]);

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
    if (session.agentStatus?.state !== "working" && connected && queue.length > 0 && !pendingMessages.length && !drainingRef.current) {
      drainingRef.current = true;
      const nextItem = queue[0];
      updateQueue((old) => old.slice(1));
      onSubmit(nextItem.text);
      registerPendingPrompt(nextItem.text);
      setTimeout(() => { drainingRef.current = false; setQueueTick((tick) => tick + 1); }, 1200);
    }
  }, [session.agentStatus?.state, connected, queue.length, onSubmit, messages, pendingMessages.length, queueTick]);

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
    const parsed = parseDelegate(item.text);
    updateDraft(parsed.text);
    setDelegating(parsed.delegated);
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
    const request = [draft.trim(), attachmentText].filter(Boolean).join("\n\n");
    const text = delegating && request ? delegateMessage(request) : request;
    if (!text || text.length > 16384) return;
    setDelegating(false);
    updateQueue((old) => [...old, { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }]);
    updateDraft("");
    updateAttachments([]);
    input.current?.blur();
    stick.current = true;
  }

  function send(event) {
    event?.preventDefault?.();
    const attachmentText = attachments.map((file) => tr("Fichier joint : {0}", file.path)).join("\n");
    const request = [draft.trim(), attachmentText].filter(Boolean).join("\n\n");
    const text = delegating && request ? delegateMessage(request) : request;
    if (!text || text.length > 16384 || !connected || uploading) return;
    input.current?.blur();
    setSubmitError("");
    setDelegating(false);
    onSubmit(text);
    registerPendingPrompt(text);
    updateDraft("");
    updateAttachments([]);
  }

  const quotaExhausted = conversationQuotaExhausted({ session, messages, activity, quota, pending: pendingMessages.length > 0 });

  // Détection du dernier message utilisateur envoyé pour lequel l'agent travaille actuellement
  const [contextEvents, setContextEvents] = useState([]);
  const { main: splitMessages, exchanges: receivedExchanges, founderMessages } = useMemo(() => splitInterAgent(displayMessages), [displayMessages]);
  const feedMessages = useMemo(() => mergeContextEvents(splitMessages, contextEvents), [splitMessages, contextEvents]);
  const lastUserMsgIndex = feedMessages.map((m) => m.direction).lastIndexOf("in");
  const isWorkingOnLastMsg = session.agentStatus?.state === "working" && lastUserMsgIndex !== -1 && lastUserMsgIndex > feedMessages.map((m) => (m.final === false ? "note" : m.direction)).lastIndexOf("out");
  const [sidePane, setSidePane] = useState("requests");
  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!stopping) return undefined; const timer = setTimeout(() => setStopping(false), 8000); return () => clearTimeout(timer); }, [stopping]);
  useEffect(() => { if (session.agentStatus?.state !== "working") setStopping(false); }, [session.agentStatus?.state]);
  const [freshBusy, setFreshBusy] = useState(false);
  const [delegating, setDelegating] = useState(false);
  useEffect(() => { setDelegating(false); }, [session.id]);
  async function startFresh() {
    if (!window.confirm(tr("Relancer {0} sur un contexte propre ? Il reprend seul ce qu'il faisait et ce qui reste à faire ; sa mémoire, ses demandes et l'historique affiché sont conservés.", session.name))) return;
    setFreshBusy(true);
    setLocalTransition({ kind: "fresh", sessionId: session.id });
    try { await api(`/api/sessions/${encodeURIComponent(session.id)}/fresh`, { method: "POST" }); } catch (reason) { setSubmitError(reason.message); } finally { setFreshBusy(false); }
  }
  const stopAgent = () => { setStopping(true); onStop?.(); };
  const [subagents, setSubagents] = useState([]);
  const [contextTransition, setContextTransition] = useState(null);
  // Shown from the click, before the server has anything to report.
  const [localTransition, setLocalTransition] = useState(null);
  useEffect(() => { setContextEvents([]); setContextTransition(null); setLocalTransition(null); }, [session.id]);
  useEffect(() => {
    const started = (event) => { if (event.detail?.sessionId === session.id) { setLocalTransition(event.detail); stick.current = true; } };
    window.addEventListener("noyau:context-transition", started);
    return () => window.removeEventListener("noyau:context-transition", started);
  }, [session.id]);
  useEffect(() => { if (!localTransition) return undefined; const timer = setTimeout(() => setLocalTransition(null), 12000); return () => clearTimeout(timer); }, [localTransition]);
  const transition = contextTransition || localTransition;
  useEffect(() => setSubagents([]), [session.id]);
  const runningSubagents = subagents.filter((item) => item.running).length;
  // Finished ones stay listed only while another still runs: the banner must not outlive the work.
  const shownSubagents = runningSubagents ? subagents.filter((item) => item.running || Date.now() - Date.parse(item.updatedAt) < 3600000) : [];
  const [sentExchanges, setSentExchanges] = useState([]);
  const [peerFilter, setPeerFilter] = useState(null);
  const [focusedExchange, setFocusedExchange] = useState(null);
  useEffect(() => { setSentExchanges([]); setPeerFilter(null); setFocusedExchange(null); setSidePane("requests"); }, [session.id]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (document.hidden) return;
      const result = await api(`/api/map/exchanges?project=all&window=7d&agent=${encodeURIComponent(session.id)}`).catch(() => null);
      if (active && Array.isArray(result?.exchanges)) setSentExchanges(result.exchanges.filter((item) => item.fromId === session.id));
    };
    void load();
    const timer = setInterval(load, 20000);
    return () => { active = false; clearInterval(timer); };
  }, [api, session.id]);
  const threadItems = useMemo(() => [
    ...receivedExchanges.map((item) => ({ id: item.id, incoming: true, peer: item.message.from || tr("Agent"), at: item.message.at, text: item.message.text, replies: item.replies })),
    ...sentExchanges.map((item) => ({ id: item.id, incoming: false, peer: item.to, at: item.at, text: item.text, replies: item.reply ? [{ stableId: `${item.id}:reply`, text: item.reply, at: null, fromPeer: true }] : [] })),
  ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)), [receivedExchanges, sentExchanges]);
  const threadPeers = useMemo(() => [...new Set(threadItems.map((item) => item.peer))], [threadItems]);
  const shownThread = peerFilter ? threadItems.filter((item) => item.peer === peerFilter) : threadItems;
  function openExchange(id) {
    setPeerFilter(null);
    setSidePane("agents");
    setTimelineOpen(true);
    setFocusedExchange(id);
    requestAnimationFrame(() => document.querySelector(`[data-exchange-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  }
  // Like a shell: up recalls sent prompts while the field is empty or showing an untouched one, down goes back.
  const recall = useRef({ index: -1, shown: "", original: "" });
  useEffect(() => { recall.current = { index: -1, shown: "", original: "" }; }, [session.id]);
  function recallPrompt(event) {
    const state = recall.current;
    const browsing = state.index >= 0 && draft === state.shown;
    if (!browsing && draft) return;
    const up = event.key === "ArrowUp";
    if (!browsing && !up) return;
    const history = founderMessages.filter((message) => message.direction === "in" && !message.pending).map((message) => message.text).reverse();
    const index = browsing ? state.index + (up ? 1 : -1) : 0;
    if (index >= history.length) return;
    event.preventDefault();
    if (index < 0) {
      recall.current = { index: -1, shown: "", original: "" };
      updateDraft("");
      return;
    }
    recall.current = { index, shown: history[index], original: "" };
    updateDraft(history[index]);
  }
  function reactToExchange(item) {
    const quote = `À propos ${item.incoming ? "du message reçu de" : "de ton message à"} ${item.peer} (« ${oneLine(item.text, 90)} ») : `;
    updateDraft(`${draft}${draft && !/\s$/.test(draft) ? "\n" : ""}${quote}`);
    if (window.innerWidth <= 900) setTimelineOpen(false);
    requestAnimationFrame(() => document.querySelector(".agent-conversation textarea")?.focus());
  }

  useEffect(() => { setAnsweredQuestionIds([]); setDismissedWait(false); }, [session.id]);
  useEffect(() => { if (session.agentStatus?.state !== "waiting") setDismissedWait(false); }, [session.agentStatus?.state]);
  const questionPayload = useMemo(() => {
    const settled = new Set(obviouslyAnsweredIds(founderMessages));
    return JSON.stringify(conversationQuestions(founderMessages).filter((item) => !settled.has(item.id)).slice(-30));
  }, [founderMessages]);
  useEffect(() => {
    let active = true; const questions = JSON.parse(questionPayload).reverse();
    if (!questions.length) return () => { active = false; };
    const batches = []; for (let i = 0; i < questions.length; i += 5) batches.push(questions.slice(i, i + 5));
    const work = async () => { while (active && batches.length) { const batch = batches.shift(); try { const result = await pollAi(api, "/api/agent/question-status", { questions: batch }, () => active); if (active && Array.isArray(result?.answered)) setAnsweredQuestionIds((old) => [...new Set([...old, ...result.answered])]); } catch { /* Unknown answers stay open. */ } } };
    const timer = setTimeout(() => { void work(); void work(); }, 700);
    return () => { active = false; clearTimeout(timer); };
  }, [questionPayload, api, session.id]);
  const timelineItems = useMemo(() => buildConversationTimeline(founderMessages, { answeredIds: answeredQuestionIds, working: session.agentStatus?.state === "working" || held + queued > 0 }).map((message) => {
    const todo = message.role === "user" ? findMatchingTodo(message.text, todos, projectId) : null;
    return { id: message.stableId, text: message.text, role: message.role, title: message.role === "assistant" ? agentReplyTitle(message.text, message.questions) : reformulateRequest(message.text, todo), bullets: fallbackRecap(message.text, todo), at: message.at, status: todoClosed(todo) && message.status === "working" ? "done" : message.status, statusLabel: message.role === "assistant" ? (message.status === "question" ? tr("Question en attente de ta réponse") : message.status === "progress" ? tr("Point d'avancement") : tr("Réponse de l'agent")) : message.status === "working" && !todoClosed(todo) ? tr("L'agent travaille encore sur cette demande") : tr("Demande traitée"), questions: message.questions, todo };
  }), [founderMessages, answeredQuestionIds, todos, projectId, session.agentStatus?.state, held, queued]);

  const titleRequests = useMemo(() => JSON.stringify(timelineItems.filter((item) => item.role === "user").map(({ id, text }) => ({ id, text: text.slice(0, 12000) }))), [timelineItems]);
  useEffect(() => {
    let active = true; const queue = [];
    const known = {};
    for (const item of JSON.parse(titleRequests)) {
      const cached = recalledRecap(item.text);
      if (cached) known[item.id] = { ...cached, ai: true, loading: false }; else queue.push(item);
    }
    if (Object.keys(known).length) setRecaps((prev) => ({ ...prev, ...known }));
    const work = async () => {
      while (active && queue.length) {
        const item = queue.pop();
        try {
          const result = await pollAi(api, "/api/agent/recap-prompt", { text: item.text, kind: "request" }, () => active);
          if (!result?.ai || !result.bullets?.length) continue;
          rememberRecap(item.text, result);
          if (active) setRecaps((prev) => ({ ...prev, [item.id]: { title: result.title, bullets: result.bullets, ai: true, loading: false } }));
        } catch { /* Keep the provisional title; try again when the conversation changes. */ }
      }
    };
    const timer = setTimeout(() => { void work(); void work(); void work(); }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [titleRequests, api, session.id]);

  return <section className="agent-conversation" aria-label={tr("Conversation avec {0}", session.name)}>
    {autonomy && <AutonomyBanner session={session} autonomy={autonomy} api={api} onChange={setAutonomy}/>}
    <div className="agent-chat-layout">
      <div className="agent-chat-feed" ref={scroll} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
        {available && displayMessages.length > 0 && <div className="agent-chat-history-note">{tr("Historique récent · les messages plus anciens peuvent manquer")}</div>}
        {available === null && displayMessages.length === 0 && !error && <div className="agent-chat-empty agent-chat-loading"><p>{tr("Chargement de la conversation…")}</p></div>}
        {available !== null && displayMessages.length === 0 && <div className="agent-chat-empty"><b>{tr("Conversation avec")}{" "}{session.name}</b><p>{tr("Envoie un message pour commencer.")}</p></div>}
        {feedMessages.map((message, index) => {
          const isCurrentExecutingPrompt = isWorkingOnLastMsg && index === lastUserMsgIndex;
          if (message.contextEvent) {
            const { kind, from, to } = message.contextEvent;
            return <div className="agent-chat-context-marker" role="separator" key={message.stableId} data-chat-id={message.stableId}>
              <span>{kind === "switch" ? tr("{0} a pris le relais de {1} ici", assistantName(to), assistantName(from)) : tr("Contexte rafraîchi ici : l’agent a repris avec sa mémoire et ses demandes")}{message.at ? ` · ${new Date(message.at).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</span>
            </div>;
          }
          if (message.exchange) {
            const replies = message.exchange.replies.length;
            return <button type="button" data-chat-id={message.stableId} className={`agent-chat-exchange-marker${focusedExchange === message.exchange.id && sidePane === "agents" && timelineOpen ? " on" : ""}`} key={message.stableId} onClick={() => openExchange(message.exchange.id)} title={tr("Voir l’échange dans le fil inter-agents")}>
              <span className="agent-chat-avatar inter-agent" aria-hidden="true">{(message.from || "A").slice(0, 1).toUpperCase()}</span>
              <span className="agent-chat-exchange-body">
                <span className="agent-chat-exchange-head"><strong>{message.from || tr("Agent")}</strong>{" → "}{session.name}{message.at ? ` · ${new Date(message.at).toLocaleString(LOCALE, { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
                <span className="agent-chat-exchange-preview">{oneLine(message.text)}</span>
              </span>
              <span className="agent-chat-exchange-state">{isCurrentExecutingPrompt ? <i className="agent-chat-exchange-working" title={tr("En cours de traitement")}/> : replies > 0 ? tr(replies > 1 ? "{0} réponses" : "{0} réponse", replies) : null}<b aria-hidden="true">›</b></span>
            </button>;
          }
          if (message.kind === "incident") {
            return <article className="agent-chat-incident" data-chat-id={message.stableId} key={message.stableId}>
              <header><AppIcon name="alert" size={14}/><strong>{tr("Surveillance Noyau")}</strong>{isCurrentExecutingPrompt && <i className="agent-chat-exchange-working" title={tr("En cours de traitement")}/>}{message.at ? <time>{new Date(message.at).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time> : null}</header>
              <p>{message.text}</p>
            </article>;
          }
          const mentionedFiles = message.direction === "out" ? detectProjectFiles(message.text, projectFiles) : [];
          return <article data-chat-id={message.stableId} className={`agent-chat-message ${message.direction === "in" ? "user" : "assistant"}${message.pending ? " pending" : ""}`} key={message.stableId}>
            <div className="agent-chat-meta">
              <span className={`agent-chat-avatar ${message.direction === "in" ? "user" : "assistant"}`} aria-hidden="true">{message.direction === "in" ? (message.from ? message.from.slice(0, 1).toUpperCase() : "V") : <AppIcon name="chat" size={13}/>}</span>
              <strong>{message.direction === "in" ? message.from || tr("Vous") : session.name}</strong>
              <span className="agent-chat-role">{message.direction === "in" ? tr("Vous") : tr("Assistant")}</span>
              {message.delegated && <span className="agent-chat-delegated"><AppIcon name="robot" size={12}/>{tr("Confié à un nouvel agent")}</span>}
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
                              <FileTypeIcon extension={f.extension} directory={f.isDirectory || f.kind === "folder"} size={20}/>
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
              {isCurrentExecutingPrompt && onStop && <button type="button" className="agent-chat-msg-cancel" aria-label={tr("Annuler la réponse")} title={tr("Arrêter la réponse de l’agent")} disabled={stopping} onClick={stopAgent}><AppIcon name="stop" size={15}/> <span>{stopping ? tr("Arrêt…") : tr("Annuler")}</span></button>}
              {message.direction === "in" && !message.truncated && !isCurrentExecutingPrompt && !message.pending && <button type="button" aria-label={tr("Réutiliser le message")} title={tr("Réutiliser dans un nouveau message")} onClick={() => { updateDraft(message.text); input.current?.focus(); }}><AppIcon name="edit" size={15}/></button>}
              {message.direction === "out" && typeof speechSynthesis !== "undefined" && <button type="button" onClick={() => { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(message.text); u.lang = LOCALE; speechSynthesis.speak(u); }} aria-label={tr("Lire la réponse")} title={tr("Lire la réponse")}><AppIcon name="volume" size={15}/></button>}
            </div>
          </article>;
        })}
        {quotaExhausted && <div className="agent-chat-quota-alert" role="alert"><span className="agent-chat-quota-icon"><AppIcon name="lock" size={18}/></span><div className="agent-chat-quota-text"><strong>{tr("Limite de quota atteinte")}</strong><p>{tr("L’agent a atteint son plafond d’utilisation (")}{session.assistant}{tr("). Vous pouvez basculer de moteur ou attendre la réinitialisation.")}</p></div></div>}
        {transition && <div className="agent-chat-context-loading" role="status"><i className="agent-chat-exchange-working" aria-hidden="true"/><span>{transition.kind === "switch" ? tr("Passage de {0} à {1}, reprise de la conversation…", assistantName(transition.from || session.assistant), assistantName(transition.to)) : tr("Relance sur un contexte propre, reprise du travail en cours…")}</span></div>}
        {session.agentStatus?.state === "working" && <div className="agent-chat-progress working"><span className="agent-chat-pulse working" /> {stopping ? tr("Arrêt de {0}…", session.name) : `${session.name} ${tr("travaille")}`} <button type="button" aria-label={tr("Voir activité en direct")} title={tr("Voir activité en direct")} onClick={onTerminal}><AppIcon name="terminal" size={16}/></button><button type="button" aria-label={tr("Arrêter la réponse")} title={tr("Arrêter la réponse")} disabled={stopping} onClick={stopAgent}><AppIcon name="stop" size={16}/></button></div>}
        {session.agentStatus?.state === "working" && activity && <pre className="agent-chat-live" aria-label={tr("Activité en direct")}>{activity}</pre>}
        {session.agentStatus?.state === "waiting" && !dismissedWait && <div className="agent-chat-progress waiting"><span className="agent-chat-pulse waiting" /> {session.name}{" "}{tr("attend une réponse")} <button type="button" className="agent-wait-dismiss" onClick={async () => { setDismissedWait(true); try { await api(`/api/sessions/${encodeURIComponent(session.id)}/dismiss-waiting`, { method: "POST", body: "{}" }); } catch (error) { setDismissedWait(false); setError(error.message); } }}>{tr("Pas en attente ?")}</button></div>}
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
        {!timelineOpen && threadItems.length > 0 && <button type="button" className="agent-chat-side-rail-agents" title={tr("Fil inter-agents")} aria-label={tr("Fil inter-agents")} onClick={() => { setSidePane("agents"); setTimelineOpen(true); }}><AppIcon name="chat" size={13}/><span>{threadItems.length}</span></button>}
        {timelineOpen && <div className="agent-chat-side-tabs" role="tablist" aria-label={tr("Panneau latéral")}>
          <button type="button" role="tab" aria-selected={sidePane === "requests"} className={sidePane === "requests" ? "on" : ""} onClick={() => setSidePane("requests")}>{tr("Ma discussion")}</button>
          <button type="button" role="tab" aria-selected={sidePane === "agents"} className={sidePane === "agents" ? "on" : ""} onClick={() => setSidePane("agents")}>{tr("Inter-agents")}{threadItems.length > 0 && <small>{threadItems.length}</small>}</button>
        </div>}
        {timelineOpen && sidePane === "agents" && <div className="agent-chat-thread">
          {threadPeers.length > 1 && <div className="agent-chat-thread-peers">
            <button type="button" className={!peerFilter ? "on" : ""} onClick={() => setPeerFilter(null)}>{tr("Tous")}</button>
            {threadPeers.map((peer) => <button type="button" key={peer} className={peerFilter === peer ? "on" : ""} onClick={() => setPeerFilter(peer)}>{peer}</button>)}
          </div>}
          {shownThread.length === 0 && <div className="agent-chat-timeline-empty">{tr("Aucun échange avec un autre agent.")}</div>}
          {shownThread.map((item) => <article key={item.id} data-exchange-id={item.id} className={`agent-chat-thread-item ${item.incoming ? "incoming" : "sent"}${focusedExchange === item.id ? " focused" : ""}`}>
            <header>
              <strong>{item.incoming ? `${item.peer} → ${session.name}` : `${session.name} → ${item.peer}`}</strong>
              {item.at && <time>{new Date(item.at).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>}
            </header>
            <div className="agent-chat-markdown agent-chat-thread-text"><ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>{item.text}</ReactMarkdown></div>
            {item.replies.map((reply) => <div key={reply.stableId} className="agent-chat-thread-reply">
              <small>{tr("Réponse de {0}", item.incoming ? session.name : item.peer)}</small>
              <div className="agent-chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>{reply.text}</ReactMarkdown></div>
            </div>)}
            <button type="button" className="agent-chat-thread-react" onClick={() => reactToExchange(item)}><AppIcon name="edit" size={12}/>{tr("Réagir")}</button>
          </article>)}
        </div>}
        {timelineOpen && sidePane === "requests" && (
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
                  className={`agent-chat-timeline-item ${item.status} ${item.role}`}
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
                      {item.status === "progress" && "…"}
                    </span>
                    <span className="agent-chat-timeline-text" title={item.text}><small className="agent-chat-timeline-role">{item.role === "assistant" ? tr("Agent") : tr("Vous")}</small>{item.role === "user" && recaps[item.id]?.ai ? (recaps[item.id].title || recaps[item.id].bullets[0]) : item.title}</span>
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
                  {item.questions?.length > 0 && <div className="agent-chat-unanswered">{item.questions.map((question, index) => <div key={index}>? {question}</div>)}</div>}
                  {isExpanded && (
                    <div className="agent-chat-timeline-full-prompt" onClick={(e) => e.stopPropagation()}>
                      <div className="agent-chat-timeline-recap-head">
                        <span className="agent-chat-timeline-recap-title">{recaps[item.id]?.loading ? tr("Synthèse en cours…") : recaps[item.id]?.ai ? tr("✨ Récapitulatif IA") : tr("Résumé provisoire · IA indisponible")}</span>
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
                    item.role === "user" && onTagTodo && (
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
      {session.contextAdvice?.level === "saturated" && <div className="agent-chat-saturated" role="status"><i aria-hidden="true"/><span>{tr("Contexte saturé : l'agent n'a plus de place pour travailler correctement.")}</span><button type="button" disabled={freshBusy} onClick={startFresh}>{freshBusy ? tr("Relance…") : tr("Relancer sans rien perdre")}</button></div>}
      {shownSubagents.length > 0 && <details className={`agent-chat-subagents${runningSubagents ? " running" : ""}`}>
        <summary>{runningSubagents > 0 && <i className="agent-chat-exchange-working" aria-hidden="true"/>}<b>{tr(runningSubagents > 1 ? "{0} sous-agents en cours" : "{0} sous-agent en cours", runningSubagents)}</b>{runningSubagents > 0 && shownSubagents.length > runningSubagents && <small>{tr("{0} terminés", shownSubagents.length - runningSubagents)}</small>}</summary>
        <ul>{shownSubagents.map((item) => <li key={item.id} className={item.running ? "running" : ""}>
          <strong>{item.description || item.type || item.id}</strong>
          <small>{item.running ? (item.lastTool ? tr("En cours · {0}", item.lastTool) : tr("En cours")) : item.interrupted ? tr("Interrompu") : tr("Terminé")} · {new Date(item.updatedAt).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })}</small>
          {item.lastText && <p>{oneLine(item.lastText, 220)}</p>}
        </li>)}</ul>
      </details>}
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
                <p className="agent-chat-queue-content">{parseDelegate(item.text).text}</p>
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
      {(submitError || error) && <p className="agent-chat-error" role="status">{submitError || error}</p>}
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
              return;
            }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") recallPrompt(e);
          }}
          onPaste={(e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } }}
          placeholder={delegating ? tr("Demande à confier à un nouvel agent, créé par {0}…", session.name) : tr("Écrire à {0}…", session.name)}
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
          <button type="button" className={`agent-chat-tool agent-chat-delegate${delegating ? " active" : ""}`} aria-pressed={delegating} aria-label={tr("Confier à un nouvel agent")} title={delegating ? tr("{0} créera un agent dédié pour ce message. Cliquer pour annuler.", session.name) : tr("Confier ce message à un nouvel agent dédié, créé par {0}", session.name)} onClick={() => { setDelegating((on) => !on); input.current?.focus(); }}><AppIcon name="robot" size={18}/></button>
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
