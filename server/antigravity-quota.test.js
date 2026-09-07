import assert from "node:assert/strict";
import test from "node:test";
import { AntigravityQuotaService, parseAntigravityUsage } from "./antigravity-quota.js";

const SAMPLE = [
  "Gemini Models\tWeekly Limit Remaining\t96%\t2026-09-06T12:44:54Z",
  "Gemini Models\tFive Hour Limit Remaining\t77%\t2026-08-30T17:44:54Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-06T13:20:03Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-08-30T18:20:03Z",
].join("\n");

test("le relevé Antigravity donne les fenêtres Gemini, la plus courte en tête", () => {
  const quota = parseAntigravityUsage(SAMPLE);
  assert.deepEqual(quota.windows.map(({ label, remainingPercent }) => [label, remainingPercent]), [["5 h", 77], ["7 j", 96]]);
  assert.equal(quota.windows[0].resetsAt, "2026-08-30T17:44:54.000Z");
  assert.equal(quota.families.length, 4);

  const spacedSample = [
    "Gemini Models          Weekly Limit Remaining     96%   2026-09-06T12:44:54Z",
    "Gemini Models          Five Hour Limit Remaining  77%   2026-08-30T17:44:54Z",
  ].join("\n");
  const spacedQuota = parseAntigravityUsage(spacedSample);
  assert.equal(spacedQuota.windows[0].remainingPercent, 77);
  assert.equal(spacedQuota.windows[1].remainingPercent, 96);
});

test("une sortie sans relevé ne remplace pas les quotas connus", async () => {
  assert.equal(parseAntigravityUsage("Antigravity CLI 1.1.22\nNothing to report"), null);
  const service = new AntigravityQuotaService({ store: { set: async () => { throw new Error("écriture interdite"); } }, binary: "agy", run: async () => ({ stdout: "" }) });
  await assert.rejects(() => service.refresh(), /illisible/);
});

test("le relevé est enregistré tel quel pour l'interface", async () => {
  const saved = {};
  const service = new AntigravityQuotaService({
    store: { set: async (key, value) => { saved[key] = value; } },
    binary: "agy",
    run: async () => ({ stdout: SAMPLE }),
  });
  await service.refresh();
  assert.equal(saved.antigravity.windows[0].remainingPercent, 77);
  assert.match(saved.antigravity.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});
