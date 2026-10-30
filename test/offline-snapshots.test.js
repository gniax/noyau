import test from "node:test";
import assert from "node:assert/strict";
import { calendarSnapshot, sameSnapshotScope } from "../src/offline-snapshots.js";

test("offline calendar cache retains events but excludes private feed URLs and arbitrary subscription secrets", () => {
  const snapshot = calendarSnapshot({ events: [{ title: "Rendez-vous", start: "2026-10-28" }], subscriptions: [{ id: "x", name: "Perso", color: "#123", enabled: true, url: "https://private.invalid/secret-token", token: "secret" }] });
  assert.equal(snapshot.events[0].title, "Rendez-vous"); assert.equal(snapshot.subscriptions[0].name, "Perso"); assert.doesNotMatch(JSON.stringify(snapshot), /secret|private\.invalid/);
  assert.equal(calendarSnapshot({ events: [] }), null);
});
test("late cached responses cannot cross profiles or server origins", () => {
  const expected = { profile: "owner", server: "https://home" };
  assert.equal(sameSnapshotScope(expected, { ...expected }), true);
  assert.equal(sameSnapshotScope(expected, { profile: "other", server: expected.server }), false);
  assert.equal(sameSnapshotScope(expected, { profile: "owner", server: "https://elsewhere" }), false);
  assert.equal(sameSnapshotScope({ profile: "", server: "https://home" }, { profile: "", server: "https://home" }), false);
});
