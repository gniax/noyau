import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./app-icon.jsx";
import { isNative } from "./native-mobile.js";
import { readProjectFile } from "./project-file-transport.js";
import { PdfPreview } from "./pdf-preview.jsx";
import {
  formatFileBytes,
  getFileIcon,
  getFileCategory,
  getFileBadgeClass,
  getMimeType,
  parseCsvRows,
  detectProjectFiles,
  downloadProjectFile
} from "./project-file-utils.js";
import { tr } from "./i18n.js";

export {
  formatFileBytes,
  getFileIcon,
  getFileCategory,
  getFileBadgeClass,
  getMimeType,
  parseCsvRows,
  detectProjectFiles,
  downloadProjectFile
};

export function ProjectFilePreviewModal({ file, files = [], project, onClose, onSelectFile, onDownload }) {
  const profileId = typeof localStorage !== "undefined" ? localStorage.getItem("noyau:profile") : "";
  const token = typeof localStorage !== "undefined" ? (localStorage.getItem("noyau:token") || localStorage.getItem("token")) : "";
  const projectId = typeof project === "object" ? (project?.id || "") : (project || "");
  const ext = file?.extension || (file?.name ? `.${file.name.split(".").pop()}` : "");
  const category = getFileCategory(ext);
  const currentIndex = files.findIndex((f) => f.name === file?.name);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < files.length - 1;

  const previewUrl = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file?.name || "")}?inline=1${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}${token ? `&token=${encodeURIComponent(token)}` : ""}`;

  const [mediaPreview, setMediaPreview] = useState({ key: "", url: "", error: "", loading: true });
  const [zoomScale, setZoomScale] = useState(1);
  const [imgDimensions, setImgDimensions] = useState(null);

  const displayedPreviewUrl = ["image", "pdf", "audio", "video"].includes(category)
    ? (mediaPreview.key === previewUrl && mediaPreview.url ? mediaPreview.url : (isNative ? "" : previewUrl))
    : previewUrl;

  useEffect(() => {
    if (!["image", "pdf", "audio", "video"].includes(category) || !file?.name) return;
    let active = true;
    let objectUrl = "";
    setMediaPreview({ key: previewUrl, url: "", error: "", loading: true });

    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (profileId) headers["x-noyau-profile"] = profileId;

    readProjectFile(previewUrl, { headers })
      .then((blob) => {
        if (!active) return;
        const mime = blob.type && blob.type !== "application/octet-stream" ? blob.type : getMimeType(ext);
        const typedBlob = blob.type === mime ? blob : new Blob([blob], { type: mime });
        objectUrl = URL.createObjectURL(typedBlob);
        setMediaPreview({ key: previewUrl, url: objectUrl, blob: typedBlob, error: "", loading: false });
      })
      .catch((error) => {
        if (!active) return;
        setMediaPreview({ key: previewUrl, url: previewUrl, error: error.message, loading: false });
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [previewUrl, category, profileId, file?.name, ext, token]);

  const [textContent, setTextContent] = useState("");
  const [loadingText, setLoadingText] = useState(false);
  const [textError, setTextError] = useState("");
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [viewMode, setViewMode] = useState("default");
  const [csvFilter, setCsvFilter] = useState("");

  useEffect(() => {
    setZoomScale(1);
    setImgDimensions(null);
    setCopied(false);
    setCsvFilter("");
    setViewMode("default");

    if (["text", "csv", "json", "markdown"].includes(category) && file?.name) {
      let active = true;
      setLoadingText(true);
      setTextError("");
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (profileId) headers["x-noyau-profile"] = profileId;

      readProjectFile(previewUrl, { headers })
        .then(async (blob) => {
          if (!active) return;
          const txt = await blob.text();
          setTextContent(txt);
          setLoadingText(false);
        })
        .catch((err) => {
          if (active) {
            setTextError(err.message || tr("Erreur de chargement du fichier"));
            setLoadingText(false);
          }
        });

      return () => {
        active = false;
      };
    }
  }, [file?.name, category, previewUrl, profileId, token]);

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === "Escape") {
        onClose?.();
      } else if (e.key === "ArrowLeft" && hasPrev && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        onSelectFile?.(files[currentIndex - 1]);
      } else if (e.key === "ArrowRight" && hasNext && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        onSelectFile?.(files[currentIndex + 1]);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasPrev, hasNext, currentIndex, files, onClose, onSelectFile]);

  function copyText() {
    if (!textContent) return;
    navigator.clipboard?.writeText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  const csvData = useMemo(() => {
    if (category !== "csv" || !textContent) return null;
    return parseCsvRows(textContent);
  }, [category, textContent]);

  const filteredCsvRows = useMemo(() => {
    if (!csvData) return [];
    if (!csvFilter.trim()) return csvData.rows;
    const q = csvFilter.trim().toLowerCase();
    return csvData.rows.filter((row) => row.some((cell) => String(cell).toLowerCase().includes(q)));
  }, [csvData, csvFilter]);

  const formattedJson = useMemo(() => {
    if (category !== "json" || !textContent) return null;
    try {
      return JSON.stringify(JSON.parse(textContent), null, 2);
    } catch {
      return null;
    }
  }, [category, textContent]);

  const displayedText = (category === "json" && viewMode === "default" && formattedJson) ? formattedJson : textContent;
  const linesCount = displayedText ? displayedText.split("\n").length : 0;
  const lineNumbers = useMemo(() => {
    if (linesCount <= 0) return "";
    return Array.from({ length: linesCount }, (_, i) => i + 1).join("\n");
  }, [linesCount]);

  const badgeClass = getFileBadgeClass(ext);

  if (!file) return null;

  const modalContent = (
    <div className="modal-backdrop project-file-preview-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <section className="modal project-file-preview-modal" role="dialog" aria-modal="true" aria-label={tr("Aperçu de {0}", file.name)}>
        <header className="project-file-preview-head">
          <div className="project-file-preview-title-area">
            <span className="project-file-preview-icon">{getFileIcon(ext)}</span>
            <div className="project-file-preview-titles">
              <div className="project-file-preview-name">
                <h3 title={file.name}>{file.name}</h3>
                <span className={`project-file-badge ${badgeClass}`}>
                  {(ext?.replace(/^\./, "") || "fichier").toUpperCase()}
                </span>
              </div>
              <div className="project-file-preview-meta">
                <span>{file.sizeFormatted || formatFileBytes(file.size)}</span>
                {imgDimensions && <span> · {imgDimensions.w} × {imgDimensions.h} px</span>}
                {linesCount > 0 && <span> · {linesCount} {tr(linesCount > 1 ? "lignes" : "ligne")}</span>}
              </div>
            </div>
            {files.length > 1 && (
              <div className="project-file-preview-nav">
                <button
                  type="button"
                  className="project-file-preview-nav-btn"
                  onClick={() => hasPrev && onSelectFile?.(files[currentIndex - 1])}
                  disabled={!hasPrev}
                  title={tr("Fichier précédent (←)")}
                >
                  ‹
                </button>
                <span>{currentIndex + 1} / {files.length}</span>
                <button
                  type="button"
                  className="project-file-preview-nav-btn"
                  onClick={() => hasNext && onSelectFile?.(files[currentIndex + 1])}
                  disabled={!hasNext}
                  title={tr("Fichier suivant (→)")}
                >
                  ›
                </button>
              </div>
            )}
          </div>
          <div className="project-file-preview-actions">
            <a
              href={displayedPreviewUrl || previewUrl}
              target="_blank"
              rel="noreferrer"
              className="ghost"
              title={tr("Ouvrir dans un nouvel onglet")}
            >
              <AppIcon name="external" size={16} /><span>{tr("Ouvrir")}</span>
            </a>
            <button
              type="button"
              className="ghost"
              onClick={() => onDownload ? onDownload(file.name) : downloadProjectFile(projectId, file.name)}
              title={tr("Télécharger sur l'appareil")}
            >
              <AppIcon name="download" size={16} /><span>{tr("Télécharger")}</span>
            </button>
            <button
              type="button"
              className="ghost project-file-preview-close"
              onClick={onClose}
              title={tr("Fermer l'aperçu (Échap)")}
              aria-label={tr("Fermer l'aperçu")}
            >
              <AppIcon name="close" size={16} />
            </button>
          </div>
        </header>

        <div className="project-file-preview-body">
          {category === "image" && (
            <div className="project-file-preview-image-container">
              {mediaPreview.loading && !displayedPreviewUrl && (
                <div className="project-file-preview-loading">{tr("Chargement de l'image…")}</div>
              )}
              {displayedPreviewUrl && (
                <img
                  src={displayedPreviewUrl}
                  alt={file.name}
                  className="project-file-preview-image"
                  style={{ transform: `scale(${zoomScale})` }}
                  onLoad={(e) => {
                    setImgDimensions({ w: e.target.naturalWidth, h: e.target.naturalHeight });
                  }}
                />
              )}
              <div className="project-file-preview-image-toolbar">
                <button type="button" onClick={() => setZoomScale((s) => Math.max(0.25, s - 0.25))} title={tr("Zoom arrière")}>－</button>
                <span>{Math.round(zoomScale * 100)}%</span>
                <button type="button" onClick={() => setZoomScale((s) => Math.min(4, s + 0.25))} title={tr("Zoom avant")}>＋</button>
                <button type="button" onClick={() => setZoomScale(1)} title={tr("Taille réelle (100%)")}>100%</button>
              </div>
            </div>
          )}

          {category === "pdf" && (mediaPreview.key === previewUrl && mediaPreview.blob
            ? <PdfPreview blob={mediaPreview.blob} name={file.name} />
            : mediaPreview.key === previewUrl && !mediaPreview.loading && !isNative
              ? <iframe src={`${previewUrl}#toolbar=1`} title={file.name} className="project-file-preview-iframe" />
              : <div className="project-file-preview-loading">{mediaPreview.error ? tr("Aperçu PDF impossible : {0}", mediaPreview.error) : tr("Chargement du PDF…")}</div>)}

          {category === "audio" && (
            <div className="project-file-preview-media-container">
              <div className="project-file-preview-audio-card">
                <i><AppIcon name="volume" size={24} /></i>
                <strong>{file.name}</strong>
                <audio controls src={displayedPreviewUrl || undefined} autoPlay={false} />
              </div>
            </div>
          )}

          {category === "video" && (
            <div className="project-file-preview-media-container">
              <video controls playsInline src={displayedPreviewUrl || undefined} className="project-file-preview-video" autoPlay={false} />
            </div>
          )}

          {["text", "csv", "json", "markdown"].includes(category) && (
            <>
              <div className="project-file-preview-subbar">
                <div className="project-file-preview-subbar-left">
                  {category === "csv" && (
                    <>
                      <button
                        type="button"
                        className={viewMode !== "raw" ? "active" : ""}
                        onClick={() => setViewMode("default")}
                      >
                        {tr("Tableau (")}{csvData?.rows?.length || 0})
                      </button>
                      <button
                        type="button"
                        className={viewMode === "raw" ? "active" : ""}
                        onClick={() => setViewMode("raw")}
                      >
                        {tr("Brut (CSV)")}
                      </button>
                      {viewMode !== "raw" && (
                        <input
                          type="search"
                          placeholder={tr("Filtrer les lignes…")}
                          value={csvFilter}
                          onChange={(e) => setCsvFilter(e.target.value)}
                          className="project-file-preview-search"
                        />
                      )}
                    </>
                  )}
                  {category === "json" && formattedJson && (
                    <>
                      <button
                        type="button"
                        className={viewMode === "default" ? "active" : ""}
                        onClick={() => setViewMode("default")}
                      >
                        {tr("Formaté")}
                      </button>
                      <button
                        type="button"
                        className={viewMode === "raw" ? "active" : ""}
                        onClick={() => setViewMode("raw")}
                      >
                        {tr("Brut")}
                      </button>
                    </>
                  )}
                </div>
                <div className="project-file-preview-subbar-right">
                  <button
                    type="button"
                    className={`ghost ${wrapLines ? "active" : ""}`}
                    onClick={() => setWrapLines((w) => !w)}
                    title={tr("Retour à la ligne automatique")}
                  >
                    {tr("Retour à la ligne")}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={copyText}
                    title={tr("Copier le contenu dans le presse-papiers")}
                  >
                    {copied ? tr("Copié !") : tr("Copier le texte")}
                  </button>
                </div>
              </div>

              {loadingText && (
                <div className="project-file-preview-loading">{tr("Chargement du contenu…")}</div>
              )}
              {textError && (
                <div className="project-file-preview-error">
                  <p>{textError}</p>
                  <button type="button" onClick={() => onDownload ? onDownload(file.name) : downloadProjectFile(project?.id, file.name)}>
                    {tr("Télécharger plutôt le fichier")}
                  </button>
                </div>
              )}

              {!loadingText && !textError && category === "csv" && viewMode !== "raw" && csvData && (
                <div className="project-file-preview-csv-container">
                  <table className="project-file-preview-table">
                    <thead>
                      <tr>
                        <th className="row-num">#</th>
                        {csvData.headers.map((h, i) => (
                          <th key={i}>{h || `Col ${i + 1}`}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCsvRows.map((row, rIdx) => (
                        <tr key={rIdx}>
                          <td className="row-num">{rIdx + 1}</td>
                          {csvData.headers.map((_, cIdx) => (
                            <td key={cIdx}>{row[cIdx] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredCsvRows.length === 0 && (
                    <div className="project-file-preview-table-empty">
                      {tr("Aucune ligne ne correspond au filtre «")}{" "}{csvFilter} »
                    </div>
                  )}
                </div>
              )}

              {!loadingText && !textError && (category !== "csv" || viewMode === "raw") && (
                <div className="project-file-preview-code-container">
                  <pre className="project-file-preview-line-numbers" aria-hidden="true">
                    {lineNumbers}
                  </pre>
                  <pre className={`project-file-preview-code ${wrapLines ? "wrap" : ""}`}>
                    <code>{displayedText}</code>
                  </pre>
                </div>
              )}
            </>
          )}

          {category === "other" && (
            <div className="project-file-preview-unsupported">
              <span className="project-file-preview-unsupported-icon">{getFileIcon(ext)}</span>
              <h3>{file.name}</h3>
              <p>
                {tr("L'aperçu direct de ce type de fichier (")}<strong>{ext || "binaire"}</strong>{tr(") n'est pas pris en charge dans le navigateur.")}
              </p>
              <div className="project-file-preview-unsupported-actions">
                <button type="button" className="primary" onClick={() => onDownload ? onDownload(file.name) : downloadProjectFile(project?.id, file.name)}>
                  {tr("↓ Télécharger (")}{file.sizeFormatted || formatFileBytes(file.size)})
                </button>
                <a href={previewUrl} target="_blank" rel="noreferrer" className="ghost">
                  {tr("↗ Tenter l'ouverture dans un nouvel onglet")}
                </a>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modalContent, document.body) : modalContent;
}
