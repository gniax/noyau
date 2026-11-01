import test from "node:test";
import assert from "node:assert/strict";
import { delegateMessage, parseDelegate } from "../shared/delegate.js";
import { classifyUserText } from "../server/agent-map.js";

test("a delegated request shows only the founder's words", () => {
  const sent = delegateMessage("Corrige le bug\n\nFichier joint : /x/a.png");
  assert.match(sent, /noyau-agent-create/);
  assert.deepEqual(parseDelegate(sent), { delegated: true, text: "Corrige le bug\n\nFichier joint : /x/a.png" });
  assert.deepEqual(classifyUserText(sent), { from: null, kind: "founder", delegated: true, text: "Corrige le bug\n\nFichier joint : /x/a.png" });
});

test("an ordinary message is not a delegation", () => {
  assert.deepEqual(parseDelegate("[Délégation] sans le reste"), { delegated: false, text: "[Délégation] sans le reste" });
  assert.equal(classifyUserText("Bonjour").delegated, undefined);
});
