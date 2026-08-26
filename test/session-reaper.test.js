import test from "node:test";
import assert from "node:assert/strict";
import { SessionReaper } from "../server/session-reaper.js";

function harness({ entries, live, migrating = () => false }) {
  const state = new Map(Object.entries(entries));
  let clock = 1_000;
  const reaper = new SessionReaper({
    tmux: { list: async () => live().map((id) => ({ id })) },
    store: { get: (id) => state.get(id) || null, remove: async (id) => state.delete(id) },
    isMigrating: migrating,
    graceMs: 20_000,
    now: () => clock,
  });
  return { reaper, state, advance: (ms) => { clock += ms; } };
}

test("an agent that exits on its own is removed after the grace delay", async () => {
  let live = ["noyau-claude-1"];
  const { reaper, state, advance } = harness({ entries: { "noyau-claude-1": { autoRestore: true } }, live: () => live });

  assert.deepEqual(await reaper.tick(), []);
  live = [];
  assert.deepEqual(await reaper.tick(), []);
  advance(21_000);
  assert.deepEqual(await reaper.tick(), ["noyau-claude-1"]);
  assert.equal(state.has("noyau-claude-1"), false);
});

test("a switch or permission restart never removes the agent", async () => {
  let live = ["noyau-codex-1", "noyau-codex-2"];
  const { reaper, state, advance } = harness({
    entries: { "noyau-codex-1": { migrationState: "summarizing" }, "noyau-codex-2": { permissionRestartPending: true } },
    live: () => live,
    migrating: (id) => id === "noyau-codex-1",
  });

  await reaper.tick();
  live = [];
  await reaper.tick();
  advance(60_000);
  assert.deepEqual(await reaper.tick(), []);
  assert.equal(state.size, 2);
});

test("agents never seen alive survive so a reboot can restore them", async () => {
  const { reaper, state, advance } = harness({ entries: { "noyau-claude-9": { autoRestore: true } }, live: () => [] });

  await reaper.tick();
  advance(120_000);
  assert.deepEqual(await reaper.tick(), []);
  assert.equal(state.size, 1);
});

test("a tmux failure never removes anything", async () => {
  const reaper = new SessionReaper({
    tmux: { list: async () => { throw new Error("no server running"); } },
    store: { get: () => ({}), remove: async () => { throw new Error("should not remove"); } },
  });
  assert.deepEqual(await reaper.tick(), []);
});
