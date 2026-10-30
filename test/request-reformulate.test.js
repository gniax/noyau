import test from "node:test";
import assert from "node:assert/strict";
import { reformulateRequest } from "../src/request-reformulate.js";

test("reformulateRequest uses linked todo text when available", () => {
  const result = reformulateRequest("n'importe quoi", { text: "Ergonomie chat : envoi sur Entrée" });
  assert.equal(result, "Ergonomie chat : envoi sur Entrée");
});

test("reformulateRequest truncates long todo text with ellipsis", () => {
  const longTodo = { text: "Une très très longue tâche avec beaucoup de détails pour tester la troncature automatique" };
  const result = reformulateRequest("prompt", longTodo);
  assert.ok(result.length <= 50);
  assert.ok(result.endsWith("…"));
});

test("reformulateRequest strips conversational filler and formats cleanly", () => {
  assert.equal(
    reformulateRequest("faudrait que le sommaire de droite reformule mes demandes stp"),
    "Le sommaire de droite reformule mes demandes"
  );
  assert.equal(
    reformulateRequest("tu peux corriger le bug de scroll"),
    "Corriger le bug de scroll"
  );
  assert.equal(
    reformulateRequest("bonjour, ajoute un bouton pour voir en direct svp"),
    "Un bouton pour voir en direct"
  );
});

test("reformulateRequest takes the first clause if multiple clauses separated by semicolons", () => {
  const res = reformulateRequest("ajoute le bouton de renvoi direct ; et fais en sorte de scroller");
  assert.equal(res, "Le bouton de renvoi direct");
});

test("reformulateRequest falls back gracefully on empty text", () => {
  assert.equal(reformulateRequest(""), "Demande");
  assert.equal(reformulateRequest(null), "Demande");
  assert.equal(reformulateRequest("   "), "Demande utilisateur");
});

import { findMatchingTodo } from "../src/request-reformulate.js";

test("findMatchingTodo does not falsely match unrelated todo like nuggets et boosts", () => {
  const allTodos = [
    { id: "t1", ref: "*1234", projectId: "p1", text: "Prioriser les Nuggets et Boosts en 1er" },
    { id: "t2", ref: "*5678", projectId: "p1", text: "Build de l'application mobile iOS" },
  ];
  // Message sans rapport avec nuggets
  const res = findMatchingTodo("tu peux build l'ipa et l'apk stp", allTodos, "p1");
  assert.notEqual(res?.id, "t1");
});

test("findMatchingTodo matches explicit *XXXX ref immediately", () => {
  const allTodos = [
    { id: "t1", ref: "*9A50", projectId: "p1", text: "Ergonomie chat" },
  ];
  const res = findMatchingTodo("corrige ça pour *9A50 stp", allTodos, "p1");
  assert.equal(res?.id, "t1");
});

test("findMatchingTodo rejects todos from another project", () => {
  const allTodos = [
    { id: "t1", ref: "*1111", projectId: "project-atlas", text: "Gestion des tokens et votes" },
  ];
  const res = findMatchingTodo("gestion des tokens et votes", allTodos, "project-noyau");
  assert.equal(res, null);
});
