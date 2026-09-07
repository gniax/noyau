import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TextCorrector, buildCorrectionPrompt, cleanCorrectedText } from "./text-corrector.js";

function createMockSpawn({ output = "Texte corrigé", exitCode = 0, errorOutput = "" } = {}) {
  let executed = null;
  const spawnFn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end(data) {
        executed = { binary, args, options, stdin: data };
        process.nextTick(() => {
          if (output) child.stdout.emit("data", Buffer.from(output));
          if (errorOutput) child.stderr.emit("data", Buffer.from(errorOutput));
          child.emit("close", exitCode);
        });
      },
    };
    return child;
  };
  return { spawnFn, getExecuted: () => executed };
}

test("cleanCorrectedText nettoie les guillemets et préfixes résiduels", () => {
  assert.equal(cleanCorrectedText('"Acheter du pain"'), "Acheter du pain");
  assert.equal(cleanCorrectedText("« Faire la vaisselle »"), "Faire la vaisselle");
  assert.equal(cleanCorrectedText("```markdown\nCorriger le bug\n```"), "Corriger le bug");
  assert.equal(cleanCorrectedText("Voici le texte corrigé : Ranger la chambre"), "Ranger la chambre");
  assert.equal(cleanCorrectedText("", "fallback"), "fallback");
  assert.equal(cleanCorrectedText(null, "fallback"), "fallback");
});

test("buildCorrectionPrompt adapte le contexte", () => {
  const promptTodo = buildCorrectionPrompt("faire le menage", "todo");
  assert.match(promptTodo, /tâche to-do/);
  assert.match(promptTodo, /faire le menage/);

  const promptComment = buildCorrectionPrompt("mon commantaire", "comment");
  assert.match(promptComment, /commentaire/);
  assert.match(promptComment, /mon commantaire/);
});

test("TextCorrector corrige via Claude si préféré", async () => {
  const { spawnFn, getExecuted } = createMockSpawn({ output: "Acheter du pain et du lait." });
  const corrector = new TextCorrector({
    claudeBinary: "/usr/bin/claude",
    pickProvider: () => "claude",
    spawnFn,
  });

  const corrected = await corrector.correct("achete du pain et du lais", { context: "todo" });
  assert.equal(corrected, "Acheter du pain et du lait.");
  const exec = getExecuted();
  assert.equal(exec.binary, "/usr/bin/claude");
  assert.match(exec.stdin, /achete du pain et du lais/);
});

test("TextCorrector fait un fallback propre sur le texte brut en cas d'erreur", async () => {
  const { spawnFn } = createMockSpawn({ exitCode: 1, errorOutput: "Rate limit" });
  const corrector = new TextCorrector({
    claudeBinary: "/usr/bin/claude",
    binary: null,
    pickProvider: () => "claude",
    spawnFn,
  });

  const raw = "texte brut avec des fautes";
  const result = await corrector.correct(raw);
  assert.equal(result, raw);
});

test("TextCorrector ignore le texte vide", async () => {
  const corrector = new TextCorrector();
  assert.equal(await corrector.correct(""), "");
  assert.equal(await corrector.correct("   "), "   ");
  assert.equal(await corrector.correct(null), null);
});
