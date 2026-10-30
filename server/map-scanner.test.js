import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codeEvidence, diffInventories, envKeyNames, keyLines, manifestDependencies, providerFor, scanDirs, sheetPrompt } from "./map-scanner.js";

test("envKeyNames keeps names and never values", () => {
  const names = envKeyNames("# comment\nSTRIPE_SECRET_KEY=sk_live_abcdef\nexport SOLANA_RPC_URL = https://x.example/?api-key=zzz\nlowercase=1\n");
  assert.deepEqual(names, ["STRIPE_SECRET_KEY", "SOLANA_RPC_URL"]);
});

test("codeEvidence finds hosts and env key usages", () => {
  const found = codeEvidence(`fetch("https://api.coingecko.com/api/v3/ping"); getenv('BREVO_API_KEY'); process.env.TG_API_ID; os.environ.get("OPENAI_API_KEY")`);
  assert.deepEqual(found.hosts.map((host) => host.host), ["api.coingecko.com"]);
  assert.deepEqual(found.keys.sort(), ["BREVO_API_KEY", "OPENAI_API_KEY", "TG_API_ID"]);
});

test("providerFor maps hosts, keys and SDKs", () => {
  assert.equal(providerFor({ host: { host: "pro-api.coingecko.com", path: "" } }).slug, "coingecko");
  assert.equal(providerFor({ host: { host: "www.googleapis.com", path: "/youtube/v3/videos" } }).slug, "youtube");
  assert.equal(providerFor({ key: "SOLANA_RPC_URL" }).slug, "solana-rpc");
  assert.equal(providerFor({ key: "TG_API_HASH" }).slug, "telegram-user");
  assert.equal(providerFor({ key: "TELEGRAM_BOT_TOKEN" }).slug, "telegram");
  assert.equal(providerFor({ sdk: "stripe/stripe-php" }).slug, "stripe");
  assert.equal(providerFor({ host: { host: "example.com", path: "" } }), null);
});

test("manifestDependencies reads package, composer and requirements", () => {
  assert.deepEqual(manifestDependencies("package.json", JSON.stringify({ dependencies: { stripe: "1" }, devDependencies: { vite: "1" } })), ["stripe"]);
  assert.deepEqual(manifestDependencies("composer.json", JSON.stringify({ require: { php: ">=8", "stripe/stripe-php": "^10" } })), ["stripe/stripe-php"]);
  assert.deepEqual(manifestDependencies("requirements.txt", "requests==2\n# x\ntelethon>=1\n"), ["requests", "telethon"]);
});

test("scanDirs collects evidence without secret values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "map-scan-"));
  try {
    await fs.mkdir(path.join(dir, "bot"));
    await fs.mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
    await fs.writeFile(path.join(dir, "bot", ".env"), "TELEGRAM_BOT_TOKEN=123456:SECRETVALUE\nACME_API_KEY=supersecret\n");
    await fs.writeFile(path.join(dir, "bot", "index.js"), `fetch("https://api.telegram.org/bot"); fetch("https://api.acme.io/v1/x");`);
    await fs.writeFile(path.join(dir, "node_modules", "x", "a.js"), `fetch("https://api.openai.com/v1")`);
    await fs.writeFile(path.join(dir, "config.php"), `<?php define('X', 'https://api.stripe.com');`);
    const { providers } = await scanDirs([dir]);
    assert.deepEqual(Object.keys(providers).sort(), ["acme", "telegram"]);
    assert.deepEqual(providers.telegram.keys.map((key) => key.name), ["TELEGRAM_BOT_TOKEN"]);
    assert.ok(providers.acme.guessed);
    const serialized = JSON.stringify(providers);
    assert.ok(!serialized.includes("SECRETVALUE") && !serialized.includes("supersecret"));
    assert.deepEqual(keyLines(providers.telegram.keys, (file) => path.relative(dir, file)), ["TELEGRAM_BOT_TOKEN — bot/.env"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("diffInventories reports added, changed and gone", () => {
  const diff = diffInventories({ a: { hash: "1" }, b: { hash: "2" }, c: { hash: "3" }, d: { hash: "4", gone: true } }, { a: { hash: "1" }, b: { hash: "9" }, d: { hash: "4" }, e: { hash: "5" } });
  assert.deepEqual(diff, { added: ["d", "e"], changed: ["b"], gone: ["c"] });
});

test("sheetPrompt lists every item id", () => {
  const prompt = sheetPrompt([{ id: "api:x", label: "X", type: "API", evidence: ["hôtes: api.x.com"] }]);
  assert.match(prompt, /id: api:x/);
  assert.match(prompt, /JSON strict/);
});
