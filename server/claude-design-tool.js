import { spawn } from "node:child_process";
import path from "node:path";

const DESIGN_SYSTEM_PROMPT = "Tu es Claude Design. Traite la demande design/UI/UX/graphisme/images dans ce projet. Modifie ou génère les fichiers directement si nécessaire, puis résume clairement tes actions et les fichiers créés ou modifiés.";

export class ClaudeDesignTool {
  constructor({ claudeBinary = "claude", store = null, projects = null, workspaceRoot = process.cwd(), timeout = 10 * 60_000, spawnFn = spawn } = {}) {
    this.claudeBinary = claudeBinary;
    this.store = store;
    this.projects = projects;
    this.workspaceRoot = workspaceRoot;
    this.timeout = timeout;
    this.spawnFn = spawnFn;
  }

  resolveCwd(callerSessionId, requestedCwd = null) {
    if (requestedCwd) return path.resolve(requestedCwd);
    if (callerSessionId && this.store) {
      const caller = this.store.get(callerSessionId);
      if (caller?.cwd) return path.resolve(caller.cwd);
      if (caller?.projectId && this.projects) {
        const project = this.projects.get(caller.projectId);
        if (project?.rootPath) return path.resolve(project.rootPath);
      }
    }
    return path.resolve(this.workspaceRoot);
  }

  async run({ callerSessionId = null, cwd = null, prompt }) {
    const task = String(prompt || "").trim().slice(0, 50_000);
    if (!task) throw new Error("Demande Claude Design requise.");
    const targetCwd = this.resolveCwd(callerSessionId, cwd);

    const fullPrompt = `${DESIGN_SYSTEM_PROMPT}\n\nDemande:\n${task}`;
    const reply = await new Promise((resolve, reject) => {
      const args = ["-p", "--dangerously-skip-permissions", "--output-format", "text"];
      const child = this.spawnFn(this.claudeBinary, args, {
        cwd: targetCwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let errorOutput = "";
      child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(0, 500_000); });
      child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-8000); });
      child.on("error", reject);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude Design : délai dépassé (10 min)."));
      }, this.timeout);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`Claude Design (${code}): ${errorOutput.trim() || "échec d'exécution"}`));
        resolve(output.trim());
      });
      child.stdin.end(fullPrompt);
    });

    if (!reply) throw new Error("Claude Design : réponse vide.");
    return { prompt: task, response: reply, cwd: targetCwd, success: true };
  }
}

