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
  await service.updateSettings({ monthlyIncome: 2500, savingsGoal: 500, currentSavings: 1000, emergencyMonths: 3, budgets: { food: 400 } });
  await service.addTransaction({ kind: "expense", amount: 350, description: "Courses", category: "food", date: "2026-08-10" });
  await service.addTransaction({ kind: "expense", amount: 800, description: "Loyer", category: "housing", date: "2026-08-02" });

  const summary = service.summary("2026-08");
  assert.equal(summary.income, 2500);
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
  await service.updateSettings({ monthlyIncome: 3000, savingsGoal: 1000, safetyBuffer: 200, budgets: { housing: 1000, food: 450, leisure: 300 } });
  for (const month of ["05", "06", "07"]) {
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
  await service.updateSettings({ monthlyIncome: 2500, safetyBuffer: 150 });
  const added = await service.financeAgent("Chaque mois je paye 950 euros de loyer", "2026-08");
  assert.equal(added.action, "recurring-added");
  assert.equal(added.recurring[0].description, "loyer");
  assert.equal(added.recurring[0].dayOfMonth, 1);
  assert.equal(added.summary.recurringByCategory.housing, 950);
  assert.equal(added.summary.categoryPlans.housing.projected, 950);

  const changed = await service.financeAgent("À partir du 1er janvier le loyer passe à 1200", "2026-08");
  assert.equal(changed.action, "recurring-changed");
  assert.equal(changed.recurring.filter(({ endDate }) => !endDate)[0].amount, 1200);
  assert.equal(service.summary("2026-12").recurringByCategory.housing, 950);
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
