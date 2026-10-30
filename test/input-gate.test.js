import test from "node:test";
import assert from "node:assert/strict";
import { InputGate, draftAfterInput } from "../server/input-gate.js";

test("un brouillon en cours retient les messages automatiques jusqu'a l'envoi", async () => {
  let clock = 0;
  const changes = [];
  const gate = new InputGate({ idleMs: 90_000, settleMs: 1_000, pollMs: 5, now: () => clock, onChange: (id, n) => changes.push(n) });
  assert.equal(gate.busy("a"), false);
  gate.typed("a", true);
  assert.equal(gate.busy("a"), true);
  let delivered = false;
  const waiting = gate.waitFree("a").then(() => { delivered = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(delivered, false);
  assert.equal(gate.pending("a"), 1);
  gate.typed("a", false);
  clock += 1_500;
  await waiting;
  assert.equal(delivered, true);
  assert.deepEqual(changes, [1, 0]);
});

test("un brouillon abandonne ne bloque pas indefiniment", () => {
  let clock = 0;
  const gate = new InputGate({ idleMs: 90_000, now: () => clock });
  gate.typed("a", true);
  clock += 91_000;
  assert.equal(gate.busy("a"), false);
});

test("Entree, Ctrl-C et Ctrl-U terminent le brouillon", () => {
  assert.equal(draftAfterInput("bonj"), true);
  assert.equal(draftAfterInput("fini\r"), false);
  assert.equal(draftAfterInput("\x03"), false);
  assert.equal(draftAfterInput("\x15"), false);
  assert.equal(draftAfterInput(""), null);
});

test("focus, souris, fleches et reponses terminal ne comptent pas comme brouillon", () => {
  for (const sequence of ["\x1b[I", "\x1b[O", "\x1b[A", "\x1bOB", "\x1b[<0;12;5M", "\x1b[?1;2c", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b[I\x1b[O"]) {
    assert.equal(draftAfterInput(sequence), null, JSON.stringify(sequence));
  }
  assert.equal(draftAfterInput("\x1b[Ibonjour"), true);
});
