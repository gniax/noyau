import test from "node:test";
import assert from "node:assert/strict";
import { pinnedRead } from "../src/native-pinned-fetch.js";
const origin = "https://home.example:4242";
test("iOS first-party GET uses native HTTP and preserves JSON and 401 status", async () => {
  const response = await pinnedRead(origin + "/api/auth/session", {}, { origin, originalFetch: () => { throw Error("proxy used"); }, request: async (input) => { assert.equal(input.method, "GET"); return { status: 401, headers: { "content-type": "application/json" }, data: { authenticated: false } }; } });
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { authenticated: false });
});
test("iOS pinned GET preserves binary and other origins use normal fetch", async () => {
  const originalFetch = async () => new Response("normal");
  const response = await pinnedRead(origin + "/api/file", {}, { origin, originalFetch, request: async () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, data: btoa("abc") }) });
  assert.equal(await response.text(), "abc");
  assert.equal(await (await pinnedRead("https://other.example", {}, { origin, originalFetch, request: () => { throw Error("unexpected"); } })).text(), "normal");
});
test("cancelled iOS pinned read rejects without request", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pinnedRead(origin + "/api/x", { signal: controller.signal }, { origin, originalFetch: fetch, request: () => { throw Error("unexpected"); } }), { name: "AbortError" });
});
