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
    name: "Meridian",
    assistant: "codex",
    cwd: "/path/to/meridian",
    projectId: "proj-1",
    profileId: "principal",
    threadId: "thread-abc",
  }, { reason: "closed" });

  await service.archive("noyau-claude-2", {
    name: "Atlas",
    assistant: "claude",
    cwd: "/path/to/atlas",
    projectId: "proj-2",
    profileId: "guest",
    agentSessionId: "session-xyz",
    shared: true,
  }, { reason: "manual" });

  const listAll = await service.list();
  assert.equal(listAll.length, 2);
  assert.equal(listAll[0].id, "noyau-claude-2"); // newest first
  assert.equal(listAll[1].id, "noyau-codex-1");

  const listPrincipal = await service.list({ profileId: "principal" });
  assert.equal(listPrincipal.length, 2); // includes the primary profile and the shared guest one

  const listInvité = await service.list({ profileId: "guest" });
  assert.equal(listInvité.length, 1); // includes only guest

  const entry = await service.get("noyau-codex-1");
  assert.equal(entry.name, "Meridian");
  assert.equal(entry.threadId, "thread-abc");
  assert.equal(entry.reason, "closed");

  const removed = await service.remove("noyau-codex-1");
  assert.equal(removed, true);
  const remaining = await service.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "noyau-claude-2");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("AgentArchiveService restores an archived agent via tmux", async () => {
  const service = new AgentArchiveService();
  await service.archive("noyau-codex-old", {
    name: "Meridian",
    assistant: "codex",
    cwd: "/path/to/meridian",
    projectId: "proj-1",
    profileId: "principal",
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

  const restored = await service.restore("noyau-codex-old", { tmux: mockTmux, profileId: "principal" });
  assert.equal(restored.name, "Meridian");
  assert.equal(createdArgs.threadId, "thread-12345");
  assert.equal(createdArgs.yolo, true);

  const remaining = await service.list();
  assert.equal(remaining.length, 0); // removed upon restoration
});
