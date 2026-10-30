import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { GroceriesService } from "../server/groceries-service.js";
import { publicGroceryRoutes } from "../server/groceries-routes.js";
import { GroceryClient } from "../src/groceries-store.js";

async function setup(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-groceries-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); const service = new GroceriesService({ file: path.join(dir, "groceries.json"), now: () => Date.parse("2026-10-27T12:00:00Z") }); await service.load(); return service; }
const operation = (id, quantity = 1000) => ({ id, type: "extra", payload: { ingredientId: "milk", quantity } });
const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; };

test("sync is atomic, durable, profile-isolated and duplicate retries are idempotent", async (t) => {
  const service = await setup(t); const batch = { baseRevision: 0, operations: [operation("operation-one")] }; const first = await service.sync("owner", batch); assert.equal(first.state.revision, 1); assert.equal((await service.sync("owner", batch)).state.revision, 1); assert.equal(service.read("other").extras.length, 0);
  await assert.rejects(service.sync("owner", { baseRevision: 1, operations: [operation("operation-two", 2000), { id: "bad-operation", type: "invalid" }] })); assert.equal(service.read("owner").extras[0].quantity, 1000);
  const second = new GroceriesService({ file: service.store.file }); await second.load(); assert.equal(second.read("owner").extras[0].quantity, 1000);
});
test("stale revisions never overwrite another device silently", async (t) => { const service = await setup(t); await service.sync("p", { baseRevision: 0, operations: [operation("first-device-op")] }); const conflict = await service.sync("p", { baseRevision: 0, operations: [operation("other-device-op", 2000)] }); assert.equal(conflict.conflict, true); assert.equal(service.read("p").extras[0].quantity, 1000); });
test("public endpoint requires a revocable scoped token and cannot checkout or switch profiles", async (t) => {
  const service = await setup(t); const device = await service.addDevice("owner", "Test"); const app = express(); app.use(express.json()); app.use("/api/mobile/groceries", publicGroceryRoutes(service)); const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.on("listening", resolve)); t.after(() => new Promise((resolve) => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}/api/mobile/groceries`;
  assert.equal((await fetch(base)).status, 401); const headers = { authorization: `Bearer ${device.token}`, "content-type": "application/json", "x-noyau-profile": "victim" };
  const result = await fetch(base + "/sync", { method: "POST", headers, body: JSON.stringify({ baseRevision: 0, operations: [operation("mobile-op-one")] }) }); assert.equal(result.status, 200); assert.equal(service.read("owner").extras.length, 1); assert.equal(service.read("victim").extras.length, 0);
  assert.equal((await fetch(base + "/checkout", { method: "POST", headers, body: "{}" })).status, 404); assert.equal((await fetch(base, { headers: { ...headers, origin: "https://attacker.invalid" } })).status, 403);
  await service.revokeDevice("owner", device.id); assert.equal((await fetch(base, { headers })).status, 401); assert.equal(JSON.stringify(service.devices("owner")).includes(device.token), false);
});
test("offline edits survive reload and are not discarded on network or authentication failure", async (t) => {
  const service = await setup(t); const cache = storage(); let online = false; const request = async (url, options) => { if (!online) throw new Error("offline"); return options?.body ? service.sync("p", JSON.parse(options.body)) : { state: service.read("p") }; };
  const client = new GroceryClient({ profileId: "p", storage: cache, request }); client.dispatch("extra", { ingredientId: "milk", quantity: 1000 }); await assert.rejects(client.sync(), /offline/); assert.equal(client.local.pending.length, 1);
  const restored = new GroceryClient({ profileId: "p", storage: cache, request }); assert.equal(restored.state().extras[0].quantity, 1000); online = true; await restored.sync(); assert.equal(restored.local.pending.length, 0); assert.equal(service.read("p").extras[0].quantity, 1000);
});
test("an edit during an in-flight sync is retained and sent afterward", async (t) => {
  const service = await setup(t); let release; let calls = 0; const client = new GroceryClient({ profileId: "p", storage: storage(), request: async (_url, options) => { if (++calls === 1) await new Promise((resolve) => { release = resolve; }); return service.sync("p", JSON.parse(options.body)); } });
  client.dispatch("extra", { ingredientId: "milk", quantity: 1000 }); const syncing = client.sync(); client.dispatch("extra", { ingredientId: "milk", quantity: 2000 }); release(); await syncing; assert.equal(client.local.pending.length, 0); assert.equal(service.read("p").extras[0].quantity, 2000); assert.equal(calls, 2);
});
test("client conflicts preserve local choices until explicit resolution", async (t) => {
  const service = await setup(t); const client = new GroceryClient({ profileId: "p", storage: storage(), request: async (_url, options) => service.sync("p", JSON.parse(options.body)) }); client.dispatch("extra", { ingredientId: "milk", quantity: 2000 }); await service.sync("p", { baseRevision: 0, operations: [operation("server-first-op")] }); await client.sync(); assert.ok(client.conflict); assert.equal(client.state().extras[0].quantity, 2000); await client.sync({ rebase: true }); assert.equal(client.local.pending.length, 0); assert.equal(service.read("p").extras[0].quantity, 2000);
});
test("product page lookup blocks arbitrary hosts and redirects before making a second request", async (t) => {
  const service = await setup(t); let calls = 0; service.fetchImpl = async () => { calls++; return new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } }); };
  await assert.rejects(service.publicProduct("https://attacker.invalid/x", "carrefour"), /officielle/); assert.equal(calls, 0); await assert.rejects(service.publicProduct("https://www.carrefour.fr/x", "carrefour"), /officielle/); assert.equal(calls, 1);
});
test("structured public prices are reported without inventing packaging, availability or cart creation", async (t) => {
  const service = await setup(t); service.fetchImpl = async () => new Response('<script type="application/ld+json">{"@type":"Product","name":"Riz","offers":{"price":"2.30","priceCurrency":"EUR"}}</script>', { headers: { "content-type": "text/html" } }); const result = await service.publicProduct("https://www.carrefour.fr/x", "carrefour"); assert.equal(result.products[0].priceCents, 230); assert.equal(result.products[0].packQuantity, undefined); assert.throws(() => service.checkout("p"), /Panier incomplet/);
});
