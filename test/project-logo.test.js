import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectLogoService } from "../server/project-logo.js";

test("project logo prefers explicit logo and ignores build output", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-logo-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "public"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "public", "logo.svg"), "<svg/>");
  await fs.writeFile(path.join(root, "dist", "logo.svg"), "<svg/>");
  assert.equal(await new ProjectLogoService().find(root), path.join(root, "public", "logo.svg"));
});

test("project logo service lists and paginates images with candidate scoring", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-logo-list-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "logo.svg"), "<svg/>");
  await fs.writeFile(path.join(root, "assets", "icon.png"), "png");
  await fs.writeFile(path.join(root, "assets", "banner.jpg"), "jpg");
  await fs.writeFile(path.join(root, "assets", "photo.webp"), "webp");
  await fs.writeFile(path.join(root, "node_modules", "ignored.png"), "png");

  const service = new ProjectLogoService();
  const page1 = await service.list(root, { offset: 0, limit: 2 });
  assert.equal(page1.total, 4);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.images.length, 2);
  assert.equal(page1.images[0].name, "logo.svg"); // highest candidate score
  assert.equal(page1.images[1].name, "icon.png");

  const page2 = await service.list(root, { offset: 2, limit: 2 });
  assert.equal(page2.images.length, 2);
  assert.equal(page2.hasMore, false);

  const searchResult = await service.list(root, { search: "banner" });
  assert.equal(searchResult.total, 1);
  assert.equal(searchResult.images[0].name, "banner.jpg");
});

