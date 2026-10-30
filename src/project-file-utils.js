import { isNative, shareNativeProjectFile } from "./native-mobile.js";

export function formatFileBytes(bytes) {
  if (!bytes || bytes === 0) return "0 o";
  const k = 1024;
  const sizes = ["o", "Ko", "Mo", "Go"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function getFileIcon(ext) {
  const e = String(ext || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".bmp", ".ico"].includes(e)) return "🖼️";
  if ([".pdf"].includes(e)) return "📕";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(e)) return "🎬";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(e)) return "🎵";
  if ([".csv", ".tsv", ".xlsx", ".xls"].includes(e)) return "📊";
  if ([".zip", ".tar", ".gz", ".rar", ".7z", ".apk", ".ipa", ".aab"].includes(e)) return "📦";
  if ([".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".zsh", ".json", ".html", ".css", ".sql", ".rs", ".go", ".c", ".cpp"].includes(e)) return "💻";
  if ([".md", ".markdown", ".txt", ".doc", ".docx", ".log"].includes(e)) return "📝";
  return "📁";
}

export function getFileCategory(ext) {
  const e = String(ext || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].includes(e)) return "image";
  if ([".pdf"].includes(e)) return "pdf";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(e)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(e)) return "audio";
  if ([".csv", ".tsv"].includes(e)) return "csv";
  if ([".json"].includes(e)) return "json";
  if ([".md", ".markdown"].includes(e)) return "markdown";
  if ([
    ".txt", ".text", ".log", ".env", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".jsx",
    ".ts", ".tsx", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".py", ".yml", ".yaml",
    ".xml", ".sql", ".rs", ".go", ".c", ".cpp", ".h", ".hpp", ".php", ".rb", ".toml", ".ini",
    ".conf", ".diff", ".patch", ".dockerfile", ".gitignore", ".gitattributes"
  ].includes(e)) return "text";
  return "other";
}

export function getFileBadgeClass(ext) {
  const cat = getFileCategory(ext);
  if (cat === "image") return "image";
  if (cat === "pdf") return "pdf";
  if (["csv", "json"].includes(cat)) return "data";
  if (["audio", "video"].includes(cat)) return "media";
  return "";
}

export function getMimeType(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".gif") return "image/gif";
  if (e === ".webp") return "image/webp";
  if (e === ".svg") return "image/svg+xml";
  if (e === ".bmp") return "image/bmp";
  if (e === ".ico") return "image/x-icon";
  if (e === ".pdf") return "application/pdf";
  if (e === ".mp4") return "video/mp4";
  if (e === ".webm") return "video/webm";
  if (e === ".mp3") return "audio/mpeg";
  if (e === ".wav") return "audio/wav";
  if (e === ".ogg") return "audio/ogg";
  if (e === ".json") return "application/json";
  if (e === ".csv") return "text/csv";
  if (e === ".md" || e === ".markdown") return "text/markdown";
  return "application/octet-stream";
}

export function parseCsvRows(text) {
  if (!text) return { headers: [], rows: [] };
  const firstLine = text.split(/\r?\n/)[0] || "";
  let delimiter = ",";
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (semis > commas && semis > tabs) delimiter = ";";
  else if (tabs > commas && tabs > semis) delimiter = "\t";

  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = "";
    } else if ((char === "\r" || char === "\n") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c !== "")) rows.push(currentRow);
      currentRow = [];
      currentCell = "";
    } else {
      currentCell += char;
    }
  }
  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((c) => c !== "")) rows.push(currentRow);
  }

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0];
  const bodyRows = rows.slice(1);
  return { headers, rows: bodyRows };
}

export function detectProjectFiles(text, files) {
  if (!text || !Array.isArray(files) || !files.length) return [];
  const mentioned = [];
  const lowerText = text.toLowerCase();
  for (const file of files) {
    if (!file?.name) continue;
    const name = file.name.trim();
    if (name.length < 3) continue;
    const lowerName = name.toLowerCase();
    const escaped = lowerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|[\\s\`'"(\\[</>])${escaped}(?:$|[\\s\`'")\\]</>,;:!?.])`, "i");
    if (regex.test(text) || lowerText.includes(lowerName)) {
      if (!mentioned.some((m) => m.name === file.name)) {
        mentioned.push(file);
      }
    }
  }
  return mentioned;
}

export async function downloadProjectFile(projectId, filename, { isNative: native = isNative } = {}) {
  try {
    const token = typeof localStorage !== "undefined" ? (localStorage.getItem("noyau:token") || localStorage.getItem("token")) : null;
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const profile = typeof localStorage !== "undefined" ? localStorage.getItem("noyau:profile") : "";
    if (profile) headers["x-noyau-profile"] = profile;

    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(filename)}`, {
      credentials: "include",
      headers,
    });
    if (!response.ok) {
      throw new Error(`Erreur ${response.status}`);
    }
    const blob = await response.blob();
    if (native) {
      await shareNativeProjectFile(blob, filename);
      return;
    }
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      window.URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  } catch (error) {
    if (typeof window !== "undefined") {
      window.alert(`Téléchargement impossible : ${error.message}`);
    }
    throw error;
  }
}
