import test from "node:test";
import assert from "node:assert/strict";
import { loadBundledHome, networkLabel, probeNoyau, validateNativeServer } from "../src/native-connection.js";

test("native server accepts HTTPS origins only, without credentials, paths or fragments", () => {
  assert.equal(validateNativeServer(" https://home.example:4242/ "), "https://home.example:4242");
  for (const value of ["http://home.example", "https://user:pass@home.example", "https://home.example/path", "https://home.example/?a=b", "https://home.example/#x", "not-a-url"]) assert.throws(() => validateNativeServer(value));
});
test("network status reports actual transport and does not infer VPN state", () => {
  assert.equal(networkLabel({ connected: true, connectionType: "wifi" }), "Wi-Fi connecté");
  assert.equal(networkLabel({ connected: true, connectionType: "cellular" }), "Réseau mobile connecté");
  assert.equal(networkLabel({ connected: false, connectionType: "wifi" }), "Aucun réseau détecté");
  assert.equal(networkLabel({ connected: true, connectionType: "unknown" }), "Réseau connecté");
});
test("home configuration is optional, origin-validated and carries only public CA metadata", async () => {
  const fingerprint = Array(32).fill("AB").join(":");
  const config = await loadBundledHome(async () => Response.json({ homeUrl: "https://home.example:4242", hasCertificate: true, caFingerprint: fingerprint }));
  assert.deepEqual(config, { homeUrl: "https://home.example:4242", hasCertificate: true, caFingerprint: fingerprint });
  assert.equal(await loadBundledHome(async () => Response.json({ homeUrl: "http://attacker.invalid" })), null);
  assert.equal(await loadBundledHome(async () => { throw new Error("absent"); }), null);
});
test("reachability distinguishes unauthenticated, authenticated, malformed and TLS/network failures", async () => {
  let options;
  assert.deepEqual(await probeNoyau("https://home.example", { fetcher: async (url, init) => { assert.equal(url, "https://home.example/api/auth/session"); options = init; return Response.json({ error: "Unauthorized" }, { status: 401 }); } }), { reachable: true, authenticated: false });
  assert.equal(options.credentials, "include");
  assert.equal((await probeNoyau("https://home.example", { fetcher: async () => Response.json({ authenticated: true, profile: { id: "owner" } }) })).profile.id, "owner");
  await assert.rejects(probeNoyau("https://home.example", { fetcher: async () => Response.json({}) }), /ne répond pas comme Noyau/);
  await assert.rejects(probeNoyau("https://home.example", { fetcher: async () => { throw new TypeError("TLS rejected"); } }), /TLS rejected/);
});
