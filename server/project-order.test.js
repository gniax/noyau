import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectOrder, sortProjects } from "./project-order.js";

test("project order keeps visible projects and appends new ones", () => {
  assert.deepEqual(normalizeProjectOrder(["octanix", "kitty", "coin"], ["kitty", "octanix", "hidden", "kitty"]), ["kitty", "octanix", "coin"]);
  const sorted = sortProjects([["octanix", { name: "Octanix" }], ["kitty", { name: "Nimbus" }], ["coin", { name: "Atlas" }]], ["octanix", "kitty"]);
  assert.deepEqual(sorted.map(([id]) => id), ["octanix", "kitty", "coin"]);
});
