import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextAudit, auditProposals, parseUsage, projectSlug } from "./context-audit.js";

const usageOf = (lines) => parseUsage(lines.join("\n"));

test("les appels d'outils et de skills se lisent dans la transcription", () => {
  const usage = usageOf([
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"caveman:caveman"}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_stripe_stripe__list","input":{}}]}}',
    '{"type":"user","message":{"content":"pas un appel"}}',
  ]);
  assert.equal(usage.tools.Bash, 1);
  assert.equal(usage.skills["caveman:caveman"], 1);
  assert.equal(usage.tools.mcp__plugin_stripe_stripe__list, 1);
});

test("seul ce qui n'a jamais servi est proposé au retrait", () => {
  const usage = usageOf([
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"caveman:caveman"}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__plugin_stripe_stripe__charges","input":{}}]}}',
  ]);
  const proposals = auditProposals({
    plugins: [
      { name: "caveman@caveman", shortName: "caveman", skills: [{ name: "caveman", weight: 400 }], servers: [] },
      { name: "stripe@official", shortName: "stripe", skills: [{ name: "stripe-docs", weight: 400 }], servers: ["stripe"] },
      { name: "frontend@official", shortName: "frontend", skills: [{ name: "frontend-design", weight: 800 }], servers: [] },
    ],
    skills: [
      { name: "noyau-agents", plugin: null, weight: 600 },
      { name: "octanix-knowledge", plugin: null, weight: 400, hidden: true },
    ],
    servers: [{ name: "gmail" }],
    usage,
  });

  const ids = proposals.map((item) => item.id);
  // Plugin et serveur MCP utilises: intouchables. Skill deja masque: rien a proposer.
  assert.ok(!ids.includes("plugin:caveman@caveman"));
  assert.ok(!ids.includes("plugin:stripe@official"));
  assert.ok(!ids.includes("skill:octanix-knowledge"));
  assert.deepEqual(ids.sort(), ["mcp:gmail", "plugin:frontend@official", "skill:noyau-agents"]);
  assert.equal(proposals.find((item) => item.id === "mcp:gmail").risk, "medium");
});

test("le dossier de travail donne le nom du répertoire de transcriptions", () => {
  assert.equal(projectSlug("/home/user/projects/noyau"), "-home-user-projects-noyau");
});

test("appliquer puis annuler laisse le fichier de réglages comme avant", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-audit-"));
  const audit = new ContextAudit({ homeDir: cwd });
  const file = path.join(cwd, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2), "utf8");

  const catalog = [
    { id: "plugin:stripe@official", kind: "plugin", target: "stripe@official", label: "stripe", savedTokens: 900 },
    { id: "skill:noyau-agents", kind: "skill", target: "noyau-agents", label: "noyau-agents", savedTokens: 150 },
    { id: "mcp:gmail", kind: "mcp", target: "gmail", label: "gmail", savedTokens: 400 },
  ];

  const applied = await audit.apply(cwd, ["plugin:stripe@official", "skill:noyau-agents", "mcp:gmail"], catalog);
  assert.equal(applied.savedTokens, 1450);
  const written = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(written.enabledPlugins["stripe@official"], false);
  assert.equal(written.skillOverrides["noyau-agents"].visibility, "hidden");
  assert.deepEqual(written.disabledMcpjsonServers, ["gmail"]);
  // Les reglages voisins ne bougent pas.
  assert.deepEqual(written.permissions.allow, ["Bash(ls:*)"]);

  await audit.revert(cwd);
  const restored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(restored, { permissions: { allow: ["Bash(ls:*)"] } });
  await assert.rejects(() => audit.revert(cwd), /Aucune optimisation/);
  await fs.rm(cwd, { recursive: true, force: true });
});

test("le modèle local peut protéger un élément sans rien décider d'autre", async () => {
  const audit = new ContextAudit({
    homeDir: "/tmp/noyau-home",
    localLlm: { chat: async () => '{"garder":["mcp:gmail"],"raisons":{"mcp:gmail":"Sert aux rappels."}}' },
  });
  const reviewed = await audit.review([
    { id: "mcp:gmail", label: "gmail", detail: "", savedTokens: 400, reason: "Jamais appelé." },
    { id: "skill:vieux", label: "vieux", detail: "", savedTokens: 100, reason: "Jamais appelé." },
  ]);
  assert.equal(reviewed[0].advised, false);
  assert.equal(reviewed[0].reason, "Sert aux rappels.");
  assert.equal(reviewed[1].advised, true);
});

test("l'allègement d'un agent n'écrit que dans son propre fichier", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-audit-"));
  const audit = new ContextAudit({ homeDir: cwd });
  const projectFile = path.join(cwd, ".claude", "settings.local.json");
  await fs.mkdir(path.dirname(projectFile), { recursive: true });
  await fs.writeFile(projectFile, JSON.stringify({ enabledPlugins: { "stripe@official": true } }, null, 2), "utf8");
  const agentFile = path.join(cwd, "agent-settings", "noyau-claude-1.json");

  const catalog = [{ id: "plugin:stripe@official", kind: "plugin", target: "stripe@official", label: "stripe", savedTokens: 900 }];
  await audit.apply(cwd, ["plugin:stripe@official"], catalog, agentFile);

  assert.equal(JSON.parse(await fs.readFile(agentFile, "utf8")).enabledPlugins["stripe@official"], false);
  // Le dossier reste intact: un autre agent du meme projet garde ses outils.
  assert.equal(JSON.parse(await fs.readFile(projectFile, "utf8")).enabledPlugins["stripe@official"], true);

  await audit.revert(cwd, agentFile);
  await assert.rejects(() => fs.readFile(agentFile, "utf8"), /ENOENT/);
  await fs.rm(cwd, { recursive: true, force: true });
});
