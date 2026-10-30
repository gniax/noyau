import { Capacitor, CapacitorCookies, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { isNative, nativeServer } from "./native-mobile.js";
import { BiometricClient } from "./biometric-client.js";

const vault = registerPlugin("BiometricVault");
const key = (scope) => `noyau:biometric:${scope}`;
const metadata = {
  async get(scope) { const { value } = await Preferences.get({ key: key(scope) }); return value ? JSON.parse(value) : null; },
  async set(scope, record) { await Preferences.set({ key: key(scope), value: JSON.stringify(record) }); window.dispatchEvent(new Event("noyau:biometric-changed")); },
  async remove(scope) { await Preferences.remove({ key: key(scope) }); window.dispatchEvent(new Event("noyau:biometric-changed")); },
};
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "include", headers: { "content-type": "application/json", "X-Noyau-Profile": localStorage.getItem("noyau:profile") || "" }, signal: AbortSignal.timeout(6000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `Erreur ${response.status}`), { status: response.status });
  return result;
}
export function biometricClient(profileId = localStorage.getItem("noyau:profile") || "") {
  return new BiometricClient({ server: nativeServer(), profileId, vault, metadata, request });
}
export async function biometricStatus(profileId) {
  if (!isNative) return { available: false, native: false, label: "Face ID / empreinte", enabled: false };
  const status = await vault.status(); const record = await biometricClient(profileId).record();
  return { ...status, native: true, enabled: Boolean(record), record };
}
export async function enableBiometric(profileId, password) {
  const status = await biometricStatus(profileId); if (!status.available) throw new Error("Activez Face ID / Touch ID ou une empreinte forte dans les réglages du téléphone.");
  return biometricClient(profileId).enroll({ password, platform: Capacitor.getPlatform(), label: `${status.label} · ${Capacitor.getPlatform()}` });
}
export async function disableBiometric(profileId) { return isNative && nativeServer() && profileId ? biometricClient(profileId).disable() : { revoked: true }; }
export async function biometricPasswordFallback() {
  const profileId = localStorage.getItem("noyau:profile"); if (profileId) await disableBiometric(profileId);
  await fetch("/api/logout", { method: "POST", credentials: "include", signal: AbortSignal.timeout(3000) }).catch(() => {});
  await CapacitorCookies.deleteCookie({ url: nativeServer(), key: "noyau_session" }); localStorage.removeItem("noyau:profile");
}
