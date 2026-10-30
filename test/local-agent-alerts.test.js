import test from "node:test";
import assert from "node:assert/strict";
import { enableLocalAgentAlerts, sendLocalAgentAlert } from "../src/local-agent-alerts.js";
function context(display = "granted") {
  const store = new Map(), sent = [];
  return { profileId: "owner", server: "https://home.example", storage: { getItem: k => store.get(k), setItem: (k,v) => store.set(k,v) }, notifications: { requestPermissions: async () => ({ display }), checkPermissions: async () => ({ display }), schedule: async value => sent.push(value) }, randomId: () => 123, sent };
}
test("local alerts require consent, profile scope and supported event", async () => {
  const c = context(); assert.equal(await sendLocalAgentAlert({ ...c, sessionId: "agent", type: "done" }), false);
  await enableLocalAgentAlerts(c); assert.equal(await sendLocalAgentAlert({ ...c, sessionId: "agent", agentName: "Telegram", projectName: "Atlas", type: "done" }), true);
  assert.equal(c.sent[0].notifications[0].extra.session, "agent"); assert.equal(c.sent[0].notifications[0].title, "Atlas"); assert.equal(c.sent[0].notifications[0].body, "Telegram a terminé sa réponse.");
  assert.equal(await sendLocalAgentAlert({ ...c, profileId: "other", sessionId: "agent", type: "done" }), false);
  assert.equal(await sendLocalAgentAlert({ ...c, sessionId: "agent", type: "waiting" }), false);
  assert.equal(await sendLocalAgentAlert({ ...c, sessionId: "agent", type: "unknown" }), false);
});
test("denied permission never stores consent or schedules alerts", async () => {
  const c = context("denied"); await assert.rejects(enableLocalAgentAlerts(c), /refusées/);
  assert.equal(await sendLocalAgentAlert({ ...c, sessionId: "agent", type: "done" }), false); assert.equal(c.sent.length, 0);
});
