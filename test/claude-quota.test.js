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

test("Claude 401 preserves previous quota if available", async () => {
  let saved = null;
  const previousQuota = { fiveHour: { remainingPercent: 50, resetsAt: "2026-09-06T22:00:00.000Z" } };
  const service = new ClaudeQuotaService({
    store: { get: () => previousQuota, set: async (_key, value) => { saved = value; } },
    credentialsFile: new URL("fixtures/claude-credentials.json", import.meta.url),
    fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers() }),
  });
  const res = await service.refresh();
  assert.deepEqual(res, previousQuota);
  assert.equal(saved, null);
});

test("Claude 401 sets loggedOut if no previous quota and no refresh token", async () => {
  let saved = null;
  const service = new ClaudeQuotaService({
    store: { get: () => null, set: async (_key, value) => { saved = value; } },
    credentialsFile: new URL("fixtures/claude-credentials.json", import.meta.url),
    fetchImpl: async () => ({ ok: false, status: 401, headers: new Headers() }),
  });
  await service.refresh();
  assert.equal(saved?.status, "loggedOut");
});
