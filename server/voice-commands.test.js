import test from "node:test";
import assert from "node:assert/strict";
import { bestMatch, hasWakeWord, parseCommand, stripWake } from "./voice-commands.js";

const agents = [
  { id: "noyau-codex-1", name: "Octanix" },
  { id: "noyau-codex-2", name: "Atlas" },
  { id: "noyau-claude-3", name: "Nimbus" },
];

test("le mot d'éveil ouvre la commande et n'est pas confondu avec un mot isolé", () => {
  assert.equal(hasWakeWord("noyau ouvre l'agent octanix"), true);
  assert.equal(hasWakeWord("ouvre les todos"), false);
  assert.deepEqual(stripWake("Noyau, ouvre l'agent Octanix"), { awake: true, rest: "ouvre l agent octanix" });
});

test("un nom propre mal transcrit retrouve quand même son agent", () => {
  // Vosk rend « Octanix » en « obtenez »: le rapprochement doit tenir.
  assert.equal(bestMatch("obtenez", agents)?.name, "Octanix");
  assert.equal(bestMatch("at las", agents)?.name, "Atlas");
  assert.equal(bestMatch("nim bus", agents)?.name, "Nimbus");
  // Un mot sans rapport ne doit rien déclencher.
  assert.equal(bestMatch("température du salon", agents), null);
});

test("les commandes d'ouverture visent le bon agent", () => {
  const command = parseCommand("noyau ouvre l'agent obtenez", { agents });
  assert.equal(command.action, "open-agent");
  assert.equal(command.name, "Octanix");

  assert.equal(parseCommand("noyau affiche atlas", { agents }).name, "Atlas");
  assert.equal(parseCommand("noyau va sur les todos", { agents }).action, "view");
  assert.equal(parseCommand("noyau va sur les todos", { agents }).view, "todos");
  assert.equal(parseCommand("noyau budget", { agents }).view, "finances");
});

test("les commandes de service sont reconnues", () => {
  assert.equal(parseCommand("noyau coupe le son").action, "mute");
  assert.equal(parseCommand("noyau remets le son").action, "unmute");
  assert.equal(parseCommand("noyau stop").action, "stop-listening");
  const dictation = parseCommand("noyau dicte relance les tests puis commit");
  assert.equal(dictation.action, "dictate");
  assert.equal(dictation.text, "relance les tests puis commit");
});

test("sans mot d'éveil, seul un ordre clair passe", () => {
  // Un ordre net vers un agent connu suffit: le mot d'appel devient facultatif.
  assert.equal(parseCommand("ouvre l'agent octanix", { agents }).action, "open-agent");
  // Une conversation qui ne concerne pas Noyau ne declenche rien.
  assert.equal(parseCommand("octanix", { agents }), null);
  assert.equal(parseCommand("il faut que je rappelle le comptable demain", { agents }), null);
  assert.equal(parseCommand("arrete de raconter n importe quoi", { agents }), null);
  assert.equal(parseCommand("noyau").action, "wake");
  assert.equal(parseCommand("noyau ouvre la porte du garage", { agents }).action, "unknown");
});

test("« l'agent » vise un agent, « le projet » vise un projet", () => {
  const context = {
    agents: [{ id: "noyau-codex-1", name: "Octanix" }],
    projects: [{ id: "project-1", name: "Octanix" }],
  };
  assert.equal(parseCommand("noyau ouvre l'agent octanix", context).action, "open-agent");
  assert.equal(parseCommand("noyau ouvre le projet octanix", context).action, "open-project");
});

test("Noyau relaie un ordre a un agent sans ouvrir sa vue", () => {
  const command = parseCommand("noyau dis a l'agent atlas de corriger la route de paiement", { agents });
  assert.equal(command.action, "send-agent");
  assert.equal(command.id, "noyau-codex-2");
  assert.equal(command.text, "corriger la route de paiement");
});

test("une tache en cours se coupe a la voix", () => {
  assert.equal(parseCommand("noyau arrete l'agent atlas", { agents }).action, "interrupt");
  assert.equal(parseCommand("noyau arrete l'agent atlas", { agents }).id, "noyau-codex-2");
  assert.equal(parseCommand("noyau annule sa tache", { agents }).id, null);
  assert.equal(parseCommand("noyau stop", { agents }).action, "stop-listening");
});

test("la vue d'un agent s'affiche comme on la demande", () => {
  assert.equal(parseCommand("affiche la vue de l'agent atlas", { agents }).action, "open-agent");
  assert.equal(parseCommand("noyau affiche la page des todos", { agents }).view, "todos");
});

test("l'entretien d'un agent se demande aussi à la voix", () => {
  const compact = parseCommand("noyau compacte le contexte de atlas", { agents });
  assert.equal(compact.action, "optimize");
  assert.equal(compact.mode, "compact");
  assert.equal(compact.id, "noyau-codex-2");
  assert.equal(parseCommand("noyau vide la conversation de atlas", { agents }).mode, "clear");
  assert.equal(parseCommand("noyau relance l'agent atlas", { agents }).action, "restart");
});
