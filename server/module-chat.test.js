import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chatConfig, normalizeChatFeed, readModuleChat } from "./module-chat.js";

test("chat config accepts only module-contained JSON files", () => {
  assert.equal(chatConfig(null, "/project"), null);
  assert.deepEqual(chatConfig({ file: "data/feed.json" }, "/project"), { file: "/project/data/feed.json" });
  for (const file of ["../feed.json", "/other/feed.json", "feed.txt", null]) {
    assert.throws(() => chatConfig({ file }, "/project"), /Fichier chat module invalide/);
  }
});

test("chat feed is bounded, chronological, deduplicated and never invents delivery status", () => {
  const result = normalizeChatFeed({ updatedAt: "2026-10-11T14:00:00Z", messages: [
    { id: 2, text: "<script>unsafe</script>\nhttps://example.com", timestamp: "2026-10-11T14:00:00Z", direction: "outgoing", status: "sent", secret: "not exposed" },
    { id: "1", text: "Earlier", timestamp: "2026-10-10T14:00:00Z", direction: "incoming", status: "received" },
    { id: 2, text: "Duplicate" }, null, { text: "No ID" }, { id: 3, text: null },
    { id: 4, text: "Unknown", timestamp: "invalid", direction: "bad", status: "read" },
  ] });
  assert.deepEqual(result.messages.map((item) => item.id), ["4", "1", "2"]);
  assert.equal(result.messages[0].status, "unknown");
  assert.equal(result.messages[0].direction, "system");
  assert.equal(result.messages[0].timestamp, null);
  assert.equal(result.messages[2].text, "<script>unsafe</script>\nhttps://example.com");
  assert.equal(result.messages[2].secret, undefined);
  assert.equal(result.updatedAt, "2026-10-11T14:00:00.000Z");
  const bounded = normalizeChatFeed({ messages: Array.from({ length: 120 }, (_, id) => ({ id, text: "a".repeat(9000) })) });
  assert.equal(bounded.messages.length, 100);
  assert.equal(bounded.messages[0].text.length, 8192);
  assert.throws(() => normalizeChatFeed({ messages: "bad" }), /Historique chat invalide/);
});

test("chat reads refreshed snapshots and fails safely on missing, invalid, large or escaped files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-chat-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workingDirectory = path.join(root, "module");
  await fs.mkdir(workingDirectory);
  const file = path.join(workingDirectory, "feed.json");
  const module = { workingDirectory, chat: { file } };
  assert.equal(await readModuleChat({ workingDirectory }), null);
  assert.equal((await readModuleChat(module)).availability, "waiting");
  await fs.writeFile(file, JSON.stringify({ messages: [{ id: 1, text: "First" }] }));
  assert.equal((await readModuleChat(module)).messages[0].text, "First");
  await fs.writeFile(file, JSON.stringify({ messages: [{ id: 2, text: "Next" }] }));
  assert.equal((await readModuleChat(module)).messages[0].text, "Next");
  await fs.writeFile(file, "broken JSON");
  assert.equal((await readModuleChat(module)).availability, "unavailable");
  await fs.writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal((await readModuleChat(module)).availability, "unavailable");
  await fs.unlink(file);
  const outside = path.join(root, "private.json");
  await fs.writeFile(outside, JSON.stringify({ messages: [{ id: 9, text: "Secret" }] }));
  await fs.symlink(outside, file);
  assert.equal((await readModuleChat(module)).availability, "unavailable");
  assert.deepEqual((await readModuleChat(module)).messages, []);
});
