import test from "node:test";
import assert from "node:assert/strict";
import { contextAdvice, contextAlerts, optimizeCommand, supportsOptimize } from "./context-advice.js";

const session = (id, assistant, contextPercent, extra = {}) => ({ id, name: id, assistant, usage: contextPercent === null ? null : { contextPercent, ...extra } });

test("le niveau suit ce qu'il reste de contexte", () => {
  assert.equal(contextAdvice(session("a", "claude", 80)).level, "ok");
  assert.equal(contextAdvice(session("a", "claude", 50)).level, "watch");
  assert.equal(contextAdvice(session("a", "claude", 25)).level, "warn");
  assert.equal(contextAdvice(session("a", "claude", 12)).level, "critical");
  assert.equal(contextAdvice(session("a", "claude", 0)).action, "clear");
  assert.equal(contextAdvice(session("a", "claude", 30)).action, "compact");
});

test("un agent sans mesure ou sans commande ne conseille rien", () => {
  assert.equal(contextAdvice(session("a", "shell", 10)), null);
  assert.equal(contextAdvice(session("a", "claude", null)), null);
  assert.equal(contextAdvice(null), null);
});

test("les alertes remontent les agents les plus satures d'abord", () => {
  const alerts = contextAlerts([
    session("sain", "claude", 90),
    session("moyen", "codex", 40),
    session("plein", "codex", 8),
    session("terminal", "shell", 2),
  ]);
  assert.deepEqual(alerts.map((alert) => alert.sessionId), ["plein", "moyen"]);
  assert.equal(alerts[0].id, "plein:critical");
  assert.equal(alerts[0].assistant, "codex");
});

test("chaque agent a sa commande de remise a zero", () => {
  assert.equal(optimizeCommand("codex", "clear"), "/new");
  assert.equal(optimizeCommand("claude", "clear"), "/clear");
  assert.equal(optimizeCommand("claude", "compact"), "/compact");
  assert.equal(supportsOptimize("shell"), false);
  assert.throws(() => optimizeCommand("shell", "compact"), /sans commande/);
  assert.throws(() => optimizeCommand("claude", "boom"), /inconnu/);
});
