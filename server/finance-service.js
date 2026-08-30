import crypto from "node:crypto";

export const FINANCE_CATEGORIES = [
  { id: "housing", label: "Logement" },
  { id: "food", label: "Alimentation" },
  { id: "transport", label: "Transport" },
  { id: "subscriptions", label: "Abonnements" },
  { id: "insurance", label: "Assurances" },
  { id: "taxes", label: "Impôts & taxes" },
  { id: "bank_fees", label: "Frais bancaires" },
  { id: "shopping", label: "Achats" },
  { id: "health", label: "Santé" },
  { id: "leisure", label: "Loisirs" },
  { id: "personal", label: "Soins personnels" },
  { id: "external_transfers", label: "Virements externes" },
  { id: "other", label: "Autres" },
];

const CATEGORY_IDS = new Set(FINANCE_CATEGORIES.map(({ id }) => id));
const MODULE_TYPES = new Set(["asset", "recurring", "envelope", "transfer"]);
const ESSENTIAL_CATEGORY_IDS = new Set(["housing", "food", "transport", "subscriptions", "insurance", "taxes", "bank_fees", "health"]);
const PACED_CATEGORY_IDS = new Set(["food", "transport", "shopping", "health", "leisure", "personal", "external_transfers", "other"]);
const SALARY_PATTERN = /salaire|salary|payroll|remuneration|traitement|fiche de paie|virement employeur/;
const INVESTMENT_TRANSFER_PATTERN = /\bepargne\b|\blivret\b|assurance vie|compte titres/;
const DEFAULT_SETTINGS = {
  savingsGoal: 0,
  safetyBuffer: 0,
  emergencyMonths: 3,
  budgets: Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, 0])),
};
const FRENCH_MONTHS = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
};

function money(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 10_000_000) throw new Error(`${label} invalide.`);
  return Math.round(number * 100) / 100;
}

function validMonth(value) {
  const month = String(value || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Mois invalide.");
  return month;
}

function validDate(value) {
  const date = String(value || "");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Date invalide.");
  return date;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function shiftMonth(month, offset) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function lowerMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.floor((sorted.length - 1) / 2)]);
}

function aggregate(items) {
  const spentByCategory = Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, 0]));
  let expenses = 0;
  let recordedIncome = 0;
  for (const transaction of items) {
    if (transaction.amount < 0) {
      const amount = Math.abs(transaction.amount);
      expenses += amount;
      if (spentByCategory[transaction.category] !== undefined) spentByCategory[transaction.category] += amount;
    } else if (CATEGORY_IDS.has(transaction.category)) {
      expenses -= transaction.amount;
      spentByCategory[transaction.category] -= transaction.amount;
    } else {
      recordedIncome += transaction.amount;
    }
  }
  for (const id of CATEGORY_IDS) spentByCategory[id] = round(Math.max(0, spentByCategory[id]));
  return { expenses: round(Math.max(0, expenses)), recordedIncome: round(recordedIncome), spentByCategory };
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchTerms(value) {
  return String(value || "").split(/[\n,;|]+/).map(normalized).filter(Boolean);
}

function transferSignature(description) {
  return normalized(description).replace(/^(?:vir|virement)(?: sepa| inst| instantane)?\s+/, "");
}

function cardPurchaseSignature(description) {
  return normalized(description)
    .replace(/^(?:carte|avoir)\s+\d{2}\s+\d{2}\s+\d{2}\s+/, "")
    .replace(/\s+cb\s+\d+.*$/, "")
    .replace(/\s+\d+(?:\s+\d+)?\s+(?:eur|us)$/, "")
    .replace(/\s+fact\s+\d{6}.*$/, "");
}

function recurringSignature(description) {
  const first = String(description || "").split(" · ")[0];
  return cardPurchaseSignature(first)
    .replace(/^(?:prlv|prelevement)(?: sepa)?\s+/, "")
    .replace(/^(?:rem|remboursement|refund)\s+/, "")
    .replace(/\s+fact\s+\d{6}.*$/, "")
    .replace(/\s+\d{6,}.*$/, "")
    .trim() || normalized(first);
}

function refundLike(transaction) {
  return transaction.amount > 0 && /^(?:avoir|rem\b|remboursement|refund)/.test(normalized(transaction.description));
}

function embeddedCardDate(transaction) {
  const description = String(transaction.description || "");
  const slash = description.match(/^(?:CARTE|AVOIR)\s+(\d{2})\/(\d{2})\/(\d{2})\b/i);
  const compact = description.match(/\bFACT\s+(\d{2})(\d{2})(\d{2})\b/i);
  const match = slash || compact;
  if (!match) return null;
  const candidate = `20${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  const booked = new Date(`${transaction.date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) return null;
  const delayDays = (booked.getTime() - parsed.getTime()) / 86_400_000;
  return delayDays >= 0 && delayDays <= 45 ? candidate : null;
}

function effectiveTransactionDate(transaction) {
  return transaction.source === "enable-banking" ? embeddedCardDate(transaction) || transaction.date : transaction.date;
}

function classifyTransactions(items, modules = []) {
  const configuredTransferMatchers = modules
    .filter(({ moduleType, enabled, transactionMatch }) => ["asset", "transfer"].includes(moduleType) && enabled !== false && transactionMatch)
    .flatMap(({ moduleType, transactionMatch }) => matchTerms(transactionMatch).map((match) => ({ match, reason: moduleType === "asset" ? "placement" : "transfert-interne" })));
  const directions = new Map();
  for (const transaction of items) {
    if (transaction.source !== "enable-banking") continue;
    const signature = transferSignature(transaction.description);
    if (!signature) continue;
    const values = directions.get(signature) || new Set();
    values.add(transaction.amount < 0 ? "out" : "in");
    directions.set(signature, values);
  }
  const result = new Map();
  const internalNames = [...directions.entries()].filter(([, values]) => values.size > 1).map(([signature]) => signature);
  for (const transaction of items) {
    if (transaction.source !== "enable-banking") continue;
    if (/\bcorporate card\b/.test(normalized(transaction.description))) {
      result.set(transaction.id, "professionnel");
      continue;
    }
    const description = normalized(transaction.description);
    const configuredTransfer = configuredTransferMatchers.find(({ match }) => description.includes(match));
    if (INVESTMENT_TRANSFER_PATTERN.test(description) || configuredTransfer) {
      result.set(transaction.id, configuredTransfer?.reason || "placement");
      continue;
    }
    const rawDescription = normalized(transaction.description);
    const signature = transferSignature(transaction.description);
    const signatureTokens = signature.split(" ").filter((token) => !["m", "mr", "mme", "madame", "monsieur"].includes(token));
    const ownerAlias = /^(?:vir|virement)\b/.test(rawDescription) && signatureTokens.length >= 2 && internalNames.some((name) => {
      const nameTokens = new Set(name.split(" "));
      return signatureTokens.every((token) => nameTokens.has(token));
    });
    if (directions.get(signature)?.size > 1 || ownerAlias) result.set(transaction.id, "transfert-interne");
  }
  const cardDuplicates = new Map();
  for (const transaction of items) {
    if (transaction.source !== "enable-banking" || result.has(transaction.id)) continue;
    const bank = normalized(String(transaction.account || "").split(" · ")[0]);
    const key = `${bank}|${transaction.date}|${transaction.amount}`;
    const matches = cardDuplicates.get(key) || [];
    matches.push(transaction);
    cardDuplicates.set(key, matches);
  }
  for (const matches of cardDuplicates.values()) {
    const cardEntries = matches.filter(({ account }) => normalized(account).includes("carte"));
    const accountEntries = matches.filter(({ account }) => !normalized(account).includes("carte"));
    for (const duplicate of cardEntries) {
      const signature = cardPurchaseSignature(duplicate.description);
      const original = accountEntries.find((transaction) => {
        const other = cardPurchaseSignature(transaction.description);
        return signature === other || signature.startsWith(`${other} `) || other.startsWith(`${signature} `);
      });
      if (original) result.set(duplicate.id, "doublon-carte");
    }
  }
  return result;
}

function learnedSalaryDescriptions(items, classifications) {
  const groups = new Map();
  for (const transaction of items) {
    if (transaction.amount < 500 || transaction.category !== "income" || classifications.has(transaction.id) || transaction.source !== "enable-banking") continue;
    const description = normalized(transaction.description);
    if (!description || SALARY_PATTERN.test(description)) continue;
    const months = groups.get(description) || new Map();
    const month = transaction.date.slice(0, 7);
    months.set(month, round((months.get(month) || 0) + transaction.amount));
    groups.set(description, months);
  }
  const recurrent = [...groups.entries()]
    .filter(([, months]) => months.size >= 2)
    .map(([description, months]) => ({ description, months: months.size, amount: median([...months.values()]) }))
    .sort((a, b) => b.months - a.months || b.amount - a.amount);
  return new Set(recurrent.length ? [recurrent[0].description] : []);
}

function categoryForDescription(description) {
  const value = normalized(description);
  if (/loyer|vilogia|credit immobilier|electricite|\bedf\b|engie|\bgaz\b|\beau\b|assurance habitation/.test(value)) return "housing";
  if (/carrefour|auchan|monoprix|intermarch|\blidl\b|\baldi\b|franprix|leclerc|costco|tang freres|picard|souss market|pottier distribut|tgtg|too good to go|restaurant|rest |repas|boulanger|deliveroo|uber eats|mcdonald|five guys|\bkfc\b|aim thai|hao hao|palmito|pistacho|delice|coffee|brunch|bistro|relay daily|nous anti gaspi|studenac|tommy\d|slasticarnica|ajme ajme|selecta|courses|alimentation|u etab paiement/.test(value)) return "food";
  if (/transport|\btrain\b|sncf|ratp|metro|navigo|essence|parking|peage|autoroute|cofiroute|atlandes|bidegi|certas esso|plenergy|easyjet|lmnext|lastminute|\buber\b|ubr pending|\bbolt\b|levaparc|dac uep|zracna luka|pbp versailles/.test(value)) return "transport";
  if (/abonnement|offre confort|netflix|spotify|canva|adobe|telephone|internet|\borange\b|apple com bill|google storage/.test(value)) return "subscriptions";
  if (/assurance|assura|\bmaif\b|\bgmf\b|l olivier/.test(value)) return "insurance";
  if (/direction generale des fina|dgfip|finances publiques|tresor public|\bimpot/.test(value)) return "taxes";
  if (/frais bancaire|comm(?:ission)? intervention|cotisation carte|\bagios\b/.test(value)) return "bank_fees";
  if (/amazon|paypal|aliexpress|ebay|zara|uniqlo|abercrombie|\bcos\b|courir|wconcept|normal le chesn|lovegobuy/.test(value)) return "shopping";
  if (/sante|mutuelle|medecin|docteur|doctolib|pharm|\bphie\b|dentiste|hopital|cso cc parly|\bdr\s/.test(value)) return "health";
  if (/keepcool|delfin nautica|loisir|cinema|concert|sport|\bjeu\b|steam|playstation/.test(value)) return "leisure";
  if (/planity|coiffeur|beaute|barbier|esthetique/.test(value)) return "personal";
  if (/^(?:vir|virement)(?: sepa| inst| instantane)?\b/.test(value)) return "external_transfers";
  return "other";
}

function applyCategoryModules(items, modules) {
  const matchers = modules
    .filter(({ moduleType, enabled, transactionMatch }) => moduleType === "recurring" && enabled !== false && transactionMatch)
    .flatMap(({ transactionMatch, category }) => matchTerms(transactionMatch).map((match) => ({ match, category })));
  return items.map((transaction) => {
    if (transaction.amount >= 0) return transaction;
    const category = matchers.find(({ match }) => normalized(transaction.description).includes(match))?.category;
    const inferred = transaction.source === "enable-banking" && transaction.category === "other" ? categoryForDescription(transaction.description) : transaction.category;
    return category || inferred !== transaction.category ? { ...transaction, category: category || inferred } : transaction;
  });
}

function frenchDate(value, now) {
  const match = normalized(value).match(/(?:^|\s)(\d{1,2})(?:er)?\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = FRENCH_MONTHS[match[2]];
  let year = match[3] ? Number(match[3]) : now.getFullYear();
  let result = new Date(Date.UTC(year, month - 1, day));
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  if (!match[3] && result < today) {
    year += 1;
    result = new Date(Date.UTC(year, month - 1, day));
  }
  if (result.getUTCDate() !== day || result.getUTCMonth() !== month - 1) throw new Error("Date de changement invalide.");
  return result.toISOString().slice(0, 10);
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export class FinanceService {
  constructor({ store, aggregatorConfigured = false, now = () => new Date(), advisor = null, classifier = null } = {}) {
    this.store = store;
    this.aggregatorConfigured = aggregatorConfigured;
    this.now = now;
    this.advisor = advisor;
    this.classifier = classifier;
  }

  setAggregatorConfigured(value) {
    this.aggregatorConfigured = Boolean(value);
  }

  setAdvisor(advisor) {
    this.advisor = advisor;
  }

  setClassifier(classifier) {
    this.classifier = classifier;
  }

  settings() {
    const saved = this.store.get("settings") || {};
    const { monthlyIncome: _ignored, currentSavings: _legacySavings, liquidSavings: _legacyLiquid, investedAssets: _legacyInvested, ...stored } = saved;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      budgets: { ...DEFAULT_SETTINGS.budgets, ...(saved.budgets || {}) },
    };
  }

  modules() {
    return Object.entries(this.store.all())
      .filter(([id, value]) => id.startsWith("finance-module-") && value?.type === "finance-module" && MODULE_TYPES.has(value.moduleType))
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => a.moduleType.localeCompare(b.moduleType) || a.name.localeCompare(b.name, "fr"));
  }

  async migrateLegacyModules() {
    const entries = [];
    const removals = [];
    for (const [id, value] of Object.entries(this.store.all())) {
      if (!id.startsWith("recurring-") || value?.type !== "recurring") continue;
      entries.push([`finance-module-${id.slice("recurring-".length)}`, {
        ...value,
        type: "finance-module",
        moduleType: "recurring",
        name: value.description,
        enabled: true,
      }]);
      removals.push(id);
    }
    const saved = this.store.get("settings") || {};
    const legacyLiquid = Number(saved.liquidSavings ?? saved.currentSavings ?? 0);
    const legacyInvested = Number(saved.investedAssets ?? 0);
    const existingAssets = this.modules().filter(({ moduleType }) => moduleType === "asset");
    if (legacyLiquid > 0 && !existingAssets.some(({ bucket }) => bucket === "liquid")) entries.push(["finance-module-legacy-liquid", {
      type: "finance-module", moduleType: "asset", name: "Épargne liquide", amount: round(legacyLiquid), bucket: "liquid", institution: "", transactionMatch: "", enabled: true, createdAt: new Date().toISOString(),
    }]);
    if (legacyInvested > 0 && !existingAssets.some(({ bucket }) => bucket === "invested")) entries.push(["finance-module-legacy-invested", {
      type: "finance-module", moduleType: "asset", name: "Placements", amount: round(legacyInvested), bucket: "invested", institution: "", transactionMatch: "", enabled: true, createdAt: new Date().toISOString(),
    }]);
    if (entries.length) await this.store.setMany(entries);
    if (saved.currentSavings !== undefined || saved.liquidSavings !== undefined || saved.investedAssets !== undefined) {
      const { currentSavings: _current, liquidSavings: _liquid, investedAssets: _invested, ...cleanSettings } = saved;
      await this.store.set("settings", cleanSettings);
    }
    for (const id of removals) await this.store.remove(id);
    return { migrated: entries.length };
  }

  transactions() {
    return Object.entries(this.store.all())
      .filter(([id, value]) => id.startsWith("transaction-") && value?.type === "transaction")
      .map(([id, value]) => {
        const date = effectiveTransactionDate(value);
        return { id, ...value, date, ...(date === value.date ? {} : { bookingDate: value.date }) };
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }

  recurring() {
    return this.modules()
      .filter(({ moduleType }) => moduleType === "recurring")
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.description.localeCompare(b.description));
  }

  moduleInput(input = {}, existing = null) {
    const moduleType = String(input.moduleType || existing?.moduleType || "");
    if (!MODULE_TYPES.has(moduleType)) throw new Error("Type module financier invalide.");
    const name = String(input.name ?? existing?.name ?? "").trim().slice(0, 120);
    if (!name) throw new Error("Nom module requis.");
    const common = {
      type: "finance-module",
      moduleType,
      name,
      enabled: input.enabled === undefined ? existing?.enabled !== false : Boolean(input.enabled),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (moduleType === "asset") {
      const amount = money(input.amount ?? existing?.amount ?? 0, "Montant actif");
      return {
        ...common,
        amount,
        // Repere de depart: les versements posterieurs viennent s'ajouter au montant saisi.
        amountUpdatedAt: amount === existing?.amount ? existing?.amountUpdatedAt || existing?.createdAt || common.createdAt : new Date().toISOString(),
        bucket: ["liquid", "invested"].includes(input.bucket ?? existing?.bucket) ? input.bucket ?? existing.bucket : "liquid",
        institution: String(input.institution ?? existing?.institution ?? "").trim().slice(0, 80),
        transactionMatch: String(input.transactionMatch ?? existing?.transactionMatch ?? "").trim().slice(0, 240),
      };
    }
    if (moduleType === "envelope") {
      const accountMatch = String(input.accountMatch ?? existing?.accountMatch ?? "").trim().slice(0, 120);
      if (!accountMatch) throw new Error("Compte à suivre requis.");
      return { ...common, accountMatch };
    }
    if (moduleType === "transfer") {
      const transactionMatch = String(input.transactionMatch ?? existing?.transactionMatch ?? "").trim().slice(0, 240);
      if (!matchTerms(transactionMatch).length) throw new Error("Motif transfert requis.");
      return { ...common, transactionMatch };
    }
    const amount = money(input.amount ?? existing?.amount, "Montant charge");
    if (!amount) throw new Error("Montant nul interdit.");
    const startDate = validDate(input.startDate ?? existing?.startDate ?? this.now().toISOString().slice(0, 10));
    const dayOfMonth = Number(input.dayOfMonth ?? existing?.dayOfMonth ?? startDate.slice(8, 10));
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw new Error("Jour mensuel invalide.");
    const endDateValue = input.endDate === undefined ? existing?.endDate : input.endDate;
    const endDate = endDateValue ? validDate(endDateValue) : null;
    if (endDate && endDate < startDate) throw new Error("Fin charge antérieure au début.");
    return {
      ...common,
      description: name,
      amount,
      category: CATEGORY_IDS.has(input.category ?? existing?.category) ? input.category ?? existing.category : categoryForDescription(name),
      startDate,
      endDate,
      dayOfMonth,
      account: String(input.account ?? existing?.account ?? "Prévision").trim().slice(0, 60) || "Prévision",
      transactionMatch: String(input.transactionMatch ?? existing?.transactionMatch ?? "").trim().slice(0, 240),
    };
  }

  async addModule(input = {}) {
    const module = this.moduleInput(input);
    const id = `finance-module-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    await this.store.set(id, module);
    return { id, ...module };
  }

  async updateModule(id, input = {}) {
    if (!/^finance-module-[a-z0-9-]+$/.test(id)) throw new Error("Module financier introuvable.");
    const existing = this.store.get(id);
    if (existing?.type !== "finance-module") throw new Error("Module financier introuvable.");
    const module = this.moduleInput(input, existing);
    await this.store.set(id, module);
    return { id, ...module };
  }

  async removeModule(id) {
    if (!/^finance-module-[a-z0-9-]+$/.test(id) || this.store.get(id)?.type !== "finance-module") throw new Error("Module financier introuvable.");
    await this.store.remove(id);
  }

  agentHistory() {
    return Object.entries(this.store.all())
      .filter(([id, value]) => id.startsWith("finance-agent-") && value?.type === "finance-agent-message")
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-60);
  }

  async addRecurring(input = {}) {
    const description = String(input.description || "").trim().slice(0, 120);
    if (!description) throw new Error("Description charge requise.");
    const amount = money(input.amount, "Montant charge");
    if (!amount) throw new Error("Montant nul interdit.");
    const category = CATEGORY_IDS.has(input.category) ? input.category : categoryForDescription(description);
    const startDate = validDate(input.startDate || this.now().toISOString().slice(0, 10));
    const dayOfMonth = input.dayOfMonth === undefined ? Number(startDate.slice(8, 10)) : Number(input.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw new Error("Jour mensuel invalide.");
    return this.addModule({ ...input, moduleType: "recurring", name: description, amount, category, startDate, endDate: null, dayOfMonth });
  }

  async changeRecurring({ match, amount, effectiveDate } = {}) {
    const needle = normalized(match);
    if (!needle) throw new Error("Charge à modifier requise.");
    const date = validDate(effectiveDate);
    const rules = this.recurring().filter((rule) => !rule.endDate && (normalized(rule.description).includes(needle) || needle.includes(normalized(rule.description))));
    const current = rules.at(-1);
    if (!current) throw new Error(`Charge « ${String(match).trim()} » introuvable.`);
    const nextAmount = money(amount, "Nouveau montant");
    if (!nextAmount) throw new Error("Montant nul interdit.");
    if (date <= current.startDate) {
      const updated = await this.updateModule(current.id, { amount: nextAmount, startDate: date, dayOfMonth: Number(date.slice(8, 10)) });
      return { previous: null, current: updated };
    }
    await this.updateModule(current.id, { endDate: previousDate(date) });
    const replacement = await this.addRecurring({ ...current, amount: nextAmount, startDate: date, dayOfMonth: Number(date.slice(8, 10)) });
    return { previous: current, current: replacement };
  }

  async removeRecurring(id) {
    if (this.store.get(id)?.moduleType !== "recurring") throw new Error("Charge récurrente introuvable.");
    await this.removeModule(id);
  }

  async recordAgentMessage(role, content) {
    const id = `finance-agent-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    await this.store.set(id, { type: "finance-agent-message", role, content: String(content).slice(0, role === "assistant" ? 5000 : 1000), createdAt: new Date().toISOString() });
  }

  async financeAgent(message, month) {
    const content = String(message || "").trim().slice(0, 1000);
    if (!content) throw new Error("Message requis.");
    const selectedMonth = validMonth(month);
    await this.recordAgentMessage("user", content);
    const value = normalized(content);
    const amountContent = content.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const changeAmount = amountContent.match(/(?:passe|passera|sera)\s+a\s+(\d+(?:[.,]\d{1,2})?)/);
    const paymentAmount = amountContent.match(/(?:paye|paie|verse)\s+(\d+(?:[.,]\d{1,2})?)/);
    const euroAmount = amountContent.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:euros?|eur)\b/);
    const amount = Number((changeAmount?.[1] || paymentAmount?.[1] || euroAmount?.[1] || "").replace(",", ".")) || null;
    let reply;
    let action = "answer";
    let actionDetail = null;
    const effectiveDate = frenchDate(content, this.now());
    const change = value.match(/(?:a partir du\s+\d{1,2}(?:er)?\s+[a-z]+(?:\s+\d{4})?\s+)(?:le |la |mon |ma )?(.+?)\s+(?:passe|passera|sera)\s+a\s+\d/);
    if (change && amount && effectiveDate) {
      const result = await this.changeRecurring({ match: change[1], amount, effectiveDate });
      reply = `${result.current.description}: ${result.current.amount.toFixed(2)} € par mois dès le ${effectiveDate}. Ancienne période conservée dans prévisions.`;
      action = "recurring-changed";
      actionDetail = reply;
    } else if (/chaque mois|tous les mois|mensuel/.test(value) && amount) {
      const amountToken = normalized(paymentAmount?.[1] || euroAmount?.[1]);
      const amountIndex = value.indexOf(amountToken);
      let description = value.slice(amountIndex + amountToken.length).replace(/^\s*(?:euros?|eur)?\s*(?:de|pour le|pour la|pour)?\s*/, "").replace(/\s+a partir du\s+.*$/, "").trim();
      if (!description) description = value.match(/(?:paye|paie|verse)\s+(.+?)\s+\d/)?.[1] || "charge mensuelle";
      const startDate = effectiveDate || this.now().toISOString().slice(0, 10);
      const statedDay = value.match(/(?:chaque mois|tous les mois).*?\ble\s+(\d{1,2})\b/)?.[1];
      const rule = await this.addRecurring({ description, amount, startDate, dayOfMonth: statedDay ? Number(statedDay) : 1 });
      reply = `${rule.description}: ${rule.amount.toFixed(2)} € ajoutés chaque mois, catégorie ${FINANCE_CATEGORIES.find(({ id }) => id === rule.category)?.label}.`;
      action = "recurring-added";
      actionDetail = reply;
    } else if (/liste|charges|prelevements|recurrent/.test(value)) {
      const active = this.recurring().filter(({ endDate }) => !endDate);
      reply = active.length ? active.map((rule) => `${rule.description}: ${rule.amount.toFixed(2)} € le ${rule.dayOfMonth}`).join("\n") : "Aucune charge mensuelle enregistrée.";
    } else if (/combien|depenser|epargner|reste/.test(value)) {
      const summary = this.summary(selectedMonth);
      reply = `Reste dépensable prudent: ${summary.safeToSpend.toFixed(2)} €. Épargne soutenable: ${summary.protectedSavings.toFixed(2)} €. Réserve imprévus: ${summary.safetyBuffer.toFixed(2)} €.`;
    } else {
      reply = "Agent Codex indisponible. Réessaie dans quelques secondes.";
    }
    if (this.advisor) {
      try {
        reply = await this.advisor({ message: content, month: selectedMonth, action: actionDetail });
      } catch (error) {
        reply = `${reply}\n\nErreur agent: ${error.message}`;
      }
    }
    await this.recordAgentMessage("assistant", reply);
    return { reply, action, recurring: this.recurring(), history: this.agentHistory(), summary: this.summary(selectedMonth) };
  }

  async updateSettings(input = {}) {
    const current = this.settings();
    const next = {
      savingsGoal: input.savingsGoal === undefined ? current.savingsGoal : money(input.savingsGoal, "Objectif épargne"),
      safetyBuffer: input.safetyBuffer === undefined ? current.safetyBuffer : money(input.safetyBuffer, "Réserve imprévus"),
      emergencyMonths: input.emergencyMonths === undefined ? current.emergencyMonths : Number(input.emergencyMonths),
      budgets: { ...current.budgets },
    };
    if (!Number.isInteger(next.emergencyMonths) || next.emergencyMonths < 1 || next.emergencyMonths > 24) throw new Error("Mois de sécurité invalides.");
    if (input.budgets !== undefined) {
      if (!input.budgets || typeof input.budgets !== "object" || Array.isArray(input.budgets)) throw new Error("Budgets invalides.");
      for (const category of FINANCE_CATEGORIES) {
        if (input.budgets[category.id] !== undefined) next.budgets[category.id] = money(input.budgets[category.id], `Budget ${category.label}`);
      }
    }
    await this.store.set("settings", next);
    return next;
  }

  async addTransaction(input = {}) {
    const kind = input.kind === "income" ? "income" : input.kind === "expense" ? "expense" : null;
    if (!kind) throw new Error("Type opération invalide.");
    const description = String(input.description || "").trim().slice(0, 120);
    if (!description) throw new Error("Description requise.");
    const absoluteAmount = money(input.amount, "Montant");
    if (absoluteAmount === 0) throw new Error("Montant nul interdit.");
    const category = kind === "income" ? "income" : String(input.category || "other");
    if (kind === "expense" && !CATEGORY_IDS.has(category)) throw new Error("Catégorie invalide.");
    const id = `transaction-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const transaction = {
      type: "transaction",
      kind,
      amount: kind === "expense" ? -absoluteAmount : absoluteAmount,
      description,
      category,
      date: validDate(input.date),
      account: String(input.account || "Manuel").trim().slice(0, 60) || "Manuel",
      source: "manual",
      createdAt: new Date().toISOString(),
    };
    await this.store.set(id, transaction);
    return { id, ...transaction };
  }

  // Rattachement explicite d'un virement a un actif: le libelle bancaire ne dit pas ou va l'argent.
  async assignTransactionAsset(id, assetId) {
    const transaction = this.store.get(id);
    if (!/^transaction-[a-z0-9-]+$/.test(id) || !transaction) throw new Error("Opération introuvable.");
    const asset = assetId ? this.store.get(assetId) : null;
    if (assetId && asset?.moduleType !== "asset") throw new Error("Actif introuvable.");
    await this.store.set(id, { ...transaction, assetId: assetId || null });
    return { id, ...this.store.get(id) };
  }

  async removeTransaction(id) {
    if (!/^transaction-[a-z0-9-]+$/.test(id) || !this.store.get(id)) throw new Error("Opération introuvable.");
    await this.store.remove(id);
  }

  async categorizeTransactions({ force = false, month = null } = {}) {
    if (!this.classifier) throw new Error("Classificateur Codex indisponible.");
    if (month) validMonth(month);
    const transactions = this.transactions().filter((transaction) => transaction.source === "enable-banking" && (!month || transaction.date.startsWith(month)));
    const groups = new Map();
    for (const transaction of transactions) {
      const flow = transaction.amount < 0 || refundLike(transaction) ? "expense" : "income";
      const key = `${flow}:${recurringSignature(transaction.description)}`;
      const group = groups.get(key) || { key, transactions: [] };
      group.transactions.push(transaction);
      groups.set(key, group);
    }
    const candidates = [...groups.values()].filter(({ transactions: items }) => force || items.some(({ categorySource }) => categorySource !== "codex"));
    if (!candidates.length) return { categorized: 0, groups: 0 };
    const input = candidates.map((group, index) => {
      const byMonth = new Map();
      for (const transaction of group.transactions) byMonth.set(transaction.date.slice(0, 7), round((byMonth.get(transaction.date.slice(0, 7)) || 0) + transaction.amount));
      return {
        id: `g${index}`,
        description: group.transactions[0].description,
        examples: [...new Set(group.transactions.slice(0, 4).map(({ description }) => description))],
        flow: group.key.startsWith("expense:") ? "expense-or-refund" : "income",
        months: [...byMonth.keys()].sort(),
        count: group.transactions.length,
        medianDebit: median(group.transactions.filter(({ amount }) => amount < 0).map(({ amount }) => Math.abs(amount))),
        medianCredit: median(group.transactions.filter(({ amount }) => amount > 0).map(({ amount }) => amount)),
        medianMonthlyNet: median([...byMonth.values()].map((amount) => Math.abs(Math.min(0, amount)))),
        currentCategories: [...new Set(group.transactions.map(({ category }) => category))],
      };
    });
    let categorized = 0;
    let classifiedGroups = 0;
    for (let offset = 0; offset < input.length; offset += 20) {
      const classifications = await this.classifier(input.slice(offset, offset + 20), FINANCE_CATEGORIES);
      const entries = [];
      for (const classification of classifications) {
        const index = Number(String(classification.id || "").replace(/^g/, ""));
        const group = candidates[index];
        if (!group) continue;
        let category = String(classification.category || "other");
        if (group.key.startsWith("expense:") && category === "income") category = "other";
        if (category !== "income" && !CATEGORY_IDS.has(category)) category = "other";
        for (const transaction of group.transactions) {
          const stored = this.store.get(transaction.id);
          if (!stored) continue;
          entries.push([transaction.id, {
            ...stored,
            category,
            categorySource: "codex",
            categoryReason: String(classification.reason || "Classé par Codex").trim().slice(0, 180),
            recurringDetected: Boolean(classification.recurring),
            categorizedAt: new Date().toISOString(),
          }]);
        }
      }
      if (entries.length) {
        if (this.store.setMany) await this.store.setMany(entries);
        else for (const [id, value] of entries) await this.store.set(id, value);
      }
      categorized += entries.length;
      classifiedGroups += classifications.length;
    }
    return { categorized, groups: classifiedGroups };
  }

  async importTransactions(items = []) {
    const entries = [];
    let imported = 0;
    let updated = 0;
    const categoryMatchers = this.recurring()
      .filter(({ enabled, transactionMatch }) => enabled !== false && transactionMatch)
      .flatMap(({ transactionMatch, category }) => matchTerms(transactionMatch).map((match) => ({ match, category })));
    for (const item of items) {
      const kind = item.kind === "income" ? "income" : item.kind === "expense" ? "expense" : null;
      if (!kind || !item.externalId || !item.sourceAccount) continue;
      const absoluteAmount = money(item.amount, "Montant importé");
      if (!absoluteAmount) continue;
      const date = validDate(item.date);
      const key = crypto.createHash("sha256").update(`${item.source}:${item.sourceAccount}:${item.externalId}`).digest("hex").slice(0, 32);
      const id = `transaction-bank-${key}`;
      const existing = this.store.get(id);
      const matchedCategory = categoryMatchers.find(({ match }) => normalized(item.description).includes(match))?.category;
      const importedCategory = kind === "income" ? "income" : matchedCategory || (CATEGORY_IDS.has(item.category) ? item.category : "other");
      const keepCodexCategory = existing?.categorySource === "codex" && (existing.kind === kind) && Number(existing.amount) === (kind === "expense" ? -absoluteAmount : absoluteAmount);
      const transaction = {
        type: "transaction",
        kind,
        amount: kind === "expense" ? -absoluteAmount : absoluteAmount,
        description: String(item.description || "Opération bancaire").trim().slice(0, 120) || "Opération bancaire",
        category: keepCodexCategory ? existing.category : importedCategory,
        date,
        ...(item.bookingDate ? { bookingDate: validDate(item.bookingDate) } : {}),
        account: String(item.account || "Compte bancaire").trim().slice(0, 60) || "Compte bancaire",
        source: String(item.source || "bank").slice(0, 40),
        externalId: String(item.externalId).slice(0, 500),
        ...(keepCodexCategory ? {
          categorySource: existing.categorySource,
          categoryReason: existing.categoryReason,
          recurringDetected: existing.recurringDetected,
          categorizedAt: existing.categorizedAt,
        } : {}),
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      entries.push([id, transaction]);
      if (existing) updated += 1;
      else imported += 1;
    }
    if (entries.length) {
      if (this.store.setMany) await this.store.setMany(entries);
      else for (const [id, value] of entries) await this.store.set(id, value);
    }
    return { imported, updated };
  }

  summary(month) {
    const selectedMonth = validMonth(month);
    const settings = this.settings();
    const modules = this.modules();
    const allTransactions = applyCategoryModules(this.transactions(), modules);
    const classifications = classifyTransactions(allTransactions, modules);
    const budgetTransactions = allTransactions.filter((transaction) => !classifications.has(transaction.id));
    const transactions = budgetTransactions.filter((transaction) => transaction.date.startsWith(selectedMonth));
    const { expenses, recordedIncome, spentByCategory } = aggregate(transactions);
    const budgetTotal = round(Object.values(settings.budgets).reduce((total, value) => total + value, 0));
    const history = [-1, -2, -3]
      .map((offset) => {
        const historyMonth = shiftMonth(selectedMonth, offset);
        const historyTransactions = budgetTransactions.filter((transaction) => transaction.date.startsWith(historyMonth));
        return { month: historyMonth, expenseCount: historyTransactions.filter(({ amount }) => amount < 0).length, ...aggregate(historyTransactions) };
      })
      .filter(({ expenseCount }) => expenseCount > 0);
    const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
    const monthFirst = `${selectedMonth}-01`;
    const monthLast = `${selectedMonth}-${String(new Date(Date.UTC(selectedYear, selectedMonthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
    const recurringByCategory = Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, 0]));
    for (const rule of this.recurring()) {
      if (rule.enabled === false) continue;
      if (rule.startDate > monthLast || (rule.endDate && rule.endDate < monthFirst)) continue;
      recurringByCategory[rule.category] = round((recurringByCategory[rule.category] || 0) + rule.amount);
    }
    const now = this.now();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const salaryDescriptions = learnedSalaryDescriptions(allTransactions, classifications);
    const recordedSalary = round(transactions.filter((transaction) => transaction.amount > 0 && transaction.category === "income" && (SALARY_PATTERN.test(normalized(transaction.description)) || salaryDescriptions.has(normalized(transaction.description)))).reduce((total, transaction) => total + transaction.amount, 0));
    const incomeHistory = [-1, -2, -3, -4, -5, -6]
      .map((offset) => {
        const historyMonth = shiftMonth(selectedMonth, offset);
        const incoming = budgetTransactions.filter((transaction) => transaction.date.startsWith(historyMonth) && transaction.amount > 0 && transaction.category === "income");
        const salary = round(incoming.filter((transaction) => {
          const description = normalized(transaction.description);
          return SALARY_PATTERN.test(description) || salaryDescriptions.has(description);
        }).reduce((total, transaction) => total + transaction.amount, 0));
        const total = round(incoming.reduce((sum, transaction) => sum + transaction.amount, 0));
        return { month: historyMonth, salary, total };
      })
      .filter(({ total }) => total > 0);
    const explicitSalaryHistory = incomeHistory.filter(({ salary }) => salary > 0);
    const inferredIncome = lowerMedian((explicitSalaryHistory.length ? explicitSalaryHistory : incomeHistory).map(({ salary, total }) => salary || total));
    const income = selectedMonth < currentMonth ? recordedIncome : round(Math.max(recordedIncome, inferredIncome));
    const incomeSource = income <= 0 ? "missing" : selectedMonth < currentMonth || recordedIncome >= inferredIncome ? "recorded" : "history";
    const incomeHistoryMonths = explicitSalaryHistory.length || incomeHistory.length;
    const savingsCapacity = round(income - expenses);
    const savingsRate = income > 0 ? Math.round((savingsCapacity / income) * 100) : 0;
    const [year, monthNumber] = selectedMonth.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const elapsedDays = selectedMonth < currentMonth ? daysInMonth : selectedMonth === currentMonth ? Math.min(daysInMonth, now.getDate()) : 0;
    const daysRemaining = selectedMonth < currentMonth ? 0 : selectedMonth === currentMonth ? daysInMonth - elapsedDays + 1 : daysInMonth;
    const progress = Math.max(0.15, elapsedDays / daysInMonth);
    const categoryPlans = {};
    let futureEssentialExpenses = 0;
    let projectedExpenses = 0;
    let flexibleBudgetRemaining = 0;
    let flexibleBudgetCount = 0;
    for (const category of FINANCE_CATEGORIES) {
      const spent = spentByCategory[category.id];
      const budget = settings.budgets[category.id];
      const historicalAverage = median(history.map((item) => item.spentByCategory[category.id]));
      const recurringExpected = recurringByCategory[category.id];
      const paceProjection = selectedMonth === currentMonth ? round(spent / progress) : spent;
      const baseline = budget || historicalAverage;
      let projected = spent;
      if (selectedMonth >= currentMonth) {
        if (ESSENTIAL_CATEGORY_IDS.has(category.id)) projected = Math.max(spent, budget, historicalAverage, recurringExpected, PACED_CATEGORY_IDS.has(category.id) ? paceProjection : 0);
        else if (selectedMonth === currentMonth) projected = budget ? Math.max(spent, budget, paceProjection) : Math.max(spent, paceProjection);
        else projected = Math.max(spent, budget, historicalAverage);
      }
      projected = round(projected);
      const remaining = round(Math.max(0, projected - spent));
      const suggestedBudget = round(Math.max(spent, historicalAverage || baseline));
      const ambitious = budget > 0 && historicalAverage > budget * 1.2;
      categoryPlans[category.id] = {
        spent,
        budget,
        historicalAverage,
        recurringExpected,
        projected,
        remaining,
        suggestedBudget,
        essential: ESSENTIAL_CATEGORY_IDS.has(category.id),
        ambitious,
      };
      projectedExpenses += projected;
      if (ESSENTIAL_CATEGORY_IDS.has(category.id)) futureEssentialExpenses += remaining;
      else if (budget > 0) {
        flexibleBudgetRemaining += Math.max(0, budget - spent);
        flexibleBudgetCount += 1;
      }
    }
    projectedExpenses = round(projectedExpenses);
    futureEssentialExpenses = round(futureEssentialExpenses);
    flexibleBudgetRemaining = round(flexibleBudgetRemaining);
    const historyExpenseMedian = median(history.map((item) => item.expenses));
    const expenseVariation = history.length > 1
      ? round(history.reduce((total, item) => total + Math.abs(item.expenses - historyExpenseMedian), 0) / history.length)
      : 0;
    const automaticBuffer = income > 0 ? round(Math.max(income * 0.05, Math.min(income * 0.15, expenseVariation))) : 0;
    const safetyBuffer = settings.safetyBuffer || automaticBuffer;
    const forecastSurplusAfterBuffer = round(income - projectedExpenses - safetyBuffer);
    const historicalSurpluses = history
      .map((item) => round((item.recordedIncome || inferredIncome) - item.expenses - safetyBuffer))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const conservativeHistoricalSurplus = history.length >= 2 ? historicalSurpluses[Math.floor((historicalSurpluses.length - 1) * 0.25)] : null;
    const sustainableSavings = round(Math.max(0, conservativeHistoricalSurplus === null
      ? forecastSurplusAfterBuffer
      : Math.min(forecastSurplusAfterBuffer, conservativeHistoricalSurplus)));
    const protectedSavings = round(settings.savingsGoal > 0
      ? Math.min(settings.savingsGoal, sustainableSavings)
      : history.length >= 2
        ? sustainableSavings
        : Math.min(sustainableSavings, income * 0.1));
    const freeCash = round(income - expenses - futureEssentialExpenses - safetyBuffer - protectedSavings);
    const safeToSpend = round(Math.max(0, flexibleBudgetCount ? Math.min(freeCash, flexibleBudgetRemaining) : freeCash));
    const dailyAllowance = daysRemaining > 0 ? round(safeToSpend / daysRemaining) : 0;
    const projectedSavings = round(income - projectedExpenses);
    const dataConfidence = history.length >= 3 ? "high" : history.length >= 2 ? "medium" : "low";
    const essentialBase = round([...ESSENTIAL_CATEGORY_IDS].reduce((total, id) => total + Math.max(settings.budgets[id], categoryPlans[id].historicalAverage, spentByCategory[id]), 0));
    const emergencyTarget = round(essentialBase * settings.emergencyMonths);
    // Un actif suit les versements qui lui correspondent: un virement vers le LEP le fait monter.
    const assetEntries = modules
      .filter(({ moduleType, enabled }) => moduleType === "asset" && enabled !== false)
      .map((module) => {
        const { id, name, institution, amount, bucket } = module;
        const terms = matchTerms(module.transactionMatch);
        const fallback = normalized(name);
        const matchers = terms.length ? terms : fallback.length >= 3 ? [fallback] : [];
        const since = String(module.amountUpdatedAt || module.createdAt || "").slice(0, 10);
        const assigned = round(allTransactions
          .filter((transaction) => transaction.assetId === id)
          .reduce((total, transaction) => total - transaction.amount, 0));
        const matched = matchers.length
          ? round(allTransactions
            .filter((transaction) => !transaction.assetId && (!since || transaction.date > since) && matchers.some((matcher) => normalized(transaction.description).includes(matcher)))
            .reduce((total, transaction) => total - transaction.amount, 0))
          : 0;
        const contributions = round(assigned + matched);
        return { id, name, institution, bucket, baseAmount: amount, contributions, amount: round(amount + contributions) };
      });
    const unassignedSavings = round(allTransactions
      .filter((transaction) => transaction.date.startsWith(selectedMonth) && transaction.exclusionReason === "placement" && transaction.amount < 0)
      .filter((transaction) => !transaction.assetId)
      .filter((transaction) => !assetEntries.some((asset) => {
        const terms = matchTerms(modules.find(({ id }) => id === asset.id)?.transactionMatch);
        const matchers = terms.length ? terms : [normalized(asset.name)];
        return matchers.some((matcher) => matcher.length >= 3 && normalized(transaction.description).includes(matcher));
      }))
      .reduce((total, transaction) => total + Math.abs(transaction.amount), 0));
    const assets = {
      unassignedSavings,
      liquid: round(assetEntries.filter(({ bucket }) => bucket === "liquid").reduce((total, asset) => total + asset.amount, 0)),
      invested: round(assetEntries.filter(({ bucket }) => bucket === "invested").reduce((total, asset) => total + asset.amount, 0)),
      total: round(assetEntries.reduce((total, asset) => total + asset.amount, 0)),
      entries: assetEntries,
    };
    const spendingEnvelopes = modules
      .filter(({ moduleType, enabled }) => moduleType === "envelope" && enabled !== false)
      .map((module) => {
        const matcher = normalized(module.accountMatch);
        const envelopeTransactions = allTransactions.filter((transaction) => transaction.date.startsWith(selectedMonth) && normalized(transaction.account).includes(matcher));
        const funded = round(envelopeTransactions.filter((transaction) => transaction.amount > 0 && classifications.get(transaction.id) === "transfert-interne").reduce((total, transaction) => total + transaction.amount, 0));
        const spent = round(Math.max(0, -envelopeTransactions.filter((transaction) => !classifications.has(transaction.id)).reduce((total, transaction) => total + transaction.amount, 0)));
        const historyTransactions = [-1, -2, -3].map((offset) => {
          const historyMonth = shiftMonth(selectedMonth, offset);
          return allTransactions.filter((transaction) => transaction.date.startsWith(historyMonth) && normalized(transaction.account).includes(matcher) && !classifications.has(transaction.id));
        }).filter((items) => items.length > 0);
        const historySpending = historyTransactions.map((items) => round(Math.max(0, -items.reduce((total, transaction) => total + transaction.amount, 0))));
        const historicalMedian = median(historySpending);
        const recommendedFunding = Math.floor((historicalMedian * 0.9) / 10) * 10;
        const categoryHistory = Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, median(historyTransactions.map((items) => round(Math.max(0, -items.filter(({ category }) => category === id).reduce((total, transaction) => total + transaction.amount, 0)))))]));
        const categoryHistoryTotal = round(Object.values(categoryHistory).reduce((total, amount) => total + amount, 0));
        const recommendedCategoryLimits = Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, categoryHistoryTotal > 0 ? Math.floor((recommendedFunding * categoryHistory[id] / categoryHistoryTotal) / 5) * 5 : 0]));
        return { id: module.id, name: module.name, accountMatch: module.accountMatch, funded, spent, remaining: round(funded - spent), exceeded: round(Math.max(0, spent - funded)), historicalMedian, recommendedFunding, categoryHistory, recommendedCategoryLimits };
      });
    const recurringGroups = new Map();
    for (const transaction of budgetTransactions.filter(({ source }) => source === "enable-banking")) {
      const signature = recurringSignature(transaction.description);
      const group = recurringGroups.get(signature) || { signature, name: transaction.description.split(" · ")[0], category: transaction.category, months: new Map(), detected: false };
      group.months.set(transaction.date.slice(0, 7), round((group.months.get(transaction.date.slice(0, 7)) || 0) + transaction.amount));
      if (transaction.amount < 0) group.category = transaction.category;
      group.detected ||= Boolean(transaction.recurringDetected);
      recurringGroups.set(signature, group);
    }
    const detectedRecurring = [...recurringGroups.values()]
      .filter(({ months, detected }) => detected || months.size >= 3)
      .map(({ signature, name, category, months }) => ({ id: signature, name, category, months: months.size, monthlyNet: median([...months.values()].map((amount) => Math.max(0, -amount))) }))
      .filter(({ monthlyNet }) => monthlyNet > 0)
      .sort((a, b) => b.monthlyNet - a.monthlyNet);
    const primaryEnvelope = spendingEnvelopes[0] || null;
    const fixedCategoryIds = ["housing", "subscriptions", "insurance", "taxes"];
    const fixedChargeBreakdown = fixedCategoryIds.map((category) => {
      const plan = categoryPlans[category];
      const sources = [
        { basis: "budget", amount: settings.budgets[category] || 0 },
        { basis: "history", amount: plan.historicalAverage },
        { basis: "configured", amount: plan.recurringExpected },
      ].sort((left, right) => right.amount - left.amount);
      return {
        category,
        amount: sources[0].amount,
        basis: sources[0].basis,
        current: plan.spent,
        historicalMedian: plan.historicalAverage,
        configured: plan.recurringExpected,
        contracts: detectedRecurring.filter((item) => item.category === category).slice(0, 8),
      };
    }).filter(({ amount }) => amount > 0);
    const fixedCosts = round(fixedChargeBreakdown.reduce((total, item) => total + item.amount, 0));
    const flexibleLimit = primaryEnvelope?.recommendedFunding || Math.floor(median(history.map(({ expenses: value }) => value)) * 0.25 / 10) * 10;
    const savingsRoom = round(Math.max(0, income - fixedCosts - flexibleLimit));
    const recommendedSavings = settings.savingsGoal ? round(Math.min(settings.savingsGoal, savingsRoom)) : Math.floor(Math.min(income * 0.1, savingsRoom) / 10) * 10;
    const monthlyPlan = {
      income: round(income),
      fixedCosts,
      flexibleLimit,
      flexibleAccount: primaryEnvelope?.name || "Dépenses courantes",
      safetyBuffer,
      recommendedSavings,
      unallocated: round(Math.max(0, income - fixedCosts - flexibleLimit - recommendedSavings)),
      fixedChargeBreakdown,
      categoryLimits: Object.fromEntries(FINANCE_CATEGORIES.map((category) => {
        const plan = categoryPlans[category.id];
        const envelopeTarget = primaryEnvelope?.recommendedCategoryLimits[category.id];
        if (!fixedCategoryIds.includes(category.id) && envelopeTarget !== undefined) return [category.id, envelopeTarget];
        const historicalTarget = category.id === "other" ? 0 : plan.historicalAverage;
        const target = fixedCategoryIds.includes(category.id) ? Math.max(plan.recurringExpected, historicalTarget) : historicalTarget * 0.9;
        return [category.id, Math.ceil(target / 5) * 5];
      })),
    };
    const warnings = [];
    if (!income) warnings.push({ id: "income", tone: "info", title: "Salaire historique introuvable", detail: "Importe anciens relevés; salaire sera détecté automatiquement." });
    if (incomeSource === "history") warnings.push({ id: "income-estimate", tone: "info", title: "Salaire estimé", detail: `Base prudente sur ${incomeHistoryMonths} mois: ${inferredIncome.toFixed(2)} €.` });
    if (history.length < 2) warnings.push({ id: "history", tone: "info", title: "Projection provisoire", detail: "Importe 2 à 3 mois pour fiabiliser reste dépensable et épargne." });
    if (income > 0 && expenses > income) warnings.push({ id: "deficit", tone: "danger", title: "Mois déficitaire", detail: `${round(expenses - income).toFixed(2)} € au-dessus revenus.` });
    if (assets.unassignedSavings > 0) warnings.push({ id: "unassigned-savings", tone: "warning", title: "Versements épargne non rattachés", detail: `${assets.unassignedSavings.toFixed(2)} € placés ce mois sans actif correspondant. Ajoute le motif du virement sur l'actif concerné dans Budget · Modules.` });
    if (settings.savingsGoal > protectedSavings) warnings.push({ id: "savings", tone: "warning", title: "Objectif épargne trop haut", detail: `${protectedSavings.toFixed(2)} € soutenables selon dépenses et réserve actuelles.` });
    if (income > 0 && safeToSpend === 0) warnings.push({ id: "safe-spend", tone: "danger", title: "Pause dépenses libres", detail: "Revenus restants réservés aux charges, imprévus et épargne soutenable." });
    for (const envelope of spendingEnvelopes) {
      if (envelope.exceeded > 0) warnings.push({ id: `envelope-${envelope.id}`, tone: "danger", title: `${envelope.name} dépassée`, detail: `${envelope.exceeded.toFixed(2)} € au-dessus des virements reçus ce mois.` });
    }
    for (const category of FINANCE_CATEGORIES) {
      const budget = settings.budgets[category.id];
      const spent = round(spentByCategory[category.id]);
      if (categoryPlans[category.id].ambitious) warnings.push({ id: `realism-${category.id}`, tone: "info", title: `${category.label}: budget serré`, detail: `Historique médian ${categoryPlans[category.id].historicalAverage.toFixed(2)} € contre budget ${budget.toFixed(2)} €.` });
      if (!budget || spent < budget * 0.8) continue;
      const ratio = Math.round((spent / budget) * 100);
      warnings.push({ id: `budget-${category.id}`, tone: ratio >= 100 ? "danger" : "warning", title: `${category.label}: ${ratio}%`, detail: ratio >= 100 ? `Budget dépassé de ${round(spent - budget).toFixed(2)} €.` : `${round(budget - spent).toFixed(2)} € restants.` });
    }
    const recommendations = [];
    if (protectedSavings > 0) recommendations.push(`Épargne soutenable ce mois: ${protectedSavings.toFixed(2)} €, après charges et réserve.`);
    if (recommendedSavings > 0) recommendations.push(`Automatise ${recommendedSavings.toFixed(2)} € d’épargne dès réception du salaire; augmente seulement après trois mois sans déficit.`);
    if (primaryEnvelope?.recommendedFunding > 0) recommendations.push(`Vire ${primaryEnvelope.recommendedFunding.toFixed(2)} € vers ${primaryEnvelope.name} une fois par mois et fais-y passer toutes dépenses variables; aucun rechargement.`);
    if (!settings.safetyBuffer && automaticBuffer > 0) recommendations.push(`Coussin de sécurité conseillé: ${automaticBuffer.toFixed(2)} € à conserver disponible; ce n’est pas une charge mensuelle.`);
    if (emergencyTarget > 0 && assets.liquid < emergencyTarget) recommendations.push(`Fonds sécurité liquide: encore ${round(emergencyTarget - assets.liquid).toFixed(2)} € pour ${settings.emergencyMonths} mois essentiels. Actifs investis exclus de ce calcul.`);
    const largest = FINANCE_CATEGORIES.filter(({ id }) => !ESSENTIAL_CATEGORY_IDS.has(id)).map((category) => ({ ...category, spent: spentByCategory[category.id] })).sort((a, b) => b.spent - a.spent)[0];
    if (largest?.spent > 0) recommendations.push(`Premier levier à vérifier: ${largest.label.toLowerCase()} (${largest.spent.toFixed(2)} €).`);
    return {
      month: selectedMonth,
      income: round(income),
      recordedIncome,
      recordedSalary,
      inferredIncome,
      incomeSource,
      incomeHistoryMonths,
      expenses,
      savingsCapacity,
      savingsRate,
      afterGoal: round(savingsCapacity - settings.savingsGoal),
      safeToSpend,
      dailyAllowance,
      daysRemaining,
      futureEssentialExpenses,
      safetyBuffer,
      safetyBufferAutomatic: settings.safetyBuffer === 0,
      protectedSavings,
      sustainableSavings,
      cashAfterReserves: freeCash,
      flexibleBudgetRemaining,
      flexibleBudgetApplied: flexibleBudgetCount > 0,
      projectedExpenses,
      remainingPlannedExpenses: round(Math.max(0, projectedExpenses - expenses)),
      projectedSavings,
      forecastSurplusAfterBuffer,
      dataConfidence,
      historyMonths: history.length,
      categoryPlans,
      budgetTotal,
      spentByCategory,
      recurringByCategory,
      emergencyTarget,
      assets,
      spendingEnvelopes,
      detectedRecurring,
      monthlyPlan,
      excludedTransactionCount: allTransactions.filter((transaction) => transaction.date.startsWith(selectedMonth) && classifications.has(transaction.id)).length,
      warnings,
      recommendations,
      transactionCount: transactions.length,
    };
  }

  payload(month) {
    const selectedMonth = validMonth(month);
    const modules = this.modules();
    const allTransactions = applyCategoryModules(this.transactions(), modules);
    const classifications = classifyTransactions(allTransactions, modules);
    return {
      settings: this.settings(),
      summary: this.summary(selectedMonth),
      transactions: allTransactions.filter((transaction) => transaction.date.startsWith(selectedMonth)).map((transaction) => classifications.has(transaction.id)
        ? { ...transaction, excluded: true, exclusionReason: classifications.get(transaction.id) }
        : transaction),
      categories: FINANCE_CATEGORIES,
      modules: this.modules(),
      recurring: this.recurring(),
      agent: { history: this.agentHistory() },
      classification: {
        bankTransactions: allTransactions.filter(({ source }) => source === "enable-banking").length,
        categorizedByCodex: allTransactions.filter(({ source, categorySource }) => source === "enable-banking" && categorySource === "codex").length,
        lastCategorizedAt: allTransactions.filter(({ categorizedAt }) => categorizedAt).map(({ categorizedAt }) => categorizedAt).sort().at(-1) || null,
      },
      banking: {
        aggregator: { id: "enable-banking", name: "Enable Banking", configured: this.aggregatorConfigured },
        banks: [
          { id: "boursobank", name: "BoursoBank", access: "DSP2 via agrégateur" },
          { id: "banxo", name: "Banxo · Caisse d’Épargne", access: "DSP2 BPCE via agrégateur" },
          { id: "revolut", name: "Revolut", access: "Open Banking via agrégateur" },
        ],
      },
    };
  }
}
