import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AutonomyEstimator, ESTIMATE_POLICY, parseClaudeUsageLine, parseCodexUsageLine, projectAgent, providerYield, sumBuckets, weeklyWindow } from "./autonomy-estimate.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

const claudeLine = ({ id = "m1", at = NOW - HOUR, input = 10, created = 100, read = 1000, output = 50, model = "claude-opus-5-5" } = {}) => JSON.stringify({ type: "assistant", timestamp: iso(at), message: { id, model, usage: { input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: output } } });
const codexLine = ({ at = NOW - HOUR, input, cached = 0, output, lastInput = input, lastCached = cached, lastOutput = output }) => JSON.stringify({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, last_token_usage: { input_tokens: lastInput, cached_input_tokens: lastCached, output_tokens: lastOutput } }, rate_limits: {} } });

test("ligne Claude réelle: frais et cache séparés, synthétique et bruit ignorés", () => {
  const parsed = parseClaudeUsageLine(claudeLine());
  assert.equal(parsed.fresh, 160);
  assert.equal(parsed.cached, 1000);
  assert.equal(parsed.id, "m1");
  assert.equal(parseClaudeUsageLine(claudeLine({ model: "<synthetic>" })), null);
  assert.equal(parseClaudeUsageLine('{"type":"user","message":{"content":"assistant usage"}}'), null);
  assert.equal(parseClaudeUsageLine("pas du json assistant usage"), null);
});

test("Codex: écart entre compteurs cumulés, doublons à zéro, info nulle ignorée", () => {
  const first = parseCodexUsageLine(codexLine({ input: 100, cached: 40, output: 10 }));
  assert.equal(first.fresh, 70);
  assert.equal(first.cached, 40);
  const again = parseCodexUsageLine(codexLine({ input: 100, cached: 40, output: 10 }), first.totals);
  assert.equal(again.fresh + again.cached, 0);
  const next = parseCodexUsageLine(codexLine({ input: 300, cached: 140, output: 30 }), first.totals);
  assert.equal(next.fresh, 120);
  assert.equal(next.cached, 100);
  assert.equal(parseCodexUsageLine('{"payload":{"type":"token_count","info":null}}'), null);
  // Reprise dans un fichier neuf: le cumul contient l'historique, seul le dernier tour compte.
  const resumed = parseCodexUsageLine(codexLine({ input: 9000, output: 900, lastInput: 50, lastCached: 0, lastOutput: 5 }));
  assert.equal(resumed.fresh, 55);
});

test("fenêtre hebdo: Claude sevenDay, Codex fenêtre longue, reset passé = pas d'estimation", () => {
  const resetsAt = iso(NOW + 2 * 24 * HOUR);
  const claude = weeklyWindow("claude", { sevenDay: { remainingPercent: 80, resetsAt }, updatedAt: iso(NOW) }, NOW);
  assert.equal(claude.usedPercent, 20);
  assert.equal(claude.start, NOW + 2 * 24 * HOUR - 7 * 24 * HOUR);
  const codex = weeklyWindow("codex", { windows: [{ remainingPercent: 0, windowMinutes: 300, resetsAt }, { remainingPercent: 40, windowMinutes: 10080, resetsAt }] }, NOW);
  assert.equal(codex.usedPercent, 60);
  assert.equal(weeklyWindow("claude", { sevenDay: { remainingPercent: 80, resetsAt: iso(NOW - HOUR) } }, NOW), null);
  assert.equal(weeklyWindow("claude", null, NOW), null);
});

test("rendement: refuse les bases trop faibles au lieu d'inventer", () => {
  const window = { usedPercent: 20, start: NOW - 48 * HOUR, updatedAt: NOW };
  const usage = { fresh: 1000, cached: 9000 };
  assert.equal(providerYield(null, usage, NOW).reason, "no-quota");
  assert.equal(providerYield({ ...window, usedPercent: 2 }, usage, NOW).reason, "low-usage");
  assert.equal(providerYield({ ...window, start: NOW - HOUR }, usage, NOW).reason, "window-young");
  assert.equal(providerYield({ ...window, updatedAt: NOW - 24 * HOUR }, usage, NOW).reason, "stale-quota");
  assert.equal(providerYield(window, { fresh: 0, cached: 0 }, NOW).reason, "no-tokens");
  const value = providerYield(window, usage, NOW);
  // Arrondi du % pris à sa borne haute: rendement bas, donc estimation haute.
  assert.equal(value.freshPerPercent, 1000 / 20.5);
  assert.equal(value.allPerPercent, 10000 / 20.5);
});

test("projection: taux × 7 j × marge, lecture la plus défavorable du cache", () => {
  const usage = { fresh: 1000, cached: 0, messages: 20 };
  const yields = { claude: { usedPercent: 20, freshPerPercent: 1000, allPerPercent: 100000 }, codex: { reason: "low-usage" } };
  const result = projectAgent({ usage, observedMs: 7 * 24 * HOUR, yields });
  assert.equal(result.status, "ok");
  // 1000 tokens en 7 j × 1,5 = 1500 frais / 1000 par % = 1,5 %, arrondi au-dessus.
  assert.equal(result.providers.claude.percent, 2);
  assert.equal(result.providers.codex.percent, null);
  assert.equal(result.providers.codex.reason, "low-usage");
  assert.equal(result.margin, ESTIMATE_POLICY.margin);
  const cacheHeavy = projectAgent({ usage: { fresh: 10, cached: 9_990_000, messages: 20 }, observedMs: 7 * 24 * HOUR, yields });
  assert.ok(cacheHeavy.providers.claude.percent >= 149, "un agent très cache ne passe pas sous la lecture « tout compris »");
});

test("données insuffisantes: aucun chiffre tant que l'observation est courte", () => {
  const yields = { claude: { freshPerPercent: 1000, allPerPercent: 1000 } };
  const young = projectAgent({ usage: { fresh: 5000, cached: 0, messages: 50 }, observedMs: HOUR, yields });
  assert.equal(young.status, "insufficient");
  assert.equal(young.reason, "observation");
  assert.equal(young.providers, undefined);
  assert.equal(young.measured.tokens, 5000);
  const quiet = projectAgent({ usage: { fresh: 5000, cached: 0, messages: 2 }, observedMs: 48 * HOUR, yields });
  assert.equal(quiet.reason, "activity");
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-estimate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claudeRoot = path.join(root, "claude");
  const codexRoot = path.join(root, "codex");
  await fs.mkdir(path.join(claudeRoot, "proj", "conv", "subagents"), { recursive: true });
  await fs.mkdir(codexRoot, { recursive: true });
  const quota = (provider) => (provider === "claude"
    ? { sevenDay: { remainingPercent: 90, resetsAt: iso(NOW + 24 * HOUR) }, updatedAt: iso(NOW) }
    : { windows: [{ remainingPercent: 50, windowMinutes: 10080, resetsAt: iso(NOW + 24 * HOUR) }], updatedAt: iso(NOW) });
  return { claudeRoot, codexRoot, quota };
}

test("scan: déduplique par id de message, compte les sous-agents, relit seulement la suite", async (t) => {
  const { claudeRoot, codexRoot, quota } = await fixture(t);
  const own = path.join(claudeRoot, "proj", "conv.jsonl");
  const other = path.join(claudeRoot, "proj", "other.jsonl");
  const sub = path.join(claudeRoot, "proj", "conv", "subagents", "agent-1.jsonl");
  await fs.writeFile(own, `${claudeLine({ id: "a" })}\n${claudeLine({ id: "a" })}\n${claudeLine({ id: "b" })}\n`);
  await fs.writeFile(other, `${claudeLine({ id: "a" })}\n${claudeLine({ id: "c" })}\n`);
  await fs.writeFile(sub, `${claudeLine({ id: "s" })}\n`);
  const estimator = new AutonomyEstimator({ claudeRoot, codexRoot, quota, now: () => NOW });
  const agent = { enabledAt: iso(NOW - 24 * HOUR), sources: { claude: [own], codex: [] } };
  await estimator.refresh({ agents: [agent], force: true });
  assert.equal(estimator.providerUsage("claude", NOW - 48 * HOUR).messages, 4, "a, b, c, s");
  assert.equal(estimator.agentUsage(agent, NOW - 24 * HOUR).messages, 3, "a, b et son sous-agent");
  // Une ligne incomplète en cours d'écriture n'est pas perdue.
  const line = claudeLine({ id: "d" });
  await fs.appendFile(own, line.slice(0, 40));
  await estimator.refresh({ agents: [agent] });
  assert.equal(estimator.agentUsage(agent, NOW - 24 * HOUR).messages, 3);
  await fs.appendFile(own, `${line.slice(40)}\n`);
  await estimator.refresh({ agents: [agent] });
  assert.equal(estimator.agentUsage(agent, NOW - 24 * HOUR).messages, 4);
});

test("estimate: lecture synchrone du cache, en attente avant le premier scan, puis chiffre", async (t) => {
  const { claudeRoot, codexRoot, quota } = await fixture(t);
  const own = path.join(claudeRoot, "proj", "conv.jsonl");
  const other = path.join(claudeRoot, "proj", "other.jsonl");
  const ownLines = Array.from({ length: 10 }, (_, index) => claudeLine({ id: `o${index}`, at: NOW - HOUR, input: 100, created: 0, read: 0, output: 0 }));
  const otherLines = Array.from({ length: 90 }, (_, index) => claudeLine({ id: `x${index}`, at: NOW - HOUR, input: 100, created: 0, read: 0, output: 0 }));
  await fs.writeFile(own, `${ownLines.join("\n")}\n`);
  await fs.writeFile(other, `${otherLines.join("\n")}\n`);
  await fs.writeFile(path.join(codexRoot, "rollout-t1.jsonl"), `${codexLine({ input: 10000, output: 0 })}\n`);
  const estimator = new AutonomyEstimator({ claudeRoot, codexRoot, quota, now: () => NOW });
  const autonomy = { enabledAt: iso(NOW - 7 * 24 * HOUR), sources: { claude: [own], codex: [] } };
  assert.deepEqual(estimator.estimate("a", autonomy), { status: "pending" });
  await estimator.refresh({ agents: [autonomy], force: true });
  const result = estimator.estimate("a", autonomy);
  assert.equal(result.status, "ok");
  // Compte: 10000 tokens = 10 % → 1000/10,5 par %. Agent: 1000 tokens sur 7 j × 1,5.
  assert.equal(result.providers.claude.percent, Math.ceil(1500 / (10000 / 10.5)));
  assert.equal(result.providers.codex.percent, Math.ceil(1500 / (10000 / 50.5)));
});

test("le temps en pause réduit la durée observée, donc augmente le taux", async (t) => {
  const { claudeRoot, codexRoot, quota } = await fixture(t);
  const estimator = new AutonomyEstimator({ claudeRoot, codexRoot, quota, now: () => NOW });
  await estimator.refresh({ force: true });
  const paused = estimator.estimate("a", { enabledAt: iso(NOW - 8 * HOUR), pausedMs: 4 * HOUR, sources: {} });
  assert.equal(paused.measured.hours, 4);
  assert.equal(paused.status, "insufficient");
});

test("sumBuckets ignore ce qui précède la fenêtre", () => {
  const buckets = new Map([[0, { fresh: 1, cached: 1, messages: 1 }], [NOW, { fresh: 2, cached: 2, messages: 2 }]]);
  assert.deepEqual(sumBuckets(buckets, NOW - HOUR), { fresh: 2, cached: 2, messages: 2 });
});
