import test from "node:test";
import assert from "node:assert/strict";
import { loginNavigation } from "../src/login-navigation.js";

test("ordinary password login clears stale Budget view, preserving profile and touch mode", () => {
  assert.deepEqual(loginNavigation("?view=finances&touch=1&profile=owner"), { explicit: false, search: "touch=1&profile=owner" });
  assert.deepEqual(loginNavigation(""), { explicit: false, search: "" });
});
test("bank callbacks, agent links and explicitly requested other views survive login", () => {
  for (const search of ["?view=finances&bank=connected", "?view=finances&bankError=refused", "?session=agent-1", "?view=groceries", "?view=settings"]) assert.equal(loginNavigation(search).explicit, true);
});
