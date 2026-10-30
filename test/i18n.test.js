import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

test("every tr() text has an English translation", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/i18n-check.mjs"]).catch((error) => error);
  assert.equal(stdout.trim(), "");
});

test("English translations never invent placeholders", async () => {
  const en = JSON.parse(await fs.readFile(new URL("../src/locales/en.json", import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(en)) {
    for (const placeholder of value.match(/\{\d+\}/g) || []) assert.ok(key.includes(placeholder), `${key} -> ${value}`);
  }
});
