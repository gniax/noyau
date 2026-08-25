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
