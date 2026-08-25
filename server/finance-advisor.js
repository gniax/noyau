import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function compactPayload(payload) {
  const labels = Object.fromEntries(payload.categories.map(({ id, label }) => [id, label]));
  return {
    summary: payload.summary,
    settings: payload.settings,
    categories: payload.categories,
    modules: payload.modules.map(({ id: _id, createdAt: _created, updatedAt: _updated, ...module }) => module),
    transactions: payload.transactions.map(({ id: _id, createdAt: _created, updatedAt: _updated, externalId: _external, ...transaction }) => ({
      ...transaction,
      categoryLabel: labels[transaction.category] || transaction.category,
    })),
  };
}

export class FinanceAdvisor {
  constructor({ binary = "codex", cwd, timeout = 120_000 } = {}) {
    this.binary = binary;
    this.cwd = cwd;
    this.timeout = timeout;
  }

  async answer({ message, month, payload, history = [], action = null }) {
    const output = path.join(os.tmpdir(), `noyau-finance-${crypto.randomBytes(8).toString("hex")}.txt`);
    const prompt = [
      "Tu es Agent finances de Noyau, vrai agent conversationnel Codex.",
      "Réponds en français, directement, clairement, en texte brut sans Markdown, avec montants exacts. Distingue toujours dépenses réelles, dépenses prévues, solde bancaire actuel et estimation.",
      "Explique calculs avec catégories responsables. Ne donne pas de conseil financier certain. Ne lance aucun outil: réponds uniquement depuis snapshot fourni.",
      "Dates carte ont déjà été corrigées vers date achat. Doublons carte, transferts internes, placements et Corporate Card sont exclus du budget personnel.",
      "Projection mois courant: catégories essentielles utilisent maximum entre réel, budget, médiane historique, charge récurrente et rythme courant; catégories libres sans budget utilisent seulement rythme courant. 'Autres' ne réinjecte plus ancien historique.",
      action ? `Action locale déjà validée/exécutée: ${action}` : "Aucune action locale exécutée pour ce message.",
      `Mois demandé: ${month}`,
      `Conversation récente: ${JSON.stringify(history.filter(({ content }) => !String(content).startsWith("Commande non comprise.")).slice(-20).map(({ role, content }) => ({ role, content })))}`,
      `Snapshot financier local: ${JSON.stringify(compactPayload(payload))}`,
      `Message utilisateur: ${message}`,
    ].join("\n\n");
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(this.binary, ["exec", "--ephemeral", "--sandbox", "read-only", "--color", "never", "--output-last-message", output, "-C", this.cwd, "-"], {
          cwd: this.cwd,
          env: process.env,
          stdio: ["pipe", "ignore", "pipe"],
        });
        let errorOutput = "";
        child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-4000); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Codex finance (${code}): ${errorOutput.trim() || "échec sans détail"}`)));
        child.stdin.end(prompt);
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("Codex finance: délai dépassé."));
        }, this.timeout);
        child.on("close", () => clearTimeout(timer));
      });
      const reply = (await fs.readFile(output, "utf8")).trim().slice(0, 5000);
      if (!reply) throw new Error("Codex finance: réponse vide.");
      return reply;
    } finally {
      await fs.rm(output, { force: true }).catch(() => {});
    }
  }
}
