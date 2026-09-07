import assert from "node:assert/strict";
import test from "node:test";
import { CodexQuotaService, parseCodexRateLimitResponse } from "./codex-quota.js";

const LIVE_RESPONSE = {
  id: 2,
  result: {
    rateLimits: {
      primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 33, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
    },
  },
};

test("Codex app-server response exposes remaining quota windows", () => {
  const windows = parseCodexRateLimitResponse(LIVE_RESPONSE);
  assert.deepEqual(windows.map(({ windowMinutes, remainingPercent }) => [windowMinutes, remainingPercent]), [[300, 89], [10_080, 67]]);
});

test("Codex quota refresh persists live app-server response", async () => {
  const saved = {};
  const service = new CodexQuotaService({
    store: { set: async (key, value) => { saved[key] = value; } },
    binary: "/usr/bin/codex",
    read: async () => parseCodexRateLimitResponse(LIVE_RESPONSE),
  });
  await service.refresh();
  assert.equal(saved.codex.windows[0].remainingPercent, 89);
  assert.match(saved.codex.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.codex.source, "live");
});

test("Codex quota refresh falls back to recent session data", async () => {
  const saved = {};
  const service = new CodexQuotaService({
    store: { set: async (key, value) => { saved[key] = value; } },
    binary: "/usr/bin/codex",
    read: async () => { throw new Error("offline"); },
    fallback: async () => parseCodexRateLimitResponse(LIVE_RESPONSE),
  });
  const result = await service.refresh();
  assert.equal(result.source, "session");
  assert.equal(saved.codex.windows[1].remainingPercent, 67);
});
