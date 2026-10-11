import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPasswordStrength, createLoginThrottle, createSessionToken, hashPassword, loadAccessToken, sameWebSocketOrigin, SESSION_MAX_AGE_MS, validAccessToken, validatePasswordStrength, verifyPassword, verifySessionToken } from "./security.js";

test("access token is preserved if present and generated privately when missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-token-"));
  const file = path.join(directory, "access-token");
  await fs.writeFile(file, "custom-secret-token\n", { mode: 0o644 });
  const result = await loadAccessToken(file);
  assert.equal(result.token, "custom-secret-token");
  assert.equal(result.rotated, false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const missingFile = path.join(directory, "missing-token");
  const genResult = await loadAccessToken(missingFile);
  assert.equal(validAccessToken(genResult.token), true);
  assert.equal(genResult.token.length >= 32, true);
  assert.equal((await fs.stat(missingFile)).mode & 0o777, 0o600);

  await fs.rm(directory, { recursive: true });
});

test("websocket origin must exactly match transport and host", () => {
  assert.equal(sameWebSocketOrigin({ origin: "https://noyau.test:4242", host: "noyau.test:4242", secure: true }), true);
  assert.equal(sameWebSocketOrigin({ origin: "https://evil.test", host: "noyau.test:4242", secure: true }), false);
  assert.equal(sameWebSocketOrigin({ origin: "http://noyau.test:4242", host: "noyau.test:4242", secure: true }), false);
  assert.equal(sameWebSocketOrigin({ origin: "", host: "noyau.test:4242", secure: true }), false);
});

test("login throttle blocks repeated failures and clears after success", () => {
  const throttle = createLoginThrottle({ limit: 2, windowMs: 10_000 });
  throttle.fail("device", 1_000);
  assert.equal(throttle.retryAfter("device", 2_000), 0);
  throttle.fail("device", 2_000);
  assert.equal(throttle.retryAfter("device", 3_000), 8);
  throttle.clear("device");
  assert.equal(throttle.retryAfter("device", 3_000), 0);
});

test("password hashing and verification", () => {
  const { hash, salt } = hashPassword("secret-pass-123");
  assert.equal(typeof hash, "string");
  assert.equal(typeof salt, "string");
  assert.equal(verifyPassword("secret-pass-123", hash, salt), true);
  assert.equal(verifyPassword("wrong-pass", hash, salt), false);
  assert.equal(verifyPassword("", hash, salt), false);
  assert.equal(verifyPassword(null, hash, salt), false);
});

test("session token expires at 2 hours max and rejects tampering", () => {
  const secret = "super-secret-key-32-chars-at-least";
  const now = 1_700_000_000_000;
  const token = createSessionToken({ profileId: "main", issuedAt: now }, secret);

  // Valide tout de suite
  const verified = verifySessionToken(token, secret, SESSION_MAX_AGE_MS, now);
  assert.equal(verified?.profileId, "main");
  assert.equal(verified?.issuedAt, now);

  // Valide a 1h59m
  const nearExpiry = verifySessionToken(token, secret, SESSION_MAX_AGE_MS, now + 7_140_000);
  assert.equal(nearExpiry?.profileId, "main");

  // Expire apres 2h (7200s)
  const expired = verifySessionToken(token, secret, SESSION_MAX_AGE_MS, now + 7_200_001);
  assert.equal(expired, null);

  // Rejette secret different
  assert.equal(verifySessionToken(token, "wrong-secret", SESSION_MAX_AGE_MS, now), null);

  // Rejette jeton trafique
  const tampered = token.slice(0, -4) + "abcd";
  assert.equal(verifySessionToken(tampered, secret, SESSION_MAX_AGE_MS, now), null);
});

test("password strength validation rejects weak passwords and accepts strong ones", () => {
  // Trop court (< 8 car.)
  assert.throws(() => validatePasswordStrength("short"), /trop court/i);
  assert.throws(() => validatePasswordStrength("1234567"), /trop court/i);

  // Répétition
  assert.throws(() => validatePasswordStrength("aaaaaaaa"), /répéter/i);
  assert.throws(() => validatePasswordStrength("11111111"), /répéter/i);

  // Mots de passe courants
  assert.throws(() => validatePasswordStrength("password"), /trop simple/i);
  assert.throws(() => validatePasswordStrength("12345678"), /trop simple/i);
  assert.throws(() => validatePasswordStrength("admin123"), /trop simple/i);
  assert.throws(() => validatePasswordStrength("noyau123"), /trop simple/i);

  // Manque de mixité si < 12 car.
  assert.throws(() => validatePasswordStrength("abcdefgh"), /combiner lettres/i);
  assert.throws(() => validatePasswordStrength("87654321"), /trop simple|combiner lettres/i);

  // Valide : >= 8 car. avec lettres et chiffres/symboles
  assert.equal(validatePasswordStrength("Noyau-2026!"), true);
  assert.equal(validatePasswordStrength("chateau123"), true);

  // Valide : passphrase longue (>= 12 car.)
  assert.equal(validatePasswordStrength("mon-chateau-secret"), true);
  assert.equal(validatePasswordStrength("un mot de passe long"), true);

  // checkPasswordStrength scores
  assert.equal(checkPasswordStrength("Noyau-2026!").level, "strong");
  assert.equal(checkPasswordStrength("pass1234").level, "medium");
  assert.equal(checkPasswordStrength("short").level, "weak");
});
