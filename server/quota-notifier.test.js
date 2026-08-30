import assert from "node:assert/strict";
import test from "node:test";
import { QuotaNotifier } from "./quota-notifier.js";

class MemoryStore {
  constructor(data = {}) { this.data = data; }
  all() { return this.data; }
  get(id) { return this.data[id] || null; }
  async set(id, value) { this.data[id] = value; }
}

test("QuotaNotifier tracks exhausted quota and notifies when reset time is reached", async () => {
  let clock = 1_000_000;
  const sent = [];
  const push = {
    send: async (payload, profileId) => {
      sent.push({ payload, profileId });
      return 1;
    },
  };
  const providerState = new MemoryStore({
    claude: {
      fiveHour: { remainingPercent: 0, resetsAt: new Date(1_000_000 + 60_000).toISOString() },
    },
  });
  const profileService = {
    list: () => [
      { id: "principal", name: "Noyau", quotaResetNotify: { claude: true, codex: true, antigravity: false } },
    ],
  };

  const notifier = new QuotaNotifier({
    push,
    providerState,
    profileService,
    now: () => clock,
  });

  // First check arms the reset tracker
  await notifier.check();
  assert.equal(sent.length, 0);

  // Time passes but reset not reached yet
  clock += 30_000;
  await notifier.check();
  assert.equal(sent.length, 0);

  // Time reaches reset time
  clock += 30_001;
  const result = await notifier.check();
  assert.equal(result, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent.at(-1).payload.title, "Claude · Quota renouvelé");
  assert.equal(sent.at(-1).profileId, "principal");

  // Subsequent check should not re-notify for the same reset
  await notifier.check();
  assert.equal(sent.length, 1);
});

test("QuotaNotifier respects profile opt-out for specific models", async () => {
  let clock = 1_000_000;
  const sent = [];
  const push = {
    send: async (payload, profileId) => {
      sent.push({ payload, profileId });
      return 1;
    },
  };
  const providerState = new MemoryStore({
    codex: {
      windows: [{ label: "5h", remainingPercent: 10, resetsAt: new Date(1_000_000 + 10_000).toISOString() }],
    },
  });
  const profileService = {
    list: () => [
      { id: "principal", name: "Noyau", quotaResetNotify: { claude: true, codex: false, antigravity: false } },
    ],
  };

  const notifier = new QuotaNotifier({
    push,
    providerState,
    profileService,
    now: () => clock,
  });

  await notifier.check();
  clock += 15_000;
  const result = await notifier.check();
  assert.equal(result, 0);
  assert.equal(sent.length, 0);
});

test("QuotaNotifier re-arms when quota drops low again with a new reset time", async () => {
  let clock = 1_000_000;
  const sent = [];
  const push = {
    send: async (payload, profileId) => {
      sent.push({ payload, profileId });
      return 1;
    },
  };
  const providerState = new MemoryStore({
    claude: {
      fiveHour: { remainingPercent: 0, resetsAt: new Date(1_000_000 + 60_000).toISOString() },
    },
  });
  const profileService = {
    list: () => [
      { id: "principal", name: "Noyau", quotaResetNotify: { claude: true, codex: true, antigravity: false } },
    ],
  };

  const notifier = new QuotaNotifier({
    push,
    providerState,
    profileService,
    now: () => clock,
  });

  await notifier.check();
  clock += 60_001;
  await notifier.check();
  assert.equal(sent.length, 1);

  // New cycle: quota was used again and resets later
  await providerState.set("claude", {
    fiveHour: { remainingPercent: 5, resetsAt: new Date(clock + 120_000).toISOString() },
  });
  await notifier.check();
  assert.equal(sent.length, 1);

  clock += 120_001;
  await notifier.check();
  assert.equal(sent.length, 2);
});
