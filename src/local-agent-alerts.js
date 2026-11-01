import { agentAlertTitle, agentAlertBody } from "../shared/agent-alerts.js";
export const localAlertKey = (server, profileId) => `noyau:local-alerts:${server}:${profileId}`;
export const backgroundAlertKey = (server, profileId) => `noyau:background-alerts:${server}:${profileId}`;
// Meme procede que le projet Invaders: l'app reste reveillee par la position et se notifie elle-meme, sans cle APNs.
export async function enableBackgroundAgentAlerts({ profileId, server, deviceId, api, plugin, storage }) {
  if (!profileId || !server || !deviceId) return false;
  try { await plugin.status(); } catch { return false; } // App installee sans le module natif.
  const { token, cursor } = await api("/api/mobile/background-alerts", { method: "POST", body: JSON.stringify({ deviceId, platform: "ios" }) });
  await plugin.enable({ server, token, cursor });
  storage.setItem(backgroundAlertKey(server, profileId), "1");
  return true;
}
export async function enableLocalAgentAlerts({ profileId, server, storage, notifications }) {
  if (!profileId || !server) throw new Error("Profil requis pour les alertes.");
  const permission = await notifications.requestPermissions();
  if (permission.display !== "granted") throw new Error("Notifications refusées dans les réglages du téléphone.");
  storage.setItem(localAlertKey(server, profileId), "1");
}
export async function sendLocalAgentAlert({ profileId, server, sessionId, agentName, projectName, type, storage, notifications, randomId }) {
  if (!profileId || !server || !sessionId || type !== "done" || storage.getItem(localAlertKey(server, profileId)) !== "1") return false;
  if ((await notifications.checkPermissions()).display !== "granted") return false;
  await notifications.schedule({ notifications: [{ id: randomId(), title: agentAlertTitle(projectName, agentName), body: agentAlertBody(type, agentName), extra: { module: "agent", session: sessionId } }] });
  return true;
}
