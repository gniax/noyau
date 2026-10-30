import test from "node:test";
import assert from "node:assert/strict";
import { saveAndShareRelease } from "../src/native-release-download.js";
test("native download uses authenticated app transport and shares actual bytes", async () => {
 let got, file, shared;
 await saveAndShareRelease({ url: "https://home.example/api/projects/id/files/noyau-1.0.0-android-debug.apk", filename: "noyau-1.0.0-android-debug.apk", fetcher: async (url, options) => { got = { url, options }; return new Response(new Uint8Array([80,75,3,4])); }, writeFile: async (options) => { file = options; return { uri: "file:///cache/release.apk" }; }, statFile: async () => ({ size: 4 }), share: async (options) => { shared = options; } });
 assert.equal(got.options.credentials, "include"); assert.equal(file.data, "UEsDBA=="); assert.equal(file.recursive, true); assert.deepEqual(shared.files, ["file:///cache/release.apk"]);
});
test("native download rejects bad names and HTTP failures", async () => {
 const options = { fetcher: async () => new Response("no", { status: 404 }), writeFile: async () => { throw Error("unexpected"); }, share: async () => {} };
 await assert.rejects(saveAndShareRelease({ ...options, filename: "../secrets.apk", url: "https://example.com" }), /invalide/);
 await assert.rejects(saveAndShareRelease({ ...options, filename: "noyau-x.apk", url: "https://example.com" }), /404/);
});

test("missing or incomplete local files are never handed to share", async () => {
 const base = { url: "https://example.com/file", filename: "noyau-x.apk", fetcher: async () => new Response(new Uint8Array([80,75,3,4])), writeFile: async () => ({ uri: "file:///cache/x" }), share: async () => { throw Error("must not share"); } };
 await assert.rejects(saveAndShareRelease({ ...base, statFile: async () => { throw Error("absent"); } }), /Vérification du fichier local impossible : absent/);
 await assert.rejects(saveAndShareRelease({ ...base, statFile: async () => ({ size: 2 }) }), /incomplet/);
});

test("Android update opens installer only after verifying the cached APK", async () => {
 let installed; let shared = false;
 await saveAndShareRelease({ url: "https://example.com/file", filename: "noyau-1.0.0-android-debug.apk", fetcher: async () => new Response(new Uint8Array([80,75,3,4])), writeFile: async () => ({ uri: "file:///cache/releases/file.apk" }), statFile: async () => ({ size: 4 }), share: async () => { shared = true; }, install: async (value) => { installed = value; } });
 assert.deepEqual(installed, { path: "releases/noyau-1.0.0-android-debug.apk" }); assert.equal(shared, false);
});
