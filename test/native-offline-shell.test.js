import test from 'node:test'; import assert from 'node:assert/strict'; import { registerNativeOfflineShell } from '../src/native-offline-shell.js';
test('native shell registers only on the configured trusted HTTPS origin', async () => {
 let calls=0; const serviceWorker={register:async()=>{calls++;return {update:async()=>{}}}};
 for (const origin of ['https://other.test','capacitor://localhost','https://home.test']) await registerNativeOfflineShell({native:true,origin,server:'https://home.test',serviceWorker});
 assert.equal(calls,1);
});
