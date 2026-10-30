export function validateNativeServer(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error("Adresse HTTPS du serveur invalide."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Adresse HTTPS du serveur requise, sans chemin ni identifiant.");
  return url.origin;
}

export function networkLabel(status) {
  if (!status?.connected) return "Aucun réseau détecté";
  if (status.connectionType === "wifi") return "Wi-Fi connecté";
  if (status.connectionType === "cellular") return "Réseau mobile connecté";
  return "Réseau connecté";
}

export async function probeNoyau(server, { fetcher = fetch, timeoutMs = 5000 } = {}) {
  const origin = validateNativeServer(server);
  const response = await fetcher(`${origin}/api/auth/session`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 401) return { reachable: true, authenticated: false };
  if (!response.ok) throw new Error(`Serveur Noyau : erreur ${response.status}.`);
  const data = await response.json();
  if (typeof data?.authenticated !== "boolean") throw new Error("Le serveur ne répond pas comme Noyau.");
  return { reachable: true, authenticated: data.authenticated, profile: data.profile || null };
}

export async function loadBundledHome(fetcher = fetch) {
  try {
    const response = await fetcher('/native-home.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    const caFingerprint = typeof data.caFingerprint === "string" && /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(data.caFingerprint) ? data.caFingerprint.toUpperCase() : null;
    return { homeUrl: validateNativeServer(data.homeUrl), hasCertificate: data.hasCertificate === true, caFingerprint };
  } catch { return null; }
}
