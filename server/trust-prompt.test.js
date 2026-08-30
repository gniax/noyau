import assert from "node:assert/strict";
import test from "node:test";
import { detectsTrustQuestion, resolveTrustPrompt } from "./trust-prompt.js";

test("menu numerote: on choisit la reponse positive, quelle que soit sa place", () => {
  const claude = [
    "Do you trust the files in this folder?",
    "",
    "  1. No, exit",
    "❯ 2. Yes, proceed",
  ].join("\n");
  assert.deepEqual(resolveTrustPrompt(claude).keys, [{ literal: "2" }]);

  const codex = [
    "Do you trust this folder?",
    "  1) Yes, allow Codex to work here",
    "  2) No, quit",
  ].join("\n");
  assert.deepEqual(resolveTrustPrompt(codex).keys, [{ literal: "1" }]);
});

test("menu sans numeros: on descend jusqu'au oui avant de valider", () => {
  const pane = [
    "Trust this workspace?",
    "❯ No, exit",
    "  Yes, continue",
  ].join("\n");
  assert.deepEqual(resolveTrustPrompt(pane).keys, [{ key: "Down" }, { key: "C-m" }]);
});

test("un ecran ordinaire n'est jamais valide automatiquement", () => {
  assert.equal(detectsTrustQuestion("Voulez-vous supprimer ce fichier ? 1. Oui 2. Non"), false);
  assert.equal(resolveTrustPrompt("● Prêt. Que veux-tu faire ?"), null);
  assert.equal(resolveTrustPrompt("Do you trust this folder?\n  1. No, exit"), null);
});
