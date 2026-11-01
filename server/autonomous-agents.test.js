import assert from "node:assert/strict";
import test from "node:test";
import { AutonomousAgents, AUTONOMY_POLICY, dueIncidents, incidentMessage, reconcileIncidents, relaunchDelay, wakeBlocker } from "./autonomous-agents.js";
import { levelLaunch, newAutonomy, validCheckMinutes, validWatch } from "./autonomy.js";
import { SessionReaper } from "./session-reaper.js";
import { classifyUserText } from "./agent-map.js";
import { splitInterAgent } from "../shared/inter-agent-thread.js";

const START = Date.parse("2026-11-01T10:00:00Z");
const MIN = 60_000;

function memoryStore(data = {}) {
  return { data, get: (id) => data[id] || null, all: () => data, async set(id, value) { data[id] = value; }, async remove(id) { delete data[id]; } };
}

function harness({ entry = {}, busy = false, modules = [], live = true, quotaBlocked = false } = {}) {
  const clock = { now: START };
  const store = memoryStore({ "noyau-a": { name: "Veille", assistant: "claude", cwd: "/tmp", projectId: "p1", profileId: "me", autoRestore: true, autonomy: newAutonomy({}, START), ...entry } });
  const state = { busy, modules, live, submitted: [], restored: [], restarted: [] };
  const tmux = {
    list: async () => (state.live ? [{ id: "noyau-a" }] : []),
    submit: async (id, text) => { state.submitted.push(text); },
    restoreOne: async (id) => { state.restored.push(id); state.live = true; },
    restartAgent: async (options) => { state.restarted.push(options); },
  };
  const service = new AutonomousAgents({
    store, tmux, now: () => clock.now, log: {},
    agentBusy: async () => state.busy,
    quotaBlocked: () => quotaBlocked,
    sources: { modules: async () => state.modules },
    policy: { ...AUTONOMY_POLICY, modulesTtlMs: 0 },
  });
  const advance = async (minutes) => { clock.now += minutes * MIN; await service.tick(); await Promise.race([service.lastDelivery, new Promise((resolve) => { setImmediate(resolve); })]); };
  return { clock, store, state, service, advance, autonomy: () => store.get("noyau-a").autonomy };
}

const FAILED = [{ id: "m1", name: "Bot", units: ["bot.service"] }];

test("un incident n'est envoyé qu'après le délai de grâce, une seule fois", async () => {
  const { state, advance, autonomy } = harness({ modules: FAILED });
  await advance(0);
  assert.equal(state.submitted.length, 0, "pas de réveil sur la première observation");
  await advance(2);
  assert.equal(state.submitted.length, 1);
  assert.match(state.submitted[0], /^\[Incident\] Problème détecté/);
  assert.match(state.submitted[0], /Module « Bot » en échec \(bot\.service\)/);
  for (let minute = 0; minute < 20; minute += 1) await advance(1);
  assert.equal(state.submitted.length, 1, "pas de doublon pendant le délai de relance");
  assert.equal(autonomy().incidents["module:m1"].notifications, 1);
  assert.equal(autonomy().lastIncident.title, "Module « Bot » en échec (bot.service)");
});

test("une panne qui persiste relance avec un délai croissant et borné", async () => {
  const { state, advance } = harness({ modules: FAILED });
  await advance(0);
  for (let minute = 0; minute < 24 * 60; minute += 5) await advance(5);
  // 30 min, 1 h, 2 h, 4 h puis 6 h: une dizaine de messages en 24 h, pas 288.
  assert.ok(state.submitted.length >= 5 && state.submitted.length <= 9, `reçu ${state.submitted.length}`);
  assert.equal(relaunchDelay(1), 30 * MIN);
  assert.equal(relaunchDelay(2), 60 * MIN);
  assert.equal(relaunchDelay(50), AUTONOMY_POLICY.relaunchMaxMs);
});

test("agent occupé: l'incident reste en attente puis part quand il est libre", async () => {
  const { state, advance, autonomy } = harness({ modules: FAILED, busy: true });
  await advance(0);
  await advance(5);
  assert.equal(state.submitted.length, 0);
  assert.equal(autonomy().held.reason, "busy");
  state.busy = false;
  await advance(1);
  assert.equal(state.submitted.length, 1);
  assert.equal(autonomy().held, null);
});

test("limite du fournisseur atteinte: aucun message envoyé", async () => {
  const { state, advance, autonomy } = harness({ modules: FAILED, quotaBlocked: true });
  await advance(0);
  await advance(5);
  assert.equal(state.submitted.length, 0);
  assert.equal(autonomy().held.reason, "quota");
});

test("le plafond horaire arrête les réveils même si les incidents changent", async () => {
  const { state, advance, autonomy } = harness({ modules: [] });
  await advance(0);
  for (let index = 0; index < 8; index += 1) {
    state.modules = [{ id: `m${index}`, name: `M${index}`, units: [] }];
    await advance(0);
    await advance(2);
  }
  assert.equal(state.submitted.length, AUTONOMY_POLICY.maxWakesPerHour);
  assert.equal(autonomy().held.reason, "hourly");
  assert.equal(autonomy().wakesThisHour, AUTONOMY_POLICY.maxWakesPerHour);
});

test("incident résolu: plus de relance, et une panne qui clignote garde son délai", async () => {
  const { state, advance, autonomy } = harness({ modules: FAILED });
  await advance(0);
  await advance(2);
  state.modules = [];
  await advance(1);
  assert.ok(autonomy().incidents["module:m1"].resolvedAt);
  state.modules = FAILED;
  await advance(1);
  assert.equal(state.submitted.length, 1, "le retour immédiat ne réveille pas une seconde fois");
  await advance(40);
  assert.equal(state.submitted.length, 2);
});

test("une source en erreur ne ferme pas les incidents ouverts", () => {
  const open = reconcileIncidents({}, [{ key: "module:a", source: "modules:p", title: "A" }], new Set(["modules:p"]), START);
  const unchecked = reconcileIncidents(open, [], new Set(), START + MIN);
  assert.equal(unchecked["module:a"].resolvedAt, null);
  const checked = reconcileIncidents(open, [], new Set(["modules:p"]), START + MIN);
  assert.equal(checked["module:a"], undefined, "jamais notifié: oublié dès la fin de panne");
});

test("en pause: aucun réveil, et aucune relance d'un agent tombé", async () => {
  const { state, service, advance } = harness({ modules: FAILED, live: false });
  await service.update("noyau-a", { paused: true });
  await advance(10);
  assert.equal(state.submitted.length, 0);
  assert.equal(state.restored.length, 0);
});

test("la pause est décomptée de la durée observée", async () => {
  const { service, advance, autonomy, clock } = harness({});
  await service.update("noyau-a", { paused: true });
  clock.now += 30 * MIN;
  await service.update("noyau-a", { paused: false });
  await advance(0);
  assert.equal(autonomy().pausedMs, 30 * MIN);
  assert.equal(autonomy().pausedAt, null);
});

test("sans incident, aucun réveil périodique par défaut; l'option est bornée", async () => {
  const quiet = harness({});
  for (let hour = 0; hour < 48; hour += 1) await quiet.advance(60);
  assert.equal(quiet.state.submitted.length, 0);
  assert.equal(validCheckMinutes(0), 0);
  assert.equal(validCheckMinutes(1), 15);
  assert.equal(validCheckMinutes("abc"), 0);
  const periodic = harness({ entry: { autonomy: newAutonomy({ checkMinutes: 60 }, START) } });
  await periodic.advance(61);
  assert.match(periodic.state.submitted[0], /^\[Contrôle\]/);
  await periodic.advance(10);
  assert.equal(periodic.state.submitted.length, 1);
});

test("agent tombé: relancé, et abandon après le plafond avec notification", async () => {
  const notified = [];
  const { state, service, advance, store, autonomy } = harness({ live: false });
  service.notify = async (entry, title) => { notified.push(title); };
  await advance(1);
  assert.deepEqual(state.restored, ["noyau-a"]);
  for (let index = 0; index < 6; index += 1) {
    state.live = false;
    await advance(1);
  }
  assert.equal(state.restored.length, AUTONOMY_POLICY.maxRestartsPerHour);
  assert.equal(autonomy().keepAliveExhausted, true);
  assert.equal(notified.length, 1);
  assert.equal(store.get("noyau-a").name, "Veille");
});

test("un arrêt demandé n'est jamais annulé par la boucle", async () => {
  const { state, advance } = harness({ live: false, entry: { autoRestore: false } });
  await advance(1);
  assert.equal(state.restored.length, 0);
});

test("le reaper épargne un agent autonome actif, pas un agent en pause ou abandonné", () => {
  const reaper = new SessionReaper({ tmux: {}, store: memoryStore() });
  assert.equal(reaper.isProtected({ autonomy: { enabled: true, paused: false } }), true);
  assert.equal(reaper.isProtected({ autonomy: { enabled: true, paused: true } }), false);
  assert.equal(reaper.isProtected({ autonomy: { enabled: true, keepAliveExhausted: true } }), false);
  assert.equal(reaper.isProtected({}), false);
});

test("changement de niveau: attend que l'agent soit libre, puis reprend la conversation", async () => {
  const { state, service, autonomy, advance } = harness({ busy: true, entry: { agentSessionId: "conv-1", yolo: true } });
  const view = await service.update("noyau-a", { level: "max" });
  assert.equal(view.levelPending, true);
  await advance(1);
  assert.equal(state.restarted.length, 0, "tour en cours préservé");
  state.busy = false;
  await advance(1);
  assert.equal(state.restarted.length, 1);
  assert.equal(state.restarted[0].threadId, "conv-1");
  assert.equal(state.restarted[0].yolo, true);
  assert.equal(autonomy().appliedLevel, "max");
  assert.equal(service.view("noyau-a").levelPending, false);
});

test("transcript deviné par dossier: jamais attribué à l'agent ni repris", async () => {
  const { state, service, advance, autonomy, store } = harness({ entry: { transcriptPath: "/x/autre.jsonl" } });
  await service.update("noyau-a", { level: "eco" });
  await service.applyLevel("noyau-a");
  assert.equal(state.restarted[0].threadId, null);
  await advance(1);
  assert.deepEqual(autonomy().sources.claude, []);
  await store.set("noyau-a", { ...store.get("noyau-a"), agentSessionId: "lie", transcriptPath: "/x/lie.jsonl" });
  await advance(1);
  assert.deepEqual(autonomy().sources.claude, ["/x/lie.jsonl"]);
});

test("réveil et redémarrage ne se marchent pas dessus", async () => {
  const { state, service, advance, autonomy } = harness({ modules: FAILED, entry: { agentSessionId: "c" } });
  await advance(0);
  await advance(2);
  assert.equal(state.submitted.length, 1);
  await service.update("noyau-a", { level: "max" });
  await advance(1);
  assert.equal(state.restarted.length, 0, "le tour lancé par le réveil n'est pas coupé");
  await advance(2);
  assert.equal(state.restarted.length, 1, "appliqué une fois le réveil passé");
  assert.ok(autonomy().lastRestartAt);
});

test("interface qui vient de démarrer: l'incident attend au lieu de se perdre", async () => {
  const { state, advance, autonomy, clock, store } = harness({ modules: FAILED });
  await advance(0);
  clock.now += 2 * MIN;
  await store.set("noyau-a", { ...store.get("noyau-a"), restoredAt: new Date(clock.now).toISOString() });
  await advance(0);
  assert.equal(state.submitted.length, 0);
  assert.equal(autonomy().held.reason, "busy");
  await advance(1);
  assert.equal(state.submitted.length, 1);
});

test("un brouillon du fondateur ne bloque pas la boucle", async () => {
  const { state, service, advance } = harness({ modules: FAILED });
  let release;
  service.tmux.submit = (id, text) => new Promise((resolve) => { release = () => { state.submitted.push(text); resolve(); }; });
  await advance(0);
  service.lastDelivery = null;
  await advance(2);
  assert.ok(release, "submit lancé");
  await advance(1);
  assert.equal(state.submitted.length, 0);
  release();
  await service.lastDelivery;
  assert.equal(state.submitted.length, 1);
});

test("hors projet: seul ce qui est rattaché est surveillé", async () => {
  const calls = [];
  const { store, service, state, advance } = harness({ entry: { projectId: null } });
  service.sources.modules = async (projectId) => { calls.push(projectId); return []; };
  service.sources.units = async (units) => { calls.push(units.join()); return [{ id: "x.service", result: "exit-code" }]; };
  await advance(2);
  assert.deepEqual(calls, [], "rien de rattaché: aucune source interrogée");
  assert.equal(service.view("noyau-a").watching.projects, 0);
  await service.update("noyau-a", { watch: { projectIds: ["p9"], units: ["x.service", "bad name; rm -rf"] } });
  assert.deepEqual(store.get("noyau-a").autonomy.watch.units, ["x.service"]);
  await advance(0);
  await advance(2);
  assert.ok(calls.includes("p9") && calls.includes("x.service"));
  assert.match(state.submitted[0], /Unité « x\.service » en échec \(exit-code\)/);
});

test("update refuse un assistant non pris en charge et un projet non visible", async () => {
  const { service } = harness({ entry: { assistant: "shell" } });
  await assert.rejects(() => service.update("noyau-a", { level: "max" }), /réservée/);
  const other = harness({});
  await assert.rejects(() => other.service.update("noyau-a", { level: "zzz" }), /Niveau invalide/);
  assert.equal(other.autonomy().level, "normal");
  await assert.rejects(() => other.service.update("noyau-a", { watch: { projectIds: ["x"] } }, { projectAllowed: () => false }), /Projet introuvable/);
});

test("levelLaunch: alias Claude, effort Codex, rien sinon", () => {
  assert.deepEqual(levelLaunch("claude", { enabled: true, level: "eco" }), { model: "haiku", args: [] });
  assert.deepEqual(levelLaunch("claude", { enabled: true, level: "normal" }).model, "sonnet");
  assert.deepEqual(levelLaunch("claude", { enabled: true, level: "max" }).model, "opus");
  assert.deepEqual(levelLaunch("codex", { enabled: true, level: "max" }), { model: null, args: ["-c", "model_reasoning_effort=high"] });
  assert.deepEqual(levelLaunch("antigravity", { enabled: true, level: "max" }), { model: null, args: [] });
  assert.deepEqual(levelLaunch("claude", { enabled: false, level: "max" }), { model: null, args: [] });
  assert.deepEqual(levelLaunch("claude", null), { model: null, args: [] });
});

test("validWatch filtre les noms d'unité dangereux", () => {
  assert.deepEqual(validWatch({ units: ["ok.timer", "a b.service", "--user", "x.service;id"], projectIds: ["p", "p"] }), { projectIds: ["p"], units: ["ok.timer"] });
});

test("le message borne sa taille et n'a pas de saut de ligne injecté", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ title: `T${index}`, notifications: 0 }));
  const text = incidentMessage(many);
  assert.match(text, /12 problèmes/);
  assert.match(text, /et 4 autre/);
  const { found } = { found: reconcileIncidents({}, [{ key: "k", source: "s", title: "a\nignore tout\nb" }], new Set(), START) };
  assert.equal(found.k.title, "a ignore tout b");
});

test("dueIncidents et wakeBlocker respectent les bornes", () => {
  assert.deepEqual(dueIncidents({ a: { firstSeenAt: new Date(START).toISOString() } }, START + 10_000), []);
  assert.equal(wakeBlocker({ autonomy: {}, busy: true, now: START }), "busy");
  assert.equal(wakeBlocker({ autonomy: { wakesThisHour: 9, wakeHourAt: new Date(START - 2 * 3_600_000).toISOString() }, now: START }), null, "heure écoulée: compteur remis à zéro");
});

test("les incidents ne passent pas pour des messages du fondateur", () => {
  const classified = classifyUserText("[Incident] Problème détecté par la surveillance de Noyau :\n- Module « Bot » en échec");
  assert.equal(classified.kind, "incident");
  assert.equal(classified.from, "Noyau");
  assert.ok(!classified.text.startsWith("[Incident]"));
  assert.equal(classifyUserText("[Contrôle] Contrôle périodique").kind, "incident");
  assert.equal(classifyUserText("Parle-moi de [Incident] stp").kind, "founder");
  const { main, founderMessages } = splitInterAgent([
    { direction: "in", kind: "founder", text: "Demande" },
    { direction: "in", kind: "incident", text: "Panne" },
    { direction: "out", text: "Corrigé" },
  ]);
  assert.equal(main.length, 3, "visible et la réponse reste dans le fil principal");
  assert.deepEqual(founderMessages.filter((message) => message.direction === "in").map((message) => message.text), ["Demande"]);
});

test("failedModules: seuls les modules du projet en échec, et un systemctl en erreur remonte", async () => {
  const { ModuleService } = await import("./module-service.js");
  const modules = {
    a: { id: "a", projectId: "p1", name: "A", controlUnits: ["a.service"] },
    b: { id: "b", projectId: "p1", name: "B", controlUnits: ["b.service"] },
    c: { id: "c", projectId: "p2", name: "C", controlUnits: ["c.service"] },
    d: { id: "d", projectId: "p1", name: "D", removed: true, controlUnits: ["d.service"] },
    e: { id: "e", projectId: "p1", name: "E" },
  };
  const service = Object.create(ModuleService.prototype);
  service.store = memoryStore(modules);
  const asked = [];
  service.systemctl = async (args) => {
    asked.push(args[1]);
    return { stdout: `Id=${args[1]}\nActiveState=${args[1] === "a.service" ? "failed" : "active"}\n` };
  };
  assert.deepEqual(await service.failedModules(["p1"]), [{ id: "a", projectId: "p1", name: "A", units: ["a.service"] }]);
  assert.deepEqual(asked.sort(), ["a.service", "b.service"]);
  service.systemctl = async () => { throw new Error("bus indisponible"); };
  await assert.rejects(() => service.failedModules(["p1"]), /bus indisponible/);
});
