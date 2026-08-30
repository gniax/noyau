import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractAntigravityMessages, extractClaudeMessages, extractCodexMessages, formatHandover, HandoverService } from "../server/handover.js";

const antigravityConversationId = "00000000-0000-4000-8000-000000000001";

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

test("Antigravity transcript drops failed handover noise", () => {
  const lines = [
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Corrige le script\n</USER_REQUEST><ADDITIONAL_METADATA>date</ADDITIONAL_METADATA>" },
    { type: "PLANNER_RESPONSE", source: "MODEL", content: "Script corrigé et testé." },
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Prépare passation vers Codex. Réponds uniquement avec récapitulatif.</USER_REQUEST>" },
    { type: "ERROR_MESSAGE", source: "SYSTEM", content: "Individual quota reached." },
  ].map((item) => JSON.stringify(item)).join("\n");
  assert.deepEqual(extractAntigravityMessages(lines), [
    { role: "user", text: "Corrige le script" },
    { role: "assistant", text: "Script corrigé et testé." },
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

test("handover service resolves Antigravity workspace history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-antigravity-handover-"));
  const cwd = "/workspace/marketing";
  const logDir = path.join(root, "brain", antigravityConversationId, ".system_generated", "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(root, "history.jsonl"), `${JSON.stringify({ workspace: cwd, conversationId: antigravityConversationId, timestamp: 42 })}\n`);
  await fs.writeFile(path.join(logDir, "transcript_full.jsonl"), [
    { type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Continue ici</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", source: "MODEL", content: "Travail prêt." },
  ].map((item) => JSON.stringify(item)).join("\n"));

  const service = new HandoverService({ antigravityRoot: root });
  assert.deepEqual(await service.messages({ assistant: "antigravity", cwd }), [
    { role: "user", text: "Continue ici" },
    { role: "assistant", text: "Travail prêt." },
  ]);
  await fs.rm(root, { recursive: true, force: true });
});
