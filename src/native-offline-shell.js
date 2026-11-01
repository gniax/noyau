// Remote-origin shell stays available in the same WebView origin when the server goes offline.
export function registerNativeOfflineShell({ native, origin, server, serviceWorker }) {
  if (!native || !serviceWorker || !server || origin !== server.replace(/\/$/, '') || !origin.startsWith('https://')) return Promise.resolve(null);
  return serviceWorker.register('/sw.js').then((registration) => { registration.update().catch(() => {}); return registration; }).catch(() => null);
}
