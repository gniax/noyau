import test from "node:test";
import assert from "node:assert/strict";
import { quotaTone } from "../src/quota-tone.js";

test("quotaTone returns normal for values above 25%", () => {
  assert.equal(quotaTone(100), "normal");
  assert.equal(quotaTone(50), "normal");
  assert.equal(quotaTone(26), "normal");
});

test("quotaTone returns warning for values between 11% and 25%", () => {
  assert.equal(quotaTone(25), "warning");
  assert.equal(quotaTone(15), "warning");
  assert.equal(quotaTone(11), "warning");
});

test("quotaTone returns critical for values at or below 10%", () => {
  assert.equal(quotaTone(10), "critical");
  assert.equal(quotaTone(5), "critical");
  assert.equal(quotaTone(0), "critical");
});

test("quotaTone handles invalid or missing values gracefully", () => {
  assert.equal(quotaTone(null), "normal");
  assert.equal(quotaTone(undefined), "normal");
  assert.equal(quotaTone("—"), "normal");
  assert.equal(quotaTone(""), "normal");
  assert.equal(quotaTone(NaN), "normal");
});
