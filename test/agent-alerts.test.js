import test from "node:test";
import assert from "node:assert/strict";
import { agentAlertIdentity, agentAlertTitle, agentAlertBody } from "../shared/agent-alerts.js";
test("notifications identify project and agent without duplicate names or control characters", () => {
 assert.equal(agentAlertIdentity("Atlas", "Telegram"), "Atlas · Telegram"); assert.equal(agentAlertIdentity("Atlas", "atlas"), "atlas");
 assert.equal(agentAlertIdentity("Atlas\n", "Bot\u202e"), "Atlas · Bot"); assert.equal(agentAlertIdentity("", ""), "Agent Noyau");
 assert.equal(agentAlertTitle("Atlas", "Bot"), "Atlas"); assert.equal(agentAlertBody("waiting", "Bot"), "Bot attend votre réponse."); assert.equal(agentAlertBody("done", "Bot"), "Bot a terminé sa réponse.");
});
