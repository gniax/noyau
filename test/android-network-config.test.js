import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { androidNetworkXml, configureAndroidNetworkResources } from "../scripts/android-network-config.mjs";
test("Android custom CA trust is limited to exact HTTPS host, leaving hostname validation enabled", () => {
 const xml = androidNetworkXml("https://10.0.0.8:4242"); assert.match(xml, /<domain includeSubdomains="false">10\.0\.0\.8<\/domain>/); assert.match(xml, /@raw\/noyau_local_ca/); assert.match(xml, /cleartextTrafficPermitted="false"/); assert.doesNotMatch(xml, /trust-all|hostnameVerifier/i);
 assert.throws(() => androidNetworkXml("http://example.com"), /HTTPS/); assert.throws(() => androidNetworkXml("https://evil.example/path"), /HTTPS/); assert.throws(() => androidNetworkXml("https://user:pass@example.com"), /HTTPS/);
});
test("missing private configuration removes generated anchors and falls back to default trust", async (t) => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"noyau-android-trust-")); t.after(() => fs.rm(root,{recursive:true,force:true}));
 for (const variant of ["debug","release"]) { const dir=path.join(root,"android/app/src",variant,"res/xml"); await fs.mkdir(dir,{recursive:true}); await fs.writeFile(path.join(dir,"network_security_config.xml"),"stale"); }
 assert.equal(await configureAndroidNetworkResources(root, null, null), false);
 for (const variant of ["debug","release"]) await assert.rejects(fs.stat(path.join(root,"android/app/src",variant,"res/xml/network_security_config.xml")), { code: "ENOENT" });
});
