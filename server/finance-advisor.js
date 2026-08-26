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

function extractJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : String(text)).trim();
  const start = raw.search(/[[{]/);
  return start > 0 ? raw.slice(start) : raw;
}

export class FinanceAdvisor {
  constructor({ binary = "codex", claudeBinary = "claude", cwd, timeout = 120_000, pickProvider = async () => "codex" } = {}) {
    this.binary = binary;
    this.claudeBinary = claudeBinary;
    this.cwd = cwd;
    this.timeout = timeout;
    this.pickProvider = pickProvider;
    this.lastProvider = null;
  }

  // Un fournisseur peut etre a sec: on prend celui qui a du quota, et on bascule si l'appel echoue.
  async run(prompt, schema = null) {
    const preferred = await Promise.resolve(this.pickProvider()).catch(() => "codex");
    const order = preferred === "claude" ? ["claude", "codex"] : ["codex", "claude"];
    let lastError = null;
    for (const provider of order) {
      if (provider === "claude" && !this.claudeBinary) continue;
      if (provider === "codex" && !this.binary) continue;
      try {
        const reply = provider === "claude" ? await this.runClaude(prompt, schema) : await this.runCodex(prompt, schema);
        this.lastProvider = provider;
        return reply;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Aucun agent finances disponible.");
  }

  async runClaude(prompt, schema = null) {
    const full = schema
      ? `${prompt}\n\nRéponds uniquement avec un JSON valide conforme à ce schéma, sans texte autour:\n${JSON.stringify(schema)}`
      : prompt;
    const reply = await new Promise((resolve, reject) => {
      const child = spawn(this.claudeBinary, ["-p", "--output-format", "text"], { cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let errorOutput = "";
      child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(0, 200_000); });
      child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-4000); });
      child.on("error", reject);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude finance: délai dépassé."));
      }, this.timeout);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`Claude finance (${code}): ${errorOutput.trim() || "échec sans détail"}`));
        resolve(output.trim());
      });
      child.stdin.end(full);
    });
    if (!reply) throw new Error("Claude finance: réponse vide.");
    return schema ? extractJson(reply) : reply.slice(0, 5000);
  }

  async runCodex(prompt, schema = null) {
    const output = path.join(os.tmpdir(), `noyau-finance-${crypto.randomBytes(8).toString("hex")}.txt`);
    const schemaFile = schema ? path.join(os.tmpdir(), `noyau-finance-schema-${crypto.randomBytes(8).toString("hex")}.json`) : null;
    if (schemaFile) await fs.writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-c", "notify=[]", "--output-last-message", output];
        if (schemaFile) args.push("--output-schema", schemaFile);
        args.push("-C", this.cwd, "-");
        const child = spawn(this.binary, args, {
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
      const reply = (await fs.readFile(output, "utf8")).trim().slice(0, schema ? 100_000 : 5000);
      if (!reply) throw new Error("Codex finance: réponse vide.");
      return reply;
    } finally {
      await fs.rm(output, { force: true }).catch(() => {});
      if (schemaFile) await fs.rm(schemaFile, { force: true }).catch(() => {});
    }
  }

  async answer({ message, month, payload, history = [], action = null }) {
    const prompt = [
      "Tu es Agent finances de Noyau, vrai agent conversationnel Codex.",
      "Réponds en français, directement, clairement, en texte brut sans Markdown, avec montants exacts. Distingue toujours dépenses réelles, dépenses prévues, solde bancaire actuel et estimation.",
      "Explique calculs avec catégories responsables. Ne donne pas de conseil financier certain. Ne lance aucun outil: réponds uniquement depuis snapshot fourni.",
      "Dates carte ont déjà été corrigées vers date achat. Doublons carte, transferts internes, placements et Corporate Card sont exclus du budget personnel.",
      "Trésorerie disponible = comptes courants + actifs liquides. Les actifs investis (PEA, assurance vie, compte titres) restent bloqués: jamais comptés comme argent disponible.",
      "Projection mois courant: catégories essentielles utilisent maximum entre réel, budget, médiane historique, charge récurrente et rythme courant; catégories libres sans budget utilisent seulement rythme courant. 'Autres' ne réinjecte plus ancien historique.",
      action ? `Action locale déjà validée/exécutée: ${action}` : "Aucune action locale exécutée pour ce message.",
      `Mois demandé: ${month}`,
      `Conversation récente: ${JSON.stringify(history.filter(({ content }) => !String(content).startsWith("Commande non comprise.")).slice(-20).map(({ role, content }) => ({ role, content })))}`,
      `Snapshot financier local: ${JSON.stringify(compactPayload(payload))}`,
      `Message utilisateur: ${message}`,
    ].join("\n\n");
    return this.run(prompt);
  }

  async insights({ month, payload }) {
    const schema = {
      type: "object",
      properties: {
        headline: { type: "string" },
        insights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              detail: { type: "string" },
              impact: { type: "string", enum: ["haut", "moyen", "bas"] },
              action: { type: "string" },
              amount: { type: "number" },
            },
            required: ["title", "detail", "impact", "action", "amount"],
            additionalProperties: false,
          },
        },
      },
      required: ["headline", "insights"],
      additionalProperties: false,
    };
    const prompt = [
      "Tu es analyste budget personnel. Tu reçois un snapshot financier réel et tu produis des conseils concrets, chiffrés et actionnables.",
      "Interdits: généralités ('surveille tes dépenses'), conseils d'investissement, promesses de rendement, jugements moraux.",
      "Chaque conseil cite un montant réel du snapshot, la catégorie ou le contrat concerné, et une action précise réalisable ce mois.",
      "Compare le mois courant à l'historique fourni. Signale dérives, contrats redondants, charges en hausse, marges de manœuvre.",
      "Trésorerie disponible = soldes des comptes courants + actifs bucket liquid. Les actifs bucket invested (PEA, assurance vie, compte titres) ne sont jamais de l'argent disponible: ne les compte pas comme réserve mobilisable et ne conseille pas de les vendre.",
      "Classe par impact décroissant, 3 à 6 conseils, en français, texte brut sans Markdown. amount = euros concernés par le conseil.",
      `Mois analysé: ${month}`,
      `Snapshot financier local: ${JSON.stringify(compactPayload(payload))}`,
    ].join("\n\n");
    const parsed = JSON.parse(await this.run(prompt, schema));
    return {
      headline: String(parsed.headline || "").slice(0, 300),
      insights: (parsed.insights || []).slice(0, 6).map((item) => ({
        title: String(item.title || "").slice(0, 120),
        detail: String(item.detail || "").slice(0, 600),
        impact: ["haut", "moyen", "bas"].includes(item.impact) ? item.impact : "moyen",
        action: String(item.action || "").slice(0, 300),
        amount: Number.isFinite(Number(item.amount)) ? Math.round(Number(item.amount) * 100) / 100 : null,
      })),
    };
  }

  async classify(groups, categories) {
    const allowed = ["income", ...categories.map(({ id }) => id)];
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              category: { type: "string", enum: allowed },
              recurring: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["id", "category", "recurring", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    };
    const results = [];
    for (let index = 0; index < groups.length; index += 20) {
      const batch = groups.slice(index, index + 20);
      const prompt = [
        "Tu classes opérations bancaires françaises. Retour JSON selon schéma, exactement une sortie par id. Aucun outil.",
        `Catégories: ${JSON.stringify(categories)}. income = salaire/vrai revenu/don reçu. Crédit AVOIR/REM/remboursement reprend catégorie achat, jamais income.`,
        "Abonnements inclut offres bancaires/cartes, télécom, logiciels, salles de sport et services mensuels. Frais bancaires = commissions/agios ponctuels. Virement externe = argent envoyé à tiers. Autres seulement si impossible.",
        "recurring=true si répétition mensuelle observée ou contrat/prélèvement vraisemblablement récurrent. Utilise mois/count/net mensuel fournis.",
        `Groupes: ${JSON.stringify(batch)}`,
      ].join("\n\n");
      const parsed = JSON.parse(await this.run(prompt, schema));
      results.push(...parsed.items);
    }
    return results;
  }
}
