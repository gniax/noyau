import test from "node:test";
import assert from "node:assert/strict";
import { isProjectServer, isProjectContainer } from "./project-servers.js";

test("server targeting excludes other projects and agent commands", () => {
  const root = "/workspace/nimbus";
  assert.equal(isProjectServer(root, root, "next-server (v15)"), true);
  assert.equal(isProjectServer(root, `${root}/web`, "node /app/node_modules/.bin/next dev"), true);
  assert.equal(isProjectServer(root, `${root}-copy`, "next-server (v15)"), false);
  assert.equal(isProjectServer(root, root, "codex fix next-server"), false);
  assert.equal(isProjectServer(root, root, "node server/index.js"), false);
});

test("container targeting leaves databases and unrelated compose stacks alone", () => {
  const item = (cwd, service) => ({ Config: { Labels: { "com.docker.compose.project.working_dir": cwd, "com.docker.compose.service": service } } });
  assert.equal(isProjectContainer("/workspace/atlas", item("/workspace/atlas/docker", "php")), true);
  assert.equal(isProjectContainer("/workspace/atlas", item("/workspace/atlas/docker", "db")), false);
  assert.equal(isProjectContainer("/workspace/atlas", item("/workspace/octanix", "web")), false);
  assert.equal(isProjectContainer("/workspace/atlas", {}), false);
});
