import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { boardConfig, boardMedia, normalizeBoard, readModuleBoard } from "./module-board.js";

test("board file must stay under home and be json", () => {
  assert.equal(boardConfig(null, "/home/u"), null);
  assert.deepEqual(boardConfig({ file: "~/.cache/x/board.json" }, "/home/u"), { file: "/home/u/.cache/x/board.json", mediaDir: "/home/u/.cache/x" });
  for (const file of ["/etc/board.json", "~/../board.json", "~/board.txt"]) assert.throws(() => boardConfig({ file }, "/home/u"), /invalide/);
});

test("board keeps https links and plain media names only", () => {
  const board = normalizeBoard({ sections: [{ title: "S", rows: [["a", "b"]], cards: [{ title: "Nano", tone: "live", links: [{ label: "Site", url: "https://nano.org" }, { label: "X", url: "javascript:alert(1)" }], images: [{ file: "nano.gif" }, { file: "../secret.png" }, { file: "a/b.png" }] }] }] });
  const card = board.sections[0].cards[0];
  assert.deepEqual(card.links.map((link) => link.label), ["Site"]);
  assert.deepEqual(card.images.map((image) => image.file), ["nano.gif"]);
  assert.equal(card.tone, "live");
  assert.throws(() => normalizeBoard({}), /invalide/);
});

test("board reads file and serves media from its folder", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-board-"));
  try {
    const module = { board: boardConfig({ file: path.join(dir, "board.json") }, os.tmpdir()) };
    assert.equal((await readModuleBoard(module)).availability, "waiting");
    await fs.writeFile(path.join(dir, "board.json"), JSON.stringify({ title: "T", sections: [] }));
    assert.equal((await readModuleBoard(module)).title, "T");
    await fs.writeFile(path.join(dir, "nano.gif"), "GIF89a");
    assert.equal((await boardMedia(module, "nano.gif")).type, "image/gif");
    await assert.rejects(boardMedia(module, "board.json"), /introuvable/);
    await assert.rejects(boardMedia(module, "../x.png"), /introuvable/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
