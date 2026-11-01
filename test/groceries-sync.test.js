import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { GroceriesService } from "../server/groceries-service.js";
import { initialGroceries } from "../shared/groceries.js";
import { publicGroceryRoutes } from "../server/groceries-routes.js";
import { GroceryClient } from "../src/groceries-store.js";

async function setup(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-groceries-")); t.after(() => fs.rm(dir, { recursive: true, force: true })); const service = new GroceriesService({ file: path.join(dir, "groceries.json"), now: () => Date.parse("2026-10-27T12:00:00Z") }); await service.load(); return service; }
const operation = (id, quantity = 1000) => ({ id, type: "extra", payload: { ingredientId: "milk", quantity } });
const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) }; };

test("sync is atomic, durable, profile-isolated and duplicate retries are idempotent", async (t) => {
  const service = await setup(t); const batch = { baseRevision: 0, operations: [operation("operation-one")] }; const first = await service.sync("owner", batch); assert.equal(first.state.revision, 1); assert.equal((await service.sync("owner", batch)).state.revision, 1); assert.equal(service.read("other").extras.length, 0);
  assert.equal((await service.sync("owner", { baseRevision: 1, operations: [operation("operation-two", 2000), { id: "bad-operation", type: "invalid" }] })).invalid, true); assert.equal(service.read("owner").extras[0].quantity, 1000);
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
test("client replays compatible local choices on a newer household revision", async (t) => {
  const service = await setup(t); const client = new GroceryClient({ profileId: "p", storage: storage(), request: async (_url, options) => service.sync("p", JSON.parse(options.body)) }); client.dispatch("extra", { ingredientId: "milk", quantity: 2000 }); await service.sync("p", { baseRevision: 0, operations: [operation("server-first-op")] }); await client.sync(); assert.equal(client.conflict, null); assert.equal(client.state().extras[0].quantity, 2000); assert.equal(client.local.pending.length, 0); assert.equal(service.read("p").extras[0].quantity, 2000);
});
test("product page lookup blocks arbitrary hosts and redirects before making a second request", async (t) => {
  const service = await setup(t); let calls = 0; service.fetchImpl = async () => { calls++; return new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } }); };
  await assert.rejects(service.publicProduct("https://attacker.invalid/x", "carrefour"), /officielle/); assert.equal(calls, 0); await assert.rejects(service.publicProduct("https://www.carrefour.fr/x", "carrefour"), /officielle/); assert.equal(calls, 1);
});
test("structured public prices are reported without inventing packaging, availability or cart creation", async (t) => {
  const service = await setup(t); service.fetchImpl = async () => new Response('<script type="application/ld+json">{"@type":"Product","name":"Riz","offers":{"price":"2.30","priceCurrency":"EUR"}}</script>', { headers: { "content-type": "text/html" } }); const result = await service.publicProduct("https://www.carrefour.fr/x", "carrefour"); assert.equal(result.products[0].priceCents, 230); assert.equal(result.products[0].packQuantity, undefined); assert.throws(() => service.checkout("p"), /Panier incomplet/);
});

test('explicit sharing synchronizes two profiles and keeps outsiders separate', async (t) => {
 const service=await setup(t);
 await service.sync('owner',{baseRevision:0,operations:[operation('owner-123',1000)]});
 await service.sync('member',{baseRevision:0,operations:[{id:'member-123',type:'extra',payload:{ingredientId:'rice',quantity:300}}]});
 await service.shareProfiles('owner','member');
 assert.deepEqual(service.read('member'),service.read('owner'));
 assert.deepEqual(service.read('member').extras.map(x=>x.ingredientId).sort(),['milk','rice']);
 const revision=service.read('member').revision;
 await service.sync('member',{baseRevision:revision,operations:[{id:'member-456',type:'extra',payload:{ingredientId:'tomato',quantity:200}}]});
 assert.deepEqual(service.read('owner'),service.read('member'));
 assert.equal(service.read('outsider').extras.length,0);
 assert.equal(service.store.get('member').state.extras[0].ingredientId,'rice');
 await assert.rejects(service.shareProfiles('owner','member'),/configuré/);
});

test('linked device keeps its own identity but accesses shared state', async (t) => {
 const service=await setup(t); const device=await service.addDevice('member','phone');
 await service.shareProfiles('owner','member');
 const identity=service.authenticateDevice(device.token); assert.equal(identity.profileId,'member');
 const revision=service.read('member').revision;
 await service.sync(identity.profileId,{baseRevision:revision,operations:[{id:'phone-123',type:'extra',payload:{ingredientId:'rice',quantity:200}}]});
 assert.equal(service.read('owner').extras[0].ingredientId,'rice'); assert.equal(service.devices('owner').length,0); assert.equal(service.devices('member').length,1);
});

test('sharing preserves both menus when dates collide', async (t) => {
 const service=await setup(t); const a=service.read('owner'), b=service.read('member');
 a.plan=[{id:'2026-10-27-dinner',date:'2026-10-27',meal:'dinner',recipeId:'recipe-01',portions:2,status:'accepted'}];
 b.plan=[{id:'2026-10-27-dinner',date:'2026-10-27',meal:'dinner',recipeId:'recipe-02',portions:2,status:'accepted'}];
 await service.store.set('owner',{state:a,seen:[],devices:[]}); await service.store.set('member',{state:b,seen:[],devices:[]});
 await service.shareProfiles('owner','member'); const plan=service.read('member').plan;
 assert.equal(plan.length,2); assert.equal(new Set(plan.map(x=>x.id)).size,2); assert.equal(service.store.get('member').state.plan[0].recipeId,'recipe-02');
});

test('existing personal recipes become favorites once, without reversing explicit choices', async (t) => {
 const service = await setup(t); const state=service.read('owner');
 state.customRecipes=[{id:'custom-unrated1'},{id:'custom-neutral1'},{id:'custom-disliked1'}];
 state.preferences={'custom-neutral1':'neutral','custom-disliked1':'disliked'};
 await service.store.set('owner',{state,seen:[],devices:[]});
 const again = new GroceriesService({file:service.store.file}); await again.load();
 const result=again.read('owner'); assert.equal(result.preferences['custom-unrated1'],'favorite'); assert.equal(result.preferences['custom-neutral1'],'neutral'); assert.equal(result.preferences['custom-disliked1'],'disliked'); assert.equal(result.revision,state.revision+1);
 await again.load(); assert.equal(again.read('owner').revision,result.revision);
});

test('a rejected pending action is identified without losing other queued changes', async (t) => {
 const service=await setup(t); const state=service.read('p'); state.settings.householdConfirmed=true; state.settings.excludedIngredients=['broccoli'];
 state.plan=[{id:'slot-1',date:'2026-10-31',meal:'dinner',recipeId:'recipe-01',portions:2,status:'proposed'}];
 await service.store.set('p',{state,seen:[],devices:[]});
 const good={id:'good-action-123',type:'extra',payload:{ingredientId:'rice',quantity:100}};
 const bad={id:'bad-action-1234',type:'slot',payload:{id:'slot-1',recipeId:'recipe-03',status:'accepted'}};
 const result=await service.sync('p',{baseRevision:0,operations:[good,bad]});
 assert.equal(result.invalid,true);assert.equal(result.operationId,bad.id);assert.match(result.error,/incompatible/i);assert.equal(service.read('p').extras.length,0);
 const cache=storage();const client=new GroceryClient({profileId:'p',storage:cache,request:async(_url,opts)=>service.sync('p',JSON.parse(opts.body))});
 client.local={server:{...state,settings:{...state.settings,excludedIngredients:[]}},pending:[good,bad],lastSyncAt:null};
 await client.sync(); assert.equal(client.invalid.operationId,bad.id);assert.equal(client.local.pending.length,2);
 assert.equal(client.discardInvalid(),true);assert.equal(client.local.pending.length,1);await client.sync();
 assert.equal(client.local.pending.length,0);assert.equal(service.read('p').extras[0].ingredientId,'rice');
});

test('stale invalid local actions cannot crash the screen and can be removed one at a time', async () => {
 const local=storage();const state=initialGroceries();state.settings.householdConfirmed=true;state.settings.excludedIngredients=['broccoli'];
 state.plan=[{id:'slot-1',date:'2026-10-31',meal:'dinner',recipeId:'recipe-01',portions:2,status:'proposed'}];
 const bad={id:'bad-stale-op',type:'slot',payload:{id:'slot-1',recipeId:'recipe-03',status:'accepted'}};
 local.setItem('noyau:groceries:p',JSON.stringify({server:state,pending:[bad],lastSyncAt:null}));
 let published;const client=new GroceryClient({profileId:'p',storage:local,request:async()=>({state}),onChange:(value,status)=>published={value,status}});
 client.publish();assert.equal(published.status.invalid.operationId,bad.id);assert.equal(published.value.plan[0].status,'proposed');
 assert.equal(client.discardInvalid(),true);assert.equal(client.local.pending.length,0);assert.equal(client.invalid,null);
});

test('rebasing preserves pending actions and displays the server when one action is invalid', async () => {
 const old=initialGroceries();old.settings.householdConfirmed=true;old.plan=[{id:'slot-1',date:'2026-10-31',meal:'dinner',recipeId:'recipe-01',portions:2,status:'proposed'}];
 const newer=structuredClone(old);newer.revision=2;newer.settings.excludedIngredients=['broccoli'];
 const client=new GroceryClient({profileId:'p',storage:storage(),request:async()=>({conflict:true,state:newer})});
 client.local={server:old,pending:[{id:'stale-broccoli',type:'slot',payload:{id:'slot-1',recipeId:'recipe-03',status:'accepted'}},{id:'kept-extra-op',type:'extra',payload:{ingredientId:'rice',quantity:200}}],lastSyncAt:null};
 await client.sync();assert.ok(client.conflict);await client.sync({rebase:true});
 assert.equal(client.invalid.operationId,'stale-broccoli');assert.equal(client.local.pending.length,2);assert.equal(client.state().extras[0].quantity,200);assert.equal(client.state().revision,2);
 assert.equal(client.discardInvalid(),true);assert.equal(client.local.pending.length,1);assert.equal(client.local.pending[0].id,'kept-extra-op');
});
