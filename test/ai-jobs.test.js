import test from "node:test";
import assert from "node:assert/strict";
import { AiJobs } from "../server/ai-jobs.js";

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => { setTimeout(resolve, 5); });

test("a fast result answers in the same request", async () => {
  const jobs = new AiJobs({ patienceMs: 50 });
  assert.deepEqual(await jobs.run("k", async () => ({ ok: 1 })), { ok: 1 });
});

test("a slow job answers pending at once, then delivers the result", async () => {
  const jobs = new AiJobs({ patienceMs: 1 });
  const gate = deferred();
  let calls = 0;
  const work = () => { calls += 1; return gate.promise; };
  assert.deepEqual(await jobs.run("k", work), { pending: true });
  assert.deepEqual(await jobs.run("k", work), { pending: true });
  gate.resolve("fini");
  await tick();
  assert.equal(await jobs.run("k", work), "fini");
  assert.equal(calls, 1);
});

test("concurrency is capped and the queue drains", async () => {
  const jobs = new AiJobs({ concurrency: 2, patienceMs: 1 });
  const gates = [deferred(), deferred(), deferred()];
  let started = 0;
  for (const [index, gate] of gates.entries()) await jobs.run(`k${index}`, () => { started += 1; return gate.promise; });
  assert.equal(started, 2);
  gates[0].resolve(1);
  await tick();
  assert.equal(started, 3);
});

test("a failing job reports its error once", async () => {
  const jobs = new AiJobs({ patienceMs: 20 });
  await assert.rejects(jobs.run("k", async () => { throw new Error("LLM"); }), /LLM/);
  assert.deepEqual(await jobs.run("k", async () => "repris"), "repris");
});
