import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractClaudeMessages, extractCodexMessages, formatHandover, HandoverService } from "../server/handover.js";

const codexLines = [
  { payload: { type: "message", role: "user", content: [{ type: "input_text", text: "corrige le bouton Esc" }] } },
  { payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<turn_aborted>\nignored\n</turn_aborted>" }] } },
  { payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Correctif   appliqué\nsur iOS" }] } },
].map((item) => JSON.stringify(item)).join("\n");

const claudeLines = [
  { type: "user", message: { role: "user", content: "relance le déploiement" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Service redémarré." }, { type: "tool_use", name: "Bash" }] } },
  { type: "summary", summary: "ignored" },
].map((item) => JSON.stringify(item)).join("\n");

test("Codex transcript keeps user and assistant turns only", () => {
  assert.deepEqual(extractCodexMessages(codexLines), [
    { role: "user", text: "corrige le bouton Esc" },
    { role: "assistant", text: "Correctif appliqué sur iOS" },
  ]);
});

test("Claude transcript keeps text blocks only", () => {
  assert.deepEqual(extractClaudeMessages(claudeLines), [
    { role: "user", text: "relance le déploiement" },
    { role: "assistant", text: "Service redémarré." },
  ]);
});

test("handover prompt names both agents and lists history", () => {
  const prompt = formatHandover({ source: "codex", target: "claude", cwd: "/home/user/app", messages: [{ role: "user", text: "fais X" }] });
  assert.match(prompt, /Tu es Claude et tu reprends le travail d'un agent Codex dans \/home\/user\/app\./);
  assert.match(prompt, /\[utilisateur\] fais X/);
});

test("handover service reads the latest conversation of a workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-handover-"));
  const codexRoot = path.join(root, "codex");
  const claudeRoot = path.join(root, "claude");
  await fs.mkdir(path.join(codexRoot, "2026", "08"), { recursive: true });
  await fs.mkdir(path.join(claudeRoot, "-home-user-app"), { recursive: true });
  await fs.writeFile(path.join(codexRoot, "2026", "08", "rollout-old.jsonl"), `{"payload":{"cwd":"/home/user/other"}}\n${codexLines}`);
  await fs.writeFile(path.join(codexRoot, "2026", "08", "rollout-new.jsonl"), `{"payload":{"cwd":"/home/user/app"}}\n${codexLines}`);
  await fs.writeFile(path.join(claudeRoot, "-home-user-app", "abc.jsonl"), claudeLines);
  const service = new HandoverService({ codexRoot, claudeRoot });

  const codexPrompt = await service.prompt({ assistant: "codex", target: "claude", cwd: "/home/user/app" });
  assert.match(codexPrompt, /corrige le bouton Esc/);

  const claudePrompt = await service.prompt({ assistant: "claude", target: "codex", cwd: "/home/user/app" });
  assert.match(claudePrompt, /Service redémarré\./);

  assert.equal(await service.prompt({ assistant: "codex", target: "claude", cwd: "/home/user/missing" }), null);
  await fs.rm(root, { recursive: true, force: true });
});
