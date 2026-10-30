import test from "node:test";
import assert from "node:assert/strict";
import { createPinnedSocket } from "../src/native-socket.js";
const states = { CONNECTING: 0, OPEN: 1, CLOSED: 3 };
test("pinned terminal socket delivers only its own events and sends text", async () => {
  let emit, removed = 0; const sent = [];
  const plugin = { addListener: async (_, cb) => { emit = cb; return { remove() { removed++; } }; }, connect: async () => {}, send: async (v) => sent.push(v), close: async () => {} };
  const socket = createPinnedSocket("wss://home.example/ws/terminal/agent", { plugin, id: "a", states });
  await new Promise(setImmediate); assert.equal(socket.readyState, 0);
  let messages = []; socket.addEventListener("message", event => messages.push(event.data));
  emit({ id: "other", type: "open" }); assert.equal(socket.readyState, 0);
  emit({ id: "a", type: "open" }); assert.equal(socket.readyState, 1);
  socket.send("hello"); emit({ id: "a", type: "message", data: "world" });
  assert.deepEqual(sent, [{ id: "a", data: "hello" }]); assert.deepEqual(messages, ["world"]);
  emit({ id: "a", type: "close" }); assert.equal(socket.readyState, 3); assert.equal(removed, 1);
});
test("failed connection closes and releases listener", async () => {
  let removed = false; const plugin = { addListener: async () => ({ remove() { removed = true; } }), connect: async () => { throw Error("no"); }, close: async () => {}, send: async () => {} };
  const socket = createPinnedSocket("wss://home.example/ws/terminal/agent", { plugin, id: "a", states });
  await new Promise(setImmediate); assert.equal(socket.readyState, 3); assert.equal(removed, true);
});
