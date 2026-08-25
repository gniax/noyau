import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeQuotaService } from "../server/claude-quota.js";

test("Claude 429 stores exhausted quota and retry reset", async () => {
  let saved = null;
  const service = new ClaudeQuotaService({
    store: { get: () => ({}), set: async (_key, value) => { saved = value; } },
    credentialsFile: new URL("fixtures/claude-credentials.json", import.meta.url),
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "60" }) }),
  });
  await service.refresh();
  assert.equal(saved.fiveHour.remainingPercent, 0);
  assert.ok(new Date(saved.fiveHour.resetsAt).getTime() > Date.now());
});
