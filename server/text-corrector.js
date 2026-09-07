import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function buildCorrectionPrompt(text, context = "todo") {
  const label = context === "comment" ? "d'un commentaire" : "d'une tâche to-do";
  return [
    `Tu es un correcteur orthographique et syntaxique en français pour le texte ${label}.`,
    "Ta mission : corriger les fautes d'orthographe, de grammaire, de ponctuation, les coquilles et fautes de frappe.",
    "Règles strictes :",
    "- Garde le sens exact, les termes techniques, URLs, identifiants, codes et noms de fichiers.",
    "- Garde un ton naturel, direct et concis. Ne reformule pas inutilement si c'est clair.",
    "- Réponds STRICTEMENT avec le texte corrigé uniquement, sans guillemets d'encadrement, sans explication, sans politesse.",
    "",
    `Texte à corriger :`,
    text,
  ].join("\n");
}

export function cleanCorrectedText(raw, fallback = "") {
  if (!raw || typeof raw !== "string") return fallback;
  let text = raw.trim();
  const fenced = text.match(/^```(?:text|markdown)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(?:voici le texte corrigé\s*:\s*|texte corrigé\s*:\s*|correction\s*:\s*)/i, "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("«") && text.endsWith("»")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text || fallback;
}

export class TextCorrector {
  constructor({ binary = "codex", claudeBinary = "claude", cwd = process.cwd(), timeout = 25_000, pickProvider = async () => "codex", spawnFn = spawn } = {}) {
    this.binary = binary;
    this.claudeBinary = claudeBinary;
    this.cwd = cwd;
    this.timeout = timeout;
    this.pickProvider = pickProvider;
    this.spawnFn = spawnFn;
    this.lastProvider = null;
  }

  async run(prompt) {
    const preferred = await Promise.resolve(this.pickProvider()).catch(() => "codex");
    const order = preferred === "claude" ? ["claude", "codex"] : ["codex", "claude"];
    let lastError = null;
    for (const provider of order) {
      if (provider === "claude" && !this.claudeBinary) continue;
      if (provider === "codex" && !this.binary) continue;
      try {
        const reply = provider === "claude" ? await this.runClaude(prompt) : await this.runCodex(prompt);
        this.lastProvider = provider;
        return reply;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Aucun LLM disponible pour la correction.");
  }

  async runClaude(prompt) {
    const reply = await new Promise((resolve, reject) => {
      const child = this.spawnFn(this.claudeBinary, ["-p", "--output-format", "text"], {
        cwd: this.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let errorOutput = "";
      child.stdout?.on("data", (chunk) => { output = `${output}${chunk}`.slice(0, 50_000); });
      child.stderr?.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-4000); });
      child.on("error", reject);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude corrector: délai dépassé."));
      }, this.timeout);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`Claude corrector (${code}): ${errorOutput.trim() || "échec sans détail"}`));
        resolve(output.trim());
      });
      child.stdin.end(prompt);
    });
    if (!reply) throw new Error("Claude corrector: réponse vide.");
    return reply.slice(0, 5000);
  }

  async runCodex(prompt) {
    const output = path.join(os.tmpdir(), `noyau-correct-${crypto.randomBytes(8).toString("hex")}.txt`);
    try {
      await new Promise((resolve, reject) => {
        const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--color", "never", "-c", "notify=[]", "--output-last-message", output, "-C", this.cwd, "-"];
        const child = this.spawnFn(this.binary, args, {
          cwd: this.cwd,
          env: process.env,
          stdio: ["pipe", "ignore", "pipe"],
        });
        let errorOutput = "";
        child.stderr?.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-4000); });
        child.on("error", reject);
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("Codex corrector: délai dépassé."));
        }, this.timeout);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Codex corrector (${code}): ${errorOutput.trim() || "échec sans détail"}`));
        });
        child.stdin.end(prompt);
      });
      const reply = (await fs.readFile(output, "utf8")).trim().slice(0, 5000);
      if (!reply) throw new Error("Codex corrector: réponse vide.");
      return reply;
    } finally {
      await fs.rm(output, { force: true }).catch(() => {});
    }
  }

  async correct(text, { context = "todo" } = {}) {
    const raw = String(text || "").trim();
    if (!raw) return text;
    try {
      const prompt = buildCorrectionPrompt(raw, context);
      const reply = await this.run(prompt);
      return cleanCorrectedText(reply, text);
    } catch {
      return text;
    }
  }
}
