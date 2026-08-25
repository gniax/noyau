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
const ESSENTIAL_CATEGORY_IDS = new Set(["housing", "food", "transport", "subscriptions", "health"]);
const PACED_CATEGORY_IDS = new Set(["food", "transport", "shopping", "health", "leisure", "other"]);
const SALARY_PATTERN = /salaire|salary|payroll|remuneration|traitement|fiche de paie|virement employeur/;
const DEFAULT_SETTINGS = {
  savingsGoal: 0,
  currentSavings: 0,
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

function aggregate(items) {
  const spentByCategory = Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, 0]));
  let expenses = 0;
  let recordedIncome = 0;
  for (const transaction of items) {
    if (transaction.amount < 0) {
      const amount = Math.abs(transaction.amount);
      expenses += amount;
      if (spentByCategory[transaction.category] !== undefined) spentByCategory[transaction.category] += amount;
    } else {
      recordedIncome += transaction.amount;
    }
  }
  for (const id of CATEGORY_IDS) spentByCategory[id] = round(spentByCategory[id]);
  return { expenses: round(expenses), recordedIncome: round(recordedIncome), spentByCategory };
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function categoryForDescription(description) {
  const value = normalized(description);
  if (/loyer|credit immobilier|electricite|edf|engie|gaz|eau|assurance habitation/.test(value)) return "housing";
  if (/courses|alimentation|restaurant|repas/.test(value)) return "food";
  if (/transport|train|sncf|metro|essence|parking/.test(value)) return "transport";
  if (/abonnement|netflix|spotify|canva|adobe|telephone|internet/.test(value)) return "subscriptions";
  if (/sante|mutuelle|medecin|pharmacie/.test(value)) return "health";
  if (/loisir|cinema|sport|jeu/.test(value)) return "leisure";
  return "other";
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
  constructor({ store, aggregatorConfigured = false, now = () => new Date() } = {}) {
    this.store = store;
    this.aggregatorConfigured = aggregatorConfigured;
    this.now = now;
  }

  setAggregatorConfigured(value) {
    this.aggregatorConfigured = Boolean(value);
  }

  settings() {
    const saved = this.store.get("settings") || {};
    const { monthlyIncome: _ignored, ...stored } = saved;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      budgets: { ...DEFAULT_SETTINGS.budgets, ...(saved.budgets || {}) },
    };
  }

  transactions() {
    return Object.entries(this.store.all())
      .filter(([id, value]) => id.startsWith("transaction-") && value?.type === "transaction")
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  }

  recurring() {
    return Object.entries(this.store.all())
      .filter(([id, value]) => id.startsWith("recurring-") && value?.type === "recurring")
      .map(([id, value]) => ({ id, ...value }))
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.description.localeCompare(b.description));
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
    const id = `recurring-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const rule = {
      type: "recurring",
      description,
      amount,
      category,
      startDate,
      endDate: null,
      dayOfMonth,
      account: String(input.account || "Prévision").trim().slice(0, 60) || "Prévision",
      createdAt: new Date().toISOString(),
    };
    await this.store.set(id, rule);
    return { id, ...rule };
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
      const updated = { ...this.store.get(current.id), amount: nextAmount, startDate: date, dayOfMonth: Number(date.slice(8, 10)), updatedAt: new Date().toISOString() };
      await this.store.set(current.id, updated);
      return { previous: null, current: { id: current.id, ...updated } };
    }
    await this.store.set(current.id, { ...this.store.get(current.id), endDate: previousDate(date), updatedAt: new Date().toISOString() });
    const replacement = await this.addRecurring({ ...current, amount: nextAmount, startDate: date, dayOfMonth: Number(date.slice(8, 10)) });
    return { previous: current, current: replacement };
  }

  async removeRecurring(id) {
    if (!/^recurring-[a-z0-9-]+$/.test(id) || !this.store.get(id)) throw new Error("Charge récurrente introuvable.");
    await this.store.remove(id);
  }

  async recordAgentMessage(role, content) {
    const id = `finance-agent-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    await this.store.set(id, { type: "finance-agent-message", role, content: String(content).slice(0, 1000), createdAt: new Date().toISOString() });
  }

  async financeAgent(message, month) {
    const content = String(message || "").trim().slice(0, 1000);
    if (!content) throw new Error("Message requis.");
    const selectedMonth = validMonth(month);
    await this.recordAgentMessage("user", content);
    const value = normalized(content);
    const changeAmount = value.match(/(?:passe|passera|sera)\s+a\s+(\d+(?:[.,]\d{1,2})?)/);
    const paymentAmount = value.match(/(?:paye|paie|verse)\s+(\d+(?:[.,]\d{1,2})?)/);
    const euroAmount = value.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:euros?|eur)\b/);
    const amount = Number((changeAmount?.[1] || paymentAmount?.[1] || euroAmount?.[1] || "").replace(",", ".")) || null;
    let reply;
    let action = "answer";
    const effectiveDate = frenchDate(content, this.now());
    const change = value.match(/(?:a partir du\s+\d{1,2}(?:er)?\s+[a-z]+(?:\s+\d{4})?\s+)(?:le |la |mon |ma )?(.+?)\s+(?:passe|passera|sera)\s+a\s+\d/);
    if (change && amount && effectiveDate) {
      const result = await this.changeRecurring({ match: change[1], amount, effectiveDate });
      reply = `${result.current.description}: ${result.current.amount.toFixed(2)} € par mois dès le ${effectiveDate}. Ancienne période conservée dans prévisions.`;
      action = "recurring-changed";
    } else if (/chaque mois|tous les mois|mensuel/.test(value) && amount) {
      const amountToken = paymentAmount?.[1] || euroAmount?.[1];
      const amountIndex = value.indexOf(amountToken);
      let description = value.slice(amountIndex + amountToken.length).replace(/^\s*(?:euros?|eur)?\s*(?:de|pour le|pour la|pour)?\s*/, "").replace(/\s+a partir du\s+.*$/, "").trim();
      if (!description) description = value.match(/(?:paye|paie|verse)\s+(.+?)\s+\d/)?.[1] || "charge mensuelle";
      const startDate = effectiveDate || this.now().toISOString().slice(0, 10);
      const statedDay = value.match(/(?:chaque mois|tous les mois).*?\ble\s+(\d{1,2})\b/)?.[1];
      const rule = await this.addRecurring({ description, amount, startDate, dayOfMonth: statedDay ? Number(statedDay) : 1 });
      reply = `${rule.description}: ${rule.amount.toFixed(2)} € ajoutés chaque mois, catégorie ${FINANCE_CATEGORIES.find(({ id }) => id === rule.category)?.label}.`;
      action = "recurring-added";
    } else if (/liste|charges|prelevements|recurrent/.test(value)) {
      const active = this.recurring().filter(({ endDate }) => !endDate);
      reply = active.length ? active.map((rule) => `${rule.description}: ${rule.amount.toFixed(2)} € le ${rule.dayOfMonth}`).join("\n") : "Aucune charge mensuelle enregistrée.";
    } else if (/combien|depenser|epargner|reste/.test(value)) {
      const summary = this.summary(selectedMonth);
      reply = `Reste dépensable prudent: ${summary.safeToSpend.toFixed(2)} €. Épargne soutenable: ${summary.protectedSavings.toFixed(2)} €. Réserve imprévus: ${summary.safetyBuffer.toFixed(2)} €.`;
    } else {
      reply = "Commande non comprise. Exemple: « Chaque mois je paye 950 euros de loyer » ou « À partir du 1er janvier le loyer passe à 1200 euros ».";
    }
    await this.recordAgentMessage("assistant", reply);
    return { reply, action, recurring: this.recurring(), history: this.agentHistory(), summary: this.summary(selectedMonth) };
  }

  async updateSettings(input = {}) {
    const current = this.settings();
    const next = {
      savingsGoal: input.savingsGoal === undefined ? current.savingsGoal : money(input.savingsGoal, "Objectif épargne"),
      currentSavings: input.currentSavings === undefined ? current.currentSavings : money(input.currentSavings, "Épargne actuelle"),
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

  async removeTransaction(id) {
    if (!/^transaction-[a-z0-9-]+$/.test(id) || !this.store.get(id)) throw new Error("Opération introuvable.");
    await this.store.remove(id);
  }

  async importTransactions(items = []) {
    const entries = [];
    let imported = 0;
    let updated = 0;
    for (const item of items) {
      const kind = item.kind === "income" ? "income" : item.kind === "expense" ? "expense" : null;
      if (!kind || !item.externalId || !item.sourceAccount) continue;
      const absoluteAmount = money(item.amount, "Montant importé");
      if (!absoluteAmount) continue;
      const category = kind === "income" ? "income" : CATEGORY_IDS.has(item.category) ? item.category : "other";
      const date = validDate(item.date);
      const key = crypto.createHash("sha256").update(`${item.source}:${item.sourceAccount}:${item.externalId}`).digest("hex").slice(0, 32);
      const id = `transaction-bank-${key}`;
      const existing = this.store.get(id);
      const transaction = {
        type: "transaction",
        kind,
        amount: kind === "expense" ? -absoluteAmount : absoluteAmount,
        description: String(item.description || "Opération bancaire").trim().slice(0, 120) || "Opération bancaire",
        category,
        date,
        account: String(item.account || "Compte bancaire").trim().slice(0, 60) || "Compte bancaire",
        source: String(item.source || "bank").slice(0, 40),
        externalId: String(item.externalId).slice(0, 500),
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
    const allTransactions = this.transactions();
    const transactions = allTransactions.filter((transaction) => transaction.date.startsWith(selectedMonth));
    const { expenses, recordedIncome, spentByCategory } = aggregate(transactions);
    const budgetTotal = round(Object.values(settings.budgets).reduce((total, value) => total + value, 0));
    const history = [-1, -2, -3]
      .map((offset) => {
        const historyMonth = shiftMonth(selectedMonth, offset);
        const historyTransactions = allTransactions.filter((transaction) => transaction.date.startsWith(historyMonth));
        return { month: historyMonth, expenseCount: historyTransactions.filter(({ amount }) => amount < 0).length, ...aggregate(historyTransactions) };
      })
      .filter(({ expenseCount }) => expenseCount > 0);
    const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
    const monthFirst = `${selectedMonth}-01`;
    const monthLast = `${selectedMonth}-${String(new Date(Date.UTC(selectedYear, selectedMonthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
    const recurringByCategory = Object.fromEntries(FINANCE_CATEGORIES.map(({ id }) => [id, 0]));
    for (const rule of this.recurring()) {
      if (rule.startDate > monthLast || (rule.endDate && rule.endDate < monthFirst)) continue;
      recurringByCategory[rule.category] = round((recurringByCategory[rule.category] || 0) + rule.amount);
    }
    const now = this.now();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const incomeHistory = [-1, -2, -3, -4, -5, -6]
      .map((offset) => {
        const historyMonth = shiftMonth(selectedMonth, offset);
        const incoming = allTransactions.filter((transaction) => transaction.date.startsWith(historyMonth) && transaction.amount > 0);
        const salary = round(incoming.filter((transaction) => SALARY_PATTERN.test(normalized(transaction.description))).reduce((total, transaction) => total + transaction.amount, 0));
        const total = round(incoming.reduce((sum, transaction) => sum + transaction.amount, 0));
        return { month: historyMonth, salary, total };
      })
      .filter(({ total }) => total > 0);
    const explicitSalaryHistory = incomeHistory.filter(({ salary }) => salary > 0);
    const inferredIncome = median((explicitSalaryHistory.length ? explicitSalaryHistory : incomeHistory).map(({ salary, total }) => salary || total));
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
        else if (historicalAverage) projected = Math.max(spent, round(historicalAverage * 0.7 + paceProjection * 0.3));
        else if (budget) projected = Math.max(spent, budget);
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
    const warnings = [];
    if (!income) warnings.push({ id: "income", tone: "info", title: "Salaire historique introuvable", detail: "Importe anciens relevés; salaire sera détecté automatiquement." });
    if (incomeSource === "history") warnings.push({ id: "income-estimate", tone: "info", title: "Salaire estimé", detail: `Médiane automatique de ${incomeHistoryMonths} mois: ${inferredIncome.toFixed(2)} €.` });
    if (history.length < 2) warnings.push({ id: "history", tone: "info", title: "Projection provisoire", detail: "Importe 2 à 3 mois pour fiabiliser reste dépensable et épargne." });
    if (income > 0 && expenses > income) warnings.push({ id: "deficit", tone: "danger", title: "Mois déficitaire", detail: `${round(expenses - income).toFixed(2)} € au-dessus revenus.` });
    if (settings.savingsGoal > protectedSavings) warnings.push({ id: "savings", tone: "warning", title: "Objectif épargne trop haut", detail: `${protectedSavings.toFixed(2)} € soutenables selon dépenses et réserve actuelles.` });
    if (income > 0 && safeToSpend === 0) warnings.push({ id: "safe-spend", tone: "danger", title: "Pause dépenses libres", detail: "Revenus restants réservés aux charges, imprévus et épargne soutenable." });
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
    if (!settings.safetyBuffer && automaticBuffer > 0) recommendations.push(`Réserve imprévus automatique: ${automaticBuffer.toFixed(2)} €. Ajustable dans plan mensuel.`);
    if (emergencyTarget > 0 && settings.currentSavings < emergencyTarget) recommendations.push(`Fonds sécurité: encore ${round(emergencyTarget - settings.currentSavings).toFixed(2)} € pour ${settings.emergencyMonths} mois essentiels.`);
    const largest = FINANCE_CATEGORIES.filter(({ id }) => !ESSENTIAL_CATEGORY_IDS.has(id)).map((category) => ({ ...category, spent: spentByCategory[category.id] })).sort((a, b) => b.spent - a.spent)[0];
    if (largest?.spent > 0) recommendations.push(`Premier levier à vérifier: ${largest.label.toLowerCase()} (${largest.spent.toFixed(2)} €).`);
    return {
      month: selectedMonth,
      income: round(income),
      recordedIncome,
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
      projectedSavings,
      forecastSurplusAfterBuffer,
      dataConfidence,
      historyMonths: history.length,
      categoryPlans,
      budgetTotal,
      spentByCategory,
      recurringByCategory,
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
      recurring: this.recurring(),
      agent: { history: this.agentHistory() },
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
