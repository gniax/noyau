import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import { BiometricAuthService, biometricSessionRoutes } from "../server/biometric-auth.js";
import { createLoginThrottle, createSessionToken, verifySessionToken } from "../server/security.js";
import { BiometricClient } from "../src/biometric-client.js";

async function backend(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-biometric-")); t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const records = { owner: { passwordHash: "test-hash", passwordSalt: "test-salt", passwordUpdatedAt: "2026-10-27" }, other: { passwordHash: "other-hash" } };
  const profiles = { get: (id) => records[id], authenticate: (password, id) => password === "unit-test-password" && records[id] ? { id } : null, resolve: (id) => ({ id, name: id }) };
  let now = Date.now(); const options = { file: path.join(dir, "devices.json"), profiles, secret: "unit-test-secret", now: () => now };
  const service = new BiometricAuthService(options); await service.load();
  return { service, profiles, records, options, expire: () => { now += 31 * 86400000; }, device: () => service.enroll("owner", { platform: "android", password: "unit-test-password", name: "Test phone" }) };
}

test("biometric enrollment requires current password, stores only a digest and binds one profile", async (t) => {
  const b = await backend(t); await assert.rejects(b.service.enroll("owner", { password: "wrong", platform: "android" }), /mot de passe/);
  const d = await b.device(); assert.equal(b.service.authenticate(d).profileId, "owner"); assert.equal(b.service.authenticate({ ...d, token: "x".repeat(43) }), null);
  assert.equal(b.service.authenticate({ ...d, id: "unknown" }), null); assert.equal(b.service.active(d.id, "other"), false);
  assert.equal(b.service.list("other").length, 0); assert.equal(JSON.stringify(b.service.list("owner")).includes(d.token), false);
  assert.equal((await fs.readFile(b.options.file, "utf8")).includes(d.token), false);
  const restored = new BiometricAuthService(b.options); await restored.load(); assert.equal(restored.authenticate(d).profileId, "owner");
});
test("expiry, password changes, profile deletion and revocation invalidate biometric credentials", async (t) => {
  const b = await backend(t); const d = await b.device(); await b.service.revoke("other", d.id); assert.ok(b.service.authenticate(d));
  b.records.owner.passwordUpdatedAt = "changed"; assert.equal(b.service.authenticate(d), null);
  const replacement = await b.device(); await b.service.revoke("owner", replacement.id); assert.equal(b.service.authenticate(replacement), null);
  const expired = await b.device(); b.expire(); assert.equal(b.service.authenticate(expired), null); assert.equal(b.service.list("owner").length, 0);
  delete b.records.owner; assert.equal(b.service.active(d.id, "owner"), false);
});
test("biometric session is rate limited and returns a secure profile-bound, device-revocable cookie", async (t) => {
  const b = await backend(t); const d = await b.device(); const app = express(); app.use(express.json());
  app.use(biometricSessionRoutes({ service: b.service, profiles: b.profiles, secret: b.options.secret, throttle: createLoginThrottle({ limit: 2 }) }));
  const server = app.listen(0, "127.0.0.1"); t.after(() => { server.closeAllConnections(); server.close(); }); await new Promise((resolve) => server.once("listening", resolve));
  const send = (body) => fetch(`http://127.0.0.1:${server.address().port}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await send({ ...d, profileId: "other" }); assert.equal(response.status, 200); assert.equal((await response.json()).profile.id, "owner");
  const cookie = response.headers.get("set-cookie"); for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Max-Age=7200"]) assert.ok(cookie.includes(flag));
  const verified = verifySessionToken(decodeURIComponent(cookie.split(";")[0].slice("noyau_session=".length)), b.options.secret); assert.equal(verified.biometricDeviceId, d.id);
  await b.service.revoke("owner", d.id); assert.equal(b.service.active(verified.biometricDeviceId, verified.profileId), false);
  assert.equal((await send(d)).status, 401); assert.equal((await send(d)).status, 401); const limited = await send(d); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.deepEqual(verifySessionToken(createSessionToken({ profileId: "owner", issuedAt: 1000 }, "secret"), "secret", 2000, 2000), { profileId: "owner", issuedAt: 1000 });
});
test("no more than ten active biometric devices per profile", async (t) => { const b = await backend(t); for (let i = 0; i < 10; i++) await b.device(); await assert.rejects(b.device(), /Dix appareils/); });
test("password changes while enrollment is queued never authorize a new persistent device", async (t) => {
  const b = await backend(t); let release; b.service.queue = new Promise((resolve) => { release = resolve; });
  const pending = b.device(); b.records.owner.passwordUpdatedAt = "new-password"; release();
  await assert.rejects(pending, /modifié/); assert.equal(b.service.list("owner").length, 0);
});

function clientFixture() {
  const values = new Map(); let secret; const calls = []; const expiresAt = Date.now() + 86400000;
  const vault = { async enroll({ value }) { secret = value; }, async unlock() { return { value: secret }; }, async clear() { secret = null; } };
  const metadata = { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async remove(key) { values.delete(key); } };
  const request = async (url, options) => { calls.push({ url, body: options?.body }); if (url.endsWith("/devices")) return { id: "test-device", token: "test-native-secret", profileId: "owner", expiresAt }; if (url.endsWith("/session")) return { profile: { id: "owner" } }; return {}; };
  const client = new BiometricClient({ server: "https://home.example", profileId: "owner", vault, metadata, request });
  return { client, values, calls, vault, metadata, request, enroll: () => client.enroll({ password: "test-password", platform: "android", label: "Fingerprint" }) };
}
test("native enrollment persists no password or bearer in metadata and OS approval precedes login", async () => {
  const f = clientFixture(); await f.enroll(); const json = JSON.stringify([...f.values.values()]); assert.ok(!json.includes("test-password")); assert.ok(!json.includes("test-native-secret"));
  assert.deepEqual(await f.client.unlock(), { offline: false }); f.vault.unlock = async () => { throw new Error("Cancelled by OS"); }; const before = f.calls.length;
  await assert.rejects(f.client.unlock(), /Cancelled by OS/); assert.equal(f.calls.length, before);
});
test("cancelled enrollment revokes issued device and never enables automatic unlock", async () => {
  const f = clientFixture(); f.vault.enroll = async () => { throw new Error("cancelled"); }; await assert.rejects(f.enroll(), /cancelled/);
  assert.equal(f.values.size, 0); assert.ok(f.calls.at(-1).url.endsWith("/devices/test-device"));
});
test("offline access requires biometric approval; HTTP failures and foreign scopes never bypass lock", async () => {
  const f = clientFixture(); await f.enroll(); f.client.request = async () => { throw new TypeError("Network unreachable"); }; assert.deepEqual(await f.client.unlock(), { offline: true });
  for (const status of [401, 403, 429, 500]) { f.client.request = async () => { throw Object.assign(new Error("denied"), { status }); }; await assert.rejects(f.client.unlock(), /denied/); }
  const original = f.vault.unlock; f.vault.unlock = async (options) => { const r = await original(options); return { value: JSON.stringify({ ...JSON.parse(r.value), server: "https://foreign.example" }) }; }; await assert.rejects(f.client.unlock(), /Association/);
  assert.throws(() => new BiometricClient({ server: "http://plain.example", profileId: "owner" }), /invalide/);
});
test("local disable remains possible offline or with malformed metadata", async () => {
  const f = clientFixture(); await f.enroll(); f.client.request = async () => { throw new Error("offline"); }; assert.deepEqual(await f.client.disable(), { revoked: false }); assert.equal(f.values.size, 0);
  f.metadata.get = async () => { throw new Error("invalid JSON"); }; assert.deepEqual(await f.client.disable(), { revoked: false });
});
test("native vault implementations bind secret access to OS biometric cryptography", { skip: !existsSync("android") }, async () => {
  const java = await fs.readFile(new URL("../android/app/src/main/java/com/noyau/app/BiometricVaultPlugin.java", import.meta.url), "utf8");
  const swift = await fs.readFile(new URL("../ios/App/App/BiometricVaultPlugin.swift", import.meta.url), "utf8");
  for (const code of ["AndroidKeyStore", "setUserAuthenticationRequired(true)", "AUTH_BIOMETRIC_STRONG", "new BiometricPrompt.CryptoObject(cipher)", "setInvalidatedByBiometricEnrollment(true)", "getCryptoObject()", "AES/GCM/NoPadding"]) assert.ok(java.includes(code));
  for (const code of [".biometryCurrentSet", "kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly", "SecItemCopyMatching", "deviceOwnerAuthenticationWithBiometrics"]) assert.ok(swift.includes(code));
  const index = await fs.readFile(new URL("../server/index.js", import.meta.url), "utf8");
  assert.equal(index.split("!verified.biometricDeviceId || biometricAuth.active(verified.biometricDeviceId, verified.profileId)").length - 1, 2);
});
