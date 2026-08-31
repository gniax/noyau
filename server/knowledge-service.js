const DRIVE_ID_PATTERN = /^[a-zA-Z0-9_-]{10,200}$/;
const NOTION_ID_PATTERN = /^[0-9a-f]{32}$/i;
const NOTION_VERSION = "2026-03-11";

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, "")).trim();
}

function driveKind(href, chunk) {
  if (/\/folders\//.test(href)) return "folder";
  if (/docs\.google\.com\/document\//.test(href)) return "document";
  if (/docs\.google\.com\/spreadsheets\//.test(href)) return "spreadsheet";
  if (/docs\.google\.com\/presentation\//.test(href)) return "presentation";
  const label = stripTags(chunk.match(/alt="([^"]+)"/)?.[1] || "").toLowerCase();
  if (label.includes("pdf")) return "pdf";
  if (/image|png|jpe?g|webp|gif/.test(label)) return "image";
  return "file";
}

function driveIdFromHref(href, fallback) {
  return href.match(/\/(?:folders|d)\/([a-zA-Z0-9_-]+)/)?.[1]
    || new URL(href, "https://drive.google.com").searchParams.get("id")
    || fallback;
}

export function parseDriveFolder(html) {
  return String(html || "").split('<div class="flip-entry"').slice(1).map((chunk) => {
    const fallbackId = chunk.match(/^ id="entry-([^"]+)"/)?.[1] || "";
    const href = decodeHtml(chunk.match(/<a href="([^"]+)"/)?.[1] || "");
    const title = stripTags(chunk.match(/<div class="flip-entry-title">([\s\S]*?)<\/div>/)?.[1]);
    const id = driveIdFromHref(href, fallbackId);
    const kind = driveKind(href, chunk);
    const modified = stripTags(chunk.match(/<div class="flip-entry-last-modified"><div>([\s\S]*?)<\/div>/)?.[1]);
    return { id, name: title, kind, modified, url: href, readable: ["document", "spreadsheet", "presentation"].includes(kind) };
  }).filter((item) => DRIVE_ID_PATTERN.test(item.id) && item.name && /^https:\/\/(?:drive|docs)\.google\.com\//.test(item.url));
}

async function fetchText(url, { fetchImpl = fetch, timeout = 15_000, limit = 2_000_000 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "Noyau/1.0" } });
  if (!response.ok) throw new Error(`Source distante indisponible (${response.status}).`);
  const text = await response.text();
  if (text.length > limit) throw new Error("Contenu distant trop volumineux.");
  return text.replace(/^\uFEFF/, "");
}

export async function listPublicDriveFolder(folderId, options = {}) {
  if (!DRIVE_ID_PATTERN.test(String(folderId || ""))) throw new Error("Dossier Drive invalide.");
  const html = await fetchText(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`, options);
  return { id: folderId, items: parseDriveFolder(html) };
}

export async function readPublicDriveFile(fileId, kind, options = {}) {
  if (!DRIVE_ID_PATTERN.test(String(fileId || ""))) throw new Error("Fichier Drive invalide.");
  const routes = {
    document: `https://docs.google.com/document/d/${fileId}/export?format=txt`,
    spreadsheet: `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`,
    presentation: `https://docs.google.com/presentation/d/${fileId}/export/txt`,
  };
  if (!routes[kind]) throw new Error("Aperçu texte indisponible pour ce fichier.");
  return { id: fileId, kind, content: await fetchText(routes[kind], options) };
}

export async function searchPublicDrive(rootId, query, options = {}) {
  const needle = String(query || "").trim().toLocaleLowerCase("fr-FR");
  if (!needle) throw new Error("Recherche requise.");
  const pending = [{ id: rootId, path: "" }];
  const visited = new Set();
  const found = [];
  while (pending.length && visited.size < 120) {
    const folder = pending.shift();
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    const { items } = await listPublicDriveFolder(folder.id, options);
    for (const item of items) {
      const path = folder.path ? `${folder.path}/${item.name}` : item.name;
      if (item.name.toLocaleLowerCase("fr-FR").includes(needle)) found.push({ ...item, path, match: "name" });
      if (item.kind === "folder" && pending.length < 200) pending.push({ id: item.id, path });
      if (!item.readable || found.some((entry) => entry.id === item.id && entry.match === "content")) continue;
      try {
        const { content } = await readPublicDriveFile(item.id, item.kind, options);
        const index = content.toLocaleLowerCase("fr-FR").indexOf(needle);
        if (index >= 0) found.push({ ...item, path, match: "content", snippet: content.slice(Math.max(0, index - 140), index + needle.length + 220).replace(/\s+/g, " ").trim() });
      } catch { /* fichiers sans export public restent trouvables par nom */ }
    }
  }
  return found.slice(0, 80);
}

function notionId(value) {
  const compact = String(value || "").replace(/-/g, "").match(/[0-9a-f]{32}/i)?.[0] || "";
  return NOTION_ID_PATTERN.test(compact) ? compact : null;
}

function notionRichText(value) {
  return (Array.isArray(value) ? value : []).map((part) => part.plain_text || part.text?.content || "").join("").trim();
}

function notionTitle(item) {
  for (const property of Object.values(item?.properties || {})) {
    if (property?.type === "title") return notionRichText(property.title) || "Page sans titre";
  }
  return item?.title?.[0]?.plain_text || item?.name || "Page sans titre";
}

async function notionRequest(token, endpoint, { method = "GET", body, fetchImpl = fetch } = {}) {
  if (!/^ntn_[a-zA-Z0-9_-]{20,}$/.test(String(token || ""))) throw new Error("Token Notion manquant ou invalide.");
  const response = await fetchImpl(`https://api.notion.com/v1${endpoint}`, {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Notion: ${String(payload.message || `erreur ${response.status}`).slice(0, 240)}`);
  return payload;
}

export class KnowledgeService {
  constructor({ configStore, fetchImpl = fetch }) {
    this.configStore = configStore;
    this.fetchImpl = fetchImpl;
  }

  config(moduleId) {
    return this.configStore.get(moduleId) || {};
  }

  async configureNotion(moduleId, { token, pageUrl } = {}) {
    const current = this.config(moduleId);
    const nextToken = String(token || current.token || "").trim();
    const identity = await notionRequest(nextToken, "/users/me", { fetchImpl: this.fetchImpl });
    let rootPageId = pageUrl === undefined ? current.rootPageId || null : notionId(pageUrl);
    if (pageUrl && !rootPageId) throw new Error("URL page Notion invalide.");
    if (!rootPageId) {
      const pages = await this.notionPages(nextToken, "Atlas");
      rootPageId = pages.find((page) => page.name.toLocaleLowerCase("fr-FR") === "atlas")?.id || null;
    }
    if (rootPageId) await notionRequest(nextToken, `/pages/${rootPageId}`, { fetchImpl: this.fetchImpl });
    await this.configStore.set(moduleId, {
      token: nextToken,
      rootPageId,
      integrationName: identity.name || identity.bot?.owner?.workspace?.name || "Intégration Notion",
      updatedAt: new Date().toISOString(),
    });
    return this.status({ id: moduleId, knowledge: { provider: "notion" } });
  }

  status(module) {
    if (module.knowledge?.provider === "google-drive-public") return { configured: true, scoped: true, label: "Lecture publique active" };
    const config = this.config(module.id);
    return {
      configured: Boolean(config.token),
      scoped: Boolean(config.rootPageId),
      label: !config.token ? "Token requis" : config.rootPageId ? "Page Atlas connectée" : "Partage page requis",
      integrationName: config.integrationName || null,
    };
  }

  async notionPages(token, query = "") {
    const payload = await notionRequest(token, "/search", { method: "POST", body: { query: String(query || "").slice(0, 100), page_size: 100 }, fetchImpl: this.fetchImpl });
    return (payload.results || []).filter((item) => item.object === "page").map((item) => ({
      id: notionId(item.id), name: notionTitle(item), kind: "page", modified: item.last_edited_time || null,
      url: item.url || `https://www.notion.so/${notionId(item.id)}`, readable: true, parentId: notionId(item.parent?.page_id),
    })).filter((item) => item.id);
  }

  scopedNotionPages(pages, rootPageId) {
    if (!rootPageId) return pages;
    const allowed = new Set([rootPageId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const page of pages) {
        if (!allowed.has(page.id) && allowed.has(page.parentId)) {
          allowed.add(page.id);
          changed = true;
        }
      }
    }
    return pages.filter((page) => allowed.has(page.id));
  }

  async list(module, { folderId, query = "" } = {}) {
    if (module.knowledge?.provider === "google-drive-public") {
      return listPublicDriveFolder(folderId || module.knowledge.rootId, { fetchImpl: this.fetchImpl });
    }
    if (module.knowledge?.provider === "notion") {
      const config = this.config(module.id);
      if (!config.token) throw new Error("Connexion Notion requise.");
      const pages = await this.notionPages(config.token, "");
      const scoped = this.scopedNotionPages(pages, config.rootPageId)
        .filter((item) => !query || item.name.toLocaleLowerCase("fr-FR").includes(String(query).toLocaleLowerCase("fr-FR")));
      return { id: config.rootPageId || "notion", items: scoped };
    }
    throw new Error("Source connaissances inconnue.");
  }

  async content(module, { itemId, kind } = {}) {
    if (module.knowledge?.provider === "google-drive-public") return readPublicDriveFile(itemId, kind, { fetchImpl: this.fetchImpl });
    if (module.knowledge?.provider === "notion") {
      const config = this.config(module.id);
      const id = notionId(itemId);
      if (!config.token || !id) throw new Error("Page Notion invalide.");
      if (config.rootPageId && id !== config.rootPageId) {
        const scoped = this.scopedNotionPages(await this.notionPages(config.token, ""), config.rootPageId);
        if (!scoped.some((page) => page.id === id)) throw new Error("Page hors espace Atlas.");
      }
      const payload = await notionRequest(config.token, `/pages/${id}/markdown`, { fetchImpl: this.fetchImpl });
      return { id, kind: "page", content: payload.markdown || "", truncated: Boolean(payload.truncated) };
    }
    throw new Error("Source connaissances inconnue.");
  }

  async search(module, query) {
    if (module.knowledge?.provider === "google-drive-public") return searchPublicDrive(module.knowledge.rootId, query, { fetchImpl: this.fetchImpl });
    const config = this.config(module.id);
    if (!config.token) throw new Error("Connexion Notion requise.");
    const queryText = String(query || "").trim();
    if (!queryText) throw new Error("Recherche requise.");
    const pages = this.scopedNotionPages(await this.notionPages(config.token, ""), config.rootPageId);
    const matches = [];
    for (const page of pages.slice(0, 30)) {
      try {
        const payload = await notionRequest(config.token, `/pages/${page.id}/markdown`, { fetchImpl: this.fetchImpl });
        const content = String(payload.markdown || "");
        const index = content.toLocaleLowerCase("fr-FR").indexOf(queryText.toLocaleLowerCase("fr-FR"));
        const nameMatch = page.name.toLocaleLowerCase("fr-FR").includes(queryText.toLocaleLowerCase("fr-FR"));
        if (nameMatch || index >= 0) matches.push({ ...page, match: index >= 0 ? "content" : "name", snippet: index >= 0 ? content.slice(Math.max(0, index - 140), index + queryText.length + 220).replace(/\s+/g, " ").trim() : "" });
      } catch { /* page inaccessible ignoree */ }
    }
    return matches.slice(0, 80);
  }
}

export { notionId };
