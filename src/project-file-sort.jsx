import React, { useCallback, useEffect, useState } from "react";
import "./project-file-sort.css";

function bytes(value) {
  if (!value) return "0 o";
  const units = ["o", "Ko", "Mo", "Go"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

const daysLeft = (value) => Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 86_400_000));

// Bouton « Trier » + état du tri, bilan refermable et corbeille restaurable des fichiers partagés.
export function useFileSort(project, api) {
  const [sort, setSort] = useState(null);
  const load = useCallback(async () => {
    try {
      setSort(await api(`/api/projects/${encodeURIComponent(project.id)}/files/sort`));
    } catch {
      // Ignorer: la section fichiers reste utilisable sans le tri.
    }
  }, [project.id, api]);
  useEffect(() => { load(); }, [load]);
  return [sort, load];
}

export function FileSortButton({ project, api, sort, onStarted, onOpenAgent }) {
  const [busy, setBusy] = useState(false);
  const running = sort?.status === "running";
  async function start() {
    if (running) {
      if (sort.agentId) onOpenAgent?.(sort.agentId);
      return;
    }
    if (!window.confirm("Lancer un agent qui trie les fichiers partagés de ce projet ?\n\nLes fichiers inutiles (doublons, versions intermédiaires, essais, captures de debug, fichiers vides) partent à la corbeille, restaurables 30 jours. Les fichiers de moins de 48 h et tes uploads (sauf doublon exact) sont gardés.")) return;
    setBusy(true);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/files/sort`, { method: "POST", body: JSON.stringify({}) });
      await onStarted?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className={`file-sort-btn${running ? " running" : ""}`} onClick={start} disabled={busy} title={running ? "Tri en cours : ouvrir l'agent" : "Trier les fichiers avec un agent"}>
      {busy ? "Lancement…" : running ? "Tri en cours…" : "Trier"}
    </button>
  );
}

export function FileSortPanel({ project, api, sort, onChanged }) {
  const [restoring, setRestoring] = useState("");
  const dismissKey = `file-sort-dismissed-${project.id}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissKey) || ""; } catch { return ""; }
  });
  if (!sort) return null;
  const { status, deleted = [], trash = [] } = sort;

  function dismiss() {
    setDismissed(sort.finishedAt);
    try { localStorage.setItem(dismissKey, sort.finishedAt); } catch { /* stockage indisponible: fermeture pour la session seulement */ }
  }

  async function restore(item) {
    setRestoring(item.id);
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/files/trash/${encodeURIComponent(item.id)}/restore`, { method: "POST", body: JSON.stringify({}) });
      if (result.restoredAs !== item.name) window.alert(`Restauré sous « ${result.restoredAs} » (le nom était repris).`);
      await onChanged?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setRestoring("");
    }
  }

  async function deleteForever(item) {
    if (!window.confirm(`Supprimer définitivement « ${item.name} » (${bytes(item.size)}) ?\n\nSuppression définitive, irréversible : le fichier ne pourra plus être restauré.`)) return;
    setRestoring(item.id);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/files/trash/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await onChanged?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setRestoring("");
    }
  }

  async function emptyTrash() {
    const size = bytes(trash.reduce((sum, item) => sum + (item.size || 0), 0));
    if (!window.confirm(`Vider la corbeille : ${trash.length} fichier${trash.length > 1 ? "s" : ""} (${size}) ?\n\nSuppression définitive, irréversible : aucun de ces fichiers ne pourra plus être restauré.`)) return;
    setRestoring("all");
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/files/trash`, { method: "DELETE" });
      await onChanged?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setRestoring("");
    }
  }

  return (
    <div className="file-sort">
      {status === "running" && (
        <div className="file-sort-running">
          <i /> Tri en cours… {deleted.length > 0 && `${deleted.length} à la corbeille pour l'instant`}
        </div>
      )}
      {status === "stale" && <div className="file-sort-running stale">Le dernier tri ne s'est pas terminé. Tu peux en relancer un.</div>}
      {status === "done" && sort.finishedAt && dismissed !== sort.finishedAt && (
        <div className="file-sort-done">
          <span>{deleted.length} fichier{deleted.length > 1 ? "s" : ""} en corbeille, {bytes(sort.freedBytes)} libérés</span>
          <button type="button" onClick={dismiss} aria-label="Fermer" title="Fermer">×</button>
        </div>
      )}
      {trash.length > 0 && (
        <details className="file-sort-trash">
          <summary>
            <span>Corbeille</span>
            <strong>{trash.length} fichier{trash.length > 1 ? "s" : ""} · {bytes(trash.reduce((sum, item) => sum + (item.size || 0), 0))}</strong>
          </summary>
          <div className="file-sort-trash-actions">
            <small>Purge automatique après 30 jours.</small>
            <button type="button" className="danger" onClick={emptyTrash} disabled={Boolean(restoring)}>{restoring === "all" ? "Suppression…" : "Vider la corbeille"}</button>
          </div>
          <ul>
            {[...trash].reverse().map((item) => (
              <li key={item.id}>
                <span>
                  <b title={item.name}>{item.name}</b>
                  <small>{bytes(item.size)} · {item.reason} · effacé dans {daysLeft(item.expiresAt)} j</small>
                </span>
                <button type="button" onClick={() => restore(item)} disabled={Boolean(restoring)}>{restoring === item.id ? "…" : "Restaurer"}</button>
                <button type="button" className="danger" onClick={() => deleteForever(item)} disabled={Boolean(restoring)}>Supprimer définitivement</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
