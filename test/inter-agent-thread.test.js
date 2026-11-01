import test from "node:test";
import assert from "node:assert/strict";
import { splitInterAgent, oneLine } from "../shared/inter-agent-thread.js";

const m = (stableId, direction, kind, extra = {}) => ({ stableId, direction, kind, text: stableId, ...extra });

test("an agent request and its reply leave the founder discussion but stay marked", () => {
  const { main, exchanges, founderMessages } = splitInterAgent([m("f1", "in", "founder"), m("r1", "out", "reply", { final: true }), m("a1", "in", "agent", { from: "Finance" }), m("r2", "out", "reply", { final: true })]);
  assert.deepEqual(main.map((x) => x.stableId), ["f1", "r1", "a1"]);
  assert.equal(main[2].exchange, exchanges[0]);
  assert.deepEqual(exchanges[0].replies.map((x) => x.stableId), ["r2"]);
  assert.deepEqual(founderMessages.map((x) => x.stableId), ["f1", "r1"]);
});

test("the founder never loses the answer to a request still open when an agent writes", () => {
  const { main, exchanges } = splitInterAgent([m("f1", "in", "founder"), m("a1", "in", "agent"), m("r1", "out", "reply", { final: true }), m("r2", "out", "reply", { final: true })]);
  assert.deepEqual(main.map((x) => x.stableId), ["f1", "a1", "r1"]);
  assert.deepEqual(exchanges[0].replies.map((x) => x.stableId), ["r2"]);
});

test("a progress note does not close the founder request", () => {
  const { main } = splitInterAgent([m("f1", "in", "founder"), m("a1", "in", "agent"), m("n", "out", "reply", { final: false }), m("r1", "out", "reply", { final: true })]);
  assert.deepEqual(main.map((x) => x.stableId), ["f1", "a1", "n", "r1"]);
});

test("a new founder message ends the agent exchange", () => {
  const { main, exchanges } = splitInterAgent([m("a1", "in", "agent"), m("r1", "out", "reply", { final: true }), m("f1", "in", "founder"), m("r2", "out", "reply", { final: true })]);
  assert.deepEqual(exchanges[0].replies.map((x) => x.stableId), ["r1"]);
  assert.deepEqual(main.map((x) => x.stableId), ["a1", "f1", "r2"]);
});

test("oneLine flattens and clips previews", () => {
  assert.equal(oneLine("a\n\n b"), "a b");
  assert.equal(oneLine("x".repeat(20), 5), "xxxx…");
});
