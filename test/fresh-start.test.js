import test from "node:test";
import assert from "node:assert/strict";
import { freshStartPrompt } from "../server/fresh-start.js";
import { contextAdvice } from "../server/context-advice.js";

test("a fresh start carries every recent request and the last answer", () => {
  const prompt = freshStartPrompt({ name: "Noyau", messages: [
    { direction: "in", kind: "founder", text: "Corrige le panier" },
    { direction: "out", text: "note", final: false },
    { direction: "in", kind: "agent", from: "Finance", text: "Budget ok" },
    { direction: "out", text: "Panier corrigé", final: true },
    { direction: "in", kind: "founder", text: "Et le thème" },
  ] });
  assert.match(prompt, /^Tu reprends le travail d'un autre agent/);
  assert.match(prompt, /1\. Corrige le panier/);
  assert.match(prompt, /2\. Et le thème/);
  assert.match(prompt, /Finance : Budget ok/);
  assert.match(prompt, /Panier corrigé/);
  assert.doesNotMatch(prompt, /note/);
});

test("work in progress is resumed with what remains and where to look", () => {
  const prompt = freshStartPrompt({ name: "Noyau", wasWorking: true, transcriptPath: "/x/ancien.jsonl", gitStatus: " M src/a.js", gitLog: "abc fix", todos: [{ ref: "*A1B2", text: "Finir le panier" }], messages: [
    { direction: "in", kind: "founder", text: "Première demande" },
    { direction: "out", text: "Fait", final: true },
    { direction: "in", kind: "founder", text: "Refais le thème" },
    { direction: "out", text: "Je modifie le CSS", final: false },
    { direction: "in", kind: "founder", text: "Et aussi le menu" },
  ] });
  assert.match(prompt, /REPRENDS-LE immédiatement/);
  assert.match(prompt, /sans réponse :\n- Refais le thème\n- Et aussi le menu/);
  assert.match(prompt, /Je modifie le CSS/);
  assert.match(prompt, /\*A1B2 Finir le panier/);
  assert.match(prompt, /M src\/a\.js/);
  assert.match(prompt, /\/x\/ancien\.jsonl/);
});

test("background subagents killed by the restart hand over their full brief", () => {
  const prompt = freshStartPrompt({ messages: [{ direction: "out", text: "Fini", final: true }], subagents: [
    { id: "a1", running: true, description: "Construire X", worktreePath: "/w/a1", prompt: "Consigne détaillée de X", lastText: "Je lis tmux.js" },
    { id: "a2", running: false, description: "Déjà fini", prompt: "Autre consigne" },
  ] });
  assert.match(prompt, /REPRENDS-LE/);
  assert.match(prompt, /Construire X \(worktree : \/w\/a1\)/);
  assert.match(prompt, /Consigne détaillée de X/);
  assert.match(prompt, /Je lis tmux\.js/);
  assert.doesNotMatch(prompt, /Déjà fini/);
});

test("an idle agent is not told to invent work", () => {
  const prompt = freshStartPrompt({ messages: [{ direction: "in", kind: "founder", text: "A" }, { direction: "out", text: "Fini", final: true }] });
  assert.doesNotMatch(prompt, /REPRENDS-LE/);
  assert.match(prompt, /où tu en es/);
});

test("a full context is reported as saturated, distinct from low", () => {
  assert.equal(contextAdvice({ assistant: "claude", usage: { contextPercent: 0 } }).level, "saturated");
  assert.equal(contextAdvice({ assistant: "claude", usage: { contextPercent: 3 } }).level, "saturated");
  assert.equal(contextAdvice({ assistant: "claude", usage: { contextPercent: 10 } }).level, "critical");
  assert.equal(contextAdvice({ assistant: "claude", usage: { contextPercent: 20, remainingTokens: 0 } }).level, "saturated");
});
