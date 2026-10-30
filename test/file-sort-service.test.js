import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSortService } from "../server/file-sort-service.js";

const DAY = 24 * 60 * 60 * 1000;

test("file sort trashes with reasons, protects recent and founder files, restores and purges", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-file-sort-"));
  let now = Date.now();
  const service = new FileSortService({ dataDir, now: () => now });
  const dir = path.join(dataDir, "project-files", "p1");
  const old = new Date(now - 5 * DAY);
  const put = async (name, content, time = old) => {
    await fs.writeFile(path.join(dir, name), content);
    await fs.utimes(path.join(dir, name), time, time);
  };
  try {
    await fs.mkdir(dir, { recursive: true });
    await put("logo-final.png", "A");
    await put("logo-copy.png", "A");
    await put("logo-v1.png", "B");
    await put("brief.pdf", "C");
    await put("brief-copie.pdf", "C");
    await put("fresh.png", "D", new Date(now));
    await service.markFounder("p1", "brief.pdf");
    await service.markFounder("p1", "brief-copie.pdf");

    await service.start("p1", { agentId: "a1" });
    await assert.rejects(service.start("p1"), /déjà en cours/);
    const scan = await service.scan("p1");
    assert.deepEqual(scan.find((file) => file.name === "logo-copy.png").duplicates, ["logo-final.png"]);
    assert.equal(scan.find((file) => file.name === "fresh.png").protected, true);
    assert.equal(scan.find((file) => file.name === "brief.pdf").founder, true);

    await assert.rejects(service.trash("p1", "fresh.png", { reason: "test" }), /48 h/);
    await assert.rejects(service.trash("p1", "brief-copie.pdf", { reason: "doublon" }), /fondateur/);
    await assert.rejects(service.trash("p1", "logo-v1.png", { reason: "x", duplicateOf: "logo-final.png" }), /doublon exact/);
    await assert.rejects(service.trash("p1", "../p2/x.png", { reason: "x" }), /invalide/);
    await assert.rejects(service.trash("p1", "logo-v1.png", {}), /Raison/);

    await service.trash("p1", "brief-copie.pdf", { reason: "doublon exact", duplicateOf: "brief.pdf" });
    const copy = await service.trash("p1", "logo-copy.png", { reason: "doublon exact", duplicateOf: "logo-final.png" });
    await service.trash("p1", "logo-v1.png", { reason: "version intermédiaire remplacée par logo-final.png" });
    await service.keep("p1", "brief.pdf", { reason: "uploadé par le fondateur" });
    assert.deepEqual(await service.finish("p1", { summary: "3 supprimés" }), { agentId: "a1", deleted: 3 });

    let status = await service.status("p1");
    assert.equal(status.status, "done");
    assert.equal(status.freedBytes, 3);
    assert.equal(status.kept[0].name, "brief.pdf");
    assert.deepEqual((await fs.readdir(dir)).sort(), ["brief.pdf", "fresh.png", "logo-final.png"]);

    await put("logo-copy.png", "Z", new Date(now));
    const restored = await service.restore("p1", copy.id);
    assert.equal(restored.restoredAs, "logo-copy_restaure.png");
    assert.equal(await fs.readFile(path.join(dir, "logo-copy_restaure.png"), "utf8"), "A");

    const forever = status.trash.find((item) => item.name === "brief-copie.pdf");
    await service.deleteForever("p1", forever.id);
    await assert.rejects(service.deleteForever("p1", forever.id), /introuvable/);
    assert.equal((await service.status("p1")).trash.length, 1);
    await put("tmp.txt", "XY");
    await service.trash("p1", "tmp.txt", { reason: "export temporaire" });
    assert.deepEqual(await service.emptyTrash("p1"), { count: 2, size: 3 });
    assert.deepEqual(await fs.readdir(path.join(dataDir, "project-files-trash", "p1")), []);

    now += 31 * DAY;
    status = await service.status("p1");
    assert.equal(status.trash.length, 0);
    assert.deepEqual(await fs.readdir(path.join(dataDir, "project-files-trash", "p1")), []);
    assert.equal(status.deleted.length, 3);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
