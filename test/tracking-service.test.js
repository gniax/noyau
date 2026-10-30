import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TrackingService, columnId } from "../server/tracking-service.js";

test("tracking boards keep columns, KPIs, decisions and confined report files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-tracking-"));
  const service = new TrackingService({ dir });
  try {
    assert.equal(columnId("En cours"), "inProgress");
    assert.equal(columnId("décision"), "waiting");
    assert.equal(columnId("nope"), null);

    await service.set("p1", "marketing-auto", { title: "Marketing auto", objective: "Trafic organique", agentId: "a1", agentName: "Marketing" });
    await service.setKpi("p1", "marketing-auto", { label: "Visites", value: "1200", note: "7 j" });
    await service.setKpi("p1", "marketing-auto", { label: "visites", value: "1300" });
    const planned = await service.addItem("p1", "marketing-auto", { column: "prévu", title: "Post X lundi", date: "2026-10-14", link: "http://insecure.example" });
    assert.equal(planned.column, "planned");
    assert.equal(planned.link, null);
    const ask = await service.addItem("p1", "marketing-auto", { column: "waiting", title: "Budget pub 200 €", detail: "Test 7 jours" });
    await Promise.all([1, 2, 3].map((n) => service.addItem("p1", "marketing-auto", { column: "done", title: `Fait ${n}` })));

    let { boards, waiting } = await service.list("p1");
    assert.deepEqual(boards[0].counts, { planned: 1, inProgress: 0, waiting: 1, done: 3 });
    assert.deepEqual(boards[0].kpis, [{ label: "Visites", value: "1300", note: "7 j" }]);
    assert.equal(waiting[0].boardTitle, "Marketing auto");
    assert.equal(waiting[0].agentId, "a1");

    const moved = await service.updateItem("p1", "marketing-auto", "post x", { column: "en cours" });
    assert.equal(moved.id, planned.id);
    assert.equal(moved.column, "inProgress");
    await assert.rejects(service.updateItem("p1", "marketing-auto", "fait", { column: "done" }), /Plusieurs/);

    const { item, board } = await service.decide("p1", "marketing-auto", ask.id, { decision: "go", note: "ok", by: "Moi" });
    assert.equal(item.column, "inProgress");
    assert.equal(item.decision.value, "go");
    assert.equal(board.agentId, "a1");
    await assert.rejects(service.decide("p1", "marketing-auto", ask.id, { decision: "go" }), /n'attend pas/);
    ({ waiting } = await service.list("p1"));
    assert.equal(waiting.length, 0);

    const report = await service.addReport("p1", "marketing-auto", { title: "Audit", fileName: "../../audit.html", content: Buffer.from("<h1>Audit</h1>").toString("base64") });
    assert.match(report.file, /^[0-9a-f]{6}-audit\.html$/);
    const served = await service.reportFile("p1", "marketing-auto", report.file);
    assert.equal(path.dirname(served.file), service.filesDir("p1", "marketing-auto"));
    await assert.rejects(service.reportFile("p1", "marketing-auto", "../marketing-auto.json"));
    await assert.rejects(service.addReport("p1", "marketing-auto", { title: "x", fileName: "run.sh", content: "aGk=" }), /html, pdf/);
    await assert.rejects(service.addReport("p1", "marketing-auto", { title: "x", url: "http://a.b" }), /https/);
    await assert.rejects(service.set("p1", "../evil", {}), /invalide/);
    await assert.rejects(service.list("../p1"), /invalide/);

    await service.removeReport("p1", "marketing-auto", report.id);
    await assert.rejects(fs.stat(served.file));
    await service.remove("p1", "marketing-auto");
    assert.deepEqual((await service.list("p1")).boards, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
