import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GroceriesService } from "../server/groceries-service.js";
test("catalogue scan observes robots and presents only EUR candidates without silently changing offers", async (t) => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-catalogue-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); let calls = 0;
 const service = new GroceriesService({ file: path.join(dir, "data.json"), now: () => Date.parse("2026-10-28T10:00:00Z"), fetchImpl: async (url) => { calls++; const u = new URL(url); if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /blocked\n"); return new Response('<script type="application/ld+json">{"@type":"Product","name":"Riz 1 kg","offers":{"price":"2.30","priceCurrency":"EUR"}}</script>'); } }); await service.load();
 const scan = service.catalogueScan("owner"); assert.equal(scan.running, true); for (let i = 0; i < 100 && scan.running; i++) await new Promise((resolve) => setTimeout(resolve, 2));
 assert.equal(scan.running, false); assert.equal(scan.sources.length, 3); assert.equal(scan.products.length, 3); assert.ok(scan.products.every((product) => product.priceCents === 230 && product.currencyConfirmed)); assert.equal(service.read("owner").offers.length, 0);
 const count = calls; assert.equal(service.catalogueScan("owner"), scan); assert.equal(calls, count); assert.notEqual(service.catalogueScan("other"), scan);
});
test("catalogue scan refuses protected source and unknown currency", async (t) => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-catalogue-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
 const service = new GroceriesService({ file: path.join(dir, "data.json"), fetchImpl: async (url) => { const u = new URL(url); if (u.pathname === "/robots.txt") return new Response(u.hostname.includes("carrefour") ? "User-agent: *\nDisallow: /catalogue" : "User-agent: *\nAllow: /"); return new Response('<script type="application/ld+json">{"@type":"Product","name":"Produit","offers":{"price":"1.00"}}</script>'); } }); await service.load();
 const scan = service.catalogueScan("owner"); while (scan.running) await new Promise((resolve) => setTimeout(resolve, 2)); assert.equal(scan.products.length, 0); assert.match(scan.sources.find((source) => source.storeId === "carrefour").status, /interdite/);
});
