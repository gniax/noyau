import test from "node:test";
import assert from "node:assert/strict";
import { readNativeClipboard } from "../src/native-clipboard.js";
test("native clipboard reads text exactly once per request", async () => {
  let reads = 0; const clipboard = { read: async () => { reads++; return { type: "text/plain", value: "collage" }; } };
  assert.deepEqual(await readNativeClipboard(clipboard), { kind: "text", value: "collage" }); assert.equal(reads, 1);
  await assert.rejects(readNativeClipboard(clipboard, { imageOnly: true }), /Aucune image/);
});
test("native clipboard accepts image data without fetching arbitrary URLs", async () => {
  const result = await readNativeClipboard({ read: async () => ({ type: "image/png", value: "data:image/png;base64,YWJj" }) });
  assert.equal(result.kind, "image"); assert.equal(await result.blob.text(), "abc");
  await assert.rejects(readNativeClipboard({ read: async () => ({ type: "image/png", value: "https://external.example/p.png" }) }), /non pris en charge/);
});
