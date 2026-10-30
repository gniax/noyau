import { agentAlertTitle, agentAlertBody } from "../shared/agent-alerts.js";
export const localAlertKey = (server, profileId) => `noyau:local-alerts:${server}:${profileId}`;
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
