import test from "node:test";
import assert from "node:assert/strict";
import { autoCloseCandidates, finishedTodos } from "../server/todo-autoclose.js";

const now = Date.parse("2026-11-01T12:00:00Z");
const fresh = "2026-10-30T12:00:00Z";
const llm = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test("only recent open todos of the same project are candidates", () => {
  const todos = [
    { id: "a", projectId: "p", status: "todo", createdAt: fresh },
    { id: "b", projectId: "p", status: "done", createdAt: fresh },
    { id: "c", projectId: "q", status: "todo", createdAt: fresh },
    { id: "d", projectId: "p", status: "todo", createdAt: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(autoCloseCandidates(todos, "p", now).map((todo) => todo.id), ["a"]);
});

test("a todo closes only with evidence quoted from the reply", async () => {
  const todos = [{ id: "a", text: "Corriger le bug" }, { id: "b", text: "Autre" }];
  const content = '{"done":[{"id":"a","evidence":"Bug corrigé"},{"id":"b","evidence":"jamais écrit"},{"id":"x","evidence":"Bug corrigé"}]}';
  assert.deepEqual(await finishedTodos({ todos, reply: "Bug  corrigé et déployé.", fetchImpl: llm(content) }), [{ id: "a", evidence: "Bug corrigé" }]);
});
