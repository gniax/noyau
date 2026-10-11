import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeUsage, parseFreshClaudeUsage, parseAntigravityDb, parseAntigravityTranscript } from "./usage.js";

const line = (usage) => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", usage } });

test("une transcription repartie de zero rend un contexte plein", () => {
  const fresh = parseFreshClaudeUsage('{"type":"user","message":{"content":"salut"}}');
  assert.equal(fresh.contextPercent, 100);
  assert.equal(fresh.usedTokens, 0);
});

test("une transcription deja chargee ne passe pas pour neuve", () => {
  const text = line({ input_tokens: 120_000, output_tokens: 400 });
  assert.equal(parseFreshClaudeUsage(text), null);
  assert.equal(parseClaudeUsage(text).contextPercent, 40);
});

test("Antigravity DB parsing extrait les jetons et calcule le contexte", () => {
  // Simule un fragment SQLite avec un tag varint 0x28 (field 5) et un token count de 200_000
  // 200_000 en varint: 200000 = 0x30D40 -> 0xC0, 0x9A, 0x0C
  const buf = Buffer.concat([
    Buffer.from([0x28, 0xc0, 0x9a, 0x0c]),
    Buffer.from("bot-bdc96bbc-c3c0-4f8a-bf68-93eeac6c46cf"),
  ]);
  const parsed = parseAntigravityDb(buf, 1_000_000, { windows: [{ remainingPercent: 45, resetsAt: "2026-09-14T18:00:00.000Z" }] });
  assert.equal(parsed.usedTokens, 200_000);
  assert.equal(parsed.remainingTokens, 800_000);
  assert.equal(parsed.contextPercent, 80);
  assert.equal(parsed.rateRemainingPercent, 45);
  assert.equal(parsed.estimated, false);
});

test("Antigravity transcript fallback estime les jetons", () => {
  const text = "a".repeat(3800);
  const parsed = parseAntigravityTranscript(text, 1_000_000);
  assert.equal(parsed.usedTokens, 1000);
  assert.equal(parsed.remainingTokens, 999_000);
  assert.equal(parsed.contextPercent, 100);
  assert.equal(parsed.estimated, true);
});
