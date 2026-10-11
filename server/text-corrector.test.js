import assert from "node:assert/strict";
import test from "node:test";
import { TextCorrector, cleanCorrectedText } from "./text-corrector.js";

test("cleanCorrectedText nettoie les guillemets et préfixes résiduels", () => {
  assert.equal(cleanCorrectedText('"Acheter du pain"'), "Acheter du pain");
  assert.equal(cleanCorrectedText("« Faire la vaisselle »"), "Faire la vaisselle");
  assert.equal(cleanCorrectedText("```markdown\nCorriger le bug\n```"), "Corriger le bug");
  assert.equal(cleanCorrectedText("Voici le texte corrigé : Ranger la chambre"), "Ranger la chambre");
  assert.equal(cleanCorrectedText("", "fallback"), "fallback");
  assert.equal(cleanCorrectedText(null, "fallback"), "fallback");
});

test("correction never falls back to a remote agent", async () => {
  const raw = "texte brut avec des fautes";
  assert.equal(await new TextCorrector().correct(raw), raw);
  const failed = new TextCorrector({ localLlm: { chat: async () => { throw new Error("local unavailable"); } } });
  assert.equal(await failed.correct(raw), raw);
  assert.equal(failed.lastProvider, null);
});

test("TextCorrector ignore le texte vide", async () => {
  const corrector = new TextCorrector();
  assert.equal(await corrector.correct(""), "");
  assert.equal(await corrector.correct("   "), "   ");
  assert.equal(await corrector.correct(null), null);
});

test("le modèle local corrige, et une réponse hors sujet est écartée", async () => {
  const replies = [];
  const corrector = new TextCorrector({
    localLlm: { chat: async (messages) => { replies.push(messages.at(-1).content); return replies.length === 1 ? "Rajouter un bouton pour supprimer une liste" : "Voici mon analyse détaillée du problème que vous rencontrez, avec plusieurs pistes de résolution à envisager."; } },
  });

  assert.equal(await corrector.correct("rajouter un bouton pour suprimer une liste"), "Rajouter un bouton pour supprimer une liste");
  assert.equal(corrector.lastProvider, "local");
  // Le texte brut part au modèle: les consignes vivent dans le message système.
  assert.equal(replies[0], "rajouter un bouton pour suprimer une liste");

  // Réponse qui n'est plus une correction: on conserve l'original.
  assert.equal(await corrector.correct("rajouter un bouton"), "rajouter un bouton");
});
