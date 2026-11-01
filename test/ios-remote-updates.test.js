import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { nativeServer } from '../src/native-mobile.js';

test('capacitor config declares remote live server URL and navigation allowlist', async () => {
  const config = JSON.parse(await readFile('capacitor.config.json', 'utf8'));
  assert.equal(config.server?.url, 'https://noyau.lan:4242');
  assert.ok(Array.isArray(config.server?.allowNavigation));
  assert.ok(config.server.allowNavigation.includes('noyau.lan'));
  assert.ok(config.server.allowNavigation.includes('localhost'));
});

test('iOS bridge configures dynamic server URL, custom CA trust, and local offline fallback', { skip: !existsSync('ios') }, async () => {
  const swift = await readFile('ios/App/App/NoyauBridgeViewController.swift', 'utf8');
  assert.match(swift, /class NoyauBridgeViewController: CAPBridgeViewController, WKNavigationDelegate/);
  assert.match(swift, /override public func instanceDescriptor\(\) -> InstanceDescriptor/);
  assert.match(swift, /descriptor\.serverURL = origin\.absoluteString/);
  assert.match(swift, /webView\(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge/);
  assert.match(swift, /NoyauPinnedHttpHandler\.validate\(challenge, completionHandler: completionHandler\)/);
  assert.match(swift, /webView\(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!/);
  assert.match(swift, /capacitor:\/\/localhost\/index\.html/);
});

test('nativeServer uses location origin when loaded from live HTTPS origin', () => {
  const prevOrigin = globalThis.location;
  try {
    globalThis.location = new URL('https://noyau.lan:4242/app');
    assert.equal(nativeServer(), 'https://noyau.lan:4242');
  } finally {
    globalThis.location = prevOrigin;
  }
});

test('iOS keeps running in background through location, without any APNs key, and registers the alert plugin', { skip: !existsSync('ios') }, async () => {
  const plist = await readFile('ios/App/App/Info.plist', 'utf8');
  assert.match(plist, /<key>UIBackgroundModes<\/key>\s*<array>\s*<string>location<\/string>/);
  assert.match(plist, /NSLocationAlwaysAndWhenInUseUsageDescription/);
  assert.match(plist, /NSLocationWhenInUseUsageDescription/);
  const swift = await readFile('ios/App/App/NoyauBackgroundAlerts.swift', 'utf8');
  assert.match(swift, /allowsBackgroundLocationUpdates = true/);
  assert.match(swift, /\/api\/mobile\/background-alerts\/poll/);
  assert.match(swift, /"cap_extra"/);
  assert.match(await readFile('ios/App/App/NoyauBridgeViewController.swift', 'utf8'), /registerPluginInstance\(NoyauBackgroundAlertsPlugin\(\)\)/);
  assert.match(await readFile('ios/App/App/AppDelegate.swift', 'utf8'), /NoyauBackgroundAlerts\.shared\.resumeIfEnabled\(\)/);
  const project = await readFile('ios/App/App.xcodeproj/project.pbxproj', 'utf8');
  assert.equal(project.match(/NoyauBackgroundAlerts\.swift/g).length, 6);
});
