import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { EnableBankingService } from "./enable-banking.js";

class MemoryStore {
  constructor() { this.data = {}; }
  get(id) { return this.data[id] || null; }
  all() { return this.data; }
  async set(id, value) { this.data[id] = value; }
  async remove(id) { delete this.data[id]; }
}

function jsonResponse(payload, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get(name) { return headers[name.toLowerCase()] || null; } }, async text() { return JSON.stringify(payload); } };
}

function keys() {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("Enable Banking config signs valid JWT without exposing private key", async () => {
  const pair = keys();
  let authorization = "";
  const service = new EnableBankingService({
    store: new MemoryStore(),
    now: () => new Date("2026-08-25T08:00:00Z"),
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return jsonResponse({ name: "Noyau", environment: "production", active: true, redirect_urls: ["https://noyau.lan:4243/api/finance/banking/callback"] });
    },
  });
  const status = await service.saveConfig({ appId: "app-12345678", privateKey: pair.privateKey, redirectUrl: "https://noyau.lan:4243/api/finance/banking/callback" });
  assert.equal(status.keyStored, true);
  assert.equal(Object.hasOwn(status, "privateKey"), false);
  assert.equal((await service.verify()).active, true);
  const token = authorization.replace("Bearer ", "");
  const [header, payload, signature] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, "app-12345678");
  assert.equal(JSON.parse(Buffer.from(payload, "base64url")).aud, "api.enablebanking.com");
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, "base64url")), true);
});

test("Enable Banking completes consent and imports booked EUR transactions once", async () => {
  const pair = keys();
  const imported = [];
  const finance = { async importTransactions(items) { imported.push(...items); return { imported: items.length, updated: 0 }; } };
  let authBody;
  const transactionUrls = [];
  const service = new EnableBankingService({
    store: new MemoryStore(),
    finance,
    now: () => new Date("2026-08-25T08:00:00Z"),
    fetchImpl: async (url, options) => {
      if (url.includes("/aspsps?")) return jsonResponse({ aspsps: [{ name: "Boursorama Banque", country: "FR", maximum_consent_validity: 90 }] });
      if (url.endsWith("/auth")) {
        authBody = JSON.parse(options.body);
        return jsonResponse({ url: "https://bank.example/authorize" });
      }
      if (url.endsWith("/sessions")) return jsonResponse({ session_id: "session-1", access: { valid_until: "2026-11-23T08:00:00Z" }, accounts: [{ uid: "account-1", identification_hash: "hash-1", name: "Compte courant", currency: "EUR", account_id: { iban: "FR761234567890" } }] });
      if (url.endsWith("/accounts/account-1/balances")) return jsonResponse({ balances: [{ balance_type: "CLAV", balance_amount: { amount: "1234.56", currency: "EUR" }, reference_date: "2026-08-25" }] });
      if (url.includes("/accounts/account-1/transactions?")) {
        transactionUrls.push(url);
        return jsonResponse({ transactions: [{ entry_reference: "entry-1", status: "BOOK", credit_debit_indicator: "DBIT", booking_date: "2026-08-20", transaction_amount: { amount: "950.00", currency: "EUR" }, creditor: { name: "Loyer résidence" } }] });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await service.saveConfig({ appId: "app-12345678", privateKey: pair.privateKey, redirectUrl: "https://noyau.lan:4243/api/finance/banking/callback" });
  const authorization = await service.begin({ bankId: "boursobank", institutionName: "Boursorama Banque" });
  assert.equal(authorization.url, "https://bank.example/authorize");
  assert.equal(authBody.aspsp.name, "Boursorama Banque");
  assert.equal(authBody.access.valid_until, "2026-11-23T08:00:00.000Z");
  await service.complete({ code: "code-1", state: authBody.state });
  const result = await service.sync();
  assert.deepEqual(result, { imported: 1, updated: 0, skipped: 0 });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].category, "housing");
  assert.equal(service.status().connections[0].accounts[0].masked, "•••• 7890");
  assert.equal(service.status().connections[0].accounts[0].balance, 1234.56);
  await service.sync();
  assert.equal(imported.length, 2);
  assert.match(transactionUrls.at(-1), /date_from=2026-08-22/);
});

test("Enable Banking retries rate limits", async () => {
  const pair = keys();
  let calls = 0;
  const service = new EnableBankingService({
    store: new MemoryStore(),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ message: "Too many requests" }, 429, { "retry-after": "0.001" }) : jsonResponse({ ok: true });
    },
  });
  await service.saveConfig({ appId: "app-12345678", privateKey: pair.privateKey, redirectUrl: "https://noyau.lan:4243/api/finance/banking/callback" });
  assert.deepEqual(await service.request("/test"), { ok: true });
  assert.equal(calls, 2);
});

test("Enable Banking exposes cooldown after exhausted rate limit", async () => {
  const pair = keys();
  let calls = 0;
  const service = new EnableBankingService({
    store: new MemoryStore(),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ message: "Too many requests" }, 429, { "retry-after": "0.001" });
    },
  });
  await service.saveConfig({ appId: "app-12345678", privateKey: pair.privateKey, redirectUrl: "https://noyau.lan:4243/api/finance/banking/callback" });
  await assert.rejects(service.request("/test"), (error) => error.statusCode === 429 && error.retryAfter === 15);
  assert.equal(calls, 3);
});
