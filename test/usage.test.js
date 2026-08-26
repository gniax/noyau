import test from "node:test";
import assert from "node:assert/strict";
import { codexRateWindows, parseClaudeRateLimits, parseClaudeUsage, parseCodexUsage, parsePaneUsage } from "../server/usage.js";

test("Codex usage exposes remaining context and rate limit", () => {
  const usage = parseCodexUsage(JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 40_000, output_tokens: 1_000 }, model_context_window: 200_000 },
      rate_limits: { primary: { used_percent: 25, resets_at: 1_800_000_000, window_minutes: 10_080 } },
    },
  }));
  assert.equal(usage.remainingTokens, 159_000);
  assert.equal(usage.contextPercent, 80);
  assert.equal(usage.rateRemainingPercent, 75);
  assert.equal(usage.rateWindowMinutes, 10_080);
});

test("Codex rate windows cover the five-hour and weekly limits", () => {
  const windows = codexRateWindows({
    primary: { used_percent: 94, resets_at: 1_800_000_000, window_minutes: 300 },
    secondary: { used_percent: 40, resets_at: 1_800_500_000, window_minutes: 10_080 },
  });
  assert.deepEqual(windows.map((item) => [item.label, item.remainingPercent]), [["5h", 6], ["Semaine", 60]]);
  assert.equal(windows[0].resetsAt, new Date(1_800_000_000 * 1000).toISOString());
  assert.deepEqual(codexRateWindows(undefined), []);
});

test("Claude statusline rate limits expose five-hour and weekly quota", () => {
  const quota = parseClaudeRateLimits({
    five_hour: { used_percentage: 31.2, resets_at: 1_800_000_000 },
    seven_day: { used_percentage: 72.8, resets_at: 1_800_500_000 },
  });
  assert.equal(quota.fiveHour.remainingPercent, 69);
  assert.equal(quota.sevenDay.remainingPercent, 27);
  assert.equal(quota.fiveHour.resetsAt, "2027-01-15T08:00:00.000Z");
  const apiQuota = parseClaudeRateLimits({ five_hour: { utilization: 0.42, resets_at: "2027-01-15T08:00:00Z" } });
  assert.equal(apiQuota.fiveHour.remainingPercent, 58);
});

test("Claude usage includes cache tokens and marks estimate", () => {
  const usage = parseClaudeUsage(JSON.stringify({ type: "assistant", message: { model: "claude-opus", usage: { input_tokens: 5, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 20_000, output_tokens: 500 } } }));
  assert.equal(usage.remainingTokens, 169_495);
  assert.equal(usage.estimated, true);
});

test("pane footer provides fallback context percentage", () => {
  assert.equal(parsePaneUsage("gpt · 63% context left").contextPercent, 63);
});
