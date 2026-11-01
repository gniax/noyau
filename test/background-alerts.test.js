import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundAlertService } from "../server/background-alerts.js";
import { NotificationGateway } from "../server/native-push-service.js";
import { staticCachePolicy } from "../server/static-cache.js";
import { enableBackgroundAgentAlerts, backgroundAlertKey } from "../src/local-agent-alerts.js";

const service = (options = {}) => new BackgroundAlertService(options);
const device = { deviceId: "device-phone", platform: "ios" };

test("poll returns only own profile alerts after the cursor, and rejects unknown tokens", async () => {
  const alerts = service();
  const { token, cursor } = await alerts.register("owner", device);
  const other = await alerts.register("guest", { deviceId: "device-guest", platform: "ios" });
  assert.equal(cursor, 0);
  assert.equal(await alerts.send({ title: "Fin", body: "Agent", tag: "t", url: "/?session=a" }, "owner"), 1);
  assert.deepEqual(alerts.poll(token, 0).items.map((item) => item.title), ["Fin"]);
  assert.deepEqual(alerts.poll(other.token, 0).items, []);
  assert.deepEqual(alerts.poll(token, alerts.poll(token, 0).cursor).items, []);
  assert.equal(alerts.poll("inconnu", 0), null);
  assert.equal(alerts.poll("", 0), null);
});

test("a profile with no registered phone stores nothing", async () => {
  const alerts = service();
  assert.equal(await alerts.send({ title: "x" }, "owner"), 0);
  assert.equal(alerts.state.items.length, 0);
});

test("registering again revokes the previous token; tokens and old items are not kept in clear", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "noyau-alerts-")), "alerts.json");
  let clock = 1000;
  const alerts = service({ file, now: () => clock, retentionMs: 100 });
  const first = await alerts.register("owner", device);
  const second = await alerts.register("owner", device);
  assert.equal(alerts.poll(first.token, 0), null);
  assert.ok(alerts.poll(second.token, 0));
  await alerts.send({ title: "ancien" }, "owner");
  clock += 200;
  await alerts.send({ title: "récent" }, "owner");
  assert.deepEqual(alerts.poll(second.token, 0).items.map((item) => item.title), ["récent"]);
  assert.ok(!(await fs.readFile(file, "utf8")).includes(second.token));
  const reloaded = service({ file, now: () => clock });
  await reloaded.load();
  assert.ok(reloaded.poll(second.token, 0));
});

function gateway({ webDevices = [], background = null } = {}) {
  const calls = [];
  const web = { devices: (_profile, deviceId) => webDevices.filter((item) => !deviceId || item === deviceId), send: async (_payload, profile, target) => { calls.push(target); return web.devices(profile, target).length; } };
  const native = { devices: () => [], send: async () => 0 };
  return { gate: new NotificationGateway(web, native, background), calls };
}

test("an active screen that cannot receive alerts (PC tab, kiosk) does not swallow them", async () => {
  const { gate, calls } = gateway({ webDevices: ["phone"] });
  assert.equal(await gate.send({ title: "x" }, "owner", "kiosk"), 1);
  assert.deepEqual(calls, [null]);
});

test("an active screen that can receive alerts stays the only one to ring", async () => {
  const { gate, calls } = gateway({ webDevices: ["phone", "tablet"] });
  assert.equal(await gate.send({ title: "x" }, "owner", "tablet"), 1);
  assert.deepEqual(calls, ["tablet"]);
});

test("gateway publishes for the phone that polls in background", async () => {
  const background = service();
  const { token } = await background.register("owner", device);
  const { gate } = gateway({ background });
  assert.equal(await gate.send({ title: "Fin" }, "owner", "kiosk"), 1);
  assert.equal(background.poll(token, 0).items.length, 1);
});

test("static files: hashed assets immutable, service worker and HTML never cached", () => {
  assert.match(staticCachePolicy("/srv/dist/assets/index-abc123.js"), /immutable/);
  assert.match(staticCachePolicy("/srv/dist/icons/codex.png"), /stale-while-revalidate/);
  assert.equal(staticCachePolicy("/srv/dist/sw.js"), null);
  assert.equal(staticCachePolicy("/srv/dist/index.html"), null);
});

function memoryStorage() { const map = new Map(); return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; }

test("client enables background polling, and falls back when the installed app lacks the native module", async () => {
  const storage = memoryStorage();
  const requests = [];
  const enabled = [];
  const api = async (url, options) => { requests.push([url, JSON.parse(options.body)]); return { token: "secret-device-token", cursor: 7 }; };
  const base = { profileId: "owner", server: "https://noyau", deviceId: "device-phone", api, storage };
  assert.equal(await enableBackgroundAgentAlerts({ ...base, plugin: { status: async () => { throw new Error("UNIMPLEMENTED"); } } }), false);
  assert.equal(requests.length, 0);
  assert.equal(await enableBackgroundAgentAlerts({ ...base, plugin: { status: async () => ({}), enable: async (value) => enabled.push(value) } }), true);
  assert.deepEqual(enabled, [{ server: "https://noyau", token: "secret-device-token", cursor: 7 }]);
  assert.equal(storage.getItem(backgroundAlertKey("https://noyau", "owner")), "1");
});
