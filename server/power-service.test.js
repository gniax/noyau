import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PowerService, isWithinTimeWindow } from "./power-service.js";

test("isWithinTimeWindow handles normal and cross-midnight windows", () => {
  // Même jour
  assert.equal(isWithinTimeWindow("02:00", "01:00", "06:00"), true);
  assert.equal(isWithinTimeWindow("07:00", "01:00", "06:00"), false);
  assert.equal(isWithinTimeWindow("00:30", "01:00", "06:00"), false);

  // Traverse minuit (ex: 23:00 à 07:30)
  assert.equal(isWithinTimeWindow("23:30", "23:00", "07:30"), true);
  assert.equal(isWithinTimeWindow("03:15", "23:00", "07:30"), true);
  assert.equal(isWithinTimeWindow("07:29", "23:00", "07:30"), true);
  assert.equal(isWithinTimeWindow("07:30", "23:00", "07:30"), false);
  assert.equal(isWithinTimeWindow("12:00", "23:00", "07:30"), false);
});

async function fixture({ working = [], dockerOutput = "" } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-power-"));
  const file = path.join(directory, "power-state.json");
  const executed = [];
  const mockExec = async (cmd, args) => {
    executed.push({ cmd, args });
    if (cmd === "docker" && args[0] === "ps") {
      return { stdout: dockerOutput };
    }
    return { stdout: "" };
  };
  const service = new PowerService({
    file,
    exec: mockExec,
    loadRatio: () => 0,
    agentWorkingChecker: async () => working,
  });
  return { file, service, executed };
}

test("enterSleep met en pause les conteneurs Docker en cours d'exécution", async () => {
  const dockerOutput = "c1\tatlas_nginx\tUp 24 hours\nc2\tatlas_db\tUp 24 hours (healthy)\nc3\talready_paused\tUp 24 hours (Paused)\n";
  const { service, executed } = await fixture({ dockerOutput });

  const result = await service.enterSleep();
  assert.equal(result.ok, true);
  assert.equal(result.pausedContainers.length, 2);
  assert.deepEqual(result.pausedContainers.map((c) => c.name), ["atlas_nginx", "atlas_db"]);

  // Vérifier les appels docker pause
  const pauseCalls = executed.filter((e) => e.cmd === "docker" && e.args[0] === "pause");
  assert.equal(pauseCalls.length, 2);
  assert.equal(pauseCalls[0].args[1], "c1");
  assert.equal(pauseCalls[1].args[1], "c2");

  const status = await service.getStatus();
  assert.equal(status.sleeping, true);
  assert.equal(status.pausedContainers.length, 2);
});

test("enterSleep ne reste pas bloqué si un agent a un statut travail figé", async () => {
  const dockerOutput = "c1\tatlas_nginx\tUp 24 hours\n";
  const { service } = await fixture({ working: [{ id: "agent-1", name: "Atlas" }], dockerOutput });

  // Doit s'activer sans lever d'erreur
  const result = await service.enterSleep();
  assert.equal(result.ok, true);
  assert.equal(result.sleeping, true);
});

test("wakeUp dégèle les conteneurs qui ont été mis en pause", async () => {
  const dockerOutput = "c1\tatlas_nginx\tUp 24 hours\n";
  const { service, executed } = await fixture({ dockerOutput });

  await service.enterSleep();
  const wake = await service.wakeUp();
  assert.equal(wake.ok, true);
  assert.equal(wake.unpausedContainers.length, 1);
  assert.equal(wake.unpausedContainers[0].name, "atlas_nginx");

  const unpauseCalls = executed.filter((e) => e.cmd === "docker" && e.args[0] === "unpause");
  assert.equal(unpauseCalls.length, 1);
  assert.equal(unpauseCalls[0].args[1], "c1");

  const status = await service.getStatus();
  assert.equal(status.sleeping, false);
  assert.equal(status.pausedContainers.length, 0);
});

function at(value) { return new Date(value).getTime(); }

async function clocked({ startedAt = "2026-09-14T03:00:00", working = [], load = 0, stored = null, systemIdleMs = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-power-"));
  const file = path.join(directory, "power-state.json");
  if (stored) await fs.writeFile(file, JSON.stringify(stored));
  const clock = { now: at(startedAt), working, load };
  const service = new PowerService({
    file,
    now: () => clock.now,
    loadRatio: () => clock.load,
    agentWorkingChecker: async () => clock.working,
    exec: async (cmd) => {
      if (cmd === "docker") return { stdout: "c1\tatlas_nginx\tUp 24 hours\n" };
      if (cmd === "gdbus" && systemIdleMs !== null) return { stdout: `(uint64 ${systemIdleMs},)` };
      return { stdout: "" };
    },
  });
  const advance = async (minutes) => { clock.now += minutes * 60_000; await service.tick(); return (await service.getStatus()).sleeping; };
  return { service, clock, advance };
}

test("tick entre en veille de nuit après inactivité réelle et réveille au matin", async () => {
  const { service, clock, advance } = await clocked();
  await service.tick();
  assert.equal(await advance(14), false);
  assert.equal(await advance(1), true);
  const status = await service.getStatus();
  assert.equal(status.autoTriggered, true);
  clock.now = at("2026-09-14T08:00:00");
  await service.tick();
  assert.equal((await service.getStatus()).sleeping, false);
});

test("un redémarrage ne compte pas l'ancienne date d'activité comme de l'absence", async () => {
  const { service, advance } = await clocked({ startedAt: "2026-09-14T15:00:00", stored: { schedule: { enabled: true, start: "00:00", end: "07:30", idleMinutes: 120 }, lastActivityAt: at("2026-09-13T15:00:00") } });
  await service.tick();
  assert.equal(await advance(11), false);
  assert.equal(await advance(100), false);
  assert.equal(await advance(10), true);
});

test("la charge système ne déclenche jamais la veille et la retarde", async () => {
  const { service, clock, advance } = await clocked({ startedAt: "2026-09-14T15:00:00", load: 3 });
  await service.tick();
  for (let i = 0; i < 20; i += 1) assert.equal(await advance(30), false);
  clock.load = 0;
  assert.equal(await advance(1), false, "période calme requise après la charge");
  assert.equal(await advance(10), true);
});

test("un agent lu « disponible » une seule fois entre deux travaux ne déclenche pas la veille", async () => {
  const busy = [{ id: "a", name: "Agent", state: "working" }];
  const { service, clock, advance } = await clocked({ startedAt: "2026-09-14T15:00:00", working: busy });
  await service.tick();
  assert.equal(await advance(300), false);
  clock.working = [];
  assert.equal(await advance(1), false);
  clock.working = busy;
  assert.equal(await advance(1), false);
  clock.working = [];
  assert.equal(await advance(9), false);
  assert.equal(await advance(1), true);
});

test("le contrôle des agents en échec bloque la veille", async () => {
  const { service, clock } = await clocked({ startedAt: "2026-09-14T15:00:00" });
  service.agentWorkingChecker = async () => { throw new Error("tmux saturé"); };
  clock.now += 600 * 60_000;
  await service.tick();
  assert.equal(service.isSleeping(), false);
});

test("un écran distant ouvert retient la veille, puis son départ compte", async () => {
  const { service, clock, advance } = await clocked({ startedAt: "2026-09-14T15:00:00" });
  for (let i = 0; i < 6; i += 1) { clock.now += 30 * 60_000; service.touchClient(); await service.tick(); }
  assert.equal(service.isSleeping(), false);
  assert.equal(await advance(119), false);
  assert.equal(await advance(1), true);
});

test("la veille automatique cède dès qu'un agent reprend ou après un redémarrage", async () => {
  const { service, clock, advance } = await clocked({ startedAt: "2026-09-14T15:00:00" });
  await service.tick();
  assert.equal(await advance(130), true);
  clock.working = [{ id: "a", name: "Agent", state: "working" }];
  assert.equal(await advance(1), false);

  const inherited = await clocked({ startedAt: "2026-09-14T15:00:00", stored: { sleeping: true, autoTriggered: true, autoReason: "idle", sleepingSince: "2026-09-14T01:00:00Z", pausedContainers: [] } });
  await inherited.service.tick();
  assert.equal(inherited.service.isSleeping(), false);
});

test("enterSleep et wakeUp gèrent l'alimentation de l'écran via xset", async () => {
  const { service, executed } = await fixture();
  await service.enterSleep();
  const offCalls = executed.filter((e) => e.cmd === "xset" && e.args.includes("off"));
  assert.equal(offCalls.length, 1);

  await service.wakeUp();
  const onCalls = executed.filter((e) => e.cmd === "xset" && e.args.includes("on"));
  assert.equal(onCalls.length, 1);
});

test("tick déclenche la veille après dépassement du délai d'inactivité", async () => {
  const { service } = await fixture();
  await service.updateSchedule({ enabled: true, start: "00:00", end: "00:00", idleMinutes: 120 }); // Pas de fenêtre nocturne

  // Activité récente (1 heure): pas de mise en veille
  const now = new Date("2026-09-14T14:00:00");
  service.cache.lastActivityAt = now.getTime() - 60 * 60_000;
  service.lastBusyAt = 0;
  await service.tick(now);
  let status = await service.getStatus();
  assert.equal(status.sleeping, false);

  // Inactivité 2h10 (130 minutes): mise en veille
  const later = new Date("2026-09-14T16:10:00");
  await service.tick(later);
  status = await service.getStatus();
  assert.equal(status.sleeping, true);
  assert.equal(status.autoTriggered, true);
});

test("canWakeOnActivity respecte la période de grâce de 15s", async () => {
  const { service } = await fixture();
  assert.equal(service.canWakeOnActivity(), false);

  await service.enterSleep();
  // Immédiatement après mise en veille : impossible de réveiller
  assert.equal(service.canWakeOnActivity(), false);

  // 5 secondes après : toujours refusé
  service.cache.sleepingSince = new Date(Date.now() - 5_000).toISOString();
  assert.equal(service.canWakeOnActivity(), false);

  // 16 secondes après : réveil autorisé
  service.cache.sleepingSince = new Date(Date.now() - 16_000).toISOString();
  assert.equal(service.canWakeOnActivity(), true);
});

test("getEffectiveIdleMinutes utilise le délai d'inactivité Mutter ou web", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-power-"));
  const file = path.join(directory, "power-state.json");
  const mockExec = async (cmd) => {
    if (cmd === "gdbus") return { stdout: "(uint64 7200000,)\n" };
    return { stdout: "" };
  };
  const service = new PowerService({ file, exec: mockExec });
  const now = new Date("2026-09-14T16:00:00");
  await service.read();
  service.cache.lastActivityAt = now.getTime() - 130 * 60_000;
  const idle = await service.getEffectiveIdleMinutes(now);
  assert.equal(idle, 120);
});

test('automatic sleep never pauses workloads when an agent is active or check fails', async () => {
  const calls=[]; const exec=async (file,args)=>{calls.push([file,args]);return {stdout:''};};
  const active=new PowerService({exec,agentWorkingChecker:async()=>[{id:'agent'}]});
  const result=await active.enterSleep({auto:true}); assert.equal(result.blocked,true); assert.equal(calls.some(([f,a])=>f==='docker'&&a[0]==='pause'),false);
  const unavailable=new PowerService({exec,agentWorkingChecker:async()=>{throw new Error('unavailable');}});
  await assert.rejects(()=>unavailable.enterSleep({auto:true}),/unavailable/); assert.equal(unavailable.isSleeping(),false);
});
