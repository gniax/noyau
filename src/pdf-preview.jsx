import { useEffect, useRef, useState } from "react";
import { tr } from "./i18n.js";

const MAX_PAGES = 60;

// Rendu canvas via pdf.js: l'iframe blob est bloquee par la CSP et la WebView Android n'affiche pas les PDF.
export function PdfPreview({ blob, name }) {
  const container = useRef(null);
  const [state, setState] = useState({ loading: true, error: "", pages: 0, total: 0 });

  useEffect(() => {
    if (!blob || !container.current) return undefined;
    let cancelled = false;
    let loadingTask = null;
    const host = container.current;
    host.replaceChildren();
    setState({ loading: true, error: "", pages: 0, total: 0 });
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      loadingTask = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
      const documentProxy = await loadingTask.promise;
      const total = documentProxy.numPages;
      const count = Math.min(total, MAX_PAGES);
      const ratio = window.devicePixelRatio || 1;
      for (let index = 1; index <= count && !cancelled; index += 1) {
        const page = await documentProxy.getPage(index);
        const base = page.getViewport({ scale: 1 });
        const width = Math.max(240, Math.min(host.clientWidth - 24, 1000));
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.className = "pdf-preview-page";
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
        canvas.setAttribute("aria-label", `${name} — page ${index}`);
        host.append(canvas);
        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
        if (!cancelled) setState({ loading: index < count, error: "", pages: index, total });
      }
    })().catch((error) => {
      if (!cancelled) setState({ loading: false, error: error?.message || "PDF illisible.", pages: 0, total: 0 });
    });
    return () => {
      cancelled = true;
      // pdf.js 6: seule la tache de chargement expose destroy().
      void loadingTask?.destroy().catch(() => {});
    };
  }, [blob, name]);

  return <div className="pdf-preview">
    {state.loading && !state.pages && <div className="project-file-preview-loading">{tr("Chargement du PDF…")}</div>}
    {state.error && <div className="project-file-preview-error">{tr("Aperçu PDF impossible :")}{" "}{state.error}</div>}
    <div ref={container} className="pdf-preview-pages" />
    {state.total > MAX_PAGES && <p className="pdf-preview-more">{state.total - MAX_PAGES}{" "}{tr("pages de plus : télécharge le fichier pour tout lire.")}</p>}
  </div>;
}
