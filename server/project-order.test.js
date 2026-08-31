import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectOrder, sortProjects } from "./project-order.js";

test("project order keeps visible projects and appends new ones", () => {
  assert.deepEqual(normalizeProjectOrder(["atlas", "kitty", "coin"], ["kitty", "atlas", "hidden", "kitty"]), ["kitty", "atlas", "coin"]);
  const sorted = sortProjects([["atlas", { name: "Atlas" }], ["kitty", { name: "Nimbus" }], ["coin", { name: "Meridian" }]], ["atlas", "kitty"]);
  assert.deepEqual(sorted.map(([id]) => id), ["atlas", "kitty", "coin"]);
});
