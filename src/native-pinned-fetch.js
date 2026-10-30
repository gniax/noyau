// Capacitor routes GET through a separate WebView proxy which cannot use the
// scoped iOS trust handler. Send first-party reads through its HTTP plugin too.
export async function pinnedRead(input, options = {}, { request, origin, originalFetch }) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, globalThis.location?.href || origin);
  const method = String(options.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.origin !== origin || !["GET", "HEAD"].includes(method)) return originalFetch(input, options);
  const headers = Object.fromEntries(new Headers(options.headers || (input instanceof Request ? input.headers : undefined)).entries());
  const token = typeof localStorage !== "undefined" ? (localStorage.getItem("noyau:token") || localStorage.getItem("token")) : null;
  if (token && !headers.authorization && !headers.Authorization) {
    headers.authorization = `Bearer ${token}`;
  }
  const signal = options.signal || (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
  let abort;
  const cancelled = new Promise((_, reject) => { if (signal) { abort = () => reject(signal.reason || new DOMException("Aborted", "AbortError")); signal.addEventListener("abort", abort, { once: true }); } });
  try {
    const result = await Promise.race([request({ url: url.href, method, headers, responseType: "arraybuffer", connectTimeout: 12000, readTimeout: 12000 }), cancelled]);
    let body = null;
    if (method !== "HEAD" && ![204, 205, 304].includes(result.status)) {
      const contentType = Object.entries(result.headers || {}).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
      if (contentType.toLowerCase().includes("application/json")) {
        body = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      } else {
        const raw = typeof result.data === "string" ? result.data.replace(/[\r\n\s]/g, "") : "";
        const binary = atob(raw);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        body = bytes;
      }
    }
    const safeHeaders = { ...(result.headers || {}) };
    delete safeHeaders["content-encoding"];
    delete safeHeaders["Content-Encoding"];
    delete safeHeaders["content-length"];
    delete safeHeaders["Content-Length"];
    return new Response(body, { status: result.status, headers: safeHeaders });
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
