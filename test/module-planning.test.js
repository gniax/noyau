import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { delayMinutes, parseCalendarIterations, parseEnvironment, parseJournalRuns, parseTimerShow, planningConfig, slotFor } from "../server/module-planning.js";
import { ModuleService } from "../server/module-service.js";

class MemoryStore {
  constructor() { this.data = {}; }
  get(id) { return this.data[id] || null; }
  all() { return this.data; }
  async set(id, value) { this.data[id] = value; }
  async remove(id) { delete this.data[id]; }
}

test("parseTimerShow keeps every OnCalendar of a timer", () => {
  const units = parseTimerShow([
    "TimersCalendar={ OnCalendar=*-*-* 19:00:00 Europe/Paris ; next_elapse=Mon 2026-10-12 19:00:00 CEST }",
    "TimersCalendar={ OnCalendar=*-*-* 09:30:00 Europe/Paris ; next_elapse=(null) }",
    "RandomizedDelayUSec=20min",
    "Id=atlas-shorts.timer",
    "ActiveState=active",
    "",
  ].join("\n"));
  const shorts = units.get("atlas-shorts.timer");
  assert.deepEqual(shorts.calendars, ["*-*-* 19:00:00 Europe/Paris", "*-*-* 09:30:00 Europe/Paris"]);
  assert.equal(delayMinutes(shorts.RandomizedDelayUSec), 20);
  assert.equal(delayMinutes("1min 30s"), 2);
  assert.equal(delayMinutes("0"), 0);
});

test("parseCalendarIterations reads UTC lines", () => {
  const dates = parseCalendarIterations("    Next elapse: Mon 2026-10-12 13:05:00 CEST\n       (in UTC): Mon 2026-10-12 11:05:00 UTC\n   Iteration #2: x\n       (in UTC): Mon 2026-10-12 23:05:00 UTC\n");
  assert.deepEqual(dates.map((date) => date.toISOString()), ["2026-10-12T11:05:00.000Z", "2026-10-12T23:05:00.000Z"]);
});

test("parseJournalRuns pairs start and result, parseEnvironment reads quoted values", () => {
  const runs = parseJournalRuns([
    JSON.stringify({ USER_UNIT: "a.service", JOB_TYPE: "start", __REALTIME_TIMESTAMP: "1791723600000000" }),
    JSON.stringify({ USER_UNIT: "a.service", JOB_TYPE: "start", JOB_RESULT: "done", __REALTIME_TIMESTAMP: "1791723660000000" }),
    JSON.stringify({ USER_UNIT: "a.service", JOB_TYPE: "start", __REALTIME_TIMESTAMP: "1791730000000000" }),
    JSON.stringify({ USER_UNIT: "a.service", JOB_TYPE: "start", JOB_RESULT: "failed", __REALTIME_TIMESTAMP: "1791730005000000" }),
    JSON.stringify({ USER_UNIT: "a.service", JOB_TYPE: "start", __REALTIME_TIMESTAMP: "1791740000000000" }),
  ].join("\n"));
  assert.deepEqual(runs.get("a.service").map((run) => run.result), ["ok", "failed", "running"]);
  assert.equal(runs.get("a.service")[0].finishedAt, new Date(1791723660000).toISOString());
  assert.deepEqual(parseEnvironment('NODE_ENV=production "LABEL=a b" TOURNAMENT_SOCIAL_ENABLED=0'), { NODE_ENV: "production", LABEL: "a", TOURNAMENT_SOCIAL_ENABLED: "0" });
});

test("planningConfig confines queue files to home and rejects bad timers", () => {
  const [entry] = planningConfig([{ id: "tiktok", kind: "queue", label: "TikTok", channels: ["TikTok"], queue: { file: "~/q/queue.json" } }], "/home/u");
  assert.equal(entry.queue.file, "/home/u/q/queue.json");
  assert.deepEqual(entry.queue.pending, ["todo", "retry"]);
  assert.throws(() => planningConfig([{ id: "x", kind: "queue", queue: { file: "/etc/passwd.json" } }], "/home/u"));
  assert.throws(() => planningConfig([{ id: "x", unit: "foo.service" }], "/home/u"));
});

test("environment override survives refresh, removal hides the proposal, planning lists occurrences", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-planning-"));
  const project = path.join(home, "demo");
  await fs.mkdir(path.join(project, ".noyau", "modules"), { recursive: true });
  await fs.writeFile(path.join(home, "queue.json"), JSON.stringify([
    { id: "a", status: "todo", publishAt: "2026-10-12T16:00:00.000Z", caption: "Short A" },
    { id: "b", status: "done", publishAt: "2026-10-12T07:00:00.000Z", postedAt: "2026-10-12T07:05:00.000Z", caption: "Done" },
  ]));
  await fs.writeFile(path.join(home, "tournament.json"), JSON.stringify({ status: "approved", postText: "Round 4" }));
  await fs.writeFile(path.join(project, ".noyau", "modules", "social.json"), JSON.stringify({
    id: "social",
    project: "Demo",
    name: "Social",
    controlUnits: ["post.timer"],
    planning: [
      { id: "post", unit: "post.timer", label: "Post image", channels: ["X"] },
      { id: "tiktok", kind: "queue", label: "TikTok", channels: ["TikTok"], queue: { file: "~/queue.json" } },
      { id: "tournoi", unit: "tournament.timer", label: "Tournoi", channels: ["X"], enabledEnv: "TOURNAMENT_SOCIAL_ENABLED", state: { file: "~/tournament.json", preview: "postText", status: "status" } },
    ],
  }));
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file.endsWith("systemctl") && args.includes("show")) {
      return { stdout: "TimersCalendar={ OnCalendar=*-*-* 15:00:00 Europe/Paris ; next_elapse=x }\nRandomizedDelayUSec=0\nUnit=post.service\nId=post.timer\nLoadState=loaded\nActiveState=active\n\nUnit=\nId=tournament.timer\nLoadState=not-found\nActiveState=inactive\n\n" };
    }
    if (file.endsWith("journalctl")) {
      return { stdout: `${JSON.stringify({ USER_UNIT: "post.service", JOB_TYPE: "start", __REALTIME_TIMESTAMP: String(Date.parse("2026-10-11T13:00:00Z") * 1000) })}\n${JSON.stringify({ USER_UNIT: "post.service", JOB_TYPE: "start", JOB_RESULT: "done", __REALTIME_TIMESTAMP: String(Date.parse("2026-10-11T13:00:30Z") * 1000) })}\n` };
    }
    if (file.endsWith("systemd-analyze")) {
      return { stdout: "  (in UTC): Mon 2026-10-12 13:00:00 UTC\n  (in UTC): Tue 2026-10-13 13:00:00 UTC\n  (in UTC): Wed 2026-10-21 13:00:00 UTC\n" };
    }
    return { stdout: "" };
  };
  const store = new MemoryStore();
  const service = new ModuleService({ workspaceRoot: home, store, homeDir: home, run });
  const projects = { p1: { name: "Demo" } };
  try {
    await service.install("p1--social", projects);
    let { modules } = await service.list(projects);
    assert.equal(modules[0].environment, "development");
    await service.setEnvironment("p1--social", "production");
    ({ modules } = await service.list(projects));
    assert.equal(modules[0].environment, "production");
    assert.equal(modules[0].defaultEnvironment, "development");

    const planning = await service.planning("p1", { now: new Date("2026-10-12T10:00:00Z") });
    assert.deepEqual(planning.items.map((item) => [item.label, item.at, item.past ? item.result : "next"]), [
      ["Post image", "2026-10-11T13:00:00.000Z", "ok"],
      ["TikTok", "2026-10-12T07:05:00.000Z", "ok"],
      ["Post image", "2026-10-12T13:00:00.000Z", "next"],
      ["TikTok", "2026-10-12T16:00:00.000Z", "next"],
      ["Post image", "2026-10-13T13:00:00.000Z", "next"],
    ]);
    assert.equal(planning.items[3].preview, "Short A");
    assert.deepEqual(planning.unscheduled.map((item) => [item.label, item.reason, item.preview]), [["Tournoi", "timer non installé", "Round 4"]]);
    assert.ok(!calls.some(([, ...args]) => args.some((arg) => ["start", "restart", "try-restart"].includes(arg))));

    await service.remove("p1--social");
    const after = await service.list(projects);
    assert.equal(after.modules.length, 0);
    assert.equal(after.proposals.length, 0);
    assert.equal(after.removed[0].id, "p1--social");
    await service.install("p1--social", projects);
    ({ modules } = await service.list(projects));
    assert.equal(modules[0].environment, "production");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("slotFor picks per-slot channels by Paris time, tolerating late runs", () => {
  const [entry] = planningConfig([{ id: "arena", unit: "arena.timer", channels: ["Telegram", "X"], slots: [{ at: "01:05", channels: ["Telegram"] }, { at: "13:05", channels: ["Telegram", "X"] }] }], "/home/u");
  assert.deepEqual(slotFor(entry, new Date("2026-10-12T23:05:00Z")).channels, ["Telegram"]);
  assert.deepEqual(slotFor(entry, new Date("2026-10-12T11:07:30Z")).channels, ["Telegram", "X"]);
  assert.equal(slotFor(entry, new Date("2026-10-12T05:00:00Z")), null);
});

test("writeBoost sets one occurrence, keeps other keys, purges old ones and refuses unreadable files", async () => {
  const { writeBoost, readBoosts, nearTime, parisDate } = await import("../server/module-planning.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-boost-"));
  const file = path.join(dir, "boosts.json");
  const now = new Date("2026-10-12T10:00:00Z");
  try {
    await fs.writeFile(file, JSON.stringify({ _doc: "keep", occurrences: { "2026-10-01:image": true, "2026-10-11:arena": true }, slots: { launch: false } }));
    await writeBoost(file, { occurrence: "2026-10-13:image", enabled: true }, { now });
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(saved._doc, "keep");
    assert.deepEqual(saved.occurrences, { "2026-10-11:arena": true, "2026-10-13:image": true });
    assert.deepEqual(saved.slots, { launch: false });
    await writeBoost(file, { slots: ["launch"], enabled: true }, { now });
    assert.equal((await readBoosts(file)).slots.launch, true);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["boosts.json"]);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await fs.writeFile(file, "{broken");
    await assert.rejects(writeBoost(file, { occurrence: "2026-10-13:arena", enabled: true }, { now }));
    assert.equal(await fs.readFile(file, "utf8"), "{broken");
    assert.equal(parisDate(new Date("2026-10-12T22:30:00Z")), "2026-10-13");
    assert.ok(nearTime(new Date("2026-10-12T11:05:00Z"), "13:05"));
    assert.ok(!nearTime(new Date("2026-10-12T23:05:00Z"), "13:05"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
