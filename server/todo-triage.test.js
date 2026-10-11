import test from "node:test";
import assert from "node:assert/strict";
import { TodoTriage, parseTriage, reference } from "./todo-triage.js";

const todos = [
  { id: "todo-mtr1-aa45ef", text: "Onglet Community puis retour accueil: reste bloqué sur Community", activityAt: "2026-09-07T18:00:00.000Z" },
  { id: "todo-mtr2-bbbc14", text: "Optimiser la lecture audio et la fonction Play", activityAt: "2026-09-06T10:00:00.000Z" },
  { id: "todo-mtr3-ccdone", text: "Tâche déjà terminée", status: "done", activityAt: "2026-09-07T19:00:00.000Z" },
];

function triageWith(reply) {
  return new TodoTriage({ localLlm: { chat: async () => reply } });
}

test("la réponse du modèle est lue même entourée de texte", () => {
  assert.deepEqual(parseTriage('Voici: {"suivi":true,"type":"bug","titre":"Corriger le splash","priorite":"high","doublon":null}'), {
    follow: true, type: "bug", title: "Corriger le splash", duplicate: null, priority: "high", folderTarget: null,
  });
  assert.deepEqual(parseTriage('{"suivi":true,"type":"evolution","titre":"Bouton bleu","doublon":null,"priorite":"low","dossier":"Design"}'), {
    follow: true, type: "evolution", title: "Bouton bleu", duplicate: null, priority: "low", folderTarget: "Design",
  });
  assert.deepEqual(parseTriage('{"suivi":false}'), { follow: false });
  assert.equal(parseTriage("pas de json ici"), null);
  // Une référence peut arriver avec ou sans étoile.
  assert.equal(parseTriage('{"suivi":true,"type":"bug","titre":"x","doublon":"*45ef"}').duplicate, "45EF");
});

test("un doublon annoncé est relié à la tâche réelle", async () => {
  const triage = triageWith('{"suivi":true,"type":"bug","titre":"Corriger le retour à l\'accueil","doublon":"45EF"}');
  const result = await triage.triage("le retour a l accueil depuis community ne marche toujours pas sur mobile", todos);
  assert.equal(result.follow, true);
  assert.equal(result.duplicate.id, "todo-mtr1-aa45ef");
});

test("une référence inconnue ne crée pas de faux doublon", async () => {
  const triage = triageWith('{"suivi":true,"type":"evolution","titre":"Ajouter un filtre","doublon":"9999"}');
  const result = await triage.triage("ajouter un filtre par categorie dans la bibliotheque des partitions", todos);
  assert.equal(result.duplicate, null);
  assert.equal(result.type, "evolution");
});

test("une simple question n'ouvre aucune tâche", async () => {
  const triage = triageWith('{"suivi":false}');
  assert.equal((await triage.triage("est-ce que tu peux m'expliquer comment marche le cache ici", todos)).follow, false);
  // Trop court pour être une demande: on n'appelle même pas le modèle.
  const never = new TodoTriage({ localLlm: { chat: async () => { throw new Error("ne doit pas être appelé"); } } });
  assert.equal((await never.triage("ok merci", todos)).follow, false);
});

test("les tâches terminées ne servent pas de repère", () => {
  const triage = triageWith("{}");
  const open = triage.candidates(todos).map((todo) => reference(todo.id));
  assert.deepEqual(open, ["45EF", "BBC14".slice(-4)]);
});

test("short bug reports reach the model and unknown untitled duplicates are ignored", async () => {
  const service = triageWith('{"suivi":true,"type":"bug","titre":"Corriger le crash","doublon":null}');
  assert.equal((await service.triage("ça plante")).follow, true);
  const invalid = triageWith('{"suivi":true,"doublon":"9999"}');
  assert.equal((await invalid.triage("ça plante")).follow, false);
});

test("triage serializes read, classification and write to prevent duplicate races", async () => {
  const service = triageWith("{}");
  const entries = [];
  const operation = () => service.enqueue(async () => {
    const count = entries.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!count) entries.push("task");
  });
  await Promise.all([operation(), operation()]);
  assert.equal(entries.length, 1);
  await assert.rejects(service.enqueue(async () => { throw new Error("failure"); }));
  await operation();
  assert.equal(service.pending, 0);
});

test("une passation ou une interruption n'est pas une demande", async () => {
  const triage = triageWith('{"type":"evolution","titre":"Ne devrait pas sortir","doublon":null}');
  assert.equal((await triage.triage("Tu es Claude et tu reprends le travail d'un agent Codex dans /home/x", todos)).follow, false);
  assert.equal((await triage.triage("This session is being continued from a previous conversation", todos)).follow, false);
  assert.equal((await triage.triage("[Request interrupted by user]", todos)).follow, false);
  assert.equal((await triage.triage("prépare la passation vers codex", todos)).follow, false);
  assert.equal((await triage.triage("passe la main à codex", todos)).follow, false);
  assert.equal((await triage.triage("mets le bouton à droite sur mobile", todos)).follow, true);
});

test("suggestEmojiForFolder utilise les heuristiques et le LLM", async () => {
  const { suggestEmojiForFolder } = await import("./todo-triage.js");
  assert.equal(await suggestEmojiForFolder("Développement"), "💻");
  assert.equal(await suggestEmojiForFolder("Design UI"), "🎨");
  assert.equal(await suggestEmojiForFolder("Campagne Marketing"), "📣");
  assert.equal(await suggestEmojiForFolder("Idées folles"), "💡");
  assert.equal(await suggestEmojiForFolder("Bugs critiques"), "🐛");
  assert.equal(await suggestEmojiForFolder(""), "📁");

  // Avec LLM pour nom inconnu
  const mockLlm = {
    chat: async () => "🚀",
  };
  assert.equal(await suggestEmojiForFolder("Quelque chose d'inconnu", mockLlm), "🚀");
});

