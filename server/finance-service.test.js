import assert from "node:assert/strict";
import test from "node:test";
import { FinanceService } from "./finance-service.js";

class MemoryStore {
  constructor() { this.data = {}; }
  get(id) { return this.data[id] || null; }
  all() { return this.data; }
  async set(id, value) { this.data[id] = value; }
  async remove(id) { delete this.data[id]; }
}

test("finance summary computes savings and budget warnings", async () => {
  const service = new FinanceService({ store: new MemoryStore() });
  await service.updateSettings({ monthlyIncome: 2500, savingsGoal: 500, currentSavings: 1000, emergencyMonths: 3, budgets: { food: 400 } });
  await service.addTransaction({ kind: "expense", amount: 350, description: "Courses", category: "food", date: "2026-08-10" });
  await service.addTransaction({ kind: "expense", amount: 800, description: "Loyer", category: "housing", date: "2026-08-02" });

  const summary = service.summary("2026-08");
  assert.equal(summary.income, 2500);
  assert.equal(summary.expenses, 1150);
  assert.equal(summary.savingsCapacity, 1350);
  assert.equal(summary.savingsRate, 54);
  assert.equal(summary.spentByCategory.food, 350);
  assert.equal(summary.warnings.find(({ id }) => id === "budget-food")?.tone, "warning");
});

test("finance service rejects unsafe transaction input", async () => {
  const service = new FinanceService({ store: new MemoryStore() });
  await assert.rejects(() => service.addTransaction({ kind: "expense", amount: -10, description: "Test", category: "food", date: "2026-08-10" }), /Montant invalide/);
  await assert.rejects(() => service.addTransaction({ kind: "expense", amount: 10, description: "Test", category: "unknown", date: "2026-08-10" }), /Catégorie invalide/);
  await assert.rejects(() => service.addTransaction({ kind: "expense", amount: 10, description: "", category: "food", date: "2026-08-10" }), /Description requise/);
});
