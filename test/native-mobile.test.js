import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { NativeWebSocketTickets } from "../server/native-websocket.js";
import { NativePushService, NotificationGateway } from "../server/native-push-service.js";

test("native socket tickets expire, are single-use and bind a profile to one exact path", () => {
  let now = 1000; const tickets = new NativeWebSocketTickets({ now: () => now }); const first = tickets.issue("owner", "/ws/terminal/agent-a");
  assert.equal(tickets.take(first.ticket, "/ws/terminal/agent-a").profileId, "owner"); assert.equal(tickets.take(first.ticket, "/ws/terminal/agent-a"), null);
  const second = tickets.issue("owner", "/ws/voice"); assert.equal(tickets.take(second.ticket, "/ws/terminal/agent-b"), null);
  const third = tickets.issue("owner", "/ws/voice"); now += 30001; assert.equal(tickets.take(third.ticket, "/ws/voice"), null);
});
test("native push remains explicitly unconfigured without credentials and never claims registration", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-native-push-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const push = new NativePushService({ file: path.join(dir, "devices.json"), fcmFile: "", apnsFile: "" }); await push.load(); assert.deepEqual(push.status(), { android: false, ios: false });
  await assert.rejects(push.subscribe("owner", { platform: "android", token: "fake-token-for-local-test", deviceId: "test-device" }), /non configuré/); assert.equal(await push.send({ title: "test" }, "owner"), 0);
});
test("notification gateway preserves web delivery when native is absent or unavailable", async () => {
  const web = { send: async () => 1 }; const native = { send: async () => { throw new Error("native unavailable"); } }; assert.equal(await new NotificationGateway(web, native).send({}, "owner"), 1);
  web.send = async () => 0; await assert.rejects(new NotificationGateway(web, native).send({}, "owner"), /native unavailable/);
});
test("native push moves a device between profiles, authenticates FCM and removes expired tokens", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-fcm-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let oauthCalls = 0; let sends = 0; let expired = false;
  const push = new NativePushService({ file: path.join(dir, "devices.json"), fcmFile: "", apnsFile: "", fetchImpl: async (url, options) => {
    if (url === "https://oauth2.googleapis.com/token") {
      oauthCalls++; const assertion = options.body.get("assertion"); const parts = assertion.split(".");
      assert.equal(crypto.verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), publicKey, Buffer.from(parts[2], "base64url")), true);
      assert.equal(JSON.parse(Buffer.from(parts[1], "base64url")).scope, "https://www.googleapis.com/auth/firebase.messaging");
      return Response.json({ access_token: "test-access-token", expires_in: 3600 });
    }
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/unit-test/messages:send"); assert.equal(options.headers.authorization, "Bearer test-access-token"); sends++;
    return expired ? Response.json({ error: { details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 }) : Response.json({ name: "test-message" });
  } });
  await push.load(); push.fcm = { project_id: "unit-test", client_email: "test@example.invalid", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const device = { platform: "android", token: "test-token-1234567890123456789", deviceId: "device-123456" };
  await push.subscribe("first", device); await push.subscribe("second", device);
  assert.equal(push.devices("first").length, 0); assert.equal(await push.send({ title: "Hello" }, "first"), 0);
  assert.equal(await push.send({ title: "Hello" }, "second"), 1); assert.equal(await push.send({}, "second"), 1); assert.equal(oauthCalls, 1); assert.equal(sends, 2);
  expired = true; assert.equal(await push.send({}, "second"), 0); assert.equal(push.devices("second").length, 0);
  await push.subscribe("second", device); await push.unsubscribe("first", device.deviceId); assert.equal(push.devices("second").length, 1);
  await push.unsubscribe("second", device.deviceId); assert.equal(push.devices("second").length, 0);
});
