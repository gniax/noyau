import { Capacitor, CapacitorCookies, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { pinnedRead } from "./native-pinned-fetch.js";
import { createPinnedSocket } from "./native-socket.js";
import { shareProjectFile } from "./project-file-transport.js";
import { saveAndShareRelease } from "./native-release-download.js";
import { localAlertKey, enableLocalAgentAlerts, sendLocalAgentAlert } from "./local-agent-alerts.js";
import { App } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Browser } from "@capacitor/browser";
import { Share } from "@capacitor/share";
import { Preferences } from "@capacitor/preferences";
import { PushNotifications } from "@capacitor/push-notifications";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { parisInstant } from "../shared/grocery-calendar.js";
import { recipeFor } from "../shared/groceries.js";
import { addDays, dateParis } from "../shared/groceries.js";
import { validateNativeServer } from "./native-connection.js";

export const isNative = Capacitor.isNativePlatform();
export function nativeServer() {
  const stored = isNative ? localStorage.getItem("noyau:native-server") || "" : "";
  if (stored) return stored;
  if (typeof location !== "undefined" && location.origin && /^https?:/.test(location.origin) && !location.origin.includes("localhost")) {
    return location.origin;
  }
  return isNative ? "" : location.origin;
}
export function saveNativeServer(value) { localStorage.setItem("noyau:native-server", validateNativeServer(value)); }
export async function nativeNetworkStatus() { return isNative ? Network.getStatus() : { connected: navigator.onLine, connectionType: navigator.onLine ? "unknown" : "none" }; }
export async function shareNativeCertificate() {
  if (!isNative) throw new Error("Certificat disponible uniquement dans l’application native.");
  const response = await fetch("/native-home-ca.cer"); if (!response.ok) throw new Error("Certificat Noyau non inclus dans cette application.");
  const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length < 100 || bytes.length > 20000) throw new Error("Certificat Noyau invalide.");
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  const file = await Filesystem.writeFile({ path: "noyau-local-ca.cer", data: btoa(binary), directory: Directory.Cache });
  await Share.share({ title: "Certificat Noyau Local CA", files: [file.uri], dialogTitle: "Enregistrer le certificat Noyau dans Fichiers" });
}
export function socketOrigin() { return nativeServer().replace(/^https:/, "wss:").replace(/^http:/, "ws:"); }
const nativeSocket = registerPlugin("NoyauSocket");
export function openTerminalSocket(url) {
  if (!isNative || Capacitor.getPlatform() !== "ios") return new WebSocket(url);
  return createPinnedSocket(url, { plugin: nativeSocket, id: crypto.randomUUID(), states: WebSocket });
}
export async function nativeSocketUrl(path, query = "") {
  if (!isNative) return `${socketOrigin()}${path}${query ? `?${query}` : ""}`;
  const response = await fetch("/api/mobile/ws-ticket", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "X-Noyau-Profile": localStorage.getItem("noyau:profile") || "" }, body: JSON.stringify({ path }) });
  if (!response.ok) throw new Error("Reconnectez l'application au serveur pour ouvrir cet agent.");
  const { ticket } = await response.json(); const parameters = new URLSearchParams(query); parameters.set("ticket", ticket);
  return `${socketOrigin()}${path}?${parameters}`;
}

if (isNative) {
  const original = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const path = typeof input === "string" ? input : null;
    if (path && /^\/(?:api\/|version\.json|noyau-ca\.cer)/.test(path)) {
      if (!nativeServer()) return Promise.reject(new Error("Configurez le serveur Noyau dans l'application."));
      input = nativeServer() + path; options = { credentials: "include", ...options };
    }
    if (["ios", "android"].includes(Capacitor.getPlatform()) && nativeServer()) {
      try { return pinnedRead(input, options, { request: CapacitorHttp.request, origin: nativeServer(), originalFetch: original }); } catch (error) { return Promise.reject(error); }
    }
    return original(input, options);
  };
  Network.addListener("networkStatusChange", () => window.dispatchEvent(new Event("noyau:network-return")));
  App.addListener("appStateChange", ({ isActive }) => { if (isActive) window.dispatchEvent(new Event("noyau:network-return")); });
  LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => { if (notification.extra?.module === "groceries") window.dispatchEvent(new CustomEvent("noyau:native-navigation", { detail: { view: "groceries" } })); else if (notification.extra?.module === "agent" && notification.extra?.session) window.dispatchEvent(new CustomEvent("noyau:native-navigation", { detail: { session: notification.extra.session } })); });
  PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => { const target = new URL(notification.data?.url || "/", location.origin); window.dispatchEvent(new CustomEvent("noyau:native-navigation", { detail: { view: target.searchParams.get("view") || "dashboard", session: target.searchParams.get("session") } })); });
}

export function nativeLocalAlertsEnabled(profileId) { return Boolean(isNative && profileId && localStorage.getItem(localAlertKey(nativeServer(), profileId)) === "1"); }
export async function enableNativeLocalAlerts(profileId) {
  if (!isNative) throw new Error("Notifications natives indisponibles.");
  return enableLocalAgentAlerts({ profileId, server: nativeServer(), storage: localStorage, notifications: LocalNotifications });
}
export async function scheduleNativeAgentAlert(profileId, sessionId, type, agentName, projectName) {
  if (!isNative) return false;
  return sendLocalAgentAlert({ profileId, server: nativeServer(), sessionId, type, agentName, projectName, storage: localStorage, notifications: LocalNotifications, randomId: () => crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff });
}
export async function enableNativePush(api, deviceId) {
  const platform = Capacitor.getPlatform(); const status = await api("/api/mobile/push-status");
  if (!status.configured[platform]) throw new Error("Les rappels Courses fonctionnent localement ; les notifications serveur nécessitent la configuration Firebase/FCM (Android) ou Apple APNs (iPhone).");
  const permission = await PushNotifications.requestPermissions(); if (permission.receive !== "granted") return false;
  await new Promise((resolve, reject) => {
    let registration; let failure; const timer = setTimeout(() => { cleanup(); reject(new Error("Enregistrement push : délai dépassé.")); }, 20000);
    const cleanup = () => { clearTimeout(timer); registration?.remove(); failure?.remove(); };
    const setup = async () => {
      registration = await PushNotifications.addListener("registration", async ({ value }) => { try { await api("/api/mobile/push", { method: "POST", body: JSON.stringify({ platform, token: value, deviceId }) }); cleanup(); resolve(); } catch (error) { cleanup(); reject(error); } });
      failure = await PushNotifications.addListener("registrationError", () => { cleanup(); reject(new Error("Enregistrement push refusé ; vérifiez la configuration native Firebase/APNs.")); });
      await PushNotifications.register();
    };
    setup().catch((error) => { cleanup(); reject(error); });
  }); const profile = localStorage.getItem("noyau:profile") || ""; localStorage.setItem(`noyau:push-active:${nativeServer()}:${profile}`, "1"); localStorage.removeItem(localAlertKey(nativeServer(), profile)); return true;
}

const deviceKey = (profileId) => `noyau-grocery-device-${nativeServer() || "unpaired"}-${profileId}`;
export async function saveGroceryDevice(profileId, device) { if (isNative) await Preferences.set({ key: deviceKey(profileId), value: JSON.stringify(device) }); else sessionStorage.setItem(deviceKey(profileId), JSON.stringify(device)); }
export async function loadGroceryDevice(profileId) { try { return JSON.parse(isNative ? (await Preferences.get({ key: deviceKey(profileId) })).value : sessionStorage.getItem(deviceKey(profileId))); } catch { return null; } }
export async function forgetNativeSession(profileId, deviceId, { beforeClear } = {}) {
  if (!isNative) return;
  const device = await loadGroceryDevice(profileId);
  if (device?.id) await fetch(`/api/groceries/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", credentials: "include", headers: { "X-Noyau-Profile": profileId } }).catch(() => {});
  if (deviceId) await fetch("/api/mobile/push", { method: "DELETE", credentials: "include", headers: { "content-type": "application/json", "X-Noyau-Profile": profileId }, body: JSON.stringify({ deviceId }) }).catch(() => {});
  const pushKey = `noyau:push-active:${nativeServer()}:${profileId}`;
  if (localStorage.getItem(pushKey)) await PushNotifications.unregister().catch(() => {});
  localStorage.removeItem(pushKey);
  const reminders = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
  const own = reminders.notifications.filter((item) => item.extra?.module === "groceries" && item.extra.profileId === profileId).map(({ id }) => ({ id }));
  if (own.length) await LocalNotifications.cancel({ notifications: own });
  await Preferences.remove({ key: deviceKey(profileId) });
  await beforeClear?.();
  await CapacitorCookies.deleteCookie({ url: nativeServer(), key: "noyau_session" });
  localStorage.removeItem("noyau:profile");
}

export async function groceryRequest(profileId, path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(profileId ? { "X-Noyau-Profile": profileId } : {}), ...options.headers };
  const fetchJson = async (url, settings) => { const response = await fetch(url, { ...settings, signal: AbortSignal.timeout(12000) }); const data = await response.json().catch(() => ({})); if (!response.ok && response.status !== 409) { const error = new Error(data.error || `Erreur ${response.status}`); error.status = response.status; throw error; } return data; };
  try { return await fetchJson(path, { credentials: "include", ...options, headers }); }
  catch (error) {
    if (error.status && error.status !== 401) throw error;
    const device = await loadGroceryDevice(profileId);
    const [pathname, query] = path.split("?");
    if (!device?.token || !device.endpoint || !["/api/groceries", "/api/groceries/sync"].includes(pathname)) throw error;
    return fetchJson(`${device.endpoint}${pathname.endsWith("/sync") ? "/sync" : ""}${query ? `?${query}` : ""}`, { ...options, headers: { "Content-Type": "application/json", authorization: `Bearer ${device.token}` } });
  }
}

const androidInstaller = registerPlugin("NoyauAndroidInstaller");
export async function downloadNativeRelease(url, filename, { install = false } = {}) {
  if (!isNative) throw new Error("Téléchargement natif indisponible.");
  return saveAndShareRelease({ url, filename, fetcher: fetch, writeFile: (options) => Filesystem.writeFile({ ...options, directory: Directory.Cache }), statFile: (options) => Filesystem.stat({ ...options, directory: Directory.Cache }), share: (options) => Share.share(options), install: install && Capacitor.getPlatform() === "android" ? (options) => androidInstaller.install(options) : undefined });
}

export async function openRetailer(url) { if (!/^https:\/\//.test(url)) throw new Error("Lien HTTPS requis."); if (isNative) await Browser.open({ url }); else window.open(url, "_blank", "noopener,noreferrer"); }
export async function shareShopping(text) { if (isNative) return Share.share({ title: "Courses Noyau", text }); if (navigator.share) return navigator.share({ title: "Courses Noyau", text }); await navigator.clipboard.writeText(text); return { copied: true }; }
export async function exportMenuCalendar(text) {
  if (isNative) { const file = await Filesystem.writeFile({ path: "noyau-menus.ics", data: text, directory: Directory.Cache, encoding: Encoding.UTF8 }); await Share.share({ title: "Menus Noyau", files: [file.uri], dialogTitle: "Ajouter les menus au calendrier" }); return; }
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = "menus-noyau.ics"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function scheduleMenuReminders(state, { requestPermission = false, profileId = "local" } = {}) {
  if (!isNative) return { native: false, message: "Rappels hors ligne disponibles dans l'application APK/IPA ; export calendrier disponible ici." };
  const permission = requestPermission ? await LocalNotifications.requestPermissions() : await LocalNotifications.checkPermissions();
  if (permission.display !== "granted") return { native: true, granted: false };
  const pending = await LocalNotifications.getPending();
  const own = pending.notifications.filter((item) => item.extra?.module === "groceries" && item.extra.profileId === profileId).map(({ id }) => ({ id }));
  if (own.length) await LocalNotifications.cancel({ notifications: own });
  if (!state.settings.reminders) return { native: true, granted: true, count: 0 };
  const notifications = Array.from({ length: state.settings.days }, (_, index) => addDays(dateParis(), index)).map((date) => {
    const slot = state.plan.find((item) => item.date === date && item.status === "accepted"); const at = parisInstant(date, state.settings.remindAt);
    const hash = [...`${profileId}:${date}`].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
    return { id: 100000 + hash % 2000000000, title: state.settings.meal === "lunch" ? "Une bonne idée pour déjeuner ?" : "On cuisine quoi ce soir ?", body: slot ? `${recipeFor(state, slot.recipeId)?.title || "Repas choisi"} · ${slot.portions} portions` : "Votre sélection du jour vous attend ; choisissez un plat ou préparez le prochain menu.", schedule: { at, allowWhileIdle: true }, extra: { module: "groceries", profileId, view: "groceries" } };
  }).filter((item) => item.schedule.at.getTime() > Date.now()).slice(0, 28);
  if (notifications.length) await LocalNotifications.schedule({ notifications });
  return { native: true, granted: true, count: notifications.length };
}

export async function shareNativeProjectFile(blob, filename) {
  if (!isNative) throw new Error("Partage natif indisponible.");
  return shareProjectFile(blob, filename, { writeFile: (options) => Filesystem.writeFile({ ...options, directory: Directory.Cache }), share: (options) => Share.share(options) });
}

const wireGuardLauncher = registerPlugin("WireGuardLauncher");
export async function openWireGuard() {
  if (isNative && ["android", "ios"].includes(Capacitor.getPlatform())) { await wireGuardLauncher.open(); return; }
  throw new Error("Ouvre WireGuard sur cet appareil, puis active ton tunnel.");
}
