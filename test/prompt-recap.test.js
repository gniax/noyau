import test from "node:test";
import assert from "node:assert/strict";
import { fallbackRecap, summarizeRequestPrompt } from "../server/prompt-recap.js";

test("fallbackRecap decomposes multi-clause requests into clean bullets", () => {
  const prompt = "faudrait que le sommaire reformule les demandes ; et aussi ajouter un bouton pour lire ; pareil sur desktop enlever le bandeau";
  const bullets = fallbackRecap(prompt);
  assert.ok(Array.isArray(bullets));
  assert.ok(bullets.length >= 2);
  assert.ok(!bullets[0].toLowerCase().includes("faudrait que"));
});

test("summarizeRequestPrompt returns cached or fallback when proxy unreachable", async () => {
  const result = await summarizeRequestPrompt({
    text: "ajoute un test unitaire stp ; et corrige le style",
    llmProxyUrl: "http://127.0.0.1:9999/v1/chat/completions",
    timeoutMs: 300,
  });
  assert.ok(Array.isArray(result.bullets));
  assert.ok(result.bullets.length >= 1);
});

test("recap keeps the corrected title and accepts a model ignoring the bullet format", async () => {
  const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  const titled = await summarizeRequestPrompt({ text: "corige le titr stp", fetchImpl: reply('{"title":"Corriger le titre","bullets":["Corriger le titre du récap"]}') });
  assert.equal(titled.ai, true);
  assert.equal(titled.title, "Corriger le titre");
  const plain = await summarizeRequestPrompt({ text: "jai fai une fote", fetchImpl: reply("J'ai fait une faute.") });
  assert.equal(plain.ai, true);
  assert.deepEqual(plain.bullets, ["J'ai fait une faute."]);
});
