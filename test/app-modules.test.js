import assert from "node:assert/strict";
import test from "node:test";
import { defaultModules, resolveModules, sanitizeModules } from "../server/app-modules.js";

test("modules are on by default and the env list switches some off", () => {
  assert.deepEqual(defaultModules(""), { projects: true, todos: true, calendar: true, groceries: true, budget: true });
  assert.equal(defaultModules("groceries, budget").groceries, false);
  assert.equal(defaultModules("groceries, budget").todos, true);
});

test("stored choices override defaults and unknown keys are ignored", () => {
  const current = resolveModules({ calendar: false }, defaultModules(""));
  assert.equal(current.calendar, false);
  const next = sanitizeModules({ calendar: true, budget: false, hacker: true, todos: "no" }, current);
  assert.deepEqual(next, { projects: true, todos: true, calendar: true, groceries: true, budget: false });
});
