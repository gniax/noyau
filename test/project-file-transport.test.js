import test from "node:test";
import assert from "node:assert/strict";
import { readProjectFile, shareProjectFile } from "../src/project-file-transport.js";

test("authenticated preview uses actual bytes and profile headers", async () => {
 let options;
 const blob = await readProjectFile("/api/projects/p/files/photo.png?inline=1", { headers: { "x-noyau-profile": "p" }, fetcher: async (_url, value) => { options = value; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }); } });
 assert.equal(options.credentials, "include"); assert.equal(options.headers["x-noyau-profile"], "p"); assert.equal(blob.type, "image/png"); assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
 await assert.rejects(readProjectFile("/x", { fetcher: async () => new Response("", { status: 403 }) }), /403/);
});

test("native file sharing saves bytes and rejects unsafe names", async () => {
 let write, shared; const deps = { writeFile: async value => { write = value; return { uri: "file:///cache/shared-files/photo.png" }; }, share: async value => { shared = value; } };
 await shareProjectFile(new Blob([new Uint8Array([1, 2, 3])]), "photo.png", deps);
 assert.equal(write.data, "AQID"); assert.equal(write.path, "shared-files/photo.png"); assert.deepEqual(shared.files, ["file:///cache/shared-files/photo.png"]);
 await assert.rejects(shareProjectFile(new Blob(), "../secret", deps), /invalide/);
 await assert.rejects(shareProjectFile(new Blob(), "photo.png", { ...deps, writeFile: async () => ({}) }), /impossible/);
});
