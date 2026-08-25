import crypto from "node:crypto";

const API_BASE = "https://api.enablebanking.com";
const BANK_PATTERNS = {
  boursobank: /boursorama|bourso\s*bank/i,
  banxo: /caisse\s+d.?[ée]pargne/i,
  revolut: /^revolut\b/i,
};

function text(value, limit = 200) {
  return String(value || "").trim().slice(0, limit);
}

function base64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function privateKey(value) {
  const pem = String(value || "").replace(/\\n/g, "\n").trim();
  if (!pem || pem.length > 16_384) throw new Error("Clé privée Enable Banking invalide.");
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch {
    throw new Error("Clé privée Enable Banking invalide.");
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error("Clé privée RSA requise.");
  return pem;
}

function redirectUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("URL de retour invalide.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/api/finance/banking/callback" || parsed.search || parsed.hash) throw new Error("URL HTTPS de retour invalide.");
  return parsed.toString();
}

function connectionPayload(id, value) {
  return {
    id,
    bankId: value.bankId,
    bankName: value.bankName,
    sessionId: value.sessionId,
    validUntil: value.validUntil,
    accountCount: value.accounts?.length || 0,
    accounts: (value.accounts || []).map(({ name, currency, masked, balance, balanceType, balanceAt }) => ({ name, currency, masked, balance, balanceType, balanceAt })),
    connectedAt: value.connectedAt,
    lastSyncAt: value.lastSyncAt || null,
    lastSyncCount: value.lastSyncCount || 0,
  };
}

function transactionDescription(transaction, kind) {
  const party = kind === "expense" ? transaction.creditor?.name : transaction.debtor?.name;
  const remittance = Array.isArray(transaction.remittance_information) ? transaction.remittance_information.join(" · ") : transaction.remittance_information;
  return text(party || remittance || transaction.note || transaction.bank_transaction_code?.description || "Opération bancaire", 120);
}

function transactionCategory(transaction, description) {
  const mcc = String(transaction.merchant_category_code || "");
  const normalized = description.toLowerCase();
  if (/loyer|rent|immobilier|mortgage|edf|engie|electric|gaz|eau\b/.test(normalized) || ["4900", "6513"].includes(mcc)) return "housing";
  if (/carrefour|auchan|monoprix|intermarch|lidl|aldi|restaurant|boulanger|uber eats|deliveroo/.test(normalized) || /^(5411|5422|5441|5451|5462|5499|5812|5814)$/.test(mcc)) return "food";
  if (/sncf|ratp|uber|bolt|essence|totalenergies|parking|péage|peage/.test(normalized) || /^(4111|4121|4131|4784|5541|5542|7523)$/.test(mcc)) return "transport";
  if (/netflix|spotify|apple\.com\/bill|google|abonnement|subscription|adobe|canva/.test(normalized)) return "subscriptions";
  if (/pharm|médecin|medecin|doctolib|dent|hôpital|hopital|mutuelle/.test(normalized) || /^59(12|13|14)$/.test(mcc)) return "health";
  if (/cinema|cinéma|concert|jeu|steam|playstation|bar\b/.test(normalized) || /^(7832|7922|799[1-9])$/.test(mcc)) return "leisure";
  if (/^(5[2-7]\d{2})$/.test(mcc)) return "shopping";
  return "other";
}

export class EnableBankingService {
  constructor({ store, finance, fetchImpl = fetch, now = () => new Date(), environmentConfig = null } = {}) {
    this.store = store;
    this.finance = finance;
    this.fetch = fetchImpl;
    this.now = now;
    this.environmentConfig = environmentConfig;
  }

  config() {
    return this.store.get("config") || this.environmentConfig || null;
  }

  configured() {
    const config = this.config();
    return Boolean(config?.appId && config?.privateKey && config?.redirectUrl);
  }

  connections() {
    return Object.entries(this.store.all())
      .filter(([id, value]) => id.startsWith("connection-") && value?.sessionId)
      .map(([id, value]) => connectionPayload(id, value));
  }

  status() {
    const config = this.config();
    return {
      configured: this.configured(),
      appId: config?.appId || "",
      redirectUrl: config?.redirectUrl || "",
      keyStored: Boolean(config?.privateKey),
      connections: this.connections(),
    };
  }

  async saveConfig(input = {}) {
    const current = this.config() || {};
    const appId = text(input.appId, 120);
    if (!/^[a-zA-Z0-9-]{8,120}$/.test(appId)) throw new Error("App ID Enable Banking invalide.");
    const next = {
      appId,
      privateKey: input.privateKey ? privateKey(input.privateKey) : privateKey(current.privateKey),
      redirectUrl: redirectUrl(input.redirectUrl),
      updatedAt: this.now().toISOString(),
    };
    await this.store.set("config", next);
    return this.status();
  }

  jwt() {
    const config = this.config();
    if (!this.configured()) throw new Error("Configure Enable Banking avant connexion.");
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const header = base64url({ typ: "JWT", alg: "RS256", kid: config.appId });
    const payload = base64url({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: issuedAt, exp: issuedAt + 3600 });
    const unsigned = `${header}.${payload}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), config.privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  async request(pathname, { method = "GET", body } = {}) {
    const response = await this.fetch(`${API_BASE}${pathname}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.jwt()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { message: raw }; }
    if (!response.ok) throw new Error(`Enable Banking (${response.status}): ${text(payload?.message || payload?.error || "requête refusée")}`);
    return payload;
  }

  async verify() {
    const application = await this.request("/application");
    return {
      name: text(application.name, 120),
      environment: text(application.environment, 30),
      active: Boolean(application.active),
      redirectUrls: Array.isArray(application.redirect_urls) ? application.redirect_urls.map((value) => text(value, 500)) : [],
    };
  }

  async institutions() {
    const payload = await this.request("/aspsps?country=FR&psu_type=personal&service=AIS");
    const groups = Object.fromEntries(Object.keys(BANK_PATTERNS).map((id) => [id, []]));
    for (const institution of payload.aspsps || []) {
      for (const [id, pattern] of Object.entries(BANK_PATTERNS)) {
        if (!pattern.test(institution.name || "")) continue;
        groups[id].push({
          name: text(institution.name, 120),
          country: institution.country === "FR" ? "FR" : text(institution.country, 2),
          logo: text(institution.logo, 500),
          maximumConsentValidity: Math.max(0, Number(institution.maximum_consent_validity) || 0),
        });
      }
    }
    return groups;
  }

  async begin({ bankId, institutionName } = {}) {
    if (!BANK_PATTERNS[bankId]) throw new Error("Banque non prise en charge.");
    const groups = await this.institutions();
    const options = groups[bankId];
    const institution = institutionName
      ? options.find(({ name }) => name === institutionName)
      : options.length === 1 ? options[0] : null;
    if (!institution) throw new Error(options.length ? "Choisis établissement bancaire exact." : "Banque indisponible chez Enable Banking.");
    const config = this.config();
    const state = crypto.randomUUID();
    const validityDays = Math.min(institution.maximumConsentValidity || 90, 180);
    const validUntil = new Date(this.now().getTime() + validityDays * 24 * 60 * 60 * 1000).toISOString();
    await this.store.set(`pending-${state}`, { bankId, bankName: institution.name, state, validUntil, createdAt: this.now().toISOString() });
    try {
      const authorization = await this.request("/auth", {
        method: "POST",
        body: {
          access: { valid_until: validUntil },
          aspsp: { name: institution.name, country: "FR" },
          state,
          redirect_url: config.redirectUrl,
          psu_type: "personal",
          language: "fr",
        },
      });
      if (!/^https:\/\//.test(authorization.url || "")) throw new Error("URL d’autorisation Enable Banking invalide.");
      return { url: authorization.url };
    } catch (error) {
      await this.store.remove(`pending-${state}`);
      throw error;
    }
  }

  async complete({ code, state, error, errorDescription } = {}) {
    const pendingId = `pending-${text(state, 80)}`;
    const pending = this.store.get(pendingId);
    if (!pending || pending.state !== state) throw new Error("Retour bancaire expiré ou invalide.");
    if (this.now().getTime() - new Date(pending.createdAt).getTime() > 30 * 60 * 1000) {
      await this.store.remove(pendingId);
      throw new Error("Retour bancaire expiré.");
    }
    if (error) {
      await this.store.remove(pendingId);
      throw new Error(`Connexion bancaire refusée: ${text(errorDescription || error)}`);
    }
    if (!code) throw new Error("Code bancaire manquant.");
    await this.store.set(pendingId, { ...pending, processing: true });
    try {
      const session = await this.request("/sessions", { method: "POST", body: { code: text(code, 2048) } });
      if (!session.session_id || !Array.isArray(session.accounts)) throw new Error("Session bancaire incomplète.");
      const connection = {
        bankId: pending.bankId,
        bankName: pending.bankName,
        sessionId: text(session.session_id, 120),
        validUntil: session.access?.valid_until || pending.validUntil,
        accounts: session.accounts.map((account) => ({
          uid: text(account.uid, 120),
          identificationHash: text(account.identification_hash, 500),
          name: text(account.name || account.product || "Compte", 80),
          currency: text(account.currency || "EUR", 8),
          masked: account.account_id?.iban ? `•••• ${String(account.account_id.iban).slice(-4)}` : "Compte lié",
        })).filter(({ uid }) => uid),
        connectedAt: this.now().toISOString(),
        lastSyncAt: null,
        lastSyncCount: 0,
      };
      await this.store.set(`connection-${pending.bankId}`, connection);
      await this.store.remove(pendingId);
      return connectionPayload(`connection-${pending.bankId}`, connection);
    } catch (reason) {
      await this.store.set(pendingId, { ...pending, processing: false, lastError: text(reason.message) });
      throw reason;
    }
  }

  async disconnect(bankId) {
    if (!BANK_PATTERNS[bankId] || !this.store.get(`connection-${bankId}`)) throw new Error("Connexion bancaire introuvable.");
    await this.store.remove(`connection-${bankId}`);
  }

  async sync(bankId = null) {
    const targets = Object.entries(this.store.all()).filter(([id, value]) => id.startsWith("connection-") && value?.sessionId && (!bankId || value.bankId === bankId));
    if (!targets.length) throw new Error("Aucun compte bancaire lié.");
    const dateFrom = new Date(this.now().getTime() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    for (const [id, connection] of targets) {
      const connectionTransactions = [];
      const syncedAccounts = [];
      for (const account of connection.accounts || []) {
        let syncedAccount = account;
        try {
          const payload = await this.request(`/accounts/${encodeURIComponent(account.uid)}/balances`);
          const priorities = ["ITAV", "CLAV", "FWAV", "ITBD", "CLBD", "INFO", "OTHR"];
          const balances = (payload.balances || []).filter((balance) => balance.balance_amount?.currency === "EUR" && Number.isFinite(Number(balance.balance_amount?.amount)));
          const priority = (balance) => {
            const index = priorities.indexOf(balance.balance_type);
            return index < 0 ? priorities.length : index;
          };
          const selected = [...balances].sort((left, right) => priority(left) - priority(right))[0];
          if (selected) syncedAccount = {
            ...account,
            balance: Math.round(Number(selected.balance_amount.amount) * 100) / 100,
            balanceType: text(selected.balance_type, 8),
            balanceAt: selected.last_change_date_time || selected.reference_date || this.now().toISOString(),
          };
        } catch { /* solde facultatif selon banque */ }
        syncedAccounts.push(syncedAccount);
        let continuationKey = null;
        for (let page = 0; page < 20; page += 1) {
          const query = new URLSearchParams({ date_from: dateFrom, strategy: "longest" });
          if (continuationKey) query.set("continuation_key", continuationKey);
          const payload = await this.request(`/accounts/${encodeURIComponent(account.uid)}/transactions?${query}`);
          for (const transaction of payload.transactions || []) {
            const amount = Number(transaction.transaction_amount?.amount);
            const currency = transaction.transaction_amount?.currency || account.currency;
            const date = transaction.booking_date || transaction.transaction_date || transaction.value_date;
            if (!Number.isFinite(amount) || amount === 0 || currency !== "EUR" || transaction.status !== "BOOK" || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
              skipped += 1;
              continue;
            }
            const kind = transaction.credit_debit_indicator === "CRDT" ? "income" : "expense";
            const description = transactionDescription(transaction, kind);
            const fallback = crypto.createHash("sha256").update(JSON.stringify([date, amount, kind, description, transaction.reference_number || ""])).digest("hex");
            connectionTransactions.push({
              kind,
              amount: Math.abs(amount),
              description,
              category: kind === "income" ? "income" : transactionCategory(transaction, description),
              date,
              account: `${connection.bankName} · ${account.name}`,
              source: "enable-banking",
              sourceAccount: account.identificationHash || account.uid,
              externalId: text(transaction.entry_reference || fallback, 500),
            });
          }
          continuationKey = payload.continuation_key || null;
          if (!continuationKey) break;
        }
      }
      const result = await this.finance.importTransactions(connectionTransactions);
      imported += result.imported;
      updated += result.updated;
      await this.store.set(id, { ...connection, accounts: syncedAccounts, lastSyncAt: this.now().toISOString(), lastSyncCount: result.imported + result.updated });
    }
    return { imported, updated, skipped };
  }
}
