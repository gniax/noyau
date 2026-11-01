import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
test('Android launcher targets only WireGuard and declares package visibility', { skip: !existsSync('android') }, async () => {
 const java = await readFile('android/app/src/main/java/com/noyau/app/WireGuardLauncherPlugin.java', 'utf8');
 const manifest = await readFile('android/app/src/main/AndroidManifest.xml', 'utf8');
 const main = await readFile('android/app/src/main/java/com/noyau/app/MainActivity.java', 'utf8');
 assert.match(java, /getLaunchIntentForPackage\("com\.wireguard\.android"\)/); assert.match(java, /intent == null/);
 assert.match(manifest, /<package android:name="com\.wireguard\.android"/); assert.match(main, /registerPlugin\(WireGuardLauncherPlugin\.class\)/);
});
test('iOS bridge uses the fixed, user-created shortcut rather than a private API', { skip: !existsSync('ios') }, async () => {
 const swift = await readFile('ios/App/App/NoyauBridgeViewController.swift', 'utf8');
 assert.match(swift, /registerPluginInstance\(WireGuardLauncherPlugin\(\)\)/);
 assert.match(swift, /shortcuts:\/\/run-shortcut\?name=Noyau%20WireGuard/);
 assert.match(swift, /UIApplication\.shared\.open\(url/);
});
