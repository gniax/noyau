import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function AgentMemory({ session, api, onClose }) {
  const [state, setState] = useState(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const endpoint = `/api/agent-tools/agents/${encodeURIComponent(session.agentId || session.id)}/memory`;

  useEffect(() => {
    let active = true;
    api(endpoint).then((data) => {
      if (active) { setState(data); setNotes(data.notes); }
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [endpoint, api]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); if (!busy) onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, busy]);

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError(""); setSaved(false);
    try {
      const next = await api(endpoint, { method: "PUT", body: JSON.stringify({ text: notes, revision: state.revision }) });
      setState(next); setNotes(next.notes); setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="agent-memory-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><h2 id="agent-memory-title">Mémoire commune</h2><p className="muted">{session.name} · Codex / Claude / Antigravity</p></div><button type="button" className="ghost" onClick={onClose} disabled={busy} aria-label="Fermer">×</button></div>
        <p className="muted">Notes conservées avec cet agent, relues au prochain démarrage ou changement de moteur ; aucun redémarrage imposé aux agents actifs.</p>
        {!state && !error && <p role="status">Chargement…</p>}
        {state && <form onSubmit={save}>
          <label htmlFor="agent-memory-notes">Décisions, contraintes et prochaines étapes — sans secrets</label>
          <textarea id="agent-memory-notes" rows={9} maxLength={32000} value={notes} onChange={(event) => { setNotes(event.target.value); setSaved(false); }} readOnly={session.canEdit === false} disabled={busy} />
          <small className="muted">{notes.length.toLocaleString("fr-FR")} / 32 000 caractères · passations et points automatiques conservés séparément</small>
          <details><summary>Voir contexte sauvegardé et héritage Claude</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{state.text}</pre></details>
          {session.canEdit !== false && <div className="modal-actions"><button type="submit" className="primary" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</button></div>}
        </form>}
        {saved && <p role="status">Mémoire enregistrée.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </div>, document.body,
  );
}
