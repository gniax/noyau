import React, { useEffect, useRef } from "react";
export function agentsInSameProject(session, sessions) {
  if (!session?.projectId) return [];
  // Parent passes the exact order used by the sidebar, including favorites and chosen sort.
  return sessions.filter((item) => item.projectId === session.projectId && item.id);
}
export function TerminalAgentSwitcher({ session, sessions, onOpen }) {
  const list = agentsInSameProject(session, sessions); const nav = useRef(null);
  useEffect(() => {
    const parent = nav.current; const active = parent?.querySelector('[aria-current="page"]');
    if (!parent || !active) return;
    const left = active.offsetLeft - parent.offsetLeft;
    if (left < parent.scrollLeft || left + active.offsetWidth > parent.scrollLeft + parent.clientWidth) parent.scrollTo({ left: Math.max(0, left - parent.clientWidth / 3), behavior: "smooth" });
  }, [session.id]);
  if (list.length < 2) return null;
  return <nav className="terminal-agent-switcher" ref={nav} aria-label="Agents du projet">{list.map((agent) => <button type="button" key={agent.id} aria-current={agent.id === session.id ? "page" : undefined} onClick={() => onOpen(agent.id)}><i className={`agent-state-dot ${agent.agentStatus?.state || "available"}`} /><span>{agent.name}</span></button>)}</nav>;
}
