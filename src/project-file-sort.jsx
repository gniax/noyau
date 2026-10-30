import React, { useCallback, useEffect, useState } from "react";
import "./project-file-sort.css";
import { tr } from "./i18n.js";

function bytes(value) {
  if (!value) return "0 o";
  const units = ["o", tr("Ko"), tr("Mo"), tr("Go")];
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
    if (!window.confirm(tr("Lancer un agent qui trie les fichiers partagés de ce projet ?\n\nLes fichiers inutiles (doublons, versions intermédiaires, essais, captures de debug, fichiers vides) partent à la corbeille, restaurables 30 jours. Les fichiers de moins de 48 h et tes uploads (sauf doublon exact) sont gardés."))) return;
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
    <button type="button" className={`file-sort-btn${running ? " running" : ""}`} onClick={start} disabled={busy} title={running ? tr("Tri en cours : ouvrir l'agent") : tr("Trier les fichiers avec un agent")}>
      {busy ? tr("Lancement…") : running ? tr("Tri en cours…") : tr("Trier")}
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
      if (result.restoredAs !== item.name) window.alert(tr("Restauré sous « {0} » (le nom était repris).", result.restoredAs));
      await onChanged?.();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setRestoring("");
    }
  }

  async function deleteForever(item) {
    if (!window.confirm(tr("Supprimer définitivement « {0} » ({1}) ?\n\nSuppression définitive, irréversible : le fichier ne pourra plus être restauré.", item.name, bytes(item.size)))) return;
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
    if (!window.confirm(tr("Vider la corbeille : {0} fichier{1} ({2}) ?\n\nSuppression définitive, irréversible : aucun de ces fichiers ne pourra plus être restauré.", trash.length, trash.length > 1 ? "s" : "", size))) return;
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
          <i />{" "}{tr("Tri en cours…")}{" "}{deleted.length > 0 && tr("{0} à la corbeille pour l'instant", deleted.length)}
        </div>
      )}
      {status === "stale" && <div className="file-sort-running stale">{tr("Le dernier tri ne s'est pas terminé. Tu peux en relancer un.")}</div>}
      {status === "done" && sort.finishedAt && dismissed !== sort.finishedAt && (
        <div className="file-sort-done">
          <span>{deleted.length} {tr(deleted.length > 1 ? "fichiers" : "fichier")}{" "}{tr("en corbeille,")}{" "}{bytes(sort.freedBytes)}{" "}{tr("libérés")}</span>
          <button type="button" onClick={dismiss} aria-label={tr("Fermer")} title={tr("Fermer")}>×</button>
        </div>
      )}
      {trash.length > 0 && (
        <details className="file-sort-trash">
          <summary>
            <span>{tr("Corbeille")}</span>
            <strong>{trash.length} {tr(trash.length > 1 ? "fichiers" : "fichier")} · {bytes(trash.reduce((sum, item) => sum + (item.size || 0), 0))}</strong>
          </summary>
          <div className="file-sort-trash-actions">
            <small>{tr("Purge automatique après 30 jours.")}</small>
            <button type="button" className="danger" onClick={emptyTrash} disabled={Boolean(restoring)}>{restoring === "all" ? tr("Suppression…") : tr("Vider la corbeille")}</button>
          </div>
          <ul>
            {[...trash].reverse().map((item) => (
              <li key={item.id}>
                <span>
                  <b title={item.name}>{item.name}</b>
                  <small>{bytes(item.size)} · {item.reason}{" "}{tr("· effacé dans")}{" "}{daysLeft(item.expiresAt)} j</small>
                </span>
                <button type="button" onClick={() => restore(item)} disabled={Boolean(restoring)}>{restoring === item.id ? "…" : tr("Restaurer")}</button>
                <button type="button" className="danger" onClick={() => deleteForever(item)} disabled={Boolean(restoring)}>{tr("Supprimer définitivement")}</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
