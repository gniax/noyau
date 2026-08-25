import crypto from "node:crypto";

export const FINANCE_CATEGORIES = [
  { id: "housing", label: "Logement" },
  { id: "food", label: "Alimentation" },
  { id: "transport", label: "Transport" },
  { id: "subscriptions", label: "Abonnements" },
  { id: "shopping", label: "Achats" },
  { id: "health", label: "Santé" },
  { id: "leisure", label: "Loisirs" },
  { id: "other", label: "Autres" },
];

const CATEGORY_IDS = new Set(FINANCE_CATEGORIES.map(({ id }) => id));
const DEFAULT_SETTINGS = {
  monthlyIncome: 0,
  savingsGoal: 0,
  currentSavings: 0,
  emergencyMonths: 3,
  budgets: Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, 0])),
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

export class FinanceService {
  constructor({ store, aggregatorConfigured = false } = {}) {
    this.store = store;
    this.aggregatorConfigured = aggregatorConfigured;
  }

  settings() {
    const saved = this.store.get("settings") || {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      budgets: { ...DEFAULT_SETTINGS.budgets, ...(saved.budgets || {}) },
    };
  }

  transactions() {
    return Object.entries(this.store.all())
      .filter(([id, value]) => id.startsWith("transaction-") && value?.type === "transaction")
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }

  async updateSettings(input = {}) {
    const current = this.settings();
    const next = {
      monthlyIncome: input.monthlyIncome === undefined ? current.monthlyIncome : money(input.monthlyIncome, "Revenu mensuel"),
      savingsGoal: input.savingsGoal === undefined ? current.savingsGoal : money(input.savingsGoal, "Objectif épargne"),
      currentSavings: input.currentSavings === undefined ? current.currentSavings : money(input.currentSavings, "Épargne actuelle"),
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

  async removeTransaction(id) {
    if (!/^transaction-[a-z0-9-]+$/.test(id) || !this.store.get(id)) throw new Error("Opération introuvable.");
    await this.store.remove(id);
  }

  summary(month) {
    const selectedMonth = validMonth(month);
    const settings = this.settings();
    const transactions = this.transactions().filter((transaction) => transaction.date.startsWith(selectedMonth));
    const spentByCategory = Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, 0]));
    let expenses = 0;
    let recordedIncome = 0;
    for (const transaction of transactions) {
      if (transaction.amount < 0) {
        const amount = Math.abs(transaction.amount);
        expenses += amount;
        if (spentByCategory[transaction.category] !== undefined) spentByCategory[transaction.category] += amount;
      } else {
        recordedIncome += transaction.amount;
      }
    }
    expenses = round(expenses);
    recordedIncome = round(recordedIncome);
    const income = recordedIncome || settings.monthlyIncome;
    const savingsCapacity = round(income - expenses);
    const savingsRate = income > 0 ? Math.round((savingsCapacity / income) * 100) : 0;
    const budgetTotal = round(Object.values(settings.budgets).reduce((total, value) => total + value, 0));
    const essentialBase = round(["housing", "food", "transport", "health"].reduce((total, id) => total + Math.max(settings.budgets[id], spentByCategory[id]), 0));
    const emergencyTarget = round(essentialBase * settings.emergencyMonths);
    const warnings = [];
    if (!income) warnings.push({ id: "income", tone: "info", title: "Revenu manquant", detail: "Renseigne revenu mensuel pour calculer capacité épargne." });
    if (income > 0 && expenses > income) warnings.push({ id: "deficit", tone: "danger", title: "Mois déficitaire", detail: `${round(expenses - income).toFixed(2)} € au-dessus revenus.` });
    if (settings.savingsGoal > 0 && savingsCapacity < settings.savingsGoal) warnings.push({ id: "savings", tone: "warning", title: "Objectif épargne menacé", detail: `${Math.max(0, round(settings.savingsGoal - savingsCapacity)).toFixed(2)} € à récupérer.` });
    for (const category of FINANCE_CATEGORIES) {
      const budget = settings.budgets[category.id];
      const spent = round(spentByCategory[category.id]);
      spentByCategory[category.id] = spent;
      if (!budget || spent < budget * 0.8) continue;
      const ratio = Math.round((spent / budget) * 100);
      warnings.push({ id: `budget-${category.id}`, tone: ratio >= 100 ? "danger" : "warning", title: `${category.label}: ${ratio}%`, detail: ratio >= 100 ? `Budget dépassé de ${round(spent - budget).toFixed(2)} €.` : `${round(budget - spent).toFixed(2)} € restants.` });
    }
    const recommendations = [];
    if (income > 0 && settings.savingsGoal === 0) recommendations.push(`Tester objectif automatique de ${round(income * 0.1).toFixed(2)} € (10% revenus).`);
    if (settings.savingsGoal > 0 && savingsCapacity >= settings.savingsGoal) recommendations.push(`Programmer virement de ${settings.savingsGoal.toFixed(2)} € juste après revenu.`);
    if (emergencyTarget > 0 && settings.currentSavings < emergencyTarget) recommendations.push(`Fonds sécurité: encore ${round(emergencyTarget - settings.currentSavings).toFixed(2)} € pour ${settings.emergencyMonths} mois essentiels.`);
    const largest = FINANCE_CATEGORIES.map((category) => ({ ...category, spent: spentByCategory[category.id] })).sort((a, b) => b.spent - a.spent)[0];
    if (largest?.spent > 0) recommendations.push(`Premier levier à vérifier: ${largest.label.toLowerCase()} (${largest.spent.toFixed(2)} €).`);
    return {
      month: selectedMonth,
      income: round(income),
      recordedIncome,
      expenses,
      savingsCapacity,
      savingsRate,
      afterGoal: round(savingsCapacity - settings.savingsGoal),
      budgetTotal,
      spentByCategory,
      emergencyTarget,
      warnings,
      recommendations,
      transactionCount: transactions.length,
    };
  }

  payload(month) {
    const selectedMonth = validMonth(month);
    return {
      settings: this.settings(),
      summary: this.summary(selectedMonth),
      transactions: this.transactions().filter((transaction) => transaction.date.startsWith(selectedMonth)),
      categories: FINANCE_CATEGORIES,
      banking: {
        aggregator: { id: "gocardless", name: "GoCardless Bank Account Data", configured: this.aggregatorConfigured },
        banks: [
          { id: "boursobank", name: "BoursoBank", access: "DSP2 via agrégateur" },
          { id: "banxo", name: "Banxo · Caisse d’Épargne", access: "DSP2 BPCE via agrégateur" },
          { id: "revolut", name: "Revolut", access: "Open Banking via agrégateur" },
        ],
      },
    };
  }
}
