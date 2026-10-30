import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentIdentity, initializeAgentIdentities } from "./agent-identity.js";
import { SessionStore } from "./session-store.js";
import { AgentCommunicationService } from "./agent-tools.js";

const old = "noyau-claude-mvnjtlij-8737";
const previous = "noyau-codex-mvprrm8m-d236";
const current = "noyau-claude-mvpsuv15-ca44";
const stable = "noyau-agent-mvpsuv15-ca44";

function fixture() {
  const entries = { [current]: { name: "Atlas", assistant: "claude", profileId: "owner", projectId: "p1", migratedFrom: previous, agentAliases: [old] } };
  const events = [];
  const store = {
    get: (id) => entries[id] || null,
    all: () => entries,
    set: async (id, value) => { entries[id] = value; },
    setMany: async (updates) => { for (const [id, value] of updates) entries[id] = value; },
  };
  const tmux = {
    list: async () => Object.entries(entries).map(([id, entry]) => ({ ...entry, id, managed: true, activityAt: "2026-10-27T10:00:00Z" })),
    captureVisible: async (id) => { events.push(["read", id]); return "prompt>"; },
    submit: async (id) => { events.push(["send", id]); },
    kill: async (id) => { events.push(["stop", id]); delete entries[id]; },
  };
  const projects = { get: (id) => id === "p1" ? { name: "Atlas", profileId: "owner" } : id === "p2" ? { name: "Noyau" } : null };
  const service = new AgentCommunicationService({ store, tmux, projects });
  return { entries, events, store, tmux, service };
}

test("legacy identities and aliases are persisted once and survive a store reload", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-identities-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SessionStore(path.join(directory, "sessions.json"));
  await store.set(current, { assistant: "claude", migratedFrom: previous, agentAliases: [old] });
  assert.equal(await initializeAgentIdentities(store), 1);
  assert.equal(await initializeAgentIdentities(store), 0);
  const reloaded = new SessionStore(store.file);
  await reloaded.load();
  assert.equal(reloaded.get(current).agentId, stable);
  assert.deepEqual(reloaded.get(current).agentAliases, [old, current, previous].sort());
});

test("identity reconstruction follows explicit history only, handles cycles and stops at profile boundaries", () => {
  const entries = {
    [old]: { profileId: "owner", migratedFrom: current },
    [previous]: { profileId: "owner", migratedFrom: old },
  };
  const store = { get: (id) => entries[id] };
  const identity = agentIdentity(current, { profileId: "owner", migratedFrom: previous }, store);
  assert.deepEqual(identity.agentAliases, [old, current, previous].sort());
  entries[previous].profileId = "other";
  assert.deepEqual(agentIdentity(current, { profileId: "owner", migratedFrom: previous }, store).agentAliases, [current]);
});

test("list exposes a stable provider-neutral ID, current engine and technical session separately", async () => {
  const { service, entries } = fixture();
  const [agent] = await service.list();
  assert.equal(agent.id, stable);
  assert.equal(agent.sessionId, current);
  assert.equal(agent.assistant, "claude");
  entries[current].assistant = "antigravity";
  assert.equal((await service.list())[0].id, stable);
  assert.equal((await service.list())[0].assistant, "antigravity");
});

test("send/read/assign/stop accept stable and historical IDs and target the current runtime", async () => {
  for (const query of [stable, old, previous, current]) {
    const { service, events, entries } = fixture();
    assert.equal((await service.resolve(query)).id, stable);
    assert.equal((await service.send(query, { message: "test", profileId: "owner" })).target.id, stable);
    assert.equal((await service.context(query, { profileId: "owner" })).agent.id, stable);
    await service.assignProject(query, "p2", { profileId: "owner" });
    assert.equal(entries[current].projectId, "p2");
    assert.equal((await service.stop(query, { profileId: "owner" })).stopped, stable);
    assert.deepEqual(events, [["send", current], ["read", current], ["stop", current]]);
  }
});

test("stale IDs cannot fall back to another agent's matching name, project or directory", async () => {
  const { entries, service, events } = fixture();
  const missing = "noyau-claude-missing-dead";
  entries[current].name = missing;
  await assert.rejects(service.send(missing, { message: "never deliver" }), /Agent introuvable/);
  assert.deepEqual(events, []);
});

test("aliases respect profile isolation, core protections and ambiguity checks", async () => {
  const { service, entries, events } = fixture();
  await assert.rejects(service.send(old, { message: "private", profileId: "visitor" }), /Aucun agent actif/);
  entries[current].core = true;
  await assert.rejects(service.stop(old, { profileId: "owner" }), /non supprimable/);
  entries["noyau-agent-another-beef"] = { ...entries[current], name: "Other", agentAliases: [old], migratedFrom: null };
  await assert.rejects(service.send(old, { message: "ambiguous" }), /Identifiant agent ambigu/);
  assert.deepEqual(events, []);
});

test("explicit historical alias repair is owner-only, persistent and refuses collisions", async () => {
  const { service, entries } = fixture();
  entries[current].agentAliases = [];
  const result = await service.addAlias(stable, old, { profileId: "owner" });
  assert.equal(result.id, stable);
  assert.equal((await service.resolve(old)).sessionId, current);
  entries[current].shared = true;
  await assert.rejects(service.addAlias(stable, "noyau-unknown", { profileId: "visitor" }), /Agent appartient/);
  entries[old] = { name: "Unrelated", profileId: "other" };
  await assert.rejects(service.addAlias(stable, old, { profileId: "owner" }), /déjà attribué/);
  await assert.rejects(service.addAlias(stable, "../invalid", { profileId: "owner" }), /Alias agent invalide/);
});
