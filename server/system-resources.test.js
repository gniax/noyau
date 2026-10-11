import test from "node:test";
import assert from "node:assert/strict";
import { parseMeminfo, parseProcStat, parseDockerSize, resourceHints, optimizationPrompt } from "./system-resources.js";

test("parseMeminfo uses MemAvailable and swap", () => {
  const memory = parseMeminfo("MemTotal: 16000000 kB\nMemFree: 500000 kB\nMemAvailable: 4000000 kB\nBuffers: 100000 kB\nCached: 2000000 kB\nSwapTotal: 4194304 kB\nSwapFree: 1048576 kB\n");
  assert.equal(memory.percent, 75);
  assert.equal(memory.availableMb, 3906);
  assert.equal(memory.swapUsedMb, 3072);
  assert.equal(memory.swapPercent, 75);
});

test("parseProcStat survives spaces and parentheses in names", () => {
  const stat = parseProcStat("1234 (Web Content (x)) S 1000 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 100 1000000 2560 18446744073709551615");
  assert.equal(stat.name, "Web Content (x)");
  assert.equal(stat.ppid, 1000);
  assert.equal(stat.ticks, 300);
  assert.equal(stat.rssKb, 2560 * 4);
});

test("parseDockerSize handles docker units", () => {
  assert.equal(parseDockerSize("1.5GiB"), 1536);
  assert.equal(parseDockerSize("285.3MiB"), 285);
  assert.equal(parseDockerSize("512KiB"), 1);
  assert.equal(parseDockerSize("n/a"), 0);
});

const snapshot = {
  timestamp: Date.now(),
  cpu: { model: "CPU", cores: 8, percent: 20, loadAvg: [1, 9, 4] },
  memory: parseMeminfo("MemTotal: 16000000 kB\nMemAvailable: 1600000 kB\nSwapTotal: 4194304 kB\nSwapFree: 0 kB\n"),
  gpus: [{ id: "card1", name: "Iris Xe", busyPercent: 5, freqMhz: 300, maxFreqMhz: 1300 }],
  agents: [{ id: "a", name: "Atlas", cpuPercent: 3, rssMb: 1600, processes: 4 }],
  docker: [{ name: "db", cpuPercent: 1, memoryMb: 2100 }],
  topCpu: [{ pid: 1, name: "node", cpuPercent: 95, rssMb: 100, agentName: "Atlas", command: "node x" }],
  topMemory: [{ pid: 1, name: "node", cpuPercent: 95, rssMb: 100, agentName: null, command: "node x" }],
};

test("resourceHints flags pressure", () => {
  const hints = resourceHints({ ...snapshot, cpuPercent: 20, cores: 8, loadAvg: snapshot.cpu.loadAvg });
  const text = hints.map((h) => h.text).join(" | ");
  assert.match(text, /RAM à 90%/);
  assert.match(text, /Swap/);
  assert.match(text, /Charge 5 min 9 > 8/);
  assert.match(text, /Atlas · node/);
  assert.match(text, /Docker/);
});

test("optimizationPrompt forbids stopping without confirmation", () => {
  const prompt = optimizationPrompt({ ...snapshot, hints: [] });
  assert.match(prompt, /sans ma confirmation explicite/);
  assert.match(prompt, /\[agent Atlas\]/);
});

test("descendants and ancestors walk the process tree", async () => {
  const { descendants, ancestors } = await import("./system-resources.js");
  const table = new Map([
    [1, { ppid: 0 }], [10, { ppid: 1 }], [11, { ppid: 10 }], [12, { ppid: 11 }], [20, { ppid: 1 }],
  ]);
  assert.deepEqual([...descendants(table, [10])].sort((a, b) => a - b), [10, 11, 12]);
  assert.deepEqual([...ancestors(table, 12)], [12, 11, 10, 1]);
  assert.equal(descendants(table, [99]).size, 0);
});

test("detachedRoots keeps only the top of each detached group", async () => {
  const { detachedRoots } = await import("./system-resources.js");
  const table = new Map([[1, { ppid: 0 }], [50, { ppid: 1 }], [51, { ppid: 50 }], [60, { ppid: 1 }]]);
  const owned = new Map([[50, "s"], [51, "s"], [60, "s"]]);
  assert.deepEqual(detachedRoots(table, owned).sort((a, b) => a - b), [50, 60]);
});
