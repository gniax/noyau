import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { resolveMobileRelease, sendMobileRelease } from "../server/mobile-releases.js";
test("release endpoint resolves only declared app files and supports shared fallback", async (t) => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-releases-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
 const filename = "noyau-1.0.0-android-debug.apk", project = "project-1234-abcdef"; await fs.mkdir(path.join(dir, "project-files", project), { recursive: true });
 await fs.writeFile(path.join(dir, "project-files", project, filename), "PKfixture");
 await fs.writeFile(path.join(dir, "mobile-releases.json"), JSON.stringify({ android: { filename, url: `/api/projects/${project}/files/${filename}` } }));
 const result = await resolveMobileRelease(dir, "android"); assert.equal(result.filename, filename); assert.equal(result.size, 9);
 assert.equal(await resolveMobileRelease(dir, "ios"), null); assert.equal(await resolveMobileRelease(dir, "../"), null);
 await fs.writeFile(path.join(dir, "mobile-releases.json"), JSON.stringify({ android: { filename: "../../secret.apk" } })); assert.equal(await resolveMobileRelease(dir, "android"), null);
});

test("authenticated route downloads the real APK from the hidden .data directory", async (t) => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-release-http-")); t.after(() => fs.rm(root, { recursive: true, force: true })); const dir = path.join(root, ".data"), filename = "noyau-1.0.0-android-debug.apk";
 await fs.mkdir(path.join(dir, "mobile-builds"), { recursive: true }); await fs.writeFile(path.join(dir, "mobile-builds", filename), Buffer.from([80,75,3,4])); await fs.writeFile(path.join(dir, "mobile-releases.json"), JSON.stringify({ android: { filename } }));
 const app = express(); app.use((req, res, next) => req.headers.authorization === "Bearer fixture" ? next() : res.sendStatus(401)); app.get("/api/mobile/releases/:platform/file", (req,res,next) => sendMobileRelease(dir, req.params.platform,res,next));
 const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.on("listening", resolve)); t.after(() => new Promise((resolve) => server.close(resolve))); const url = `http://127.0.0.1:${server.address().port}/api/mobile/releases/android/file`;
 assert.equal((await fetch(url)).status, 401); const result = await fetch(url, { headers: { authorization: "Bearer fixture" } }); assert.equal(result.status, 200); assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [80,75,3,4]);
});
