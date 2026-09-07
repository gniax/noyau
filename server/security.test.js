import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLoginThrottle, loadAccessToken, sameWebSocketOrigin, validAccessToken } from "./security.js";

test("access token is preserved if present and generated privately when missing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-token-"));
  const file = path.join(directory, "access-token");
  await fs.writeFile(file, "kakaka28\n", { mode: 0o644 });
  const result = await loadAccessToken(file);
  assert.equal(result.token, "kakaka28");
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
