import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentArchiveService } from "./agent-archive-service.js";

test("AgentArchiveService archives, lists, filters by profile, and removes entries", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-archive-test-"));
  const archiveFile = path.join(tmpDir, "agent-archives.json");
  const service = new AgentArchiveService({ file: archiveFile });

  await service.archive("noyau-codex-1", {
    name: "Atlas",
    assistant: "codex",
    cwd: "/path/to/atlas",
    projectId: "proj-1",
    profileId: "main",
    threadId: "thread-abc",
  }, { reason: "closed" });

  await service.archive("noyau-claude-2", {
    name: "Octanix",
    assistant: "claude",
    cwd: "/path/to/octanix",
    projectId: "proj-2",
    profileId: "aurora",
    agentSessionId: "session-xyz",
    shared: true,
  }, { reason: "manual" });

  const listAll = await service.list();
  assert.equal(listAll.length, 2);
  assert.equal(listAll[0].id, "noyau-claude-2"); // newest first
  assert.equal(listAll[1].id, "noyau-codex-1");

  const listMain = await service.list({ profileId: "main" });
  assert.equal(listMain.length, 1); // les archives partagées restent privées au profil propriétaire

  const listAurora = await service.list({ profileId: "aurora" });
  assert.equal(listAurora.length, 1); // includes only aurora

  const entry = await service.get("noyau-codex-1");
  assert.equal(entry.name, "Atlas");
  assert.equal(entry.threadId, "thread-abc");
  assert.equal(entry.reason, "closed");

  const removed = await service.remove("noyau-codex-1");
  assert.equal(removed, true);
  const remaining = await service.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "noyau-claude-2");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("un profil ne peut pas restaurer une archive partagée d'un autre profil", async () => {
  const service = new AgentArchiveService();
  await service.archive("agent-owner", { profileId: "owner", shared: true, assistant: "codex" });
  let created = false;
  await assert.rejects(() => service.restore("agent-owner", {
    profileId: "visitor",
    tmux: { async create() { created = true; } },
  }), /Accès non autorisé/);
  assert.equal(created, false);
  assert.equal((await service.list({ profileId: "owner" })).length, 1);
});

test("AgentArchiveService restores an archived agent via tmux", async () => {
  const service = new AgentArchiveService();
  await service.archive("noyau-codex-old", {
    name: "Atlas",
    assistant: "codex",
    cwd: "/path/to/atlas",
    projectId: "proj-1",
    profileId: "main",
    threadId: "thread-12345",
    yolo: true,
  });

  let createdArgs = null;
  const mockTmux = {
    create: async (args) => {
      createdArgs = args;
      return { id: "noyau-codex-new", ...args };
    },
  };

  const restored = await service.restore("noyau-codex-old", { tmux: mockTmux, profileId: "main" });
  assert.equal(restored.name, "Atlas");
  assert.equal(createdArgs.threadId, "thread-12345");
  assert.equal(createdArgs.yolo, true);

  const remaining = await service.list();
  assert.equal(remaining.length, 0); // removed upon restoration
});
