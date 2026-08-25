import assert from "node:assert/strict";
import test from "node:test";
import { FinanceService } from "./finance-service.js";

class MemoryStore {
  constructor() { this.data = {}; }
  get(id) { return this.data[id] || null; }
  all() { return this.data; }
  async set(id, value) { this.data[id] = value; }
  async setMany(entries) { for (const [id, value] of entries) this.data[id] = value; }
  async remove(id) { delete this.data[id]; }
}

test("finance summary computes savings and budget warnings", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  await service.updateSettings({ savingsGoal: 500, liquidSavings: 1000, emergencyMonths: 3, budgets: { food: 400 } });
  await service.addTransaction({ kind: "income", amount: 2500, description: "Salaire", date: "2026-07-28" });
  await service.addTransaction({ kind: "expense", amount: 350, description: "Courses", category: "food", date: "2026-08-10" });
  await service.addTransaction({ kind: "expense", amount: 800, description: "Loyer", category: "housing", date: "2026-08-02" });

  const summary = service.summary("2026-08");
  assert.equal(summary.income, 2500);
  assert.equal(summary.incomeSource, "history");
  assert.equal(summary.inferredIncome, 2500);
  assert.equal(summary.expenses, 1150);
  assert.equal(summary.savingsCapacity, 1350);
  assert.equal(summary.savingsRate, 54);
  assert.equal(summary.safeToSpend, 641);
  assert.equal(summary.futureEssentialExpenses, 84);
  assert.equal(summary.safetyBuffer, 125);
  assert.equal(summary.protectedSavings, 500);
  assert.equal(summary.spentByCategory.food, 350);
  assert.equal(summary.warnings.find(({ id }) => id === "budget-food")?.tone, "warning");
});

test("finance plan caps savings and free spending from real history", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-20T12:00:00Z") });
  await service.updateSettings({ savingsGoal: 1000, safetyBuffer: 200, budgets: { housing: 1000, food: 450, leisure: 300 } });
  for (const month of ["05", "06", "07"]) {
    await service.addTransaction({ kind: "income", amount: 3000, description: "Virement salaire", date: `2026-${month}-01` });
    await service.addTransaction({ kind: "expense", amount: 1000, description: "Loyer", category: "housing", date: `2026-${month}-02` });
    await service.addTransaction({ kind: "expense", amount: 400, description: "Courses", category: "food", date: `2026-${month}-12` });
    await service.addTransaction({ kind: "expense", amount: 600, description: "Sorties", category: "leisure", date: `2026-${month}-18` });
  }
  await service.addTransaction({ kind: "expense", amount: 1000, description: "Loyer", category: "housing", date: "2026-08-02" });
  await service.addTransaction({ kind: "expense", amount: 200, description: "Courses", category: "food", date: "2026-08-15" });

  const summary = service.summary("2026-08");
  assert.equal(summary.historyMonths, 3);
  assert.equal(summary.dataConfidence, "high");
  assert.equal(summary.protectedSavings, 800);
  assert.equal(summary.safeToSpend, 300);
  assert.equal(summary.categoryPlans.leisure.historicalAverage, 600);
  assert.equal(summary.warnings.find(({ id }) => id === "savings")?.title, "Objectif épargne trop haut");
  assert.equal(summary.warnings.find(({ id }) => id === "realism-leisure")?.tone, "info");
});

test("finance service rejects unsafe transaction input", async () => {
  const service = new FinanceService({ store: new MemoryStore() });
  await assert.rejects(() => service.addTransaction({ kind: "expense", amount: -10, description: "Test", category: "food", date: "2026-08-10" }), /Montant invalide/);
  await assert.rejects(() => service.addTransaction({ kind: "expense", amount: 10, description: "Test", category: "unknown", date: "2026-08-10" }), /Catégorie invalide/);
  await assert.rejects(() => service.addTransaction({ kind: "expense", amount: 10, description: "", category: "food", date: "2026-08-10" }), /Description requise/);
});

test("finance agent records recurring charge and future amount change", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  await service.updateSettings({ safetyBuffer: 150 });
  await service.addTransaction({ kind: "income", amount: 2500, description: "Salaire", date: "2026-07-28" });
  const added = await service.financeAgent("Chaque mois je paye 950,25 euros de loyer", "2026-08");
  assert.equal(added.action, "recurring-added");
  assert.equal(added.recurring[0].description, "loyer");
  assert.equal(added.recurring[0].dayOfMonth, 1);
  assert.equal(added.summary.recurringByCategory.housing, 950.25);
  assert.equal(added.summary.categoryPlans.housing.projected, 950.25);

  const changed = await service.financeAgent("À partir du 1er janvier le loyer passe à 1200", "2026-08");
  assert.equal(changed.action, "recurring-changed");
  assert.equal(changed.recurring.filter(({ endDate }) => !endDate)[0].amount, 1200);
  assert.equal(service.summary("2026-12").recurringByCategory.housing, 950.25);
  assert.equal(service.summary("2027-01").recurringByCategory.housing, 1200);
  assert.equal(service.agentHistory().length, 4);
});

test("bank transaction import is stable and updates duplicate", async () => {
  const service = new FinanceService({ store: new MemoryStore() });
  const transaction = { kind: "expense", amount: 42, description: "Courses", category: "food", date: "2026-08-24", account: "Banque", source: "enable-banking", sourceAccount: "account-1", externalId: "entry-1" };
  assert.deepEqual(await service.importTransactions([transaction]), { imported: 1, updated: 0 });
  assert.deepEqual(await service.importTransactions([{ ...transaction, description: "Courses corrigées" }]), { imported: 0, updated: 1 });
  assert.equal(service.transactions().length, 1);
  assert.equal(service.transactions()[0].description, "Courses corrigées");
});

test("bank analysis uses configurable assets, transfers, and spending envelope", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  await service.addModule({ moduleType: "asset", name: "Livret test", amount: 1800, bucket: "liquid", institution: "Banque A" });
  await service.addModule({ moduleType: "asset", name: "Placement test", amount: 6500, bucket: "invested", institution: "Banque B" });
  await service.addModule({ moduleType: "transfer", name: "Épargne salariale", transactionMatch: "AMUNDI ESR" });
  await service.addModule({ moduleType: "envelope", name: "Compte dépenses", accountMatch: "Revolut" });
  let entry = 0;
  async function bank({ kind, amount, description, date, account, category = "other" }) {
    entry += 1;
    await service.importTransactions([{ kind, amount, description, date, account, category, source: "enable-banking", sourceAccount: account, externalId: `entry-${entry}` }]);
  }
  await bank({ kind: "income", amount: 2598.04, description: "VIR SEPA Employeur France", date: "2026-05-27", account: "Banxo" });
  await bank({ kind: "income", amount: 2344.09, description: "VIR SEPA Employeur France", date: "2026-06-26", account: "Banxo" });
  await bank({ kind: "income", amount: 4051.2, description: "VIR SEPA Employeur France", date: "2026-07-27", account: "Banxo" });
  await bank({ kind: "income", amount: 4004.32, description: "VIR SEPA AMUNDI ESR", date: "2026-06-10", account: "Banxo" });
  await bank({ kind: "expense", amount: 600, description: "VIR SEPA MR TEST", date: "2026-08-07", account: "Banxo" });
  await bank({ kind: "income", amount: 600, description: "MR TEST", date: "2026-08-07", account: "Revolut" });
  await bank({ kind: "expense", amount: 616.24, description: "Dépenses courantes", date: "2026-08-20", account: "Revolut", category: "shopping" });
  await bank({ kind: "expense", amount: 25, description: "CARTE 17/08/26 Doctolib CB*4177", date: "2026-08-17", account: "Boursorama Banque · Compte courant", category: "health" });
  await bank({ kind: "expense", amount: 25, description: "CARTE 17/08/26 Doctolib", date: "2026-08-17", account: "Boursorama Banque · Carte Visa", category: "health" });

  const summary = service.summary("2026-08");
  assert.equal(summary.inferredIncome, 2598.04);
  assert.equal(summary.expenses, 641.24);
  assert.equal(summary.assets.liquid, 1800);
  assert.equal(summary.assets.invested, 6500);
  assert.equal(summary.assets.total, 8300);
  assert.equal(summary.assets.entries.length, 2);
  assert.deepEqual(summary.spendingEnvelopes.map(({ name, funded, spent, remaining, exceeded }) => ({ name, funded, spent, remaining, exceeded })), [{ name: "Compte dépenses", funded: 600, spent: 616.24, remaining: -16.24, exceeded: 16.24 }]);
  assert.equal(summary.excludedTransactionCount, 3);
  assert.equal(summary.warnings.find(({ id }) => id.startsWith("envelope-"))?.tone, "danger");
  assert.equal(service.payload("2026-08").transactions.filter(({ excluded }) => excluded).length, 3);
});

test("spending envelope splits one affordable limit by history", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  await service.addModule({ moduleType: "envelope", name: "Dépenses courantes", accountMatch: "Revolut" });
  let entry = 0;
  for (const month of ["05", "06", "07"]) {
    for (const item of [
      { amount: 400, description: "Courses", category: "food" },
      { amount: 100, description: "Achats", category: "shopping" },
    ]) {
      entry += 1;
      await service.importTransactions([{ kind: "expense", ...item, date: `2026-${month}-10`, account: "Revolut", source: "enable-banking", sourceAccount: "revolut", externalId: String(entry) }]);
    }
  }
  const summary = service.summary("2026-08");
  assert.equal(summary.monthlyPlan.flexibleLimit, 450);
  assert.equal(summary.monthlyPlan.categoryLimits.food, 360);
  assert.equal(summary.monthlyPlan.categoryLimits.shopping, 90);
  assert.match(summary.recommendations.find((item) => item.includes("Dépenses courantes")), /Vire 450\.00 €/);
});

test("known payment processor leaves uncategorized bucket", async () => {
  const service = new FinanceService({ store: new MemoryStore() });
  await service.importTransactions([{ kind: "expense", amount: 42, description: "PRLV PayPal Europe S.a.r.l.", category: "other", date: "2026-08-10", account: "Banque", source: "enable-banking", sourceAccount: "bank", externalId: "paypal" }]);
  const summary = service.summary("2026-08");
  assert.equal(summary.spentByCategory.shopping, 42);
  assert.equal(summary.spentByCategory.other, 0);
});

test("legacy values migrate into editable finance modules", async () => {
  const store = new MemoryStore();
  await store.set("settings", { liquidSavings: 1800, investedAssets: 6500, savingsGoal: 200 });
  await store.set("recurring-old", { type: "recurring", description: "Loyer", amount: 900, category: "housing", startDate: "2026-01-01", endDate: null, dayOfMonth: 1, account: "Prévision" });
  const service = new FinanceService({ store });
  await service.migrateLegacyModules();
  assert.equal(service.settings().savingsGoal, 200);
  assert.equal(service.modules().length, 3);
  assert.equal(service.recurring()[0].name, "Loyer");
  assert.equal(service.summary("2026-08").assets.total, 8300);
  assert.equal(store.get("recurring-old"), null);
  assert.equal(store.get("settings").liquidSavings, undefined);
});

test("self transfers and configured asset movements never become income or expense", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  await service.addModule({ moduleType: "asset", name: "Livret", amount: 1000, bucket: "liquid", transactionMatch: "VERSEMENT LIVRET, RETRAIT LIVRET" });
  const transactions = [
    { kind: "income", amount: 400, description: "VIR SEPA MR TEST PERSONNE", date: "2026-08-02", account: "Compte A" },
    { kind: "expense", amount: 400, description: "VIR SEPA MR TEST PERSONNE", date: "2026-08-03", account: "Compte B" },
    { kind: "expense", amount: 300, description: "VERSEMENT LIVRET", date: "2026-08-04", account: "Compte A" },
    { kind: "income", amount: 200, description: "RETRAIT LIVRET", date: "2026-08-05", account: "Compte A" },
  ];
  let index = 0;
  for (const transaction of transactions) {
    index += 1;
    await service.importTransactions([{ ...transaction, category: "other", source: "enable-banking", sourceAccount: transaction.account, externalId: String(index) }]);
  }
  const summary = service.summary("2026-08");
  assert.equal(summary.recordedIncome, 0);
  assert.equal(summary.expenses, 0);
  assert.equal(summary.excludedTransactionCount, 4);
});

test("recurring module recategorizes matching bank history immediately", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  await service.importTransactions([{ kind: "expense", amount: 900, description: "BAILLEUR EXEMPLE", category: "other", date: "2026-08-06", account: "Compte", source: "enable-banking", sourceAccount: "account", externalId: "rent" }]);
  assert.equal(service.summary("2026-08").spentByCategory.other, 900);
  await service.addModule({ moduleType: "recurring", name: "Loyer", amount: 900, category: "housing", startDate: "2026-01-06", dayOfMonth: 6, transactionMatch: "BAILLEUR EXEMPLE" });
  assert.equal(service.summary("2026-08").spentByCategory.housing, 900);
  assert.equal(service.summary("2026-08").spentByCategory.other, 0);
});

test("bank history uses purchase date and recategorizes existing other entries", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  const rows = [
    ["expense", 46.78, "CB DAC UEP VL FACT 310726", "transport", "2026-08-03", "travel"],
    ["expense", 124.59, "CARTE 22/08/26 L'OLIVIER ASSURA CB*4177", "insurance", "2026-08-24", "insurance"],
    ["expense", 199, "PRLV DIRECTION GENERALE DES FINANCES", "taxes", "2026-08-24", "tax"],
    ["expense", 31.98, "CB ALDI FRABL119 FACT 210826", "food", "2026-08-23", "food"],
  ];
  for (const [kind, amount, description, _category, date, externalId] of rows) {
    await service.importTransactions([{ kind, amount, description, category: "other", date, account: "Banque", source: "enable-banking", sourceAccount: "account", externalId }]);
  }

  const july = service.payload("2026-07");
  assert.equal(july.transactions[0].date, "2026-07-31");
  assert.equal(july.transactions[0].bookingDate, "2026-08-03");
  assert.equal(july.transactions[0].category, "transport");
  const august = service.payload("2026-08");
  assert.deepEqual(august.transactions.map(({ category }) => category).sort(), ["food", "insurance", "taxes"]);
  assert.equal(august.summary.spentByCategory.other, 0);
});

test("corporate card is excluded from personal spending", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  await service.importTransactions([{ kind: "expense", amount: 829.7, description: "PRLV SEPA BNP PARIBAS SA · CORPORATE CARD", category: "other", date: "2026-08-14", account: "Compte", source: "enable-banking", sourceAccount: "account", externalId: "corporate" }]);
  const payload = service.payload("2026-08");
  assert.equal(payload.summary.expenses, 0);
  assert.equal(payload.transactions[0].exclusionReason, "professionnel");
});

test("finance agent delegates free questions with budget context", async () => {
  let request;
  const service = new FinanceService({
    store: new MemoryStore(),
    now: () => new Date("2026-08-25T12:00:00Z"),
    advisor: async (value) => {
      request = value;
      return "Prévision expliquée par catégories.";
    },
  });
  const result = await service.financeAgent("Pourquoi ma dépense probable est élevée ?", "2026-08");
  assert.equal(result.reply, "Prévision expliquée par catégories.");
  assert.equal(request.month, "2026-08");
  assert.equal(request.message, "Pourquoi ma dépense probable est élevée ?");
  assert.equal(result.history.at(-1).role, "assistant");
});

test("current forecast does not replay old uncategorized spending", async () => {
  const service = new FinanceService({ store: new MemoryStore(), now: () => new Date("2026-08-25T12:00:00Z") });
  for (const month of ["05", "06", "07"]) {
    await service.addTransaction({ kind: "expense", amount: 1000, description: "Dépense historique inconnue", category: "other", date: `2026-${month}-10` });
  }
  await service.addTransaction({ kind: "expense", amount: 100, description: "Dépense actuelle inconnue", category: "other", date: "2026-08-10" });
  const plan = service.summary("2026-08").categoryPlans.other;
  assert.equal(plan.historicalAverage, 1000);
  assert.equal(plan.projected, 124);
  assert.equal(plan.remaining, 24);
});

test("Codex categories persist and refunds reduce recurring subscription cost", async () => {
  const store = new MemoryStore();
  const service = new FinanceService({
    store,
    now: () => new Date("2026-08-25T12:00:00Z"),
    classifier: async (groups) => groups.map(({ id }) => ({ id, category: "subscriptions", recurring: true, reason: "Offre bancaire mensuelle avec remise" })),
  });
  let entry = 0;
  for (const month of ["06", "07", "08"]) {
    for (const item of [
      { kind: "expense", amount: 33.1, description: "* OFFRE CONFORT" },
      { kind: "income", amount: 25.15, description: "* REM OFFRE CONFORT" },
    ]) {
      entry += 1;
      await service.importTransactions([{ ...item, category: item.kind === "income" ? "income" : "other", date: `2026-${month}-16`, account: "Banque", source: "enable-banking", sourceAccount: "account", externalId: String(entry) }]);
    }
  }
  assert.deepEqual(await service.categorizeTransactions({ force: true }), { categorized: 6, groups: 1 });
  const summary = service.summary("2026-08");
  assert.equal(summary.expenses, 7.95);
  assert.equal(summary.recordedIncome, 0);
  assert.equal(summary.spentByCategory.subscriptions, 7.95);
  assert.equal(summary.detectedRecurring[0].monthlyNet, 7.95);
  const saved = service.transactions()[0];
  assert.equal(saved.categorySource, "codex");
  await service.importTransactions([{ kind: saved.kind, amount: Math.abs(saved.amount), description: saved.description, category: "income", date: saved.date, account: saved.account, source: "enable-banking", sourceAccount: "account", externalId: saved.externalId }]);
  assert.equal(service.transactions()[0].category, "subscriptions");
});

test("Codex categorization saves completed batches before failure", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const service = new FinanceService({
    store,
    classifier: async (groups) => {
      calls += 1;
      if (calls === 2) throw new Error("Codex finance: délai dépassé.");
      return groups.map(({ id }) => ({ id, category: "food", recurring: false, reason: "Commerce alimentaire" }));
    },
  });
  for (let index = 0; index < 21; index += 1) {
    await service.importTransactions([{ kind: "expense", amount: 10, description: `COMMERCE ${index}`, category: "other", date: "2026-08-01", account: "Banque", source: "enable-banking", sourceAccount: "account", externalId: String(index) }]);
  }
  await assert.rejects(service.categorizeTransactions({ force: true }), /délai dépassé/);
  assert.equal(service.transactions().filter(({ categorySource }) => categorySource === "codex").length, 20);
  calls = 0;
  await service.categorizeTransactions();
  assert.equal(service.transactions().filter(({ categorySource }) => categorySource === "codex").length, 21);
});
